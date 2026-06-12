// Scoring: edges, streak predicate, perfect escalation, junction one-time
// caps, trade income, end-game bonuses, dry-run vs apply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoard } from '../src/core/board.js';
import {
  createScoringContext, scorePlacement, applyPlacement, endGameBonuses,
} from '../src/core/scoring.js';
import { tt, put, cfg, ALL } from './helpers.js';

const RIVER = ['RI', 'GR', 'GR', 'RI', 'GR', 'GR'];

test('soft like-match pays 10 per edge; mismatch pays 0 but stays legal', () => {
  const b = createBoard();
  put(b, ALL('GR'), 0, 0);
  const ctx = createScoringContext();
  let res = applyPlacement(b, tt(ALL('GR')), 1, 0, ctx);
  assert.equal(res.breakdown.edges, 10);
  res = applyPlacement(b, tt(ALL('FO')), 2, 0, ctx);
  assert.equal(res.breakdown.edges, 0);
  assert.equal(res.cleanliness, 'dirty');
});

test('streak: clean extends (+5 x length), neutral holds, dirty resets', () => {
  const b = createBoard();
  put(b, ALL('GR'), 0, 0);
  put(b, ALL('GR'), 1, 0);
  const ctx = createScoringContext();

  // 2 matched neighbors -> clean, streak 1
  let res = applyPlacement(b, tt(ALL('GR')), 1, -1, ctx);
  assert.equal(res.cleanliness, 'clean');
  assert.equal(res.breakdown.streak, 5);
  assert.equal(res.combo, 1);

  // 2 matched neighbors -> clean, streak 2
  res = applyPlacement(b, tt(ALL('GR')), 0, -1, ctx);
  assert.equal(res.cleanliness, 'clean');
  assert.equal(res.breakdown.streak, 10);
  assert.equal(ctx.streak, 2);

  // 1 neighbor, matched -> neutral: unchanged, pays nothing
  res = applyPlacement(b, tt(ALL('GR')), 2, 0, ctx);
  assert.equal(res.cleanliness, 'neutral');
  assert.equal(res.breakdown.streak, 0);
  assert.equal(ctx.streak, 2);

  // soft mismatch -> dirty: reset to 0
  res = applyPlacement(b, tt(ALL('FO')), -1, 0, ctx);
  assert.equal(res.cleanliness, 'dirty');
  assert.equal(ctx.streak, 0);

  // clean again starts from 1
  res = applyPlacement(b, tt(ALL('GR')), 2, -1, ctx);
  assert.equal(res.cleanliness, 'clean');
  assert.equal(res.breakdown.streak, 5);
});

test('streak pay caps at +50', () => {
  const b = createBoard();
  put(b, ALL('GR'), 0, 0);
  put(b, ALL('GR'), 1, 0);
  const ctx = createScoringContext();
  ctx.streak = 11;
  const res = applyPlacement(b, tt(ALL('GR')), 1, -1, ctx);
  assert.equal(ctx.streak, 12);
  assert.equal(res.breakdown.streak, 50);
});

test('lane end on plain ocean is legal-but-unmatched: neutral, not dirty', () => {
  const b = createBoard();
  put(b, ALL('OC'), 1, 0);
  put(b, ALL('OC'), 1, -1);
  const ctx = createScoringContext();
  ctx.streak = 3;
  const lane = tt(['LA', 'OC', 'OC', 'LA', 'OC', 'OC']);
  const res = applyPlacement(b, lane, 0, 0, ctx);
  assert.equal(res.cleanliness, 'neutral');
  assert.equal(ctx.streak, 3, 'streak untouched');
  assert.equal(res.breakdown.edges, 15, 'only the Oc-Oc edge pays');
  const laneEdge = res.edgeMatches.find((m) => m.dir === 0);
  assert.equal(laneEdge.matched, false);
});

function ring(b, cq, cr) {
  for (const [dq, dr] of [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]) {
    put(b, ALL('GR'), cq + dq, cr + dr);
  }
}

test('perfect placement: 6 neighbors all matched; escalates 50/75/100, +1 tile', () => {
  const b = createBoard();
  ring(b, 0, 0);
  ring(b, 4, 0);
  ring(b, 8, 0);
  const ctx = createScoringContext();

  let res = applyPlacement(b, tt(ALL('GR')), 0, 0, ctx);
  assert.equal(res.perfect, true);
  assert.equal(res.breakdown.perfect, 50);
  assert.equal(res.tilesAwarded, 1);
  assert.equal(res.edgeMatches.length, 6);
  assert.ok(res.edgeMatches.every((m) => m.matched));

  res = applyPlacement(b, tt(ALL('GR')), 4, 0, ctx);
  assert.equal(res.breakdown.perfect, 75, 'consecutive perfect escalates');
  assert.equal(ctx.consecutivePerfects, 2);

  // a non-perfect placement breaks the chain
  res = applyPlacement(b, tt(ALL('GR')), 0, 2, ctx);
  assert.equal(res.perfect, false);
  assert.equal(ctx.consecutivePerfects, 0);

  ctx.consecutivePerfects = 5; // deep chain: capped at the top of the ladder
  res = applyPlacement(b, tt(ALL('GR')), 8, 0, ctx);
  assert.equal(res.breakdown.perfect, 100);
});

test('source junction pays once per river network (extras: edge points only)', () => {
  const b = createBoard();
  put(b, RIVER, 0, 0);
  const ctx = createScoringContext();

  let res = applyPlacement(b, tt(ALL('MT')), 1, 0, ctx);
  assert.equal(res.breakdown.edges, 15);
  assert.equal(res.breakdown.junctions, 30);
  assert.ok(res.networkEvents.some((e) => e.type === 'spring'));
  assert.ok(res.groupsExtended.some((g) => g.terrain === 'MT' && g.size === 1));

  res = applyPlacement(b, tt(ALL('MT')), -1, 0, ctx);
  assert.equal(res.breakdown.edges, 15);
  assert.equal(res.breakdown.junctions, 0, 'second source on same network capped');
  assert.ok(!res.networkEvents.some((e) => e.type === 'spring'));
});

test('estuary junction pays once per river network', () => {
  const b = createBoard();
  put(b, RIVER, 0, 0);
  const ctx = createScoringContext();
  let res = applyPlacement(b, tt(ALL('OC')), 1, 0, ctx);
  assert.equal(res.breakdown.junctions, 40);
  assert.ok(res.networkEvents.some((e) => e.type === 'estuary'));
  res = applyPlacement(b, tt(ALL('OC')), -1, 0, ctx);
  assert.equal(res.breakdown.junctions, 0);
});

test('two source junctions created by one placement pay a single bonus', () => {
  const b = createBoard();
  put(b, ['RI', 'RI', 'GR', 'GR', 'GR', 'GR'], 0, 0); // tight bend toward (1,0),(1,-1)
  put(b, ['GR', 'GR', 'GR', 'GR', 'RI', 'RI'], 1, -1); // joins the same network
  const ctx = createScoringContext();
  const res = applyPlacement(b, tt(ALL('MT')), 1, 0, ctx);
  assert.equal(res.breakdown.edges, 30, 'two Ri-Mt edge pairs');
  assert.equal(res.breakdown.junctions, 30, 'but only one source bonus');
  assert.equal(res.networkEvents.filter((e) => e.type === 'spring').length, 1);
});

test('cliff junction (cliff mode): legal, +10 one-time, named event', () => {
  const config = cfg({ mountainCoast: 'cliff' });
  const b = createBoard();
  put(b, ALL('OC'), 0, 0);
  const ctx = createScoringContext();
  const res = applyPlacement(b, tt(ALL('MT')), 1, 0, ctx, config);
  assert.equal(res.breakdown.edges, 0);
  assert.equal(res.breakdown.junctions, 10);
  assert.deepEqual(
    res.networkEvents.filter((e) => e.type === 'cliff').map((e) => e.points),
    [10],
  );
});

function putCompletedRoute(b, r) {
  put(b, ['OC', 'OC', 'GR', 'HO', 'GR', 'GR'], 0, r, { dockEdges: [0] });
  put(b, ['LA', 'OC', 'OC', 'LA', 'OC', 'OC'], 1, r);
  put(b, ['HO', 'GR', 'GR', 'OC', 'OC', 'GR'], 2, r, { dockEdges: [3] });
}

test('trade income: +2 per completed route on subsequent placements, cap +10', () => {
  const b = createBoard();
  putCompletedRoute(b, 0);
  const ctx = createScoringContext();
  let res = applyPlacement(b, tt(ALL('GR')), -1, 0, ctx);
  assert.equal(res.breakdown.tradeIncome, 2);

  const b6 = createBoard();
  for (let i = 0; i < 6; i++) putCompletedRoute(b6, i * 2);
  res = applyPlacement(b6, tt(ALL('GR')), -1, 0, createScoringContext());
  assert.equal(res.breakdown.tradeIncome, 10, 'capped at 5 routes');

  const off = cfg({ tradeIncome: false });
  const b1 = createBoard();
  putCompletedRoute(b1, 0);
  res = applyPlacement(b1, tt(ALL('GR')), -1, 0, createScoringContext(), off);
  assert.equal(res.breakdown.tradeIncome, 0, 'flag-gated');
});

test('scorePlacement is a pure dry-run; applyPlacement commits', () => {
  const b = createBoard();
  put(b, RIVER, 0, 0);
  const ctx = createScoringContext();
  const dry = scorePlacement(b, tt(ALL('MT')), 1, 0, ctx);
  assert.equal(b.size, 1, 'board untouched');
  assert.equal(ctx.sourcePaid.size, 0, 'ctx untouched');
  const wet = applyPlacement(b, tt(ALL('MT')), 1, 0, ctx);
  assert.equal(b.size, 2);
  assert.ok(ctx.sourcePaid.size > 0);
  assert.equal(dry.points, wet.points);
  assert.deepEqual(dry.breakdown, wet.breakdown);
});

test('illegal placements return null and change nothing', () => {
  const b = createBoard();
  put(b, ALL('GR'), 0, 0);
  const ctx = createScoringContext();
  assert.equal(scorePlacement(b, tt(ALL('OC')), 1, 0, ctx), null);
  assert.equal(applyPlacement(b, tt(ALL('OC')), 1, 0, ctx), null);
  assert.equal(b.size, 1);
});

test('end-game bonuses: longest rail/river, largest mountain/ocean', () => {
  const b = createBoard();
  put(b, ['RA', 'GR', 'GR', 'RA', 'GR', 'GR'], 0, 0);
  put(b, ['RA', 'GR', 'GR', 'RA', 'GR', 'GR'], 1, 0);
  put(b, RIVER, 0, 2);
  put(b, RIVER, 1, 2);
  put(b, ALL('MT'), 0, 4);
  put(b, ALL('MT'), 1, 4);
  put(b, ALL('MT'), 2, 4);
  put(b, ALL('OC'), 0, 6);
  put(b, ALL('OC'), 1, 6);
  const eg = endGameBonuses(b);
  assert.equal(eg.longestRail, 2);
  assert.equal(eg.longestRiver, 2);
  assert.equal(eg.largestMountain, 3);
  assert.equal(eg.largestOcean, 2);
  assert.equal(eg.points, 2 * 10 + 2 * 10 + 3 * 8 + 2 * 5);
});

test('PlacementResult carries the SPEC shape', () => {
  const b = createBoard();
  put(b, ALL('GR'), 0, 0);
  const res = applyPlacement(b, tt(ALL('GR')), 1, 0, createScoringContext());
  for (const k of ['tile', 'q', 'r', 'edgeMatches', 'points', 'breakdown', 'perfect',
    'combo', 'questsCompleted', 'questsProgressed', 'tilesAwarded',
    'groupsExtended', 'networkEvents', 'cleanliness']) {
    assert.ok(k in res, k);
  }
  assert.deepEqual(res.questsCompleted, []);
  assert.deepEqual(res.edgeMatches, [{ dir: 3, matched: true, terrain: 'GR' }]);
  assert.equal(res.points,
    res.breakdown.edges + res.breakdown.junctions + res.breakdown.streak +
    res.breakdown.perfect + res.breakdown.structures + res.breakdown.tradeIncome);
});
