// Effects layer: vehicles (trains/boats/ships — GL1 VehicleSystem ported to
// module form), water animation, snowcaps + eagle, the closed juice list items
// 2–4 from DESIGN §9 (source-to-sea tally ride, ship spawn + horn event,
// snowcap swaps), stage-transition stings, and placement particles.
// Everything is driven by update(dt); no timers anywhere.
// Created by scene.init(); not normally constructed directly.

import * as THREE from 'three';
import { key, parseKey, neighbor, neighbors, opposite, toWorld } from '../core/hex.js';
import { groups, traceNetworks } from '../core/board.js';
import {
  animateWater, setSnowcap, setWindowGlow, edgeAngle, HEX_SIZE, PALETTE,
} from './tilemesh.js';

const particleGeo = new THREE.SphereGeometry(0.045, 4, 4);
const puffGeo = new THREE.SphereGeometry(1, 6, 6);
const fireflyGeo = new THREE.SphereGeometry(0.03, 4, 4);

const shipLanternMat = new THREE.MeshStandardMaterial({
  color: 0x664422, emissive: 0xffc46b, emissiveIntensity: 0,
});

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function std(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, ...opts });
}

// ctx: { scene, game, tiles (Map "q,r" -> THREE.Group), sun, hemi }
export function createEffects(ctx) {
  const { scene, game, tiles } = ctx;
  const W = (q, r) => {
    const p = toWorld(q, r, HEX_SIZE);
    return new THREE.Vector3(p.x, 0, p.z);
  };
  const board = () => game.board;
  const cfgStructures = () => game?.config?.scoring?.structures || {};
  const shipCap = () => cfgStructures().tradeRoute?.shipRenderCap ?? 8;

  const vehicleGroup = new THREE.Group();
  const fxGroup = new THREE.Group();
  scene.add(vehicleGroup, fxGroup);

  const listeners = new Set();
  const vehicles = [];
  const puffs = [];
  const particles = [];
  const tweens = [];
  const rides = [];
  const eagles = [];
  const fireflies = [];
  let time = 0;

  function emit(ev) {
    for (const cb of [...listeners]) cb(ev);
  }

  function onEvent(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  // --- tweens (used by stage stings / sunset) ---

  function tween(dur, apply, onDone) {
    tweens.push({ t: 0, dur, apply, onDone });
  }

  function tweenColor(color, toHex, dur) {
    const from = color.clone();
    const to = new THREE.Color(toHex);
    tween(dur, (k) => color.copy(from).lerp(to, k));
  }

  function tweenNum(obj, prop, to, dur, onDone) {
    const from = obj[prop];
    tween(dur, (k) => { obj[prop] = from + (to - from) * k; }, onDone);
  }

  // --- particles (GL1 spawnBurst port) ---

  function burst(x, y, z, color, count, opts = {}) {
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(particleGeo,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 }));
      m.position.set(x, y, z);
      const a = Math.random() * Math.PI * 2;
      const sp = (opts.speed || 1.5) * (0.4 + Math.random() * 0.6);
      particles.push({
        mesh: m,
        vel: new THREE.Vector3(Math.cos(a) * sp, (opts.up || 1.8) * (0.5 + Math.random() * 0.8), Math.sin(a) * sp),
        life: 0,
        max: opts.lifetime || 0.9,
        gravity: opts.gravity ?? 4.5,
      });
      fxGroup.add(m);
    }
  }

  function placementBurst(q, r, { color = 0xa1887f, count = 10 } = {}) {
    const p = W(q, r);
    burst(p.x, 0.15, p.z, color, count, { speed: 2.2, up: 1.2, lifetime: 0.6 });
  }

  function edgeBurst(q, r, dir, color, count = 12) {
    const p = W(q, r);
    const a = edgeAngle(dir);
    burst(p.x + Math.cos(a) * 0.85, 0.3, p.z + Math.sin(a) * 0.85, color, count,
      { speed: 1.6, up: 1.8, lifetime: 0.9 });
  }

  // --- vehicles (port of GL1 VehicleSystem) ---

  function traceLinearPath(startKey, terrain, visited) {
    const path = [startKey];
    visited.add(startKey);
    const grow = (curr) => {
      const { q, r } = parseKey(curr);
      const tile = board().get(curr);
      for (let i = 0; i < 6; i++) {
        if (tile.edges[i] !== terrain) continue;
        const n = neighbor(q, r, i);
        const nk = key(n.q, n.r);
        if (visited.has(nk)) continue;
        const nt = board().get(nk);
        if (nt && nt.edges[opposite(i)] === terrain) {
          visited.add(nk);
          return nk;
        }
      }
      return null;
    };
    let next;
    while ((next = grow(path[path.length - 1]))) path.push(next);
    while ((next = grow(path[0]))) path.unshift(next);
    return path;
  }

  function createTrainMesh() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 0.5), std(0xc0392b));
    body.position.y = 0.2;
    g.add(body);
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.3), std(0x2c3e50));
    stack.position.set(0, 0.35, -0.15);
    g.add(stack);
    const wheelGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.3, 8);
    const wheelMat = std(0x111111);
    for (const pz of [-0.15, 0.15]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.rotation.z = Math.PI / 2;
      w.position.set(0, 0.1, pz);
      g.add(w);
    }
    return g;
  }

  function createBoatMesh() {
    const g = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.15, 0.45), std(0xffffff));
    hull.position.y = 0.1;
    g.add(hull);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.2), std(0x3498db));
    cabin.position.set(0, 0.25, -0.05);
    g.add(cabin);
    return g;
  }

  function createShipMesh() {
    const g = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.62), std(0x7a4a2f));
    hull.position.y = 0.12;
    g.add(hull);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.4), std(PALETTE.buoyCream));
    deck.position.y = 0.22;
    g.add(deck);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 5), std(0x4a3a2a));
    mast.position.set(0, 0.45, 0.05);
    g.add(mast);
    const sailShape = new THREE.Shape();
    sailShape.moveTo(0, 0);
    sailShape.lineTo(0.26, 0);
    sailShape.quadraticCurveTo(0.2, 0.2, 0, 0.38);
    sailShape.lineTo(0, 0);
    const sail = new THREE.Mesh(new THREE.ShapeGeometry(sailShape),
      std(0xf5f0e8, { side: THREE.DoubleSide }));
    sail.rotation.y = Math.PI / 2;
    sail.position.set(0, 0.28, 0.04);
    g.add(sail);
    const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.03, 5, 5), shipLanternMat);
    lantern.position.set(0, 0.3, -0.28);
    g.add(lantern);
    return g;
  }

  function createVehicle(points, type) {
    if (points.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(points);
    const mesh = type === 'train' ? createTrainMesh() : type === 'boat' ? createBoatMesh() : createShipMesh();
    vehicleGroup.add(mesh);
    vehicles.push({
      type, mesh, curve,
      alpha: Math.random() * 0.5, direction: 1,
      speed: (type === 'ship' ? 0.07 : 0.1) / points.length,
      bobOffset: Math.random() * 10,
      smokeT: 0,
    });
  }

  function spawnVehicleType(terrain, typeName, minLen) {
    const visited = new Set();
    for (const [k, tile] of board()) {
      if (visited.has(k) || !tile.edges.includes(terrain)) continue;
      const path = traceLinearPath(k, terrain, visited);
      if (path.length >= minLen) {
        createVehicle(path.map((pk) => {
          const { q, r } = parseKey(pk);
          return W(q, r);
        }), typeName);
      }
    }
  }

  // Ordered dock-to-dock point path through a completed lane route.
  function laneRoutePathPoints(net) {
    const ends = [];
    for (const k of net.keys) {
      const { q, r } = parseKey(k);
      const t = board().get(k);
      for (let dir = 0; dir < 6; dir++) {
        if (t.edges[dir] !== 'LA') continue;
        const n = neighbor(q, r, dir);
        const nt = board().get(key(n.q, n.r));
        if (nt && nt.edges[opposite(dir)] === 'OC' && nt.dockEdges.includes(opposite(dir))) {
          ends.push({ k, dir });
        }
      }
    }
    if (!ends.length) return [];
    const adj = (k) => {
      const { q, r } = parseKey(k);
      const t = board().get(k);
      const out = [];
      for (let dir = 0; dir < 6; dir++) {
        if (t.edges[dir] !== 'LA') continue;
        const n = neighbor(q, r, dir);
        const nk = key(n.q, n.r);
        if (net.keys.has(nk) && board().get(nk).edges[opposite(dir)] === 'LA') out.push(nk);
      }
      return out;
    };
    const start = ends[0];
    const parent = new Map([[start.k, null]]);
    const order = [start.k];
    for (let i = 0; i < order.length; i++) {
      for (const nk of adj(order[i])) {
        if (!parent.has(nk)) {
          parent.set(nk, order[i]);
          order.push(nk);
        }
      }
    }
    let goal = ends.find((e) => e !== start && parent.has(e.k)) || start;
    for (let i = order.length - 1; i >= 0; i--) { // prefer the farthest dock end
      const e = ends.find((e2) => e2.k === order[i] && e2 !== start);
      if (e) { goal = e; break; }
    }
    const keyPath = [];
    for (let k = goal.k; k !== null; k = parent.get(k)) keyPath.unshift(k);
    const pts = keyPath.map((pk) => {
      const { q, r } = parseKey(pk);
      return W(q, r);
    });
    const approach = (end, point, prepend) => {
      const { q, r } = parseKey(end.k);
      const n = neighbor(q, r, end.dir);
      const p = point.clone().lerp(W(n.q, n.r), 0.45);
      if (prepend) pts.unshift(p); else pts.push(p);
    };
    approach(start, pts[0], true);
    if (goal !== start) approach(goal, pts[pts.length - 1], false);
    return pts;
  }

  // Rebuild all vehicles from the board: trains on rails, boats on rivers,
  // ships sail completed lane routes forever (render cap, DESIGN §5.6).
  function refreshVehicles() {
    vehicleGroup.clear();
    vehicles.length = 0;
    spawnVehicleType('RA', 'train', 3);
    spawnVehicleType('RI', 'boat', 3);
    let ships = 0;
    for (const net of traceNetworks(board(), 'LA')) {
      if (!net.completed || ships >= shipCap()) continue;
      const pts = laneRoutePathPoints(net);
      if (pts.length >= 2) {
        createVehicle(pts, 'ship');
        ships++;
      }
    }
  }

  function updateVehicles(dt) {
    for (const v of vehicles) {
      v.alpha += v.speed * v.direction * dt * 2.0;
      if (v.alpha >= 1) { v.alpha = 1; v.direction = -1; }
      if (v.alpha <= 0) { v.alpha = 0; v.direction = 1; }
      const pos = v.curve.getPointAt(v.alpha);
      const tangent = v.curve.getTangentAt(v.alpha);
      v.mesh.position.x = pos.x;
      v.mesh.position.z = pos.z;
      v.mesh.position.y = v.type === 'train'
        ? 0.2
        : 0.1 + Math.sin(time * 2 + v.bobOffset) * 0.02;
      const look = pos.clone();
      if (v.direction === 1) look.add(tangent); else look.sub(tangent);
      v.mesh.lookAt(look.x, v.mesh.position.y, look.z);
      if (v.type === 'train') {
        v.smokeT += dt;
        if (v.smokeT > 0.45) {
          v.smokeT = 0;
          const m = new THREE.Mesh(puffGeo,
            new THREE.MeshBasicMaterial({ color: 0xd7dde2, transparent: true, opacity: 0.4 }));
          m.scale.setScalar(0.06);
          m.position.set(v.mesh.position.x, 0.65, v.mesh.position.z);
          fxGroup.add(m);
          puffs.push({ mesh: m, life: 0 });
        }
      }
    }
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i];
      p.life += dt;
      p.mesh.position.y += dt * 0.55;
      p.mesh.scale.setScalar(0.06 + p.life * 0.16);
      p.mesh.material.opacity = Math.max(0, 0.4 * (1 - p.life / 1.3));
      if (p.life >= 1.3) {
        fxGroup.remove(p.mesh);
        p.mesh.material.dispose();
        puffs.splice(i, 1);
      }
    }
  }

  // --- source-to-sea tally ride (DESIGN §9 item 2) ---

  // Ordered source->mouth path through the completed river network touching
  // (q, r); the placement that completed the river may itself be the capping
  // mountain/ocean tile, so neighbors count too.
  function riverPathPoints(q, r) {
    const k0 = key(q, r);
    const near = new Set([k0, ...neighbors(q, r).map((n) => key(n.q, n.r))]);
    const nets = traceNetworks(board(), 'RI').filter((n) => n.completed);
    const net = nets.find((n) => [...near].some((k) => n.keys.has(k)));
    if (!net) return [];
    const endsOf = (facing) => {
      const out = [];
      for (const k of net.keys) {
        const { q: tq, r: tr } = parseKey(k);
        const t = board().get(k);
        for (let dir = 0; dir < 6; dir++) {
          if (t.edges[dir] !== 'RI') continue;
          const n = neighbor(tq, tr, dir);
          const nt = board().get(key(n.q, n.r));
          if (nt && nt.edges[opposite(dir)] === facing) out.push({ k, dir });
        }
      }
      return out;
    };
    const sources = endsOf('MT');
    const mouths = endsOf('OC');
    if (!sources.length || !mouths.length) return [];
    const start = sources[0];
    const parent = new Map([[start.k, null]]);
    const order = [start.k];
    for (let i = 0; i < order.length; i++) {
      const { q: cq, r: cr } = parseKey(order[i]);
      const t = board().get(order[i]);
      for (let dir = 0; dir < 6; dir++) {
        if (t.edges[dir] !== 'RI') continue;
        const n = neighbor(cq, cr, dir);
        const nk = key(n.q, n.r);
        if (net.keys.has(nk) && !parent.has(nk) &&
            board().get(nk).edges[opposite(dir)] === 'RI') {
          parent.set(nk, order[i]);
          order.push(nk);
        }
      }
    }
    const mouth = mouths.find((m) => parent.has(m.k));
    if (!mouth) return [];
    const keyPath = [];
    for (let k = mouth.k; k !== null; k = parent.get(k)) keyPath.unshift(k);
    const pts = keyPath.map((pk) => {
      const { q: pq, r: pr } = parseKey(pk);
      return W(pq, pr);
    });
    const cap = (end, point, prepend) => {
      const { q: eq, r: er } = parseKey(end.k);
      const n = neighbor(eq, er, end.dir);
      const p = point.clone().lerp(W(n.q, n.r), 0.45);
      if (prepend) pts.unshift(p); else pts.push(p);
    };
    cap(start, pts[0], true);
    cap(mouth, pts[pts.length - 1], false);
    return pts;
  }

  function startTallyRide(points, scorePoints) {
    if (points.length < 2) return;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.95 }));
    fxGroup.add(head);
    rides.push({
      curve: new THREE.CatmullRomCurve3(points),
      t: 0,
      dur: Math.max(2.2, points.length * 0.4),
      head,
      points: scorePoints,
      trailT: 0,
    });
    const p0 = points[0];
    emit({ type: 'tallyRide', phase: 'start', x: p0.x, y: 0.5, z: p0.z, points: scorePoints });
  }

  function updateRides(dt) {
    for (let i = rides.length - 1; i >= 0; i--) {
      const ride = rides[i];
      ride.t += dt / ride.dur;
      const k = easeInOut(Math.min(ride.t, 1));
      const pos = ride.curve.getPointAt(k);
      ride.head.position.set(pos.x, 0.45 + Math.sin(time * 6) * 0.04, pos.z);
      ride.trailT += dt;
      if (ride.trailT > 0.05) {
        ride.trailT = 0;
        burst(pos.x, 0.4, pos.z, 0xbfeeff, 1, { speed: 0.3, up: 0.4, lifetime: 0.5, gravity: 0.4 });
      }
      emit({ type: 'tallyRide', phase: 'move', x: pos.x, y: 0.5, z: pos.z, t: k, points: ride.points });
      if (ride.t >= 1) {
        burst(pos.x, 0.4, pos.z, 0x66c6e8, 18, { speed: 2.2, up: 2.2, lifetime: 1.0, gravity: 2.5 });
        emit({ type: 'tallyRide', phase: 'end', x: pos.x, y: 0.5, z: pos.z, points: ride.points });
        fxGroup.remove(ride.head);
        ride.head.material.dispose();
        rides.splice(i, 1);
      }
    }
  }

  // --- snowcaps + eagle (DESIGN §9 item 4) ---

  function popSnowcaps(group, crowned) {
    setSnowcap(group, true, { crowned });
    for (const cap of group.userData.snowcaps || []) {
      const target = cap.scale.clone();
      cap.scale.setScalar(0.01);
      tween(0.5, (k) => cap.scale.copy(target).multiplyScalar(0.01 + 0.99 * k));
    }
  }

  function snowlineSweep() {
    const min = cfgStructures().snowline?.groupSize ?? 5;
    for (const g of groups(board(), 'MT')) {
      if (g.size < min) continue;
      for (const k of g) {
        const group = tiles.get(k);
        if (group && !group.userData.snowOn) popSnowcaps(group, false);
      }
    }
  }

  function spawnEagle(center) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.16, 4), std(0x3a3230));
    body.rotation.x = Math.PI / 2;
    g.add(body);
    const wingGeo = new THREE.BoxGeometry(0.22, 0.008, 0.06);
    const wingMat = std(0x4a403c);
    const wl = new THREE.Mesh(wingGeo, wingMat);
    wl.position.x = -0.12;
    const wr = new THREE.Mesh(wingGeo, wingMat);
    wr.position.x = 0.12;
    g.add(wl, wr);
    fxGroup.add(g);
    eagles.push({ g, wl, wr, center: center.clone(), a: Math.random() * Math.PI * 2, t: 0, dur: 8 });
  }

  function updateEagles(dt) {
    for (let i = eagles.length - 1; i >= 0; i--) {
      const e = eagles[i];
      e.t += dt;
      e.a += dt * 1.3;
      const radius = 1.25;
      const x = e.center.x + Math.cos(e.a) * radius;
      const z = e.center.z + Math.sin(e.a) * radius;
      const y = e.center.y + 1.9 + Math.sin(e.t * 0.8) * 0.15;
      e.g.position.set(x, y, z);
      e.g.lookAt(e.center.x + Math.cos(e.a + 0.2) * radius, y, e.center.z + Math.sin(e.a + 0.2) * radius);
      const flap = Math.sin(e.t * 9) * 0.45;
      e.wl.rotation.z = flap;
      e.wr.rotation.z = -flap;
      if (e.t >= e.dur) {
        fxGroup.remove(e.g);
        eagles.splice(i, 1);
      }
    }
  }

  // --- celebrations (closed juice list, DESIGN §9) ---

  // networkEvent: an entry from PlacementResult.networkEvents.
  // data: { q, r } of the placement that fired it.
  function celebrate(networkEvent, data = {}) {
    const { q, r } = data;
    const at = q !== undefined ? W(q, r) : new THREE.Vector3();
    switch (networkEvent.type) {
      case 'riverCompleted':
        startTallyRide(riverPathPoints(q, r), networkEvent.points);
        break;
      case 'laneCompleted': {
        burst(at.x, 0.4, at.z, 0xf6c344, 16, { speed: 2.2, up: 2.2, lifetime: 1.0, gravity: 2.5 });
        emit({ type: 'shipHorn', event: 'laneCompleted' });
        break;
      }
      case 'tradeRoute': {
        for (const hk of (networkEvent.pair || '').split('|')) {
          if (!hk) continue;
          const { q: hq, r: hr } = parseKey(hk);
          const p = W(hq, hr);
          burst(p.x, 0.5, p.z, 0xffd700, 22, { speed: 2.6, up: 2.6, lifetime: 1.2, gravity: 2.5 });
        }
        emit({ type: 'shipHorn', event: 'tradeRoute' });
        break;
      }
      case 'peakCrowned': {
        const group = tiles.get(networkEvent.key);
        if (group) {
          popSnowcaps(group, true);
          spawnEagle(group.position.clone().setY(1.2));
          burst(group.position.x, 1.4, group.position.z, 0xf4f7f9, 20,
            { speed: 1.8, up: 2.0, lifetime: 1.1, gravity: 2.0 });
        }
        break;
      }
      case 'snowline':
        snowlineSweep();
        break;
      case 'spring':
        edgeBurst(q, r, networkEvent.dir, 0x9fd8ff);
        break;
      case 'estuary':
        edgeBurst(q, r, networkEvent.dir, 0x66c6e8);
        break;
      case 'portCall':
        edgeBurst(q, r, networkEvent.dir, 0xf6c344);
        break;
      case 'cliff':
        edgeBurst(q, r, networkEvent.dir, 0xbfb8ae);
        break;
      default:
        burst(at.x, 0.4, at.z, 0xf1c40f, 12, { speed: 2.0, up: 2.0, lifetime: 0.9, gravity: 2.5 });
    }
    emit({ type: 'celebrate', event: networkEvent.type, networkEvent, q, r });
  }

  // --- stage stings (DESIGN §9 item 5) ---

  function stageSting(stage) {
    if (stage === 'highlands') {
      // horn-call is audio's job (event below); visually a brief sun swell
      tweenNum(ctx.sun, 'intensity', ctx.sun.intensity + 0.35, 0.5, () =>
        tweenNum(ctx.sun, 'intensity', 1.25, 1.2));
    } else if (stage === 'tide') {
      // "The Tide Comes In": horizon gains sea haze
      if (scene.fog) tweenColor(scene.fog.color, 0xcfdfe6, 3);
      if (scene.background?.isColor) tweenColor(scene.background, 0xd9e6ea, 3);
      tweenColor(ctx.hemi.color, 0xeaf2f5, 3);
      if (ctx.groundMat) tweenColor(ctx.groundMat.color, 0xf2ecdd, 3);
    } else if (stage === 'voyage') {
      if (scene.fog) tweenColor(scene.fog.color, 0xc6dbe4, 3);
    } else if (stage === 'finale') {
      tweenColor(ctx.sun.color, 0xffc489, 2);
      tweenNum(ctx.sun, 'intensity', 1.35, 2);
    }
    emit({ type: 'sting', stage });
  }

  // Curtain call: the golden-hour sun finally sets; fireflies rise, ship
  // lanterns and house windows light (DESIGN §7.3).
  function sunset() {
    tweenColor(ctx.sun.color, 0xff9a5e, 4);
    tweenNum(ctx.sun, 'intensity', 0.55, 4);
    tweenNum(ctx.hemi, 'intensity', 0.35, 4);
    if (scene.fog) tweenColor(scene.fog.color, 0xe2b48e, 4);
    if (scene.background?.isColor) tweenColor(scene.background, 0xdba87e, 4);
    if (ctx.groundMat) tweenColor(ctx.groundMat.color, 0xe7bf95, 4);
    setWindowGlow(1.3);
    tweenNum(shipLanternMat, 'emissiveIntensity', 1.6, 4);
    let minX = -3, maxX = 3, minZ = -3, maxZ = 3;
    for (const g of tiles.values()) {
      minX = Math.min(minX, g.position.x); maxX = Math.max(maxX, g.position.x);
      minZ = Math.min(minZ, g.position.z); maxZ = Math.max(maxZ, g.position.z);
    }
    for (let i = 0; i < 36; i++) {
      const m = new THREE.Mesh(fireflyGeo,
        new THREE.MeshBasicMaterial({ color: 0xffe89a, transparent: true, opacity: 0.9 }));
      const base = new THREE.Vector3(
        minX + Math.random() * (maxX - minX),
        0.5 + Math.random() * 1.2,
        minZ + Math.random() * (maxZ - minZ));
      m.position.copy(base);
      fxGroup.add(m);
      fireflies.push({ mesh: m, base, phase: Math.random() * 10 });
    }
    emit({ type: 'sunset' });
  }

  // --- per-placement hook: scene.placeTileVisual() calls this after the
  // drop-bounce lands, so all juice fires in one place.
  function processResult(result) {
    for (const e of result.networkEvents || []) celebrate(e, { q: result.q, r: result.r });
    for (const e of result.events || []) {
      if (e.type === 'stage') stageSting(e.stage);
      else if (e.type === 'finale') stageSting('finale');
      else if (e.type === 'windsShift') emit({ type: 'windsShift' });
      else if (e.type === 'gameOver') emit({ type: 'gameOver', deadBoard: e.deadBoard });
    }
    refreshVehicles();
  }

  // Re-apply persistent visual state (snow) after a rebuild/undo.
  function syncBoardState() {
    snowlineSweep();
    const crowned = game?.ctx?.crownedPeaks;
    if (crowned) {
      for (const k of crowned) {
        const group = tiles.get(k);
        if (group) setSnowcap(group, true, { crowned: true });
      }
    }
    refreshVehicles();
  }

  function update(dt) {
    time += dt;
    animateWater(time);
    for (const g of tiles.values()) {
      for (const b of g.userData.bobbers || []) {
        b.mesh.position.y = b.baseY + Math.sin(time * 2 + b.phase) * b.amp;
      }
    }
    updateVehicles(dt);
    updateRides(dt);
    updateEagles(dt);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      p.vel.y -= p.gravity * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.material.opacity = Math.max(0, 1 - p.life / p.max);
      if (p.life >= p.max || p.mesh.position.y < -0.5) {
        fxGroup.remove(p.mesh);
        p.mesh.material.dispose();
        particles.splice(i, 1);
      }
    }
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      tw.t += dt;
      const k = Math.min(tw.t / tw.dur, 1);
      tw.apply(easeInOut(k));
      if (k >= 1) {
        tweens.splice(i, 1);
        if (tw.onDone) tw.onDone();
      }
    }
    for (const f of fireflies) {
      f.mesh.position.set(
        f.base.x + Math.sin(time * 0.6 + f.phase) * 0.4,
        f.base.y + Math.sin(time * 0.9 + f.phase * 2) * 0.25,
        f.base.z + Math.cos(time * 0.5 + f.phase) * 0.4);
      f.mesh.material.opacity = 0.5 + 0.5 * Math.sin(time * 3 + f.phase * 3);
    }
  }

  function dispose() {
    scene.remove(vehicleGroup, fxGroup);
    listeners.clear();
    vehicles.length = 0;
    particles.length = 0;
    tweens.length = 0;
    rides.length = 0;
    eagles.length = 0;
    fireflies.length = 0;
    puffs.length = 0;
  }

  return {
    update, celebrate, stageSting, sunset, processResult, syncBoardState,
    refreshVehicles, placementBurst, burst, onEvent, emit, dispose,
  };
}
