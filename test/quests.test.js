// Quests (DESIGN §6): spawn targets + reward formula, availability stages,
// +2 scaling capped at base+8, dead-quest guard, one-shot pool exit, rerolls,
// flagged-tile quests (grow / sealed fade), Epic pool, themed reward draws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/core/config.js';
import { mulberry32 } from '../src/core/rng.js';
import { createBoard } from '../src/core/board.js';
import { tradeRoutePairKey } from '../src/core/scoring.js';
import {
  createQuestState, spawnStandardQuest, processPlacement, useReroll, grantReroll,
  measureMetric, isIslandRinged, twinHarborsOnBoard, drawQuestRewardTile, activeQuests,
} from '../src/core/quests.js';
import { tt, put, cfg, ALL } from './helpers.js';

function bare() {
  return {
    standard: [], epic: null, flags: [],
    completedStandard: 0, oneShotCompletions: {},
    rerolls: 1, rerollsUsed: 0, flagsCompleted: 0, flagsFaded: 0,
  };
}

function env(over = {}) {
  return { board: createBoard(), stage: 'pastoral', lanesUnlocked: false, tilesRemaining: 100, ...over };
}

// config whose standard pool is restricted to the named quest ids
function pool(...ids) {
  return cfg({}, (c) => {
    c.quests.standard = c.quests.standard.filter((d) => ids.includes(d.id));
  });
}

function seq(vals, fallback = 0.3) {
  let i = 0;
  return () => (i < vals.length ? vals[i++] : fallback);
}

const result = (tile, q, r, events = []) => ({ tile, q, r, networkEvents: events });

test('numeric spawn: target = base + die, reward formula, progress prefilled', () => {
  const defs = Object.fromEntries(CONFIG.quests.standard.map((d) => [d.id, d]));
  for (let s = 1; s <= 30; s++) {
    const st = bare();
    const q = spawnStandardQuest(st, env({ stage: 'voyage', lanesUnlocked: true }), mulberry32(s));
    assert.ok(q, 'spawned');
    assert.equal(st.standard[0], q);
    const def = defs[q.id];
    if (def.oneShot) {
      assert.equal(q.target, 1);
      assert.equal(q.points, def.points);
      assert.equal(q.tiles, def.tiles);
    } else {
      assert.ok(q.target >= def.base + 1 && q.target <= def.base + def.die, q.id);
      assert.equal(q.points, 100 + 10 * q.target);
      assert.equal(q.tiles, Math.min(2 + Math.ceil(q.target / 4), 4));
      assert.equal(q.progress, 0);
    }
  }
});

test('availability stages gate the pool; openTheRoute needs lanesUnlocked', () => {
  const pastoralIds = new Set(['bigForest', 'bigField', 'bigVillage', 'longRiver', 'railLine']);
  for (let s = 1; s <= 40; s++) {
    const q = spawnStandardQuest(bare(), env({ stage: 'pastoral' }), mulberry32(s));
    assert.ok(pastoralIds.has(q.id), q.id);
  }
  const seen = new Set();
  for (let s = 1; s <= 80; s++) {
    seen.add(spawnStandardQuest(bare(), env({ stage: 'tide' }), mulberry32(s)).id);
  }
  assert.ok(seen.has('mountainRange') || seen.has('growTheOcean'), 'tide widens the pool');
  assert.ok(!seen.has('openTheRoute'), 'lane quest locked until lanes unlock');

  const only = pool('openTheRoute');
  assert.equal(spawnStandardQuest(bare(), env({ stage: 'voyage' }), mulberry32(1), only), null);
  const q = spawnStandardQuest(bare(), env({ stage: 'voyage', lanesUnlocked: true }), mulberry32(1), only);
  assert.equal(q.id, 'openTheRoute');
  assert.equal(q.minLaneLength, 5);
});

test('scaling: +2 per completed standard quest, capped at base+8', () => {
  const only = pool('bigForest');
  const rng = () => 0; // d3 -> 1
  let st = bare();
  assert.equal(spawnStandardQuest(st, env(), rng, only).target, 6 + 1);
  st = bare();
  st.completedStandard = 2;
  assert.equal(spawnStandardQuest(st, env(), rng, only).target, 6 + 1 + 4);
  st = bare();
  st.completedStandard = 10;
  assert.equal(spawnStandardQuest(st, env(), rng, only).target, 6 + 1 + 8, 'cap at base+8');
});

test('dead-quest guard: clamps to progress + tilesRemaining/4, skips infeasible', () => {
  const only = pool('bigForest');
  const b = createBoard();
  put(b, ALL('FO'), 0, 0);
  put(b, ALL('FO'), 1, 0); // FO group of 2
  // guard = 2 + floor(8/4) = 4 < base 6 -> even the base violates: no spawn
  assert.equal(
    spawnStandardQuest(bare(), env({ board: b, tilesRemaining: 8 }), () => 0.999, only),
    null);
  // guard = 2 + 5 = 7; rolled 6 + 3 = 9 -> clamped to 7
  const q = spawnStandardQuest(bare(), env({ board: b, tilesRemaining: 20 }), () => 0.999, only);
  assert.equal(q.target, 7);
  assert.equal(q.points, 170);
  assert.equal(q.progress, 2);
});

test('one-shot quests leave the pool after 2 completions', () => {
  const only = pool('riversEnd');
  const st = bare();
  st.oneShotCompletions.riversEnd = 1;
  assert.ok(spawnStandardQuest(st, env({ stage: 'tide' }), mulberry32(1), only));
  const st2 = bare();
  st2.oneShotCompletions.riversEnd = 2;
  assert.equal(spawnStandardQuest(st2, env({ stage: 'tide' }), mulberry32(1), only), null);
});

test('riversEnd completes on an estuary event, pays 100/2, respawns until pool exit', () => {
  const only = pool('riversEnd');
  const st = bare();
  const e = env({ stage: 'tide' });
  spawnStandardQuest(st, e, mulberry32(1), only);
  const tile = tt(ALL('GR'));

  let res = processPlacement(st, e, result(tile, 0, 0, [{ type: 'estuary' }]), mulberry32(2), only);
  assert.equal(res.completed.length, 1);
  assert.equal(res.completed[0].id, 'riversEnd');
  assert.equal(res.points, 100);
  assert.equal(res.tiles, 2);
  assert.equal(st.oneShotCompletions.riversEnd, 1);
  assert.equal(st.standard.length, 1, 'respawned (1 of 2 completions used)');

  res = processPlacement(st, e, result(tile, 1, 0, [{ type: 'estuary' }]), mulberry32(3), only);
  assert.equal(res.completed.length, 1);
  assert.equal(st.oneShotCompletions.riversEnd, 2);
  assert.equal(st.standard.length, 0, 'one-shot left the pool after 2');
});

test('twinHarbors: satisfied-on-board check; never spawns pre-completed', () => {
  const b = createBoard();
  put(b, ['OC', 'OC', 'GR', 'HO', 'GR', 'GR'], 0, 0, { dockEdges: [0] });
  put(b, ALL('OC'), 1, 0);
  put(b, ['HO', 'GR', 'GR', 'OC', 'OC', 'GR'], 2, 0, { dockEdges: [3] });
  assert.equal(twinHarborsOnBoard(b), true);
  const b2 = createBoard();
  put(b2, ['OC', 'OC', 'GR', 'HO', 'GR', 'GR'], 0, 0, { dockEdges: [0] });
  put(b2, ['HO', 'GR', 'GR', 'OC', 'OC', 'GR'], 4, 0, { dockEdges: [3] });
  assert.equal(twinHarborsOnBoard(b2), false, 'separate ocean groups');

  const only = pool('twinHarbors');
  assert.equal(spawnStandardQuest(bare(), env({ stage: 'tide', board: b }), mulberry32(1), only), null);
  assert.ok(spawnStandardQuest(bare(), env({ stage: 'tide', board: b2 }), mulberry32(1), only));
});

test('rerolls: replacement excludes the old id, decrements; none left -> null', () => {
  const two = pool('bigForest', 'bigField');
  const st = bare();
  const e = env();
  const first = spawnStandardQuest(st, e, mulberry32(1), two);
  const other = first.id === 'bigForest' ? 'bigField' : 'bigForest';
  const fresh = useReroll(st, 0, e, mulberry32(2), two);
  assert.equal(fresh.id, other);
  assert.equal(st.standard.length, 1);
  assert.equal(st.standard[0], fresh);
  assert.equal(st.rerolls, 0);
  assert.equal(st.rerollsUsed, 1);
  assert.equal(useReroll(st, 0, e, mulberry32(3), two), null, 'no rerolls left');

  grantReroll(st, 2);
  assert.equal(st.rerolls, 2);
  // empty pool: reroll keeps the quest and is not spent
  const one = pool('bigForest');
  const st2 = bare();
  spawnStandardQuest(st2, e, mulberry32(1), one);
  assert.equal(useReroll(st2, 0, e, mulberry32(2), one), null);
  assert.equal(st2.rerolls, 1, 'reroll refunded when nothing else is available');
  assert.equal(st2.standard.length, 1, 'old quest kept');
});

test('flag quest: spawns on flagged placement, grows, completes at 60/2', () => {
  const st = bare();
  const b = createBoard();
  const e = env({ board: b });
  const flagged = tt(ALL('HO'), { flag: {} });
  put(b, flagged, 0, 0);
  processPlacement(st, e, result(flagged, 0, 0), () => 0); // d4 -> 1
  assert.equal(st.flags.length, 1);
  const f = st.flags[0];
  assert.equal(f.terrain, 'HO');
  assert.equal(f.progress, 1);
  assert.equal(f.target, 1 + 3 + 1);

  let res;
  for (let q = 1; q <= 4; q++) {
    const t = put(b, ALL('HO'), q, 0);
    res = processPlacement(st, e, result(t, q, 0), () => 0);
  }
  assert.equal(res.completed.length, 1);
  assert.equal(res.completed[0].id, f.id);
  assert.equal(res.points, 60);
  assert.equal(res.tiles, 2);
  assert.equal(st.flagsCompleted, 1);
  assert.equal(st.flags.length, 0);
});

test('sealed flagged group fades quietly: no reward, no penalty', () => {
  const st = bare();
  const b = createBoard();
  const e = env({ board: b });
  const flagged = tt(ALL('HO'), { flag: {} });
  put(b, flagged, 0, 0);
  processPlacement(st, e, result(flagged, 0, 0), () => 0);
  assert.equal(st.flags.length, 1);
  // surround with grass: every HO edge blocked -> group sealed
  const ring = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  let last;
  for (const [q, r] of ring) last = put(b, ALL('GR'), q, r);
  const res = processPlacement(st, e, result(last, 0, 1), () => 0);
  assert.equal(st.flags.length, 0);
  assert.equal(st.flagsFaded, 1);
  assert.equal(st.flagsCompleted, 0);
  assert.equal(res.points, 0);
});

test('max 3 flags: a 4th flagged placement spawns no quest', () => {
  const st = bare();
  st.flags = [{ id: 'a' }, { id: 'b' }, { id: 'c' }].map((f) => ({
    ...f, flag: true, key: '9,9', terrain: 'HO', target: 99, progress: 1, points: 60, tiles: 2,
  }));
  const b = createBoard();
  const flagged = tt(ALL('FO'), { flag: {} });
  put(b, flagged, 0, 0);
  // distant flag groups aren't sealed (their key cells are unoccupied here),
  // so they persist; the new flag must not spawn
  st.flags.forEach((f) => { f.key = '9,9'; });
  put(b, tt(ALL('HO')), 9, 9);
  processPlacement(st, env({ board: b }), result(flagged, 0, 0), () => 0);
  assert.equal(st.flags.length, 3);
  assert.ok(!st.flags.some((f) => f.terrain === 'FO'));
});

test('isIslandRinged: >=3 land tiles fully ringed by pure-water tiles', () => {
  const b = createBoard();
  const land = [[0, 0], [1, 0], [0, 1]];
  for (const [q, r] of land) put(b, ALL('GR'), q, r);
  const ring = [
    [1, -1], [0, -1], [-1, 0], [-1, 1], [2, 0], [2, -1], [1, 1], [-1, 2], [0, 2],
  ];
  for (const [q, r] of ring) put(b, ALL('OC'), q, r);
  assert.equal(isIslandRinged(b, 3), true);

  // a lane tile counts as water in the ring
  put(b, ['LA', 'OC', 'OC', 'LA', 'OC', 'OC'], 2, 0);
  assert.equal(isIslandRinged(b, 3), true);

  // open a gap -> not ringed
  b.delete('0,-1');
  assert.equal(isIslandRinged(b, 3), false);

  // region of 1 ringed: below minRegion
  const b2 = createBoard();
  put(b2, ALL('GR'), 0, 0);
  for (const [q, r] of [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]) put(b2, ALL('OC'), q, r);
  assert.equal(isIslandRinged(b2, 3), false);
  assert.equal(isIslandRinged(b2, 1), true);
});

test('epic crownTheRange: two peakCrowned events complete it', () => {
  const st = bare();
  st.epic = { id: 'crownTheRange', epic: true, points: 350, tiles: 5, peaks: 2, target: 2, progress: 0, done: false };
  const e = env();
  const tile = tt(ALL('GR'));
  let res = processPlacement(st, e, result(tile, 0, 0, [{ type: 'peakCrowned' }]), () => 0);
  assert.equal(st.epic.progress, 1);
  assert.equal(st.epic.done, false);
  assert.deepEqual(res.progressed, [{ id: 'crownTheRange', progress: 1, target: 2 }]);
  res = processPlacement(st, e, result(tile, 1, 0, [{ type: 'peakCrowned' }]), () => 0);
  assert.equal(st.epic.done, true);
  assert.equal(res.completed[0].id, 'crownTheRange');
  assert.equal(res.points, 350);
  assert.equal(res.tiles, 5);
});

test('epic transcontinental: trade route with rail >=6 and lane >=5', () => {
  const b = createBoard();
  // crane harbor A, dock at edge 0, rail at edge 4
  put(b, ['OC', 'OC', 'GR', 'HO', 'RA', 'GR'], 0, 0, { dockEdges: [0], crane: true });
  for (let q = 1; q <= 5; q++) put(b, ['LA', 'OC', 'OC', 'LA', 'OC', 'OC'], q, 0); // lane length 5
  put(b, ['HO', 'GR', 'GR', 'OC', 'OC', 'GR'], 6, 0, { dockEdges: [3] }); // harbor B
  const rail = ['GR', 'RA', 'GR', 'GR', 'RA', 'GR'];
  for (let i = 1; i <= 4; i++) put(b, rail, -i, i); // rail network = harbor + 4 = 5

  const epic = () => ({ id: 'transcontinental', epic: true, points: 400, tiles: 6, minRail: 6, minLane: 5, target: 1, progress: 0, done: false });
  const ev = [{ type: 'tradeRoute', pair: tradeRoutePairKey('0,0', '6,0') }];
  const tile = tt(ALL('GR'));

  const st = bare();
  st.epic = epic();
  processPlacement(st, env({ board: b }), result(tile, 0, 0, ev), () => 0);
  assert.equal(st.epic.done, false, 'rail network of 5 is not enough');

  put(b, rail, -5, 5); // rail network now 6
  const res = processPlacement(st, env({ board: b }), result(tile, 0, 0, ev), () => 0);
  assert.equal(st.epic.done, true);
  assert.equal(res.points, 400);
  assert.equal(res.tiles, 6);
});

test('createQuestState: 3 distinct standard quests, one epic, 1 starting reroll', () => {
  const st = createQuestState(env(), mulberry32(7));
  assert.equal(st.standard.length, 3);
  assert.equal(new Set(st.standard.map((q) => q.id)).size, 3);
  assert.ok(CONFIG.quests.epics.some((d) => d.id === st.epic.id));
  assert.equal(st.epic.done, false);
  assert.equal(st.rerolls, 1);
  assert.equal(activeQuests(st).length, 4);
});

test('themed reward draws: 60% themed to an active quest, else stage table', () => {
  const st = bare();
  st.standard = [{ id: 'longRiver', metric: 'network:RI', target: 6, progress: 0, points: 160, tiles: 4 }];
  const themed = drawQuestRewardTile(st, seq([0.1]));
  assert.equal(themed.archetype, 'river');
  assert.equal(drawQuestRewardTile(st, seq([0.99])), null, 'roll >= 0.6 -> stage table');

  const flagged = bare();
  flagged.flags = [{ id: 'flag:0,0', flag: true, key: '0,0', terrain: 'HO', target: 5, progress: 1, points: 60, tiles: 2 }];
  assert.equal(drawQuestRewardTile(flagged, seq([0.0, 0.0])).archetype, 'hamlet');

  assert.equal(drawQuestRewardTile(bare(), seq([0.0])), null, 'no active quests');
});

test('measureMetric: groups vs networks', () => {
  const b = createBoard();
  put(b, ['RI', 'GR', 'GR', 'RI', 'GR', 'GR'], 0, 0);
  put(b, ['RI', 'GR', 'GR', 'RI', 'GR', 'GR'], 1, 0);
  put(b, ALL('FO'), 0, 2);
  assert.equal(measureMetric(b, 'network:RI'), 2);
  assert.equal(measureMetric(b, 'group:FO'), 1);
  assert.equal(measureMetric(b, 'group:MT'), 0);
});
