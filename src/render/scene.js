// Gridlands 2 — three.js scene layer: camera, golden-hour lighting, picking,
// pan/zoom, ghost-tile legality preview, placement drop-bounce, finale flight.
//
// REQUIRED IMPORT MAP — the shell (index.html) must include this BEFORE any
// module script so the bare specifier 'three' resolves:
//
//   <script type="importmap">
//   {
//     "imports": {
//       "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
//       "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
//     }
//   }
//   </script>
//
// Only 'three' is used by the render layer; the addons mapping is for future use.
//
// Contract: init(canvas, game) -> handle. `game` is a read-only core Game.
// The caller (main.js) owns the rAF loop and calls handle.update(dt) each
// frame — no timers or internal rAF here. UI/HUD lives elsewhere; this module
// touches only its canvas (plus window key/resize listeners for pan controls).

import * as THREE from 'three';
import { key, parseKey, toWorld } from '../core/hex.js';
import { placementRelations } from '../core/board.js';
import { buildTileMesh, setSnowcap, HEX_SIZE } from './tilemesh.js';
import { createEffects } from './effects.js';

const ZOOM_MIN = 6;
const ZOOM_MAX = 55;
const DROP_HEIGHT = 8;
const GRAVITY = 30;

const stripGeo = new THREE.BoxGeometry(0.68, 0.1, 0.13);
const stripMats = {
  green: new THREE.MeshBasicMaterial({ color: 0x35d07a, toneMapped: false }),
  grey: new THREE.MeshBasicMaterial({ color: 0xb9c2c8, toneMapped: false }),
  red: new THREE.MeshBasicMaterial({ color: 0xff4a3c, toneMapped: false }),
};

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function cubeRound(qf, rf) {
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

function edgeStrip(dir, status, y) {
  const m = new THREE.Mesh(stripGeo, stripMats[status]);
  const a = -dir * Math.PI / 3;
  m.position.set(Math.cos(a) * 0.86, y, Math.sin(a) * 0.86);
  m.rotation.y = -a + Math.PI / 2;
  return m;
}

export function init(canvas, game) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf3e2c8); // warm haze; horizon melts into fog
  scene.fog = new THREE.Fog(0xf3e2c8, 38, 110);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);

  // golden hour: warm low sun + soft sky fill
  const sun = new THREE.DirectionalLight(0xffd9a0, 1.25);
  sun.position.set(14, 18, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 100;
  sun.shadow.camera.left = -30;
  sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 30;
  sun.shadow.camera.bottom = -30;
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xfff1dd, 0x8c7a5e, 0.6);
  scene.add(hemi);

  // sea floor beneath the island board, grounds the world like GL1's ocean
  const seaMat = new THREE.MeshStandardMaterial({ color: 0x2e5f9e, roughness: 0.4, metalness: 0.1 });
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), seaMat);
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -0.55;
  sea.receiveShadow = true;
  scene.add(sea);

  const tiles = new Map(); // "q,r" -> THREE.Group
  const effects = createEffects({ scene, game, tiles, sun, hemi });

  const focus = new THREE.Vector3(0, 0, 0);
  let zoom = 18;
  let targetZoom = 18;
  let time = 0;
  let flight = null;
  const drops = [];
  const denies = [];
  const keysDown = {};
  const clickCbs = new Set();
  const hoverCbs = new Set();
  let hoverCell = null;
  let ghost = null; // { group, mats: [cloned], q, r, shake }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();

  const cellToWorld = (q, r) => toWorld(q, r, HEX_SIZE);

  function pickCell(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(groundPlane, hitPoint)) return null;
    const qf = (Math.sqrt(3) / 3 * hitPoint.x - hitPoint.z / 3) / HEX_SIZE;
    const rf = (2 / 3 * hitPoint.z) / HEX_SIZE;
    return cubeRound(qf, rf);
  }

  // --- tile visuals ---

  function addTileVisual(tile, q, r) {
    const group = buildTileMesh(tile);
    const p = cellToWorld(q, r);
    group.position.set(p.x, 0, p.z);
    scene.add(group);
    tiles.set(key(q, r), group);
    return group;
  }

  // Drop-bounce placement (GL1 feel, dt-driven). Fires the effects pipeline
  // (particles, celebrations, vehicle refresh) once the tile settles — do NOT
  // also call effects.processResult for the same result.
  function placeTileVisual(result) {
    const group = addTileVisual(result.tile, result.q, result.r);
    group.position.y = DROP_HEIGHT;
    drops.push({ group, q: result.q, r: result.r, vy: 0, landed: false, result });
    return group;
  }

  function rebuild() {
    for (const g of tiles.values()) scene.remove(g);
    tiles.clear();
    for (const [k, tile] of game.board) {
      const { q, r } = parseKey(k);
      addTileVisual(tile, q, r);
    }
    effects.syncBoardState();
  }

  // --- ghost tile with per-edge legality colors (DESIGN §3.3) ---

  function clearGhost() {
    if (!ghost) return;
    scene.remove(ghost.group);
    for (const m of ghost.mats) m.dispose();
    ghost = null;
  }

  function setGhost(tile, q, r) {
    clearGhost();
    if (!tile || game.board.has(key(q, r))) return;
    const group = buildTileMesh(tile);
    const mats = [];
    group.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = false;
        child.material = child.material.clone();
        child.material.transparent = true;
        child.material.opacity = Math.min(child.material.opacity, 0.6);
        child.material.depthWrite = false;
        mats.push(child.material);
      }
    });
    for (const { dir, neighborTile, rel } of placementRelations(game.board, tile, q, r, game.config)) {
      let status = 'grey'; // legal-0: empty edge, soft mismatch, lane-on-ocean
      if (neighborTile && !rel.legal) status = 'red';
      else if (neighborTile && (rel.points > 0 || rel.junction)) status = 'green';
      group.add(edgeStrip(dir, status, 0.3));
    }
    const p = cellToWorld(q, r);
    group.position.set(p.x, 0.5, p.z);
    scene.add(group);
    ghost = { group, mats, q, r, shake: 0 };
  }

  // Red-flash deny animation; edges defaults to the currently illegal dirs.
  function denyFlash(q, r, edges) {
    let dirs = edges;
    if (!dirs && game.currentTile) {
      dirs = placementRelations(game.board, game.currentTile, q, r, game.config)
        .filter((e) => e.neighborTile && !e.rel.legal)
        .map((e) => e.dir);
    }
    if (!dirs || !dirs.length) dirs = [0, 1, 2, 3, 4, 5];
    const p = cellToWorld(q, r);
    for (const dir of dirs) {
      const strip = edgeStrip(dir, 'red', 0);
      strip.material = stripMats.red.clone();
      strip.material.transparent = true;
      strip.position.x += p.x;
      strip.position.y = 0.55;
      strip.position.z += p.z;
      scene.add(strip);
      denies.push({ mesh: strip, life: 0 });
    }
    if (ghost && ghost.q === q && ghost.r === r) ghost.shake = 0.45;
    effects.emit({ type: 'deny', q, r, edges: dirs });
  }

  // --- finale camera flight (DESIGN §9 item 6; CatmullRom like GL1 vehicles) ---

  function cameraFlyAlong(keys, opts = {}) {
    const pts = (keys || []).map((k) => {
      const { q, r } = parseKey(k);
      const p = cellToWorld(q, r);
      return new THREE.Vector3(p.x, 0, p.z);
    });
    if (pts.length === 0) return Promise.resolve();
    if (pts.length === 1) pts.push(pts[0].clone().add(new THREE.Vector3(2, 0, 2)));
    if (flight) flight.resolve();
    return new Promise((resolve) => {
      flight = {
        curve: new THREE.CatmullRomCurve3(pts),
        t: 0,
        dur: opts.duration ?? Math.max(3, pts.length * 0.7),
        height: opts.height ?? 7,
        resolve,
      };
    });
  }

  // --- input ---

  let dragging = false;
  let moved = 0;
  let lastPointer = { x: 0, y: 0 };

  function onPointerDown(e) {
    lastPointer = { x: e.clientX, y: e.clientY };
    moved = 0;
    if (e.button === 2) dragging = true;
  }

  function onPointerMove(e) {
    const dx = e.clientX - lastPointer.x;
    const dy = e.clientY - lastPointer.y;
    moved += Math.abs(dx) + Math.abs(dy);
    if (dragging) {
      const f = zoom * 0.0016;
      focus.x -= dx * f;
      focus.z -= dy * f;
    } else if (!flight) {
      const cell = pickCell(e.clientX, e.clientY);
      if (cell && (!hoverCell || cell.q !== hoverCell.q || cell.r !== hoverCell.r)) {
        hoverCell = cell;
        for (const cb of [...hoverCbs]) cb(cell.q, cell.r);
      }
    }
    lastPointer = { x: e.clientX, y: e.clientY };
  }

  function onPointerUp(e) {
    if (e.button === 2) { dragging = false; return; }
    if (e.button === 0 && moved < 6 && !flight) {
      const cell = pickCell(e.clientX, e.clientY);
      if (cell) for (const cb of [...clickCbs]) cb(cell.q, cell.r);
    }
  }

  function onWheel(e) {
    e.preventDefault();
    targetZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, targetZoom + e.deltaY * 0.02));
  }

  function onContextMenu(e) {
    e.preventDefault();
  }

  function onKey(down) {
    return (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key.startsWith('Arrow')) {
        keysDown[e.key] = down;
        e.preventDefault();
      }
    };
  }
  const onKeyDown = onKey(true);
  const onKeyUp = onKey(false);

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('resize', resize);
  resize();

  // --- frame update (the only animation driver; caller owns rAF) ---

  function update(dt) {
    const d = Math.min(dt || 0, 0.1);
    time += d;

    const pan = zoom * 0.9 * d;
    if (keysDown.ArrowUp) focus.z -= pan;
    if (keysDown.ArrowDown) focus.z += pan;
    if (keysDown.ArrowLeft) focus.x -= pan;
    if (keysDown.ArrowRight) focus.x += pan;

    zoom += (targetZoom - zoom) * Math.min(1, d * 8);

    if (flight) {
      flight.t += d / flight.dur;
      const k = easeInOut(Math.min(flight.t, 1));
      const p = flight.curve.getPointAt(k);
      const ahead = flight.curve.getPointAt(Math.min(k + 0.06, 1));
      camera.position.set(p.x, flight.height, p.z + flight.height * 0.75);
      camera.lookAt(ahead.x, 0.3, ahead.z);
      if (flight.t >= 1) {
        const end = flight.curve.getPointAt(1);
        focus.set(end.x, 0, end.z);
        zoom = targetZoom = flight.height;
        flight.resolve();
        effects.emit({ type: 'flightDone' });
        flight = null;
      }
    } else {
      camera.position.set(focus.x, zoom, focus.z + zoom * 0.75);
      camera.lookAt(focus.x, 0, focus.z);
    }

    // shadow frustum tracks the camera focus
    sun.position.set(focus.x + 14, 18, focus.z + 6);
    sun.target.position.copy(focus);
    sun.target.updateMatrixWorld();

    if (ghost) {
      const p = cellToWorld(ghost.q, ghost.r);
      let ox = 0;
      if (ghost.shake > 0) {
        ghost.shake = Math.max(0, ghost.shake - d);
        ox = Math.sin(ghost.shake * 40) * 0.06 * (ghost.shake / 0.45);
      }
      ghost.group.position.set(p.x + ox, 0.5 + Math.sin(time * 4) * 0.05, p.z);
    }

    for (let i = denies.length - 1; i >= 0; i--) {
      const dn = denies[i];
      dn.life += d;
      dn.mesh.material.opacity = 0.4 + 0.6 * Math.abs(Math.sin(dn.life * 18));
      if (dn.life >= 0.7) {
        scene.remove(dn.mesh);
        dn.mesh.material.dispose();
        denies.splice(i, 1);
      }
    }

    for (let i = drops.length - 1; i >= 0; i--) {
      const drop = drops[i];
      drop.vy += GRAVITY * d;
      drop.group.position.y -= drop.vy * d;
      if (drop.group.position.y <= 0 && drop.vy > 0) {
        drop.group.position.y = 0;
        if (!drop.landed) {
          drop.landed = true;
          effects.placementBurst(drop.q, drop.r);
          effects.emit({ type: 'tileLanded', q: drop.q, r: drop.r, result: drop.result });
        }
        if (drop.vy > 2.2) {
          drop.vy = -drop.vy * 0.38;
        } else {
          drops.splice(i, 1);
          effects.processResult(drop.result);
        }
      }
    }

    effects.update(d);
    renderer.render(scene, camera);
  }

  function dispose() {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('resize', resize);
    clearGhost();
    effects.dispose();
    renderer.dispose();
  }

  function worldToScreen(wx, wy, wz) {
    const v = new THREE.Vector3(wx, wy, wz).project(camera);
    const rect = canvas.getBoundingClientRect();
    return {
      x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
      y: (-v.y * 0.5 + 0.5) * rect.height + rect.top,
      behind: v.z > 1,
    };
  }

  // initial sync (covers deserialized games)
  rebuild();

  return {
    scene, camera, renderer, effects, tiles,

    onCellClick(cb) { clickCbs.add(cb); return () => clickCbs.delete(cb); },
    onHover(cb) { hoverCbs.add(cb); return () => hoverCbs.delete(cb); },
    onEvent: effects.onEvent, // shipHorn / sting / tallyRide / deny / tileLanded...

    setGhost, clearGhost, denyFlash,
    placeTileVisual, addTileVisual, rebuild,
    cameraFlyAlong,
    setSnowcap, // re-exported for completeness

    update, resize, dispose,
    pickCell, cellToWorld, worldToScreen,
    getHoverCell: () => hoverCell,
    setFocus(q, r) { const p = cellToWorld(q, r); focus.set(p.x, 0, p.z); },
    setZoom(z) { targetZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)); },
  };
}
