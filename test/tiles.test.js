// Catalog shape invariants (DESIGN §4) + config table invariants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/core/config.js';
import { mulberry32 } from '../src/core/rng.js';
import {
  ARCHETYPES, FLAG_ELIGIBLE, makeTile, rotateTile, isPeakCandidate,
} from '../src/core/tiles.js';
import { SOFT } from '../src/core/terrain.js';

const N = 400; // samples per archetype

function sample(archetype, seed = 7) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 0; i < N; i++) out.push(makeTile(archetype, rng));
  return out;
}

function counts(edges) {
  const c = {};
  for (const e of edges) c[e] = (c[e] || 0) + 1;
  return c;
}

// Cyclic contiguity: every terrain present forms one contiguous run.
function runsAreContiguous(edges) {
  for (const t of new Set(edges)) {
    let transitions = 0;
    for (let i = 0; i < 6; i++) {
      if ((edges[i] === t) !== (edges[(i + 1) % 6] === t)) transitions++;
    }
    if (transitions > 2) return false;
  }
  return true;
}

test('catalog has exactly the 12 archetypes', () => {
  assert.equal(ARCHETYPES.length, 12);
  assert.deepEqual([...FLAG_ELIGIBLE].sort(), ['hamlet', 'meadow', 'pureSoft']);
});

test('every catalog sub-split sums to 1', () => {
  for (const [name, spec] of Object.entries(CONFIG.tiles)) {
    if (!spec || !spec.splits) continue;
    const sum = spec.splits.reduce((s, [, w]) => s + w, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${name} splits sum to ${sum}`);
  }
});

test('every §4.1 weight column sums to 100', () => {
  for (const [stage, col] of Object.entries(CONFIG.weights.table)) {
    const sum = ARCHETYPES.reduce((s, a) => s + col[a], 0);
    assert.equal(sum, 100, `${stage} sums to ${sum}`);
    for (const a of ARCHETYPES) assert.ok(a in col, `${stage} missing ${a}`);
  }
});

test('pastoral column has zero mountain/ocean weight (Act 1 is GL1)', () => {
  const p = CONFIG.weights.table.pastoral;
  for (const a of ['foothills', 'highMountain', 'coast', 'estuary', 'openOcean', 'harbor', 'lane']) {
    assert.equal(p[a], 0);
  }
});

test('meadow: soft runs, split patterns 3-3 / 4-2 / 2-2-2, contiguous', () => {
  for (const t of sample('meadow')) {
    assert.ok(t.edges.every((e) => ['GR', 'FO', 'FI'].includes(e)));
    const sizes = Object.values(counts(t.edges)).sort((a, b) => b - a).join('-');
    assert.ok(['3-3', '4-2', '2-2-2'].includes(sizes), sizes);
    assert.ok(runsAreContiguous(t.edges), t.edges.join());
  }
});

test('hamlet: 2-3 contiguous HO + Gr/Fi filler', () => {
  for (const t of sample('hamlet')) {
    const ho = t.edges.filter((e) => e === 'HO').length;
    assert.ok(ho === 2 || ho === 3);
    assert.ok(t.edges.every((e) => ['HO', 'GR', 'FI'].includes(e)));
    let transitions = 0;
    for (let i = 0; i < 6; i++) {
      if ((t.edges[i] === 'HO') !== (t.edges[(i + 1) % 6] === 'HO')) transitions++;
    }
    assert.equal(transitions, 2, 'HO run contiguous');
  }
});

test('pureSoft: 6x one of Fo/Fi/Ho', () => {
  const seen = new Set();
  for (const t of sample('pureSoft')) {
    assert.equal(new Set(t.edges).size, 1);
    assert.ok(['FO', 'FI', 'HO'].includes(t.edges[0]));
    seen.add(t.edges[0]);
  }
  assert.equal(seen.size, 3);
});

for (const [arch, terr] of [['river', 'RI'], ['rail', 'RA']]) {
  test(`${arch}: exactly 2 ${terr} edges at straight/wide/tight offsets, rest soft`, () => {
    const offsets = new Set();
    for (const t of sample(arch)) {
      const idx = t.edges.flatMap((e, i) => (e === terr ? [i] : []));
      assert.equal(idx.length, 2);
      assert.equal(idx[0], 0);
      offsets.add(idx[1]);
      assert.ok([1, 2, 3].includes(idx[1]));
      assert.ok(t.edges.every((e) => e === terr || SOFT.has(e)));
    }
    assert.deepEqual([...offsets].sort(), [1, 2, 3], 'all three splits occur');
  });
}

test('foothills: 2 Mt adjacent or skip-one, rest soft; not a peak candidate', () => {
  const offsets = new Set();
  for (const t of sample('foothills')) {
    const idx = t.edges.flatMap((e, i) => (e === 'MT' ? [i] : []));
    assert.equal(idx.length, 2);
    offsets.add(idx[1]);
    assert.ok([1, 2].includes(idx[1]));
    assert.ok(!isPeakCandidate(t));
  }
  assert.deepEqual([...offsets].sort(), [1, 2]);
});

test('highMountain: 4 contiguous Mt + 2 Gr; the only peak candidate', () => {
  for (const t of sample('highMountain')) {
    assert.deepEqual(t.edges, ['MT', 'MT', 'MT', 'MT', 'GR', 'GR']);
    assert.ok(isPeakCandidate(t));
    assert.ok(runsAreContiguous(t.edges));
  }
  for (const a of ARCHETYPES.filter((a) => a !== 'highMountain')) {
    for (const t of sample(a, 3).slice(0, 50)) assert.ok(!isPeakCandidate(t), a);
  }
});

test('coast: 2 or 3 contiguous Oc, rest soft', () => {
  const ns = new Set();
  for (const t of sample('coast')) {
    const oc = t.edges.filter((e) => e === 'OC').length;
    ns.add(oc);
    assert.ok(oc === 2 || oc === 3);
    assert.ok(runsAreContiguous(t.edges.map((e) => (e === 'OC' ? 'OC' : 'x'))));
    assert.ok(t.edges.every((e) => e === 'OC' || SOFT.has(e)));
  }
  assert.deepEqual([...ns].sort(), [2, 3]);
});

test('estuary: Oc at 0,1; Ri at 3 or 4; rest soft', () => {
  const riAt = new Set();
  for (const t of sample('estuary')) {
    assert.equal(t.edges[0], 'OC');
    assert.equal(t.edges[1], 'OC');
    const idx = t.edges.flatMap((e, i) => (e === 'RI' ? [i] : []));
    assert.equal(idx.length, 1);
    assert.ok(idx[0] === 3 || idx[0] === 4);
    riAt.add(idx[0]);
    assert.equal(t.edges.filter((e) => e === 'OC').length, 2);
  }
  assert.deepEqual([...riAt].sort(), [3, 4]);
});

test('openOcean: 6x Oc', () => {
  for (const t of sample('openOcean')) assert.deepEqual(t.edges, new Array(6).fill('OC'));
});

test('harbor: dock on edge 0; crane variant ~1 in 3 carries the Ra edge', () => {
  const tiles = sample('harbor');
  let cranes = 0;
  for (const t of tiles) {
    assert.deepEqual(t.dockEdges, [0]);
    assert.equal(t.edges[0], 'OC');
    assert.equal(t.edges[1], 'OC');
    assert.equal(t.edges[3], 'HO');
    if (t.crane) {
      cranes++;
      assert.equal(t.edges[4], 'RA');
    } else {
      assert.equal(t.edges[4], 'GR');
    }
  }
  const rate = cranes / tiles.length;
  assert.ok(rate > 0.23 && rate < 0.45, `crane rate ${rate}`);
});

test('lane: straight or wide-bend buoy channel, all 6 edges hard', () => {
  const shapes = new Set();
  for (const t of sample('lane')) {
    const las = t.edges.flatMap((e, i) => (e === 'LA' ? [i] : []));
    assert.equal(las.length, 2);
    assert.ok(t.edges.every((e) => e === 'LA' || e === 'OC'));
    shapes.add(las.join('-'));
  }
  assert.deepEqual([...shapes].sort(), ['0-2', '0-3']);
});

test('rotateTile rotates edges via unshift(pop) and dock indices identically', () => {
  const t = {
    id: 'x', archetype: 'harbor',
    edges: ['OC', 'OC', 'GR', 'HO', 'RA', 'GR'],
    dockEdges: [0], crane: true, flag: null, seed: 1, rotation: 0,
  };
  const r1 = rotateTile(t, 1);
  assert.deepEqual(r1.edges, ['GR', 'OC', 'OC', 'GR', 'HO', 'RA']);
  assert.deepEqual(r1.dockEdges, [1]);
  assert.equal(r1.rotation, 1);
  const r6 = rotateTile(t, 6);
  assert.deepEqual(r6.edges, t.edges);
  assert.deepEqual(r6.dockEdges, [0]);
  const r3 = rotateTile(rotateTile(t, 2), 1);
  assert.deepEqual(r3.edges, rotateTile(t, 3).edges);
  assert.deepEqual(t.edges, ['OC', 'OC', 'GR', 'HO', 'RA', 'GR'], 'original untouched');
});
