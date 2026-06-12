// Headless autoplay policies over the Game API (SPEC sim/, DESIGN §10).
// Each policy is (game, rng, opts) -> action:
//   { type: 'place', q, r, rotation } | { type: 'discard' } | { type: 'reroll', index }
// Policies never mutate game state; candidates are scored via the dry-run
// scorePlacement, pruned first by a cheap per-edge estimate so 200-game
// batches stay fast. All randomness flows through the injected rng.

import { CONFIG } from '../src/core/config.js';
import { Game } from '../src/core/game.js';
import { mulberry32 } from '../src/core/rng.js';
import { key, parseKey, neighbor, neighbors, opposite } from '../src/core/hex.js';
import { rotateTile, isPeakCandidate } from '../src/core/tiles.js';
import { placementRelations, groups } from '../src/core/board.js';
import { scorePlacement } from '../src/core/scoring.js';

// Sim-only policy weights. These tune the bots, not the game — every game
// number stays in CONFIG.
export const HEURISTICS = {
  topK: 12,            // candidates fully scored via scorePlacement
  extraPool: 8,        // extra junction/crowning candidates pulled into the pool
  questStep: 18,       // per tile of progress toward an active numeric quest
  twinHarborsLikely: 0.5, // fraction of quest points for a probable twin-harbor
  flagStep: 20,
  epicRailStep: 6,
  epicOceanEdge: 8,
  epicPeakFace: 18,
  tradeRouteEpicBonus: 100,
  junctionSetup: 12,   // open river end left near mountain/ocean (cappable later)
  crowdEndPenalty: 8,  // per river/lane continuation cell the candidate crowds
  harborSetup: 12,     // dock facing a lane continuation cell
  staleQuestSlack: 1,  // reroll when need > stackRemaining/guardDivisor + slack
  discardMinStack: 20, // strategic discard only with this much stack left
};

// Distinct rotations of the tile in hand (rotational symmetry deduped) mapped
// over the legal cells: [{ q, r, rotation, tile }].
function enumerateCandidates(game) {
  const tile = game.currentTile;
  const rotTiles = [];
  const sigs = new Set();
  for (let rot = 0; rot < 6; rot++) {
    const t = rot === 0 ? tile : rotateTile(tile, rot);
    const sig = t.edges.join(',') + '|' + t.dockEdges.join(',');
    if (sigs.has(sig)) rotTiles.push(null);
    else { sigs.add(sig); rotTiles.push(t); }
  }
  const out = [];
  for (const cell of game.legalPlacements()) {
    for (const rot of cell.rotations) {
      const t = rotTiles[rot];
      if (t) out.push({ q: cell.q, r: cell.r, rotation: rot, tile: t });
    }
  }
  return out;
}

// Cheap pre-score: edge points + junction bonuses + first-perfect estimate.
// Misses streaks/structures — those only matter for the fully-scored pool.
function cheapScore(game, c) {
  const cfg = game.config;
  let pts = 0;
  let nbs = 0;
  let allMatched = true;
  c.hasJunction = false;
  for (const { neighborTile, rel } of placementRelations(game.board, c.tile, c.q, c.r, cfg)) {
    if (!neighborTile) continue;
    nbs++;
    pts += rel.points;
    if (rel.junction) {
      pts += cfg.scoring.junction[rel.junction] || 0;
      c.hasJunction = true;
    } else if (rel.points === 0) allMatched = false;
  }
  if (nbs === 6 && allMatched) pts += cfg.scoring.perfect.ladder[0];
  return pts;
}

// Empty cells that would be the 6th neighbor of an uncrowned Peak candidate.
function crowningCells(game) {
  const out = new Set();
  for (const [k, t] of game.board) {
    if (game.ctx.crownedPeaks.has(k) || !isPeakCandidate(t, game.config)) continue;
    const { q, r } = parseKey(k);
    let empty = null;
    let emptyCount = 0;
    for (const n of neighbors(q, r)) {
      const nk = key(n.q, n.r);
      if (!game.board.has(nk)) { empty = nk; emptyCount++; }
    }
    if (emptyCount === 1) out.add(empty);
  }
  return out;
}

// Board-derived context computed once per decision for questAware bonuses.
function turnContext(game) {
  const board = game.board;
  const capTargets = new Set(); // tiles with MT or OC edges (river cap partners)
  const riverEndCells = new Set();
  const laneEndCells = new Set();
  const peaks = new Set();
  let dockCount = 0;
  for (const [k, t] of board) {
    let hasCap = false;
    const { q, r } = parseKey(k);
    for (let dir = 0; dir < 6; dir++) {
      const e = t.edges[dir];
      if (e === 'MT' || e === 'OC') hasCap = true;
      if (e !== 'RI' && e !== 'LA') continue;
      const n = neighbor(q, r, dir);
      const nk = key(n.q, n.r);
      if (!board.has(nk)) (e === 'RI' ? riverEndCells : laneEndCells).add(nk);
    }
    if (hasCap) capTargets.add(k);
    if (t.dockEdges.length) dockCount++;
    if (!game.ctx.crownedPeaks.has(k) && isPeakCandidate(t, game.config)) peaks.add(k);
  }
  const flagGroups = game.quests.flags.map((f) => ({
    flag: f,
    members: groups(board, f.terrain).find((g) => g.has(f.key)) || new Set([f.key]),
  }));
  return { capTargets, riverEndCells, laneEndCells, peaks, dockCount, flagGroups };
}

// Heuristic bonus on top of dry-run points: quest/epic/flag progress, junction
// setup, keeping rivers cappable and lanes harborable.
function questBonus(game, c, result, tctx) {
  const H = HEURISTICS;
  let bonus = 0;
  const sizeByTerrain = {};
  for (const g of result.groupsExtended) sizeByTerrain[g.terrain] = g.size;
  const events = result.networkEvents;

  for (const q of game.quests.standard) {
    if (q.oneShot) {
      let hit = false;
      if (q.id === 'riversEnd') hit = events.some((e) => e.type === 'estuary');
      else if (q.id === 'openTheRoute') {
        hit = events.some((e) => e.type === 'laneCompleted' && e.length >= (q.minLaneLength || 1));
      } else if (q.id === 'twinHarbors' && c.tile.dockEdges.length && tctx.dockCount > 0) {
        if (result.edgeMatches.some((m) => m.terrain === 'OC' && m.matched)) {
          bonus += q.points * H.twinHarborsLikely;
        }
      }
      if (hit) bonus += q.points;
      continue;
    }
    const terrain = q.metric.split(':')[1];
    const size = sizeByTerrain[terrain];
    if (size === undefined) continue;
    if (size >= q.target) bonus += q.points;
    else if (size > q.progress) bonus += H.questStep * (size - q.progress);
  }

  const epic = game.quests.epic;
  if (epic && !epic.done) {
    if (epic.id === 'transcontinental') {
      const ra = sizeByTerrain.RA;
      if (ra) bonus += H.epicRailStep * Math.min(ra, epic.minRail);
      if (events.some((e) => e.type === 'tradeRoute')) bonus += H.tradeRouteEpicBonus;
    } else if (epic.id === 'theIsland') {
      for (const m of result.edgeMatches) {
        if (m.terrain === 'OC' && m.matched) bonus += H.epicOceanEdge;
      }
    } else if (epic.id === 'crownTheRange') {
      const crowns = events.filter((e) => e.type === 'peakCrowned').length;
      if (crowns && epic.progress + crowns >= epic.target) bonus += epic.points;
      for (let dir = 0; dir < 6; dir++) {
        const n = neighbor(c.q, c.r, dir);
        if (!tctx.peaks.has(key(n.q, n.r))) continue;
        const e = c.tile.edges[dir];
        if (e === 'MT' || e === 'RI') bonus += H.epicPeakFace;
      }
    }
  }

  for (const { flag, members } of tctx.flagGroups) {
    for (let dir = 0; dir < 6; dir++) {
      if (c.tile.edges[dir] !== flag.terrain) continue;
      const n = neighbor(c.q, c.r, dir);
      const nk = key(n.q, n.r);
      if (!members.has(nk)) continue;
      const nt = game.board.get(nk);
      if (nt.edges[opposite(dir)] !== flag.terrain) continue;
      bonus += members.size + 1 >= flag.target ? flag.points : H.flagStep;
      break;
    }
  }

  // junction setup: leave open river ends within reach of a mountain/ocean tile
  for (let dir = 0; dir < 6; dir++) {
    if (c.tile.edges[dir] !== 'RI') continue;
    const n = neighbor(c.q, c.r, dir);
    if (game.board.has(key(n.q, n.r))) continue;
    for (const nn of neighbors(n.q, n.r)) {
      if (tctx.capTargets.has(key(nn.q, nn.r))) { bonus += HEURISTICS.junctionSetup; break; }
    }
  }

  // cappable rivers / harborable lanes: don't crowd their continuation cells
  for (const n of neighbors(c.q, c.r)) {
    const nk = key(n.q, n.r);
    if (tctx.riverEndCells.has(nk) || tctx.laneEndCells.has(nk)) bonus -= H.crowdEndPenalty;
  }

  // harbor setup: a dock facing a lane continuation cell invites a port call
  for (const di of c.tile.dockEdges) {
    const n = neighbor(c.q, c.r, di);
    if (tctx.laneEndCells.has(key(n.q, n.r))) bonus += H.harborSetup;
  }
  return bonus;
}

// Index of a standard quest worth rerolling, or -1. A quest is stale when its
// remaining need exceeds what the dead-quest guard would allow at spawn time;
// landOnly also dumps ocean-dependent quests it can never progress.
const OCEAN_QUESTS = new Set(['growTheOcean', 'riversEnd', 'twinHarbors', 'openTheRoute']);

function staleQuestIndex(game, landOnly) {
  if (game.quests.rerolls <= 0) return -1;
  const div = game.config.quests.deadGuardDivisor;
  const allowance = Math.floor(game.stackRemaining / div) + HEURISTICS.staleQuestSlack;
  for (let i = 0; i < game.quests.standard.length; i++) {
    const q = game.quests.standard[i];
    if (landOnly && OCEAN_QUESTS.has(q.id)) return i;
    if (!q.oneShot && q.target - q.progress > allowance) return i;
  }
  return -1;
}

function scoredChoice(game, rng, aware, opts = {}) {
  if (aware && !opts.noReroll) {
    const idx = staleQuestIndex(game, !!opts.landOnly);
    if (idx >= 0) return { type: 'reroll', index: idx };
  }
  const cands = enumerateCandidates(game);
  if (!cands.length) return { type: 'discard' };
  for (const c of cands) c.cheap = cheapScore(game, c);
  cands.sort((a, b) => b.cheap - a.cheap || rng() - 0.5);

  const pool = cands.slice(0, HEURISTICS.topK);
  const crowns = crowningCells(game);
  let extra = 0;
  for (let i = HEURISTICS.topK; i < cands.length && extra < HEURISTICS.extraPool; i++) {
    const c = cands[i];
    if (c.hasJunction || crowns.has(key(c.q, c.r))) { pool.push(c); extra++; }
  }

  const tctx = aware ? turnContext(game) : null;
  let best = null;
  let bestVal = -Infinity;
  let bestPoints = 0;
  for (const c of pool) {
    const res = scorePlacement(game.board, c.tile, c.q, c.r, game.ctx, game.config);
    if (!res) continue;
    let val = res.points + rng() * 1e-3;
    if (aware) val += questBonus(game, c, res, tctx);
    if (val > bestVal) { bestVal = val; bestPoints = res.points; best = c; }
  }
  if (!best) return { type: 'discard' };
  // strategic discard: only when even the best spot pays nothing and the stack
  // can absorb the lost tile (rare; winds-shift already filters dead hands)
  if (aware && bestPoints <= 0 && bestVal <= 0 &&
      game.stackRemaining > HEURISTICS.discardMinStack) {
    return { type: 'discard' };
  }
  return { type: 'place', q: best.q, r: best.r, rotation: best.rotation };
}

export const POLICIES = {
  // uniform over all legal (cell, rotation) pairs
  random(game, rng) {
    const cands = [];
    for (const cell of game.legalPlacements()) {
      for (const rot of cell.rotations) cands.push({ q: cell.q, r: cell.r, rotation: rot });
    }
    if (!cands.length) return { type: 'discard' };
    const c = cands[Math.floor(rng() * cands.length)];
    return { type: 'place', ...c };
  },
  // max immediate dry-run points
  greedy(game, rng, opts) {
    return scoredChoice(game, rng, false, opts);
  },
  // greedy + quest/epic/flag weighting, junction setup, cappability heuristics
  questAware(game, rng, opts) {
    return scoredChoice(game, rng, true, opts);
  },
  // questAware that never places an ocean-family tile (no-dominant-strategy gate)
  landOnly(game, rng, opts = {}) {
    const fam = new Set(game.config.weights.oceanFamily);
    if (fam.has(game.currentTile.archetype)) return { type: 'discard' };
    return scoredChoice(game, rng, true, { ...opts, landOnly: true });
  },
};

export const POLICY_NAMES = Object.keys(POLICIES);

// Drive one full game under a policy. Returns game.stats plus sim extras
// (archetype draw counts, mountain draw share, quest completion rate).
export function runGame({ policy, seed = 1, config = CONFIG, maxActions = 5000 }) {
  const fn = typeof policy === 'function' ? policy : POLICIES[policy];
  if (!fn) throw new Error('unknown policy: ' + policy);
  const game = new Game({ seed, config });
  const rng = mulberry32((seed ^ 0x5bd1e995) >>> 0); // policy rng, separate stream
  const drawCounts = {};
  let handsSeen = 0;
  let lastHandId = null;
  let actions = 0;
  let noReroll = false;
  while (!game.over && actions < maxActions) {
    actions++;
    const hand = game.currentTile;
    if (!hand) break;
    if (hand.id !== lastHandId) {
      lastHandId = hand.id;
      handsSeen++;
      drawCounts[hand.archetype] = (drawCounts[hand.archetype] || 0) + 1;
    }
    const action = fn(game, rng, { noReroll });
    if (action.type === 'reroll') {
      if (!game.rerollQuest(action.index)) noReroll = true; // no replacement: stop trying this turn
      continue;
    }
    noReroll = false;
    if (action.type === 'discard') {
      game.discard();
      continue;
    }
    if (action.rotation) game.rotate(action.rotation);
    if (!game.place(action.q, action.r)) game.discard(); // policy bug guard: keep moving
  }
  const stats = game.stats;
  const activeStandard = game.quests.standard.length;
  const offered = stats.standardQuestsCompleted + stats.rerollsUsed + activeStandard;
  const mtDraws = (drawCounts.foothills || 0) + (drawCounts.highMountain || 0);
  return {
    ...stats,
    policy: typeof policy === 'function' ? policy.name || 'custom' : policy,
    finished: game.over,
    actions,
    handsSeen,
    drawCounts,
    mountainDrawShare: handsSeen ? mtDraws / handsSeen : 0,
    questCompletionRate: offered ? stats.standardQuestsCompleted / offered : 0,
    epicDone: !!(stats.epic && stats.epic.done),
  };
}
