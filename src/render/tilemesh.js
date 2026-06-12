// Tile mesh builder: hex prism base + per-edge terrain wedges + seeded
// procedural props per archetype (DESIGN §9, SPEC "Visual bar"). Pointy-top
// hexes; edge i sits at world angle -i*60deg, matching core/hex.js neighbors.
// 'three' resolves via the shell's import map — JSON documented in scene.js.

import * as THREE from 'three';

export const HEX_SIZE = 1;
export const HEX_HEIGHT = 0.35;
const TOP = HEX_HEIGHT / 2;
const SOFT = new Set(['GR', 'FO', 'FI', 'HO']);

// GL1 colors as the base; MT/OC/LA/beach are the Tideline additions.
export const PALETTE = {
  grass: 0x5b8930, grassVar: 0x4a7028,
  forest: 0x1e4620, forestVar: 0x3a7d44, forestFloor: 0x46702f,
  field: 0xdcb74e, fieldRow: 0xb8933a, wheat: [0xe6c15c, 0xd9b14a, 0xc99e3c],
  house: 0xc27e5e, roof: 0x8d3824, window: 0xffc46b,
  river: 0x3498db, riverBed: 0xe6d5ac,
  railSteel: 0x2c3e50, railWood: 0x5d4037, gravel: 0x7f8c8d,
  rock: 0x8d8578, scree: 0x9b9286, snow: 0xf4f7f9,
  oceanDeep: 0x2a7fb8, oceanShallow: 0x4aa3d8,
  buoyRed: 0xe74c3c, buoyCream: 0xf5f0e8,
  beach: 0xe8d8a8,
  pier: 0x8a6a48, crane: 0xc0533a, crate: 0xb08948,
  dirt: 0x5d4037,
};

export function edgeAngle(i) {
  return -i * Math.PI / 3;
}

// Render-local deterministic rng from tile.seed (core's injected rng is never
// touched by the render layer).
function makeRand(seed) {
  let t = (seed >>> 0) || 1;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// --- shared materials (cached; tile groups never own geometry/material) ---

const matCache = new Map();
function mat(color, opts = {}) {
  const k = `${color}|${opts.rough ?? 0.9}|${opts.metal ?? 0}|${opts.flat ?? true}|${opts.opacity ?? 1}|${opts.side ?? 0}`;
  if (!matCache.has(k)) {
    matCache.set(k, new THREE.MeshStandardMaterial({
      color,
      roughness: opts.rough ?? 0.9,
      metalness: opts.metal ?? 0,
      flatShading: opts.flat ?? true,
      transparent: (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
      side: opts.side ?? THREE.FrontSide,
    }));
  }
  return matCache.get(k);
}

export const windowMaterial = new THREE.MeshStandardMaterial({
  color: 0x22303c, emissive: PALETTE.window, emissiveIntensity: 0.55,
});
export function setWindowGlow(intensity) {
  windowMaterial.emissiveIntensity = intensity;
}

const waterMaterial = new THREE.MeshStandardMaterial({
  color: PALETTE.oceanShallow, roughness: 0.18, metalness: 0.05,
  flatShading: true, transparent: true, opacity: 0.92, side: THREE.DoubleSide,
});

// --- geometry: hexagon wedge slices ---

// Triangle (center, corner+30deg, corner-30deg) covering edge 0; subdivided
// n^2 for vertex animation. Lies in XZ, y = 0, normal +y-ish (DoubleSide mats).
function wedgeGeometry(radius, n) {
  const B = [Math.cos(Math.PI / 6) * radius, Math.sin(Math.PI / 6) * radius];
  const C = [Math.cos(-Math.PI / 6) * radius, Math.sin(-Math.PI / 6) * radius];
  const P = (i, j) => [B[0] * (i / n) + C[0] * (j / n), B[1] * (i / n) + C[1] * (j / n)];
  const pos = [];
  const push = (p) => pos.push(p[0], 0, p[1]);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n - i; j++) {
      push(P(i, j)); push(P(i + 1, j)); push(P(i, j + 1));
      if (i + j < n - 1) { push(P(i + 1, j)); push(P(i + 1, j + 1)); push(P(i, j + 1)); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  return geo;
}

const LAND_WEDGE = wedgeGeometry(0.952, 1);
const WATER_WEDGE = wedgeGeometry(0.95, 4);
const WATER_BASE = WATER_WEDGE.attributes.position.array.slice();

// One shared geometry animates every ocean/lane surface; the displacement is
// purely radial so wedge and tile seams stay watertight. Called by
// effects.update(dt) every frame.
export function animateWater(time) {
  const attr = WATER_WEDGE.attributes.position;
  for (let v = 0; v < attr.count; v++) {
    const x = WATER_BASE[v * 3];
    const z = WATER_BASE[v * 3 + 2];
    const d = Math.sqrt(x * x + z * z);
    attr.array[v * 3 + 1] =
      Math.sin(time * 1.8 + d * 4.0) * 0.012 +
      Math.sin(time * 2.7 + d * 9.0 + 1.7) * 0.006;
  }
  attr.needsUpdate = true;
}

const GEO = {
  base: new THREE.CylinderGeometry(HEX_SIZE * 0.95, HEX_SIZE * 0.9, HEX_HEIGHT, 6),
  skirt: new THREE.CylinderGeometry(HEX_SIZE * 0.9, HEX_SIZE * 0.7, 0.2, 6),
  trunk: new THREE.CylinderGeometry(0.04, 0.06, 0.3, 5),
  pineCrown: new THREE.ConeGeometry(0.3, 0.55, 6),
  blob: new THREE.IcosahedronGeometry(0.22, 0),
  blobSmall: new THREE.IcosahedronGeometry(0.14, 0),
  houseBody: new THREE.BoxGeometry(0.25, 0.25, 0.25),
  houseRoof: new THREE.ConeGeometry(0.22, 0.2, 4),
  chimney: new THREE.BoxGeometry(0.045, 0.12, 0.045),
  door: new THREE.PlaneGeometry(0.08, 0.15),
  win: new THREE.PlaneGeometry(0.055, 0.055),
  plot: new THREE.BoxGeometry(0.44, 0.05, 0.4),
  wheat: new THREE.CapsuleGeometry(0.02, 0.05, 2, 6),
  bale: new THREE.CylinderGeometry(0.05, 0.05, 0.08, 8),
  bed: new THREE.BoxGeometry(0.4, 0.05, 0.72),
  riverWater: new THREE.BoxGeometry(0.35, 0.08, 0.72),
  gravel: new THREE.BoxGeometry(0.3, 0.05, 0.72),
  railBar: new THREE.BoxGeometry(0.03, 0.03, 0.7),
  sleeper: new THREE.BoxGeometry(0.24, 0.02, 0.06),
  crag: new THREE.ConeGeometry(0.34, 1, 5),
  rock: new THREE.DodecahedronGeometry(0.05),
  stem: new THREE.CylinderGeometry(0.008, 0.008, 0.1, 4),
  flowerHead: new THREE.SphereGeometry(0.035, 5, 5),
  blade: new THREE.ConeGeometry(0.015, 0.14, 4),
  buoy: new THREE.ConeGeometry(0.045, 0.1, 6),
  dash: new THREE.BoxGeometry(0.05, 0.012, 0.16),
  deck: new THREE.BoxGeometry(0.22, 0.035, 0.62),
  pile: new THREE.CylinderGeometry(0.025, 0.025, 0.22, 5),
  bollard: new THREE.CylinderGeometry(0.018, 0.022, 0.07, 5),
  crate: new THREE.BoxGeometry(0.09, 0.09, 0.09),
  craneTower: new THREE.CylinderGeometry(0.035, 0.05, 0.5, 5),
  craneJib: new THREE.BoxGeometry(0.05, 0.05, 0.55),
  craneLine: new THREE.CylinderGeometry(0.006, 0.006, 0.2, 3),
  deltaDisc: new THREE.CylinderGeometry(0.16, 0.2, 0.03, 7),
  beach: new THREE.BoxGeometry(0.9, 0.035, 0.17),
  pole: new THREE.CylinderGeometry(0.018, 0.018, 0.7, 5),
  foam: new THREE.SphereGeometry(0.035, 5, 5),
};

const flagShape = new THREE.Shape();
flagShape.moveTo(0, 0);
flagShape.lineTo(0.22, -0.07);
flagShape.lineTo(0, -0.14);
flagShape.lineTo(0, 0);
GEO.pennant = new THREE.ShapeGeometry(flagShape);

// --- per-edge prop builders ---

function addWedge(group, i, material, y) {
  const m = new THREE.Mesh(LAND_WEDGE, material);
  m.rotation.y = i * Math.PI / 3;
  m.position.y = y;
  m.receiveShadow = true;
  group.add(m);
  return m;
}

function addTree(group, x, z, scale, rand) {
  const tree = new THREE.Group();
  tree.position.set(x, TOP, z);
  tree.scale.setScalar(scale);
  tree.rotation.y = rand() * Math.PI * 2;
  const trunk = new THREE.Mesh(GEO.trunk, mat(0x3e2723, { rough: 1 }));
  trunk.position.y = 0.15;
  trunk.castShadow = true;
  tree.add(trunk);
  const fCol = new THREE.Color(PALETTE.forest).lerp(new THREE.Color(PALETTE.forestVar), rand() * 0.7);
  const foliage = mat(fCol.getHex());
  if (rand() < 0.4) {
    const b1 = new THREE.Mesh(GEO.blob, foliage);
    b1.position.y = 0.42;
    b1.rotation.set(rand() * 3, rand() * 3, 0);
    b1.castShadow = true;
    tree.add(b1);
    const b2 = new THREE.Mesh(GEO.blobSmall, foliage);
    b2.position.set(0.1, 0.54, 0.05);
    b2.castShadow = true;
    tree.add(b2);
  } else {
    for (let k = 0; k < 3; k++) {
      const cone = new THREE.Mesh(GEO.pineCrown, foliage);
      cone.scale.setScalar(1 - k * 0.22);
      cone.position.y = 0.3 + k * 0.22;
      cone.castShadow = true;
      tree.add(cone);
    }
  }
  group.add(tree);
}

function addForest(group, i, rand) {
  const a = edgeAngle(i);
  const x = Math.cos(a) * 0.6;
  const z = Math.sin(a) * 0.6;
  addTree(group, x, z, 0.8 + rand() * 0.4, rand);
  const extras = 1 + Math.floor(rand() * 2);
  for (let e = 0; e < extras; e++) {
    addTree(group, x + (rand() - 0.5) * 0.45, z + (rand() - 0.5) * 0.45, 0.4 + rand() * 0.3, rand);
  }
}

function addField(group, i, rand) {
  const a = edgeAngle(i);
  const field = new THREE.Group();
  field.position.set(Math.cos(a) * 0.58, TOP, Math.sin(a) * 0.58);
  field.rotation.y = -a;
  const plot = new THREE.Mesh(GEO.plot, mat(PALETTE.fieldRow, { rough: 1 }));
  plot.position.y = 0.025;
  plot.receiveShadow = true;
  field.add(plot);
  // wheat rows: 2 parallel rows of 4 stalks
  for (let row = 0; row < 2; row++) {
    for (let j = 0; j < 4; j++) {
      const stalk = new THREE.Mesh(
        GEO.wheat, mat(PALETTE.wheat[Math.floor(rand() * 3)], { rough: 1 }));
      const sy = 0.7 + rand() * 0.4;
      stalk.scale.y = sy;
      stalk.position.set((row - 0.5) * 0.2, 0.05 + 0.04 * sy, (j - 1.5) * 0.1);
      stalk.rotation.z = (rand() - 0.5) * 0.25;
      field.add(stalk);
    }
  }
  if (rand() < 0.3) {
    const bale = new THREE.Mesh(GEO.bale, mat(0xc9a23f, { rough: 1 }));
    bale.rotation.z = Math.PI / 2;
    bale.rotation.y = rand() * Math.PI;
    bale.position.set((rand() - 0.5) * 0.25, 0.1, (rand() - 0.5) * 0.2);
    bale.castShadow = true;
    field.add(bale);
  }
  group.add(field);
}

function addHouse(group, i, rand) {
  const a = edgeAngle(i);
  const houseGroup = new THREE.Group();
  houseGroup.position.set(Math.cos(a) * 0.58, TOP, Math.sin(a) * 0.58);
  houseGroup.rotation.y = -a + Math.PI / 2;
  const wScale = 0.8 + rand() * 0.4;
  const hScale = 0.8 + rand() * 0.4;
  const house = new THREE.Mesh(GEO.houseBody, mat(PALETTE.house));
  house.scale.set(wScale, hScale, 1);
  house.position.y = 0.125 * hScale;
  house.castShadow = true;
  house.receiveShadow = true;
  houseGroup.add(house);
  const roof = new THREE.Mesh(GEO.houseRoof, mat(PALETTE.roof));
  roof.scale.set(wScale, 1, 1);
  roof.position.y = 0.25 * hScale + 0.1;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  houseGroup.add(roof);
  const chimney = new THREE.Mesh(GEO.chimney, mat(0x8d6e63, { rough: 1 }));
  chimney.position.set(0.08 * wScale, 0.25 * hScale + 0.14, 0);
  houseGroup.add(chimney);
  const door = new THREE.Mesh(GEO.door, mat(0x3e2723));
  door.position.set(0, 0.075, 0.126);
  houseGroup.add(door);
  for (const sx of [-0.075, 0.075]) {
    const win = new THREE.Mesh(GEO.win, windowMaterial);
    win.position.set(sx * wScale, 0.13 * hScale, 0.126);
    houseGroup.add(win);
  }
  group.add(houseGroup);
}

function addRiver(group, i, userData, rand) {
  const a = edgeAngle(i);
  const mx = Math.cos(a) * 0.46;
  const mz = Math.sin(a) * 0.46;
  const bed = new THREE.Mesh(GEO.bed, mat(PALETTE.riverBed));
  bed.position.set(mx, TOP + 0.01, mz);
  bed.rotation.y = -a + Math.PI / 2;
  group.add(bed);
  const water = new THREE.Mesh(GEO.riverWater, mat(PALETTE.river, { rough: 0.1, metal: 0.2, opacity: 0.85, flat: false }));
  water.position.set(mx, TOP + 0.04, mz);
  water.rotation.y = -a + Math.PI / 2;
  group.add(water);
  userData.bobbers.push({ mesh: water, baseY: TOP + 0.04, phase: rand() * 10, amp: 0.015 });
  for (let f = 0; f < 3; f++) {
    const foam = new THREE.Mesh(GEO.foam, mat(0xffffff, { rough: 1 }));
    foam.scale.set(0.45, 0.25, 0.45);
    foam.position.set((f % 2 === 0 ? 1 : -1) * 0.175, 0.045, (rand() - 0.5) * 0.5);
    water.add(foam);
  }
}

function addRail(group, i) {
  const a = edgeAngle(i);
  const gravel = new THREE.Mesh(GEO.gravel, mat(PALETTE.gravel, { rough: 1 }));
  gravel.position.set(Math.cos(a) * 0.46, TOP + 0.02, Math.sin(a) * 0.46);
  gravel.rotation.y = -a + Math.PI / 2;
  group.add(gravel);
  const steel = mat(PALETTE.railSteel, { metal: 0.6, rough: 0.4 });
  for (const sx of [-0.06, 0.06]) {
    const rail = new THREE.Mesh(GEO.railBar, steel);
    rail.position.set(sx, 0.04, 0);
    gravel.add(rail);
  }
  for (let k = 0; k < 4; k++) {
    const tie = new THREE.Mesh(GEO.sleeper, mat(PALETTE.railWood));
    tie.position.set(0, 0.03, (k - 1.5) * 0.17);
    gravel.add(tie);
  }
}

function addCrag(group, x, z, h, rand, userData) {
  const crag = new THREE.Mesh(GEO.crag, mat(PALETTE.rock, { rough: 1 }));
  crag.scale.set(0.8 + rand() * 0.5, h, 0.8 + rand() * 0.5);
  crag.position.set(x, TOP, z);
  crag.rotation.y = rand() * Math.PI;
  crag.castShadow = true;
  // ConeGeometry origin is mid-height: lift so the base sits on the tile top.
  crag.position.y = TOP + h / 2;
  group.add(crag);
  const snow = new THREE.Mesh(GEO.crag, mat(PALETTE.snow, { rough: 0.6 }));
  const snowScale = 0.42;
  snow.scale.set(crag.scale.x * snowScale * 1.06, h * snowScale, crag.scale.z * snowScale * 1.06);
  snow.position.set(x, TOP + h - (h * snowScale) / 2 + 0.005, z);
  snow.rotation.y = crag.rotation.y;
  snow.visible = false;
  snow.userData.baseScale = snow.scale.clone();
  userData.snowcaps.push(snow);
  group.add(snow);
}

function addMountain(group, i, rand, userData) {
  const a = edgeAngle(i);
  addCrag(group, Math.cos(a) * 0.58, Math.sin(a) * 0.58, 0.5 + rand() * 0.3, rand, userData);
  if (rand() < 0.6) {
    const boulder = new THREE.Mesh(GEO.rock, mat(PALETTE.scree, { rough: 1 }));
    boulder.scale.setScalar(1.4 + rand());
    boulder.position.set(Math.cos(a) * (0.4 + rand() * 0.3), TOP + 0.03, Math.sin(a) * (0.4 + rand() * 0.3));
    boulder.rotation.set(rand() * 3, rand() * 3, 0);
    boulder.castShadow = true;
    group.add(boulder);
  }
}

function addOcean(group, i, userData) {
  addWedge(group, i, mat(PALETTE.oceanDeep, { rough: 0.7, side: THREE.DoubleSide }), TOP + 0.002);
  const water = new THREE.Mesh(WATER_WEDGE, waterMaterial);
  water.rotation.y = i * Math.PI / 3;
  water.position.y = TOP + 0.024;
  group.add(water);
}

function addLane(group, i, userData, rand) {
  addOcean(group, i, userData);
  const a = edgeAngle(i);
  // buoy-dashed channel: cream dashes with red/cream buoys flanking the line
  for (let k = 0; k < 3; k++) {
    const d = 0.22 + k * 0.26;
    const dash = new THREE.Mesh(GEO.dash, mat(PALETTE.buoyCream, { rough: 0.6 }));
    dash.position.set(Math.cos(a) * d, TOP + 0.045, Math.sin(a) * d);
    dash.rotation.y = -a + Math.PI / 2;
    group.add(dash);
    userData.bobbers.push({ mesh: dash, baseY: TOP + 0.045, phase: rand() * 10, amp: 0.012 });
  }
  for (let k = 0; k < 2; k++) {
    const d = 0.35 + k * 0.26;
    const side = k % 2 === 0 ? 1 : -1;
    const buoy = new THREE.Mesh(GEO.buoy, mat(k % 2 === 0 ? PALETTE.buoyRed : PALETTE.buoyCream, { rough: 0.7 }));
    const px = Math.cos(a) * d - Math.sin(a) * side * 0.14;
    const pz = Math.sin(a) * d + Math.cos(a) * side * 0.14;
    buoy.position.set(px, TOP + 0.07, pz);
    group.add(buoy);
    userData.bobbers.push({ mesh: buoy, baseY: TOP + 0.07, phase: rand() * 10, amp: 0.02 });
  }
}

function addGrassDecor(group, i, rand) {
  if (rand() < 0.3) return;
  const a = edgeAngle(i) + (rand() - 0.5) * 0.7;
  const d = 0.35 + rand() * 0.3;
  const x = Math.cos(a) * d;
  const z = Math.sin(a) * d;
  const roll = rand();
  if (roll < 0.5) {
    const stem = new THREE.Mesh(GEO.stem, mat(0x4a7028));
    stem.position.set(x, TOP + 0.05, z);
    group.add(stem);
    const heads = [0xe74c3c, 0xf6c344, 0xffffff, 0xe98fb6];
    const head = new THREE.Mesh(GEO.flowerHead, mat(heads[Math.floor(rand() * 4)], { rough: 0.6 }));
    head.position.set(x, TOP + 0.11, z);
    group.add(head);
  } else if (roll < 0.75) {
    const rock = new THREE.Mesh(GEO.rock, mat(0x95a5a6, { rough: 1 }));
    rock.position.set(x, TOP + 0.02, z);
    rock.rotation.set(rand() * 3, rand() * 3, 0);
    rock.scale.y = 0.7 + rand() * 0.5;
    group.add(rock);
  } else {
    for (let j = 0; j < 3; j++) {
      const blade = new THREE.Mesh(GEO.blade, mat(0x6da33c));
      blade.position.set(x + (rand() - 0.5) * 0.09, TOP + 0.06, z + (rand() - 0.5) * 0.09);
      blade.scale.y = 0.7 + rand() * 0.6;
      group.add(blade);
    }
  }
}

// --- archetype extras ---

function addBeachRims(group, edges) {
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    const oceanSoft =
      (edges[i] === 'OC' && SOFT.has(edges[j])) ||
      (edges[j] === 'OC' && SOFT.has(edges[i]));
    if (!oceanSoft) continue;
    const a = edgeAngle(i) - Math.PI / 6; // shared corner direction
    const strip = new THREE.Mesh(GEO.beach, mat(PALETTE.beach, { rough: 1 }));
    strip.position.set(Math.cos(a) * 0.48, TOP + 0.014, Math.sin(a) * 0.48);
    strip.rotation.y = -a;
    strip.receiveShadow = true;
    group.add(strip);
  }
}

function addDelta(group, tile, rand) {
  const oc = [];
  for (let i = 0; i < 6; i++) if (tile.edges[i] === 'OC') oc.push(edgeAngle(i));
  if (!oc.length) return;
  let vx = 0, vz = 0;
  for (const a of oc) { vx += Math.cos(a); vz += Math.sin(a); }
  const a = Math.atan2(vz, vx);
  const sand = mat(PALETTE.beach, { rough: 1 });
  for (let k = 0; k < 3; k++) {
    const disc = new THREE.Mesh(GEO.deltaDisc, sand);
    const d = 0.18 + k * 0.2;
    const spread = (k - 1) * 0.35;
    disc.position.set(
      Math.cos(a) * d - Math.sin(a) * spread * 0.4,
      TOP + 0.03 + k * 0.002,
      Math.sin(a) * d + Math.cos(a) * spread * 0.4);
    disc.scale.setScalar(1 - k * 0.18);
    group.add(disc);
  }
  for (let k = 0; k < 4; k++) {
    const silt = new THREE.Mesh(GEO.rock, mat(0xd8c79a, { rough: 1 }));
    silt.scale.set(1, 0.4, 1);
    silt.position.set(
      Math.cos(a) * (0.3 + rand() * 0.4) + (rand() - 0.5) * 0.3,
      TOP + 0.035,
      Math.sin(a) * (0.3 + rand() * 0.4) + (rand() - 0.5) * 0.3);
    group.add(silt);
  }
}

function addPier(group, dockDir, crane, rand) {
  const a = edgeAngle(dockDir);
  const wood = mat(PALETTE.pier, { rough: 1 });
  const deck = new THREE.Mesh(GEO.deck, wood);
  deck.position.set(Math.cos(a) * 0.5, TOP + 0.065, Math.sin(a) * 0.5);
  deck.rotation.y = -a + Math.PI / 2;
  deck.castShadow = true;
  group.add(deck);
  for (let k = 0; k < 3; k++) {
    for (const side of [-1, 1]) {
      const pile = new THREE.Mesh(GEO.pile, wood);
      pile.position.set(side * 0.09, -0.09, (k - 1) * 0.26);
      deck.add(pile);
    }
  }
  for (const pz of [-0.26, 0.22]) {
    const bollard = new THREE.Mesh(GEO.bollard, mat(0x4a3a2a, { rough: 1 }));
    bollard.position.set(0.08, 0.05, pz);
    deck.add(bollard);
  }
  for (let k = 0; k < 2 + Math.floor(rand() * 2); k++) {
    const crate = new THREE.Mesh(GEO.crate, mat(PALETTE.crate, { rough: 1 }));
    crate.position.set(
      Math.cos(a) * 0.16 + (rand() - 0.5) * 0.16,
      TOP + 0.045,
      Math.sin(a) * 0.16 + (rand() - 0.5) * 0.16);
    crate.rotation.y = rand() * Math.PI;
    crate.castShadow = true;
    group.add(crate);
  }
  if (crane) {
    const red = mat(PALETTE.crane, { rough: 0.7 });
    const tower = new THREE.Mesh(GEO.craneTower, red);
    const tx = Math.cos(a) * 0.18 - Math.sin(a) * 0.22;
    const tz = Math.sin(a) * 0.18 + Math.cos(a) * 0.22;
    tower.position.set(tx, TOP + 0.25, tz);
    tower.castShadow = true;
    group.add(tower);
    const jib = new THREE.Mesh(GEO.craneJib, red);
    jib.position.set(tx + Math.cos(a) * 0.18, TOP + 0.5, tz + Math.sin(a) * 0.18);
    jib.rotation.y = -a + Math.PI / 2;
    jib.castShadow = true;
    group.add(jib);
    const line = new THREE.Mesh(GEO.craneLine, mat(0x333333));
    line.position.set(tx + Math.cos(a) * 0.38, TOP + 0.4, tz + Math.sin(a) * 0.38);
    group.add(line);
  }
}

function addQuestFlag(group, rand) {
  const a = rand() * Math.PI * 2;
  const x = Math.cos(a) * 0.25;
  const z = Math.sin(a) * 0.25;
  const pole = new THREE.Mesh(GEO.pole, mat(PALETTE.dirt, { rough: 1 }));
  pole.position.set(x, TOP + 0.35, z);
  pole.castShadow = true;
  group.add(pole);
  const pennant = new THREE.Mesh(GEO.pennant, mat(PALETTE.buoyRed, { side: THREE.DoubleSide }));
  pennant.position.set(x, TOP + 0.68, z);
  pennant.rotation.y = rand() * Math.PI * 2;
  group.add(pennant);
}

// --- main builder ---

const WEDGE_COLORS = {
  FO: () => mat(PALETTE.forestFloor, { side: THREE.DoubleSide }),
  FI: () => mat(PALETTE.field, { side: THREE.DoubleSide }),
  HO: () => mat(0x8fa050, { side: THREE.DoubleSide }),
  MT: () => mat(PALETTE.scree, { rough: 1, side: THREE.DoubleSide }),
};

// buildTileMesh(tile) -> THREE.Group positioned at origin; caller places it.
// group.userData: { tile, bobbers: [{mesh, baseY, phase, amp}], snowcaps:
// [Mesh], peak } — consumed by effects.js (water bob, snowcap toggles).
export function buildTileMesh(tile) {
  const group = new THREE.Group();
  const rand = makeRand(tile.seed ?? 1);
  const userData = { tile, bobbers: [], snowcaps: [], peak: false };
  group.userData = userData;

  const allWater = tile.edges.every((e) => e === 'OC' || e === 'LA');
  const baseColor = allWater
    ? new THREE.Color(PALETTE.oceanDeep).multiplyScalar(0.75)
    : new THREE.Color(PALETTE.grass).lerp(new THREE.Color(PALETTE.grassVar), rand() * 0.5);
  const base = new THREE.Mesh(GEO.base, mat(baseColor.getHex(), { rough: 1 }));
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);
  const skirt = new THREE.Mesh(GEO.skirt, mat(PALETTE.dirt, { rough: 1 }));
  skirt.position.y = -HEX_HEIGHT / 2 - 0.1;
  group.add(skirt);

  let mtEdges = 0;
  for (const e of tile.edges) if (e === 'MT') mtEdges++;
  userData.peak = mtEdges >= 4;

  for (let i = 0; i < 6; i++) {
    const t = tile.edges[i];
    if (WEDGE_COLORS[t]) addWedge(group, i, WEDGE_COLORS[t](), TOP + 0.004);
    switch (t) {
      case 'GR': addGrassDecor(group, i, rand); break;
      case 'FO': addForest(group, i, rand); break;
      case 'FI': addField(group, i, rand); break;
      case 'HO': addHouse(group, i, rand); break;
      case 'RI': addRiver(group, i, userData, rand); break;
      case 'RA': addRail(group, i); break;
      case 'MT': addMountain(group, i, rand, userData); break;
      case 'OC': addOcean(group, i, userData); break;
      case 'LA': addLane(group, i, userData, rand); break;
    }
  }

  if (userData.peak) addCrag(group, 0, 0, 1.05 + rand() * 0.2, rand, userData);
  addBeachRims(group, tile.edges);
  if (tile.archetype === 'estuary') addDelta(group, tile, rand);
  for (const d of tile.dockEdges || []) addPier(group, d, tile.crane, rand);
  if (tile.flag) addQuestFlag(group, rand);

  return group;
}

// Snowcap toggle (DESIGN §9 item 4): snowline = plain caps; peakCrowned =
// bigger caps. effects.js animates the pop-in by rescaling from 0.
export function setSnowcap(group, on, { crowned = false } = {}) {
  for (const cap of group.userData.snowcaps || []) {
    cap.visible = on;
    cap.scale.copy(cap.userData.baseScale);
    if (crowned) cap.scale.multiplyScalar(1.35);
  }
  group.userData.snowOn = on;
  group.userData.snowCrowned = crowned;
}
