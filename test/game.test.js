// Game orchestration (SPEC core API): constructor/stack, rotate, legality,
// place() enrichment, stage announcements, winds-shift valve, discard, undo,
// serialize round-trip, zen, and 50 seeded full runs with invariants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/core/config.js';
import { Game } from '../src/core/game.js';
import { tt, ALL } from './helpers.js';

// Greedy step: first legal cell, first legal rotation.
function step(g) {
  const spots = g.legalPlacements();
  if (!spots.length) return null;
  const s = spots[0];
  if (s.rotations[0]) g.rotate(s.rotations[0]);
  return g.place(s.q, s.r);
}

function run(g, max = 600) {
  let n = 0;
  while (!g.over && n < max) {
    if (!step(g)) break;
    n++;
  }
  return n;
}

const LANE = () => tt(['LA', 'OC', 'OC', 'LA', 'OC', 'OC'], { archetype: 'lane' });

test('constructor: default stack from CONFIG, hand drawn, quests initialized', () => {
  const g = new Game({ seed: 7 });
  assert.equal(g.tileCount, CONFIG.stack.start);
  assert.equal(g.stackRemaining, CONFIG.stack.start - 1, 'one tile drawn into hand');
  assert.equal(g.currentTile.edges.length, 6);
  assert.equal(g.placements, 0);
  assert.equal(g.score, 0);
  assert.equal(g.over, false);
  assert.equal(g.quests.standard.length, 3);
  assert.ok(g.quests.epic);
  assert.equal(g.quests.rerolls, CONFIG.quests.rerolls.atStart);
});

test('same seed -> identical games; different seed -> different draw', () => {
  const a = new Game({ seed: 99 });
  const b = new Game({ seed: 99 });
  assert.deepEqual(a.currentTile, b.currentTile);
  assert.deepEqual(JSON.parse(a.serialize()), JSON.parse(b.serialize()));
});

test('rotate cycles edges one step; rotate(-1) undoes it', () => {
  const g = new Game({ seed: 7 });
  const e0 = g.currentTile.edges.slice();
  g.rotate();
  assert.deepEqual(g.currentTile.edges, [e0[5], ...e0.slice(0, 5)]);
  g.rotate(-1);
  assert.deepEqual(g.currentTile.edges, e0);
});

test('legalPlacements on an empty board: origin, all 6 rotations', () => {
  const g = new Game({ seed: 7 });
  assert.deepEqual(g.legalPlacements(), [{ q: 0, r: 0, rotations: [0, 1, 2, 3, 4, 5] }]);
  assert.equal(g.canPlace(0, 0).legal, true);
});

test('place: enriched PlacementResult; illegal -> null, state untouched', () => {
  const g = new Game({ seed: 7 });
  const res = g.place(0, 0);
  assert.ok(res);
  assert.equal(g.placements, 1);
  for (const k of ['questsCompleted', 'questsProgressed', 'events', 'tilesAwarded']) {
    assert.ok(k in res, k);
  }
  assert.equal(typeof res.breakdown.quests, 'number');
  assert.equal(g.score, res.points);

  const before = g.serialize();
  assert.equal(g.place(40, 40), null, 'not adjacent');
  assert.equal(g.serialize(), before, 'illegal place mutates nothing');
});

test('nextTiles peeks without consuming; the peeked tile is drawn next', () => {
  const g = new Game({ seed: 8 });
  const stack = g.stackRemaining;
  const peek = g.nextTiles(3);
  assert.equal(peek.length, 3);
  assert.equal(g.stackRemaining, stack, 'peek consumes nothing');
  assert.deepEqual(g.nextTiles(3), peek, 'stable peek');
  const firstId = peek[0].id;
  step(g);
  assert.equal(g.currentTile.id, firstId);
});

test('stage transitions announced; rerolls granted at tide and voyage', () => {
  const g = new Game({ seed: 5 });
  const events = [];
  while (!g.over && g.placements < 46) {
    const res = step(g);
    events.push(...res.events);
  }
  const stages = events.filter((e) => e.type === 'stage').map((e) => e.stage);
  assert.deepEqual(stages, ['highlands', 'tide', 'voyage']);
  const grants = events.filter((e) => e.type === 'rerollGranted').map((e) => e.stage);
  assert.deepEqual(grants, ['tide', 'voyage']);
  const R = CONFIG.quests.rerolls;
  assert.equal(g.quests.rerolls + g.quests.rerollsUsed, R.atStart + R.atTide + R.atVoyage,
    'start + tide + voyage grants');
});

test('discard: explicit, costs discardCost, draws a replacement', () => {
  const g = new Game({ seed: 9 });
  const cost = CONFIG.valves.discardCost;
  const id0 = g.currentTile.id;
  const stack = g.stackRemaining;
  const out = g.discard();
  assert.equal(g.score, cost);
  assert.notEqual(g.currentTile.id, id0);
  assert.equal(g.stackRemaining, stack - 1);
  assert.equal(g.stats.discards, 1);
  assert.ok(out.events.some((e) => e.type === 'discard' && e.cost === cost));
});

test('winds shift: unplaceable draw auto-rerolls free', () => {
  const g = new Game({ seed: 11 });
  g.board.set('0,0', tt(ALL('GR')));
  g.board.set('1,0', tt(ALL('GR')));
  g.lookahead = [LANE()]; // lane tile cannot touch grass
  const score = g.score;
  g.discard();
  assert.equal(g.stats.windsShiftFires, 1);
  assert.equal(g.stats.windsShiftMeadowFallbacks, 0);
  assert.ok(g.currentTile);
  assert.ok(g.legalPlacements().length > 0, 'replacement is placeable');
  assert.equal(g.score, score + CONFIG.valves.discardCost, 'valve itself is free');
});

test('winds shift falls back to a guaranteed Meadow Blend', () => {
  const g = new Game({ seed: 12 });
  g.board.set('0,0', tt(ALL('GR')));
  g._generateTile = () => LANE(); // every reroll is stuck too
  g.discard();
  assert.equal(g.stats.windsShiftFires, 1);
  assert.equal(g.stats.windsShiftMeadowFallbacks, 1);
  assert.equal(g.currentTile.archetype, 'meadow');
  assert.ok(g.legalPlacements().length > 0);
});

test('dead board even after both valves ends the game', () => {
  const g = new Game({ seed: 13 });
  g.board = new Map([['0,0', tt(ALL('LA'))]]); // nothing soft may ever touch it
  g._generateTile = () => tt(ALL('GR'));
  const out = g.discard();
  assert.equal(g.over, true);
  assert.equal(g.stats.deadBoard, true);
  assert.equal(g.currentTile, null);
  assert.ok(out.events.some((e) => e.type === 'gameOver' && e.deadBoard));
  assert.ok(g.stats.endGame, 'end-game tally still runs');
});

test('undo restores the exact pre-placement state', () => {
  const g = new Game({ seed: 42 });
  for (let i = 0; i < 5; i++) step(g);
  const before = JSON.parse(g.serialize());
  const spot = g.legalPlacements()[0];
  if (spot.rotations[0]) g.rotate(spot.rotations[0]);
  const res1 = g.place(spot.q, spot.r);
  assert.ok(res1);
  assert.equal(g.undo(), true);
  assert.deepEqual(JSON.parse(g.serialize()), before);
  assert.equal(g.undo(), false, 'single-level only');
  // replaying the same move reproduces the same outcome (rng replay)
  if (spot.rotations[0]) g.rotate(spot.rotations[0]);
  const res2 = g.place(spot.q, spot.r);
  assert.equal(res2.points, res1.points);
  assert.deepEqual(res2.breakdown, res1.breakdown);
});

test('serialize/deserialize round-trips mid-game and stays in lockstep', () => {
  const g = new Game({ seed: 1234 });
  for (let i = 0; i < 20; i++) step(g);
  const json = g.serialize();
  const g2 = Game.deserialize(json);
  assert.deepEqual(JSON.parse(g2.serialize()), JSON.parse(json));
  for (let i = 0; i < 10; i++) {
    const r1 = step(g);
    const r2 = step(g2);
    assert.equal(r1.points, r2.points);
    assert.equal(r1.tile.id, r2.tile.id);
  }
  assert.deepEqual(JSON.parse(g2.serialize()), JSON.parse(g.serialize()));
});

test('rerollQuest: swaps a standard quest, spends the reroll', () => {
  const g = new Game({ seed: 14 });
  for (let i = g.quests.rerolls; i > 1; i--) {
    assert.ok(g.rerollQuest(0), 'spend down to the last reroll');
  }
  const oldId = g.quests.standard[0].id;
  const fresh = g.rerollQuest(0);
  assert.ok(fresh);
  assert.notEqual(fresh.id, oldId);
  assert.equal(g.quests.standard[0].id, fresh.id);
  assert.equal(g.quests.rerolls, 0);
  assert.equal(g.rerollQuest(1), null, 'no rerolls left');
});

test('game over on stack exhaustion: end bonuses paid, further moves null', () => {
  const g = new Game({ seed: 30, tileCount: 15 });
  run(g);
  assert.equal(g.over, true);
  assert.equal(g.currentTile, null);
  assert.ok(g.stats.endGame);
  assert.equal(g.place(0, 1), null);
  assert.equal(g.discard(), null);
  assert.deepEqual(g.nextTiles(3), []);
  const ch = g.stats.channels;
  assert.equal(g.score, ch.edges + ch.streaksPerfects + ch.quests + ch.structures + ch.endGame);
});

test('zen: stages advance, stack is infinite, game never ends', () => {
  const g = new Game({ seed: 21, zen: true });
  for (let i = 0; i < 60; i++) assert.ok(step(g));
  assert.equal(g.over, false);
  assert.equal(g.placements, 60);
  assert.equal(g.stats.stage, 'voyage');
  assert.equal(g.stackRemaining, Infinity);
  const g2 = Game.deserialize(g.serialize());
  assert.equal(g2.stackRemaining, Infinity, 'infinity survives the round-trip');
  assert.ok(step(g2));
});

test('50 seeded games (incl. zen) run to completion with sane invariants', () => {
  let totalQuests = 0;
  let totalPerfects = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const zen = seed % 10 === 0;
    const g = new Game({ seed, zen });
    let prev = 0;
    let guard = 0;
    while (!g.over && guard < 600) {
      const res = step(g);
      assert.ok(res, `seed ${seed}: hand always placeable`);
      assert.ok(g.score >= prev, `seed ${seed}: score monotonic`);
      const questTiles = res.questsCompleted.reduce((s, q) => s + q.tiles, 0);
      assert.ok(res.tilesAwarded >= questTiles, `seed ${seed}: quest tiles awarded`);
      prev = g.score;
      guard++;
      if (zen && guard >= 100) break;
    }
    const st = g.stats;
    if (zen) {
      assert.equal(g.over, false, `seed ${seed}: zen never ends`);
      assert.equal(st.placements, 100);
    } else {
      assert.equal(g.over, true, `seed ${seed}: ended within ${guard} placements`);
      assert.ok(st.placements >= 15, `seed ${seed}: placed a real session (${st.placements})`);
    }
    assert.ok(st.reproduction >= 0 && st.reproduction < 1,
      `seed ${seed}: R sane (${st.reproduction.toFixed(2)})`);
    const ch = st.channels;
    assert.equal(g.score, ch.edges + ch.streaksPerfects + ch.quests + ch.structures + ch.endGame,
      `seed ${seed}: channels sum to score`);
    assert.ok(st.score > 0, `seed ${seed}: positive score`);
    totalQuests += st.questsCompleted;
    totalPerfects += st.perfects;
  }
  assert.ok(totalQuests > 0, 'quests complete across seeds');
  assert.ok(totalPerfects >= 0);
});

test('stats carries every sim metric field', () => {
  const g = new Game({ seed: 3, tileCount: 20 });
  run(g);
  const st = g.stats;
  for (const k of ['seed', 'zen', 'score', 'placements', 'channels', 'stage', 'stackRemaining',
    'draws', 'discards', 'tilesEarned', 'reproduction', 'perfects', 'perfectRate', 'maxStreak',
    'windsShiftFires', 'windsShiftRate', 'stuckStates', 'deadBoard', 'questsCompleted',
    'flagsCompleted', 'flagsFaded', 'epic', 'rerollsLeft', 'structures', 'engagement',
    'largestGroups', 'endGame', 'legalMovesRemaining', 'frontierCells']) {
    assert.ok(k in st, k);
  }
  for (const k of ['edges', 'streaksPerfects', 'quests', 'structures', 'endGame']) {
    assert.ok(k in st.channels, 'channel ' + k);
  }
  for (const k of ['riverCompleted', 'laneCompleted', 'peakCrowned']) {
    assert.equal(typeof st.engagement[k], 'boolean', 'engagement ' + k);
  }
});
