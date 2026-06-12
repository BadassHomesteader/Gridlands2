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
import { key, parseKey, neighbor, toWorld, neighbors } from '../core/hex.js';
import { placementRelations, canPlace } from '../core/board.js';
import { rotateTile } from '../core/tiles.js';
import { buildTileMesh, setSnowcap, HEX_SIZE } from './tilemesh.js';
import { createEffects } from './effects.js';

const ZOOM_MIN = 6;
const ZOOM_MAX = 55;
const ZOOM_START = 10; // opening tiles fill the frame; follow eases out later
const FOLLOW_RESUME = 3; // seconds hands-off before centroid-follow resumes
const DROP_HEIGHT = 8;
const GRAVITY = 30;
const GROUND_Y = -0.42;

const stripGeo = new THREE.BoxGeometry(0.68, 0.1, 0.13);
const buoyGeo = new THREE.SphereGeometry(0.1, 7, 6);
const buoyCapGeo = new THREE.SphereGeometry(0.052, 6, 5);
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

// Warm parchment sea-haze ground texture — the empty world must read as
// golden-hour mist (matching the menu), never as night ocean, so Ocean TILES
// stay the only blue water on screen.
function makeGroundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(512, 512, 30, 512, 512, 512);
  grad.addColorStop(0, '#fdf3dd');
  grad.addColorStop(0.18, '#f7e8cb');
  grad.addColorStop(0.45, '#efdcba');
  grad.addColorStop(1, '#e3cda6');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1024, 1024);
  // soft dune/haze mottling (seeded so shots are reproducible)
  let s = 7;
  const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < 130; i++) {
    g.fillStyle = rand() < 0.5
      ? 'rgba(213, 184, 138, 0.05)'
      : 'rgba(255, 250, 236, 0.07)';
    g.beginPath();
    g.ellipse(rand() * 1024, rand() * 1024, 24 + rand() * 80, 14 + rand() * 50,
      rand() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Flat hexagonal ring (lies in XZ); corners match the tile prism orientation.
function hexRingGeometry(r0, r1) {
  const pos = [];
  const P = (r, a) => [Math.cos(a) * r, 0, Math.sin(a) * r];
  for (let k = 0; k < 6; k++) {
    const a1 = (Math.PI / 180) * (30 + k * 60);
    const a2 = (Math.PI / 180) * (30 + (k + 1) * 60);
    const A = P(r0, a1);
    const B = P(r1, a1);
    const C = P(r1, a2);
    const D = P(r0, a2);
    pos.push(...A, ...B, ...C, ...A, ...C, ...D);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  return geo;
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

  // warm parchment ground (replaces the old navy "sea floor" — it dominated
  // the frame and was confusable with real Ocean tiles). Unlit so the cream
  // stays exact; fog melts it into the horizon haze.
  const groundMat = new THREE.MeshBasicMaterial({ map: makeGroundTexture() });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = GROUND_Y;
  scene.add(ground);
  // tile shadows land on a transparent catcher (basic materials ignore lights)
  const shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.ShadowMaterial({ color: 0x6b4a26, opacity: 0.3 }));
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.y = GROUND_Y + 0.005;
  shadowPlane.receiveShadow = true;
  scene.add(shadowPlane);

  // frontier hints: faint hex outlines on empty cells adjacent to placed
  // tiles, so "where can I build" reads against the haze
  const hintGroup = new THREE.Group();
  scene.add(hintGroup);
  const hintGeo = hexRingGeometry(0.8, 0.91);
  const hintMat = new THREE.MeshBasicMaterial({
    color: 0xc2a274, transparent: true, opacity: 0.3,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const hints = new Map(); // "q,r" -> mesh

  // perfect-spot affordance: an empty cell with >=5 placed neighbors is a
  // forming §5.3 ring — its frontier ring turns gold. When the tile IN HAND
  // can legally fill it (any rotation), the ring pulses hot as an invitation.
  // Fillability is re-evaluated on board change / draw / rotate, never per-frame.
  const perfectSpots = new Map(); // "q,r" -> { mesh, hot }
  const spotSoftMat = new THREE.MeshBasicMaterial({
    color: 0xe0a83c, transparent: true, opacity: 0.3,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const spotHotMat = new THREE.MeshBasicMaterial({
    color: 0xffce5c, transparent: true, opacity: 0.6,
    depthWrite: false, side: THREE.DoubleSide,
  });

  // dock teaching hint: buoy breadcrumbs on the open-water cells a lane could
  // still reach from a harbor's dock (soft edges facing those cells would
  // brick the route — the costliest hidden lesson in the fun review).
  const dockGroup = new THREE.Group();
  scene.add(dockGroup);
  let dockHint = null; // { items: [{ mesh, baseY, phase, mats }], expiresAt, fromGhost }
  const OC_PROBE = {
    id: 'probe-oc-hint', archetype: 'openOcean',
    edges: ['OC', 'OC', 'OC', 'OC', 'OC', 'OC'],
    dockEdges: [], crane: false, flag: null, seed: 0, rotation: 0,
  };

  const tiles = new Map(); // "q,r" -> THREE.Group
  const effects = createEffects({ scene, game, tiles, sun, hemi, groundMat });

  const focus = new THREE.Vector3(0, 0, 0);
  let zoom = ZOOM_START;
  let targetZoom = ZOOM_START;
  let bounds = null; // bbox of placed tiles in world units
  const followTarget = new THREE.Vector3(0, 0, 0);
  let panIdle = FOLLOW_RESUME + 1; // start in follow mode
  let autoZoomPaused = false; // manual wheel pauses refit until next placement
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

  // --- board tracking: bbox bounds, follow target, frontier hints ---

  function updateFrontier() {
    const want = new Set();
    for (const k of tiles.keys()) {
      const { q, r } = parseKey(k);
      for (const n of neighbors(q, r)) {
        const nk = key(n.q, n.r);
        if (!tiles.has(nk)) want.add(nk);
      }
    }
    for (const [k, m] of hints) {
      if (!want.has(k)) {
        hintGroup.remove(m);
        hints.delete(k);
      }
    }
    for (const k of want) {
      if (hints.has(k)) continue;
      const { q, r } = parseKey(k);
      const m = new THREE.Mesh(hintGeo, hintMat);
      const p = cellToWorld(q, r);
      m.position.set(p.x, GROUND_Y + 0.012, p.z);
      hintGroup.add(m);
      hints.set(k, m);
    }
    updatePerfectSpots();
  }

  // Gold rings on near-complete rings (replaces the tan hint on those cells,
  // so the frontier system never doubles up). Cheap: a handful of cells x6
  // core canPlace calls, run only when board or hand changes.
  function updatePerfectSpots() {
    const want = new Map(); // "q,r" -> hot
    if (!game.over) {
      const counts = new Map();
      for (const k of game.board.keys()) {
        const { q, r } = parseKey(k);
        for (const n of neighbors(q, r)) {
          const nk = key(n.q, n.r);
          if (!game.board.has(nk)) counts.set(nk, (counts.get(nk) || 0) + 1);
        }
      }
      for (const [k, count] of counts) {
        if (count < 5) continue;
        let hot = false;
        const hand = game.currentTile;
        if (hand) {
          const { q, r } = parseKey(k);
          for (let rot = 0; rot < 6 && !hot; rot++) {
            const t = rot === 0 ? hand : rotateTile(hand, rot);
            hot = canPlace(game.board, t, q, r, game.config).legal;
          }
        }
        want.set(k, hot);
      }
    }
    for (const [k, s] of perfectSpots) {
      if (want.has(k)) continue;
      hintGroup.remove(s.mesh);
      perfectSpots.delete(k);
      const h = hints.get(k);
      if (h) h.visible = true;
    }
    for (const [k, hot] of want) {
      let s = perfectSpots.get(k);
      if (!s) {
        const { q, r } = parseKey(k);
        const m = new THREE.Mesh(hintGeo, spotSoftMat);
        const p = cellToWorld(q, r);
        // float at the hole's rim (just above tile tops) so the invitation
        // is never occluded by the very neighbors that formed the ring
        m.position.set(p.x, 0.19, p.z);
        hintGroup.add(m);
        s = { mesh: m, hot: false };
        perfectSpots.set(k, s);
      }
      s.hot = hot;
      s.mesh.material = hot ? spotHotMat : spotSoftMat;
      const h = hints.get(k);
      if (h) h.visible = false; // gold ring stands in for the tan hint here
    }
  }

  // --- dock teaching hint (buoy breadcrumbs) ---

  // BFS outward from each dock edge, 2-3 cells: through already-open water
  // (placed OC/LA tiles) and empty cells that can still legally become open
  // water (the OC probe — a soft edge facing the cell fails it, which IS the
  // lesson). Cells with no placed neighbor yet count as open sea, so the
  // breadcrumb fans 2-3 cells out even from a brand-new coast.
  function waterReach(q0, r0, tile, maxDepth = 3) {
    const out = [];
    const seen = new Set([key(q0, r0)]);
    let layer = (tile.dockEdges || []).map((dir) => neighbor(q0, r0, dir));
    for (let depth = 1; depth <= maxDepth && layer.length; depth++) {
      const next = [];
      for (const cell of layer) {
        const k = key(cell.q, cell.r);
        if (seen.has(k)) continue;
        seen.add(k);
        const placed = game.board.get(k);
        if (placed) {
          // sail straight through existing open water, no breadcrumb needed
          if (!placed.edges.some((e) => e === 'OC' || e === 'LA')) continue;
        } else {
          const check = canPlace(game.board, OC_PROBE, cell.q, cell.r, game.config);
          // only edge conflicts brick a cell; mere distance from the board
          // ("not adjacent...") is still future open water
          if (check.reasons.some((why) => !why.startsWith('not adjacent'))) continue;
          out.push({ q: cell.q, r: cell.r, depth });
        }
        for (const n of neighbors(cell.q, cell.r)) next.push(n);
      }
      layer = next;
    }
    return out;
  }

  function clearDockHint(onlyGhost = false) {
    if (!dockHint || (onlyGhost && !dockHint.fromGhost)) return;
    for (const it of dockHint.items) {
      dockGroup.remove(it.mesh);
      for (const m of it.mats) m.dispose();
    }
    dockHint = null;
  }

  function showDockHint(q, r, tile, { ttl = Infinity, fromGhost = false } = {}) {
    clearDockHint();
    const cells = waterReach(q, r, tile);
    if (!cells.length) return;
    const items = [];
    for (const c of cells) {
      const p = cellToWorld(c.q, c.r);
      const fade = Math.max(0.35, 1 - (c.depth - 1) * 0.28); // faint with distance
      const bodyMat = new THREE.MeshBasicMaterial({
        color: 0xf5f0e8, transparent: true, opacity: 0.8 * fade, depthWrite: false,
      });
      const capMat = new THREE.MeshBasicMaterial({
        color: 0xe74c3c, transparent: true, opacity: 0.8 * fade, depthWrite: false,
      });
      const g = new THREE.Group();
      const body = new THREE.Mesh(buoyGeo, bodyMat);
      const cap = new THREE.Mesh(buoyCapGeo, capMat);
      cap.position.y = 0.1;
      g.add(body, cap);
      const baseY = 0.12;
      g.position.set(p.x, baseY, p.z);
      dockGroup.add(g);
      items.push({ mesh: g, baseY, phase: ((c.q * 7 + c.r * 13) % 6 + 6) % 6, mats: [bodyMat, capMat] });
    }
    dockHint = { items, expiresAt: ttl === Infinity ? Infinity : time + ttl, fromGhost };
  }

  function boardChanged() {
    if (tiles.size) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const g of tiles.values()) {
        minX = Math.min(minX, g.position.x);
        maxX = Math.max(maxX, g.position.x);
        minZ = Math.min(minZ, g.position.z);
        maxZ = Math.max(maxZ, g.position.z);
      }
      bounds = { minX, maxX, minZ, maxZ };
      followTarget.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    } else {
      bounds = null;
      followTarget.set(0, 0, 0);
    }
    autoZoomPaused = false; // every placement re-allows the gentle zoom refit
    updateFrontier();
  }

  // generous pan clamp: board bbox + margin that scales with zoom
  function clampFocus() {
    const m = 9 + zoom * 0.6;
    const b = bounds || { minX: -6, maxX: 6, minZ: -6, maxZ: 6 };
    focus.x = Math.max(b.minX - m, Math.min(b.maxX + m, focus.x));
    focus.z = Math.max(b.minZ - m, Math.min(b.maxZ + m, focus.z));
  }

  // --- tile visuals ---

  function addTileVisual(tile, q, r) {
    const group = buildTileMesh(tile);
    const p = cellToWorld(q, r);
    group.position.set(p.x, 0, p.z);
    scene.add(group);
    tiles.set(key(q, r), group);
    boardChanged();
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
    clearDockHint(); // a timed hint must not outlive an undone harbor
    for (const g of tiles.values()) scene.remove(g);
    tiles.clear();
    for (const [k, tile] of game.board) {
      const { q, r } = parseKey(k);
      addTileVisual(tile, q, r);
    }
    boardChanged(); // covers the rebuild-to-empty case (addTileVisual not hit)
    effects.syncBoardState();
  }

  // --- ghost tile with per-edge legality colors (DESIGN §3.3) ---

  function clearGhost() {
    clearDockHint(true); // ghost-sourced dock hints live and die with the ghost
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
    // hovering a Harbor: show where lanes could still reach this dock
    if (tile.dockEdges && tile.dockEdges.length) {
      showDockHint(q, r, tile, { fromGhost: true });
    }
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
      panIdle = 0; // never yank the camera during a player pan
      clampFocus();
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
    autoZoomPaused = true; // respect manual zoom until the next placement
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
    const arrowPanning =
      keysDown.ArrowUp || keysDown.ArrowDown || keysDown.ArrowLeft || keysDown.ArrowRight;
    if (keysDown.ArrowUp) focus.z -= pan;
    if (keysDown.ArrowDown) focus.z += pan;
    if (keysDown.ArrowLeft) focus.x -= pan;
    if (keysDown.ArrowRight) focus.x += pan;
    if (arrowPanning || dragging) {
      panIdle = 0;
      clampFocus();
    } else {
      panIdle += d;
    }

    // gentle centroid-follow: once the player is hands-off, ease the camera
    // toward the board's bbox center and (after placements) zoom out to fit
    if (!flight && bounds && panIdle >= FOLLOW_RESUME) {
      const ease = Math.min(1, d * 1.6);
      focus.x += (followTarget.x - focus.x) * ease;
      // small south bias lifts the board toward the visual center (the tilted
      // camera otherwise leaves extra headroom above the board)
      focus.z += (followTarget.z + zoom * 0.04 - focus.z) * ease;
      if (!autoZoomPaused) {
        const sx = (bounds.maxX - bounds.minX) / 2 + 2.6;
        const sz = (bounds.maxZ - bounds.minZ) / 2 + 2.6;
        const fit = Math.max(ZOOM_START,
          1.12 * Math.max(sx / (0.5 * camera.aspect), sz / 0.49));
        if (fit > targetZoom) {
          targetZoom = Math.min(ZOOM_MAX,
            targetZoom + (fit - targetZoom) * Math.min(1, d * 1.4));
        }
      }
    }

    zoom += (targetZoom - zoom) * Math.min(1, d * 8);

    hintMat.opacity = 0.24 + 0.07 * Math.sin(time * 1.6); // soft frontier pulse
    // perfect-spot shimmer: gentle gold for forming rings, a stronger beat
    // (opacity + slight breathing scale) when the tile in hand fits
    spotSoftMat.opacity = 0.26 + 0.1 * Math.sin(time * 2.1);
    spotHotMat.opacity = 0.52 + 0.26 * Math.sin(time * 3.4);
    if (perfectSpots.size) {
      const sc = 1 + 0.045 * Math.sin(time * 3.4);
      for (const s of perfectSpots.values()) s.mesh.scale.setScalar(s.hot ? sc : 1);
    }
    // dock breadcrumbs bob like real buoys; timed hints expire here
    if (dockHint) {
      if (time >= dockHint.expiresAt) {
        clearDockHint();
      } else {
        for (const it of dockHint.items) {
          it.mesh.position.y = it.baseY + Math.sin(time * 2.2 + it.phase) * 0.035;
        }
      }
    }

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
          // a freshly landed Harbor teaches its sea path for a few seconds
          const landedTile = drop.result && drop.result.tile;
          if (landedTile && landedTile.dockEdges && landedTile.dockEdges.length) {
            showDockHint(drop.q, drop.r, landedTile, { ttl: 4 });
          }
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
    clearDockHint();
    scene.remove(dockGroup);
    groundMat.map.dispose();
    groundMat.dispose();
    hintGeo.dispose();
    hintMat.dispose();
    spotSoftMat.dispose();
    spotHotMat.dispose();
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
    refreshPerfectSpots: updatePerfectSpots, // call on draw/rotate (hand changed)
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
