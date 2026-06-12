// Draw-engine order of operations (DESIGN §4.2): stage table -> tide gate ->
// harbor pity -> mountain pity -> finale -> ocean-family cap -> renormalize.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/core/config.js';
import { mulberry32 } from '../src/core/rng.js';
import {
  ARCHETYPES, FLAG_ELIGIBLE, computeWeights, drawTile, stageFor,
} from '../src/core/tiles.js';

const FAMILY = CONFIG.weights.oceanFamily;

function gs(over = {}) {
  return {
    placements: 30, stackRemaining: 40,
    largestOceanGroup: 0, laneAdmissibleFrontier: 0,
    needyLaneRoute: false, harborPityDrawsLeft: 0,
    uncrownedPeak: false, activeFlags: 0,
    ...over,
  };
}

const sum = (w, keys = ARCHETYPES) => keys.reduce((s, a) => s + w[a], 0);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

test('stage boundaries keyed to total placements', () => {
  assert.equal(stageFor(0), 'pastoral');
  assert.equal(stageFor(11), 'pastoral');  // draw for placement 12
  assert.equal(stageFor(12), 'highlands'); // draw for placement 13
  assert.equal(stageFor(23), 'highlands');
  assert.equal(stageFor(24), 'tide');
  assert.equal(stageFor(44), 'tide');
  assert.equal(stageFor(45), 'voyage');
  assert.equal(stageFor(200), 'voyage');
});

test('weights always renormalize to 100', () => {
  for (const over of [
    {}, { placements: 0 }, { placements: 15 }, { placements: 60 },
    { uncrownedPeak: true }, { needyLaneRoute: true, largestOceanGroup: 5, laneAdmissibleFrontier: 4 },
    { stackRemaining: 5, largestOceanGroup: 5, laneAdmissibleFrontier: 4 },
  ]) {
    close(sum(computeWeights(gs(over))), 100, JSON.stringify(over));
  }
});

test('tide gate closed: lane weight redistributes 2/3 coast, 1/3 open ocean', () => {
  const w = computeWeights(gs()); // ocean group 0 -> gate closed; tide table
  assert.equal(w.lane, 0);
  const t = CONFIG.weights.table.tide;
  close(w.coast, t.coast + t.lane * (2 / 3), 'coast');
  close(w.openOcean, t.openOcean + t.lane * (1 / 3), 'openOcean');
  close(sum(w, FAMILY), sum({ ...t }, FAMILY), 'family share unchanged');
});

test('tide gate needs BOTH ocean group >= 3 AND >= 2 admissible frontier cells', () => {
  assert.equal(computeWeights(gs({ largestOceanGroup: 3, laneAdmissibleFrontier: 1 })).lane, 0);
  assert.equal(computeWeights(gs({ largestOceanGroup: 2, laneAdmissibleFrontier: 5 })).lane, 0);
  const w = computeWeights(gs({ largestOceanGroup: 3, laneAdmissibleFrontier: 2 }));
  assert.ok(w.lane > 0);
  close(w.lane, CONFIG.weights.table.tide.lane, 'unmodified lane weight');
});

test('harbor pity triples harbor weight (condition live or timer running)', () => {
  const base = computeWeights(gs());
  for (const over of [{ needyLaneRoute: true }, { harborPityDrawsLeft: 7 }]) {
    const w = computeWeights(gs(over));
    // pity runs before the cap; verify pre-cap ratio harbor/coast is 3x base
    close(w.harbor / w.coast, (base.harbor / base.coast) * 3, JSON.stringify(over));
  }
});

test('mountain pity: +4pp to foothills, taken proportionally from soft archetypes', () => {
  const st = gs({ placements: 15 }); // highlands
  const base = computeWeights(st);
  const w = computeWeights({ ...st, uncrownedPeak: true });
  const t = CONFIG.weights.table.highlands;
  close(w.foothills, t.foothills + 4, 'foothills +4');
  const softSum = t.meadow + t.hamlet + t.pureSoft;
  close(w.meadow, t.meadow - 4 * (t.meadow / softSum), 'meadow share');
  close(w.hamlet, t.hamlet - 4 * (t.hamlet / softSum), 'hamlet share');
  close(w.pureSoft, t.pureSoft - 4 * (t.pureSoft / softSum), 'pureSoft share');
  close(sum(w), 100, 'total');
  assert.ok(base.foothills < w.foothills);
});

test('finale doubles harbor and lane, then the 35% family cap clamps LAST', () => {
  const st = gs({
    placements: 60, stackRemaining: 10,
    largestOceanGroup: 5, laneAdmissibleFrontier: 4,
  });
  const w = computeWeights(st);
  close(sum(w), 100, 'total');
  close(sum(w, FAMILY), 35, 'family capped at exactly 35 during finale');
  // doubling survives inside the family: harbor:lane ratio = (5*2):(5*2)
  close(w.harbor, w.lane, 'harbor == lane after x2');
  // non-family ratios untouched
  const t = CONFIG.weights.table.voyage;
  close(w.meadow / w.river, t.meadow / t.river, 'non-family ratios preserved');
});

test('ocean-family cap enforced after pity modifiers (strict order)', () => {
  // tide stage + harbor pity pushes family over 25% -> scaled back to exactly 25
  const st = gs({ needyLaneRoute: true, largestOceanGroup: 5, laneAdmissibleFrontier: 4 });
  const w = computeWeights(st);
  close(sum(w), 100, 'total');
  close(sum(w, FAMILY), 25, 'family clamped to tide cap 25');
  // within-family proportions still reflect the x3 pity (harbor 12 vs coast 12)
  close(w.harbor / w.coast, (4 * 3) / 12, 'pity preserved within family');
});

test('cap not applied when family is under it', () => {
  const st = gs({ largestOceanGroup: 5, laneAdmissibleFrontier: 4 }); // plain tide table
  const w = computeWeights(st);
  const t = CONFIG.weights.table.tide;
  close(sum(w, FAMILY), sum({ ...t }, FAMILY), 'family share = raw table share');
  for (const a of ARCHETYPES) close(w[a], t[a], a);
});

test('pastoral draws never produce mountain or ocean archetypes', () => {
  const rng = mulberry32(42);
  const st = gs({ placements: 3, stackRemaining: 42 });
  for (let i = 0; i < 300; i++) {
    const t = drawTile(rng, st);
    assert.ok(
      ['meadow', 'hamlet', 'pureSoft', 'river', 'rail'].includes(t.archetype),
      t.archetype,
    );
  }
});

test('drawTile flags only eligible archetypes and respects maxFlags', () => {
  const rng = mulberry32(9);
  const st = gs({ placements: 3 });
  let flagged = 0;
  for (let i = 0; i < 600; i++) {
    const t = drawTile(rng, st);
    if (t.flag) {
      flagged++;
      assert.ok(FLAG_ELIGIBLE.has(t.archetype), t.archetype);
    }
  }
  assert.ok(flagged > 0, 'some tiles flagged at 20% rate');
  const rng2 = mulberry32(9);
  for (let i = 0; i < 600; i++) {
    assert.equal(drawTile(rng2, gs({ placements: 3, activeFlags: 3 })).flag, null);
  }
});

test('drawTile draws roughly match the stage table (voyage, all gates open)', () => {
  const rng = mulberry32(123);
  const st = gs({ placements: 60, largestOceanGroup: 5, laneAdmissibleFrontier: 4 });
  const n = 6000;
  const got = Object.fromEntries(ARCHETYPES.map((a) => [a, 0]));
  for (let i = 0; i < n; i++) got[drawTile(rng, st).archetype]++;
  const t = CONFIG.weights.table.voyage;
  for (const a of ARCHETYPES) {
    const want = t[a] / 100;
    assert.ok(Math.abs(got[a] / n - want) < 0.03, `${a}: ${got[a] / n} vs ${want}`);
  }
});
