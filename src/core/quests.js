// Quest layer (DESIGN §6): standard pool with availability stages, dead-quest
// guard, +2 scaling, rerolls; the per-run Epic (island ring detection,
// transcontinental, crown the range); flagged-tile quests; themed reward draws.
// Pure: all randomness via the injected rng.

import { CONFIG } from './config.js';
import { key, parseKey, neighbor, neighbors } from './hex.js';
import { isSoft } from './terrain.js';
import { groups, largestGroupSize, traceNetworks } from './board.js';
import { makeTile, rotateTile } from './tiles.js';
import { pick, shuffle } from './rng.js';

const STAGE_ORDER = { pastoral: 0, highlands: 1, tide: 2, voyage: 3 };

function die(rng, n) {
  return 1 + Math.floor(rng() * n);
}

// metric 'group:XX' -> largest XX group; 'network:XX' -> longest XX network.
export function measureMetric(board, metric) {
  const [kind, terrain] = metric.split(':');
  if (kind === 'group') return largestGroupSize(board, terrain);
  return traceNetworks(board, terrain).reduce((m, n) => Math.max(m, n.size), 0);
}

// Two harbors (docked tiles) on the same ocean group.
export function twinHarborsOnBoard(board) {
  for (const g of groups(board, 'OC')) {
    let docks = 0;
    for (const k of g) if (board.get(k).dockEdges.length > 0) docks++;
    if (docks >= 2) return true;
  }
  return false;
}

// The Island: a connected region of >= minRegion land tiles whose every
// neighbor cell holds a pure-water tile (all edges Oc/La). Coast/harbor tiles
// have soft edges, so they read as land and extend the region instead.
export function isIslandRinged(board, minRegion = 3) {
  const isSea = (t) => t.edges.every((e) => e === 'OC' || e === 'LA');
  const seen = new Set();
  for (const [start, t0] of board) {
    if (seen.has(start) || isSea(t0)) continue;
    const comp = [start];
    const compSet = new Set([start]);
    seen.add(start);
    let ringed = true;
    for (let i = 0; i < comp.length; i++) {
      const { q, r } = parseKey(comp[i]);
      for (const n of neighbors(q, r)) {
        const nk = key(n.q, n.r);
        if (compSet.has(nk)) continue;
        const nt = board.get(nk);
        if (!nt) { ringed = false; continue; }
        if (isSea(nt)) continue;
        compSet.add(nk);
        seen.add(nk);
        comp.push(nk);
      }
    }
    if (ringed && comp.length >= minRegion) return true;
  }
  return false;
}

// env (caller-maintained): { board, stage, lanesUnlocked, tilesRemaining }

function availableDefs(state, env, config, excludeId) {
  const qc = config.quests;
  const active = new Set(state.standard.map((q) => q.id));
  return qc.standard.filter((def) => {
    if (def.id === excludeId || active.has(def.id)) return false;
    if (def.from === 'lanesUnlocked') {
      if (!env.lanesUnlocked) return false;
    } else if (STAGE_ORDER[env.stage] < STAGE_ORDER[def.from]) return false;
    if (def.oneShot && (state.oneShotCompletions[def.id] || 0) >= qc.oneShotMaxCompletions) return false;
    if (def.id === 'twinHarbors' && twinHarborsOnBoard(env.board)) return false;
    return true;
  });
}

// Spawn one standard quest into state.standard. Numeric targets roll
// base + dN (+2 per completion, capped at base+8) and obey the dead-quest
// guard: target <= bestProgress + floor(tilesRemaining/4); if even the base
// violates the guard, a different quest is drawn. Returns the quest or null.
export function spawnStandardQuest(state, env, rng, config = CONFIG, excludeId = null) {
  const qc = config.quests;
  const candidates = shuffle(rng, availableDefs(state, env, config, excludeId));
  for (const def of candidates) {
    if (def.oneShot) {
      const quest = {
        id: def.id, oneShot: true, target: 1, progress: 0,
        points: def.points, tiles: def.tiles,
      };
      if (def.minLaneLength) quest.minLaneLength = def.minLaneLength;
      state.standard.push(quest);
      return quest;
    }
    const best = measureMetric(env.board, def.metric);
    const guard = best + Math.floor((env.tilesRemaining ?? Infinity) / qc.deadGuardDivisor);
    if (def.base > guard) continue;
    let target = def.base + die(rng, def.die) +
      Math.min(state.completedStandard * qc.scaling.perCompletion, qc.scaling.capAboveBase);
    target = Math.min(target, guard);
    if (target <= best) {
      if (best + 1 > guard) continue;
      target = best + 1; // never spawn pre-completed
    }
    const r = qc.reward;
    const quest = {
      id: def.id, metric: def.metric, target, progress: best,
      points: r.base + r.perTarget * target,
      tiles: Math.min(r.tileBase + Math.ceil(target / r.tileDivisor), r.tileCap),
    };
    state.standard.push(quest);
    return quest;
  }
  return null;
}

export function createQuestState(env, rng, config = CONFIG) {
  const state = {
    standard: [], epic: null, flags: [],
    completedStandard: 0,
    oneShotCompletions: {},
    rerolls: config.quests.rerolls.atStart,
    rerollsUsed: 0,
    flagsCompleted: 0,
    flagsFaded: 0,
  };
  for (let i = 0; i < config.quests.visibleStandard; i++) {
    spawnStandardQuest(state, env, rng, config);
  }
  const def = pick(rng, config.quests.epics);
  state.epic = { ...def, epic: true, target: def.peaks || 1, progress: 0, done: false };
  return state;
}

export function grantReroll(state, n = 1) {
  state.rerolls += n;
}

// Spend a reroll on standard slot `index`. The old quest is only discarded if
// a replacement exists; otherwise nothing is spent. Returns the new quest.
export function useReroll(state, index, env, rng, config = CONFIG) {
  if (state.rerolls <= 0) return null;
  const old = state.standard[index];
  if (!old) return null;
  const fresh = spawnStandardQuest(state, env, rng, config, old.id);
  if (!fresh) return null;
  state.standard.pop(); // spawn appended; move it into the rerolled slot
  state.standard[index] = fresh;
  state.rerolls--;
  state.rerollsUsed++;
  return fresh;
}

const FLAG_PRIORITY = ['HO', 'FO', 'FI', 'GR'];

function dominantSoftTerrain(edges) {
  const counts = {};
  for (const e of edges) if (isSoft(e)) counts[e] = (counts[e] || 0) + 1;
  let best = null;
  let bestN = 0;
  for (const t of FLAG_PRIORITY) {
    const n = counts[t] || 0;
    if (n > bestN) { best = t; bestN = n; }
  }
  return best;
}

function spawnFlag(state, board, result, rng, config) {
  const terrain = dominantSoftTerrain(result.tile.edges);
  if (!terrain) return;
  const k = key(result.q, result.r);
  const g = groups(board, terrain).find((s) => s.has(k));
  const current = g ? g.size : 1;
  const f = config.quests.flag;
  state.flags.push({
    id: 'flag:' + k, flag: true, key: k, terrain,
    target: current + f.targetBase + die(rng, f.targetDie),
    progress: current, points: f.points, tiles: f.tiles,
  });
}

// A group is sealed when no tile in it has a `terrain` edge facing empty space.
function groupSealed(board, g, terrain) {
  for (const k of g) {
    const t = board.get(k);
    const { q, r } = parseKey(k);
    for (let dir = 0; dir < 6; dir++) {
      if (t.edges[dir] !== terrain) continue;
      const n = neighbor(q, r, dir);
      if (!board.has(key(n.q, n.r))) return false;
    }
  }
  return true;
}

function oneShotProgress(q, events, board) {
  if (q.id === 'riversEnd') return events.some((e) => e.type === 'estuary') ? 1 : 0;
  if (q.id === 'twinHarbors') return twinHarborsOnBoard(board) ? 1 : 0;
  if (q.id === 'openTheRoute') {
    return events.some((e) => e.type === 'laneCompleted' && e.length >= (q.minLaneLength || 1)) ? 1 : 0;
  }
  return 0;
}

function transcontinentalSatisfied(board, events, epic) {
  const fires = events.filter((e) => e.type === 'tradeRoute');
  if (!fires.length) return false;
  const lanes = traceNetworks(board, 'LA');
  const rails = traceNetworks(board, 'RA');
  for (const e of fires) {
    const [a, b] = e.pair.split('|');
    const lane = lanes.find((n) =>
      n.completed && n.dockHarborKeys.includes(a) && n.dockHarborKeys.includes(b));
    if (!lane || lane.size < epic.minLane) continue;
    const railOk = [a, b].some((hk) => {
      const t = board.get(hk);
      if (!t || !t.crane) return false;
      const rn = rails.find((n) => n.keys.has(hk));
      return rn && rn.size >= epic.minRail;
    });
    if (railOk) return true;
  }
  return false;
}

// Advance every quest after a committed placement. `result` is the
// PlacementResult from scoring (board already contains result.tile).
// Returns { completed, progressed, points, tiles }.
export function processPlacement(state, env, result, rng, config = CONFIG) {
  const completed = [];
  const progressed = [];
  let points = 0;
  let tiles = 0;
  const events = result.networkEvents || [];
  const board = env.board;

  // flag spawn (§6.3) — flag-eligible draws while 3 are active spawn unflagged
  if (result.tile && result.tile.flag && state.flags.length < config.quests.maxFlags) {
    spawnFlag(state, board, result, rng, config);
  }

  // standard: progress pass
  for (const q of state.standard) {
    const prog = q.oneShot
      ? Math.max(q.progress, oneShotProgress(q, events, board))
      : measureMetric(board, q.metric);
    if (prog > q.progress) {
      q.progress = prog;
      progressed.push({ id: q.id, progress: prog, target: q.target });
    }
  }

  // standard: completions + respawns (fresh quests can never be pre-completed)
  for (let i = 0; i < state.standard.length; i++) {
    const q = state.standard[i];
    if (q.progress < q.target) continue;
    completed.push({ ...q });
    points += q.points;
    tiles += q.tiles;
    state.completedStandard++;
    if (q.oneShot) {
      state.oneShotCompletions[q.id] = (state.oneShotCompletions[q.id] || 0) + 1;
    }
    state.standard.splice(i, 1);
    spawnStandardQuest(state, env, rng, config);
    i--;
  }

  // epic
  const epic = state.epic;
  if (epic && !epic.done) {
    let prog = epic.progress;
    if (epic.id === 'theIsland') {
      if (isIslandRinged(board, epic.minRegion)) prog = 1;
    } else if (epic.id === 'crownTheRange') {
      prog += events.filter((e) => e.type === 'peakCrowned').length;
    } else if (epic.id === 'transcontinental') {
      if (transcontinentalSatisfied(board, events, epic)) prog = 1;
    }
    if (prog > epic.progress) {
      epic.progress = prog;
      progressed.push({ id: epic.id, progress: prog, target: epic.target });
    }
    if (epic.progress >= epic.target) {
      epic.done = true;
      completed.push({ ...epic });
      points += epic.points;
      tiles += epic.tiles;
    }
  }

  // flags: grow -> complete; sealed -> quiet fade (cozy mandate)
  const kept = [];
  for (const f of state.flags) {
    const g = groups(board, f.terrain).find((s) => s.has(f.key)) || new Set([f.key]);
    if (g.size > f.progress) {
      f.progress = g.size;
      progressed.push({ id: f.id, progress: f.progress, target: f.target });
    }
    if (f.progress >= f.target) {
      completed.push({ ...f });
      points += f.points;
      tiles += f.tiles;
      state.flagsCompleted++;
      continue;
    }
    if (groupSealed(board, g, f.terrain)) {
      state.flagsFaded++;
      continue;
    }
    kept.push(f);
  }
  state.flags = kept;

  return { completed, progressed, points, tiles };
}

export function activeQuests(state) {
  const out = state.standard.slice();
  if (state.epic && !state.epic.done) out.push(state.epic);
  return out.concat(state.flags);
}

// §6.4 themed reward archetypes per quest.
const THEMES = {
  bigForest: ['pureSoft', 'meadow'],
  bigField: ['meadow'],
  bigVillage: ['hamlet', 'pureSoft'],
  longRiver: ['river'],
  railLine: ['rail'],
  mountainRange: ['foothills', 'highMountain'],
  growTheOcean: ['coast', 'openOcean'],
  riversEnd: ['estuary', 'river'],
  twinHarbors: ['harbor', 'coast'],
  openTheRoute: ['lane', 'harbor'],
  theIsland: ['coast', 'openOcean'],
  transcontinental: ['rail', 'lane', 'harbor'],
  crownTheRange: ['foothills', 'highMountain'],
};

const FLAG_THEMES = { HO: 'hamlet', FO: 'pureSoft', FI: 'meadow', GR: 'meadow' };

// 60% of quest-reward tiles are themed to a currently active quest; the other
// 40% return null and the caller draws from the stage table instead.
export function drawQuestRewardTile(state, rng, config = CONFIG) {
  if (rng() >= config.quests.themedRewardRate) return null;
  const candidates = activeQuests(state).filter((q) => q.terrain ? FLAG_THEMES[q.terrain] : THEMES[q.id]);
  if (!candidates.length) return null;
  const q = pick(rng, candidates);
  const archetype = q.terrain ? FLAG_THEMES[q.terrain] : pick(rng, THEMES[q.id]);
  let tile = makeTile(archetype, rng, config);
  const rot = Math.floor(rng() * 6);
  if (rot) tile = rotateTile(tile, rot);
  return tile;
}
