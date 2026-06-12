// Structure completions (DESIGN §5.4-§5.6): riverCompleted, laneCompleted with
// hinterland, peak crowning (incl. retroactive + river faces), trade route
// memoization, snowline once-only merge semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoard } from '../src/core/board.js';
import {
  createScoringContext, applyPlacement, tradeRoutePairKey,
} from '../src/core/scoring.js';
import { tt, put, cfg, ALL } from './helpers.js';

const RIVER = ['RI', 'GR', 'GR', 'RI', 'GR', 'GR'];

function evt(res, type) {
  return res.networkEvents.filter((e) => e.type === type);
}

test('riverCompleted: +12 x length, +2 tiles, fires once; extensions never refire', () => {
  const b = createBoard();
  put(b, RIVER, 0, 0);
  put(b, ['RI', 'GR', 'RI', 'RI', 'GR', 'GR'], 1, 0); // branch arm at edge 2
  const ctx = createScoringContext();

  let res = applyPlacement(b, tt(ALL('MT')), 2, 0, ctx); // source end
  assert.equal(evt(res, 'riverCompleted').length, 0, 'source alone is not completion');

  res = applyPlacement(b, tt(ALL('OC')), -1, 0, ctx); // mouth end -> completed
  const [done] = evt(res, 'riverCompleted');
  assert.ok(done);
  assert.equal(done.length, 2);
  assert.equal(done.points, 24);
  assert.equal(res.breakdown.structures, 24);
  assert.equal(res.tilesAwarded, 2);
  assert.equal(res.breakdown.junctions, 40, 'estuary pays alongside completion');

  // grow the still-completed network via the open branch: no refire
  res = applyPlacement(b, tt(['GR', 'GR', 'GR', 'GR', 'GR', 'RI']), 1, -1, ctx);
  assert.equal(evt(res, 'riverCompleted').length, 0);
  assert.equal(res.breakdown.structures, 0);
});

test('laneCompleted: +20 x length + 5 x hinterlands, +2 tiles, port calls per end', () => {
  const b = createBoard();
  put(b, ['OC', 'OC', 'GR', 'HO', 'GR', 'GR'], 0, 0, { dockEdges: [0] }); // harbor A
  put(b, ['HO', 'HO', 'GR', 'GR', 'GR', 'GR'], -1, 0); // A's town (hinterland 2)
  const ctx = createScoringContext();

  let res = applyPlacement(b, tt(['LA', 'OC', 'OC', 'LA', 'OC', 'OC']), 1, 0, ctx);
  assert.equal(res.breakdown.edges, 15);
  assert.equal(res.breakdown.junctions, 25, 'first port call');
  assert.equal(evt(res, 'laneCompleted').length, 0, 'one end still open');

  // harbor B closes the route
  res = applyPlacement(
    b, tt(['HO', 'GR', 'GR', 'OC', 'OC', 'GR'], { dockEdges: [3] }), 2, 0, ctx,
  );
  assert.equal(res.breakdown.junctions, 25, 'second port call');
  const [done] = evt(res, 'laneCompleted');
  assert.ok(done);
  assert.equal(done.length, 1);
  assert.equal(done.points, 20 * 1 + 5 * (2 + 0), 'hinterland A=2, B=0');
  assert.equal(res.tilesAwarded, 2);
  assert.deepEqual([...done.hinterlands].sort(), [0, 2]);
});

// Crane-harbor trade web: A(crane)@(0,0) with 3 rail tiles, lane @(1,0),
// then harbor B @(2,0) completes the route and fires the trade pair.
function tradeBoard({ rails = 3 } = {}) {
  const b = createBoard();
  put(b, ['OC', 'OC', 'GR', 'HO', 'RA', 'GR'], 0, 0, { dockEdges: [0], crane: true });
  const chain = [[-1, 1], [-2, 2], [-3, 3]].slice(0, rails);
  chain.forEach(([q, r], i) => {
    const last = i === chain.length - 1;
    put(b, last ? ['GR', 'RA', 'GR', 'GR', 'GR', 'GR'] : ['GR', 'RA', 'GR', 'GR', 'RA', 'GR'], q, r);
  });
  put(b, ['LA', 'OC', 'OC', 'LA', 'OC', 'OC'], 1, 0);
  return b;
}

const HARBOR_B = ['HO', 'GR', 'GR', 'OC', 'OC', 'GR'];

test('tradeRoute: completed lane between docks + crane rail network >=4 fires +150/+4', () => {
  const b = tradeBoard();
  const ctx = createScoringContext();
  const res = applyPlacement(b, tt(HARBOR_B, { dockEdges: [3] }), 2, 0, ctx);
  const [tr] = evt(res, 'tradeRoute');
  assert.ok(tr, 'fired');
  assert.equal(tr.points, 150);
  assert.equal(tr.pair, tradeRoutePairKey('0,0', '2,0'));
  assert.equal(tr.extra, false);
  assert.ok(evt(res, 'laneCompleted').length === 1, 'laneCompleted fires too');
  assert.equal(res.tilesAwarded, 2 + 4);
  assert.equal(res.breakdown.structures, 20 + 150);
  assert.ok(ctx.firedTradeRoutes.has('0,0|2,0'));
});

test('tradeRoute memoization: a fired pair never refires', () => {
  const b = tradeBoard();
  const ctx = createScoringContext();
  ctx.firedTradeRoutes.add(tradeRoutePairKey('2,0', '0,0')); // sorted key, either order
  const res = applyPlacement(b, tt(HARBOR_B, { dockEdges: [3] }), 2, 0, ctx);
  assert.equal(evt(res, 'tradeRoute').length, 0);
  assert.equal(evt(res, 'laneCompleted').length, 1, 'completion itself still pays');
});

test('tradeRoute needs the rail network to be >=4 at fire time', () => {
  const b = tradeBoard({ rails: 2 }); // crane network = 3 tiles
  const res = applyPlacement(b, tt(HARBOR_B, { dockEdges: [3] }), 2, 0, createScoringContext());
  assert.equal(evt(res, 'tradeRoute').length, 0);
});

test('tradeRoute needs a crane harbor, not just any harbor', () => {
  const b = tradeBoard();
  b.set('0,0', tt(['OC', 'OC', 'GR', 'HO', 'RA', 'GR'], { dockEdges: [0], crane: false }));
  const res = applyPlacement(b, tt(HARBOR_B, { dockEdges: [3] }), 2, 0, createScoringContext());
  assert.equal(evt(res, 'tradeRoute').length, 0);
});

const PEAK = ['MT', 'MT', 'MT', 'MT', 'GR', 'GR'];

// Ring around the peak at (0,0): N0..N3 face its Mt edges, N4/N5 its grass.
function peakBoard() {
  const b = createBoard();
  put(b, PEAK, 0, 0);
  put(b, ALL('MT'), 1, 0);  // N0
  put(b, ALL('MT'), 1, -1); // N1
  put(b, ALL('MT'), 0, -1); // N2
  put(b, ALL('MT'), -1, 0); // N3
  put(b, ['GR', 'GR', 'MT', 'GR', 'GR', 'GR'], -1, 1); // N4 (soft face to peak)
  return b;
}

test('peakCrowned fires retroactively when the 6th neighbor lands', () => {
  const b = peakBoard();
  const ctx = createScoringContext();
  // N5 completes the ring but only touches the peak's GRASS edge
  const res = applyPlacement(b, tt(['GR', 'MT', 'GR', 'GR', 'GR', 'GR']), 0, 1, ctx);
  const [crown] = evt(res, 'peakCrowned');
  assert.ok(crown, 'retroactive crowning');
  assert.equal(crown.key, '0,0');
  assert.equal(crown.points, 60);
  assert.ok(ctx.crownedPeaks.has('0,0'));
  // the same placement merges the Mt group to >=5: snowline co-fires
  assert.equal(evt(res, 'snowline').length, 1);
  assert.equal(res.breakdown.structures, 60 + 25);
  assert.equal(res.tilesAwarded, 1, 'peak pays +1 tile; snowline none');

  // fires once per tile: later placements never re-crown
  const res2 = applyPlacement(b, tt(ALL('GR')), 0, 2, ctx);
  assert.equal(evt(res2, 'peakCrowned').length, 0);
});

test('a river edge counts as an engaged rock face (source crowning)', () => {
  const b = createBoard();
  put(b, PEAK, 0, 0);
  put(b, ALL('MT'), 1, 0);
  put(b, ALL('MT'), 1, -1);
  put(b, ALL('MT'), -1, 0);
  put(b, ['GR', 'GR', 'MT', 'GR', 'GR', 'GR'], -1, 1);
  put(b, ['GR', 'MT', 'GR', 'GR', 'GR', 'GR'], 0, 1);
  const ctx = createScoringContext();
  // 6th neighbor brings a RIVER face to the peak's Mt edge 2
  const res = applyPlacement(b, tt(['MT', 'GR', 'GR', 'GR', 'MT', 'RI']), 0, -1, ctx);
  assert.ok(evt(res, 'spring').length === 1, 'source junction pays');
  assert.equal(evt(res, 'peakCrowned').length, 1);
});

test('cliff mode: an ocean face does NOT crown (not an engaged rock face)', () => {
  const config = cfg({ mountainCoast: 'cliff' });
  const b = createBoard();
  put(b, PEAK, 0, 0);
  put(b, ALL('OC'), 1, 0); // cliff face on Mt edge 0
  put(b, ALL('MT'), 1, -1);
  put(b, ALL('MT'), 0, -1);
  put(b, ALL('MT'), -1, 0);
  put(b, ['GR', 'GR', 'MT', 'GR', 'GR', 'GR'], -1, 1);
  const ctx = createScoringContext();
  const res = applyPlacement(b, tt(['GR', 'MT', 'GR', 'GR', 'GR', 'GR']), 0, 1, ctx, config);
  assert.equal(evt(res, 'peakCrowned').length, 0);
  assert.equal(evt(res, 'cliff').length, 1, 'N5 Mt edge vs ocean pays the cliff');
});

test('snowline: fires when a mountain group first reaches 5; merges never refire', () => {
  const b = createBoard();
  const ctx = createScoringContext();
  let res;
  for (let q = 0; q < 5; q++) {
    res = applyPlacement(b, tt(ALL('MT')), q, 0, ctx);
    if (q < 4) assert.equal(evt(res, 'snowline').length, 0, `tile ${q + 1}`);
  }
  assert.equal(evt(res, 'snowline').length, 1, 'fires at 5');
  assert.equal(res.breakdown.structures, 25);

  put(b, ALL('MT'), 6, 0);
  put(b, ALL('MT'), 7, 0);
  // bridge merges 5-group (paid) with 2-group: 8 tiles, but no refire
  res = applyPlacement(b, tt(ALL('MT')), 5, 0, ctx);
  assert.equal(evt(res, 'snowline').length, 0, 'merge does not refire');
  assert.equal(res.breakdown.structures, 0);
});

test('two separate groups can each earn their own snowline', () => {
  const b = createBoard();
  const ctx = createScoringContext();
  for (let q = 0; q < 5; q++) applyPlacement(b, tt(ALL('MT')), q, 0, ctx);
  for (let q = 0; q < 4; q++) put(b, ALL('MT'), q, 4);
  const res = applyPlacement(b, tt(ALL('MT')), 4, 4, ctx);
  assert.equal(evt(res, 'snowline').length, 1, 'independent group fires');
});
