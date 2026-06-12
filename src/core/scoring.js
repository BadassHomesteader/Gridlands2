// Placement scoring (DESIGN §3, §5): per-edge points, capped junction bonuses,
// clean streak, escalating perfects, structure completions, trade income,
// end-game bonuses. scorePlacement = dry-run; applyPlacement commits.

import { CONFIG } from './config.js';
import { key, parseKey, neighbor, opposite } from './hex.js';
import { isSoft } from './terrain.js';
import {
  canPlace, placementRelations, groups, traceNetworks, hinterland,
} from './board.js';
import { isPeakCandidate } from './tiles.js';

export function createScoringContext() {
  return {
    streak: 0,
    consecutivePerfects: 0,
    sourcePaid: new Set(),       // river-network keys that paid a source bonus
    estuaryPaid: new Set(),      // river-network keys that paid an estuary bonus
    riversCompleted: new Set(),  // keys of river networks that paid riverCompleted
    lanesCompleted: new Set(),   // keys of lane routes that paid laneCompleted
    crownedPeaks: new Set(),     // keys of crowned Peak tiles
    snowlineKeys: new Set(),     // keys of mountain groups that fired snowline
    firedTradeRoutes: new Set(), // sorted 'keyA|keyB' harbor pairs
  };
}

function cloneCtx(ctx) {
  return {
    streak: ctx.streak,
    consecutivePerfects: ctx.consecutivePerfects,
    sourcePaid: new Set(ctx.sourcePaid),
    estuaryPaid: new Set(ctx.estuaryPaid),
    riversCompleted: new Set(ctx.riversCompleted),
    lanesCompleted: new Set(ctx.lanesCompleted),
    crownedPeaks: new Set(ctx.crownedPeaks),
    snowlineKeys: new Set(ctx.snowlineKeys),
    firedTradeRoutes: new Set(ctx.firedTradeRoutes),
  };
}

function anyKeyIn(keys, set) {
  for (const k of keys) if (set.has(k)) return true;
  return false;
}

function addAll(keys, set) {
  for (const k of keys) set.add(k);
}

export function tradeRoutePairKey(harborKeyA, harborKeyB) {
  return [harborKeyA, harborKeyB].sort().join('|');
}

function evaluate(board, tile, q, r, ctx, config) {
  if (!canPlace(board, tile, q, r, config).legal) return null;
  const s = config.scoring;
  const k = key(q, r);

  const completedLanesBefore = traceNetworks(board, 'LA').filter((n) => n.completed).length;

  const after = new Map(board);
  after.set(k, tile);
  const riverNetsAfter = traceNetworks(after, 'RI');
  const laneNetsAfter = traceNetworks(after, 'LA');
  const next = cloneCtx(ctx);

  // --- per-edge points + junction bonuses (§3.1 / §5.1)
  let edgePoints = 0;
  let junctionPoints = 0;
  let placedNeighbors = 0;
  let softMismatch = false;
  const edgeMatches = [];
  const networkEvents = [];

  for (const { dir, neighborTile, neighborKey, rel } of placementRelations(board, tile, q, r, config)) {
    if (!neighborTile) continue;
    placedNeighbors++;
    const a = tile.edges[dir];
    const b = neighborTile.edges[opposite(dir)];
    edgePoints += rel.points;
    if (isSoft(a) && isSoft(b) && a !== b) softMismatch = true;
    const matched = rel.points > 0 || rel.junction !== null; // junctions count as matched
    edgeMatches.push({ dir, matched, terrain: a });

    if (rel.junction === 'source' || rel.junction === 'estuary') {
      // one source + one estuary bonus per river network (extras: edge points only)
      const paidSet = rel.junction === 'source' ? next.sourcePaid : next.estuaryPaid;
      const riverKey = a === 'RI' ? k : neighborKey;
      const net = riverNetsAfter.find((n) => n.keys.has(riverKey));
      if (net && !anyKeyIn(net.keys, paidSet)) {
        const pts = s.junction[rel.junction];
        junctionPoints += pts;
        addAll(net.keys, paidSet);
        networkEvents.push({ type: rel.junction === 'source' ? 'spring' : 'estuary', dir, points: pts });
      }
    } else if (rel.junction === 'portCall' || rel.junction === 'cliff') {
      const pts = s.junction[rel.junction];
      junctionPoints += pts;
      networkEvents.push({ type: rel.junction, dir, points: pts });
    }
  }

  // --- clean / dirty / neutral + streak (§2, §5.2)
  const allFacingMatched = edgeMatches.every((m) => m.matched);
  let cleanliness;
  if (softMismatch) cleanliness = 'dirty';
  else if (placedNeighbors >= 2 && allFacingMatched) cleanliness = 'clean';
  else cleanliness = 'neutral';

  let streakPoints = 0;
  if (cleanliness === 'dirty') next.streak = 0;
  else if (cleanliness === 'clean') {
    next.streak = ctx.streak + 1;
    streakPoints = Math.min(next.streak * s.streak.per, s.streak.cap);
  }

  // --- perfect placement (§5.3): 6 neighbors, all 6 edges matched
  const perfect = placedNeighbors === 6 && allFacingMatched;
  let perfectPoints = 0;
  let tilesAwarded = 0;
  if (perfect) {
    const ladder = s.perfect.ladder;
    perfectPoints = ladder[Math.min(ctx.consecutivePerfects, ladder.length - 1)];
    next.consecutivePerfects = ctx.consecutivePerfects + 1;
    tilesAwarded += s.perfect.bonusTiles;
  } else {
    next.consecutivePerfects = 0;
  }

  // --- structure completions (§5.4)
  let structurePoints = 0;

  for (const net of riverNetsAfter) {
    if (!net.completed || anyKeyIn(net.keys, next.riversCompleted)) continue;
    const pts = s.structures.riverCompleted.perTile * net.size;
    structurePoints += pts;
    tilesAwarded += s.structures.riverCompleted.tiles;
    addAll(net.keys, next.riversCompleted);
    networkEvents.push({ type: 'riverCompleted', length: net.size, points: pts });
  }

  for (const net of laneNetsAfter) {
    if (!net.completed || anyKeyIn(net.keys, next.lanesCompleted)) continue;
    const hinterlands = net.dockHarborKeys.map((hk) => hinterland(after, hk));
    const hSum = hinterlands.reduce((a, b) => a + b, 0);
    const pts = s.structures.laneCompleted.perTile * net.size +
      s.structures.laneCompleted.perHinterland * hSum;
    structurePoints += pts;
    tilesAwarded += s.structures.laneCompleted.tiles;
    addAll(net.keys, next.lanesCompleted);
    networkEvents.push({ type: 'laneCompleted', length: net.size, hinterlands, points: pts });
  }

  // peak crowning (§5.5) — retroactive: check every uncrowned candidate
  for (const [pk, pt] of after) {
    if (next.crownedPeaks.has(pk) || !isPeakCandidate(pt, config)) continue;
    const { q: pq, r: pr } = parseKey(pk);
    let crowned = true;
    for (let dir = 0; dir < 6 && crowned; dir++) {
      const n = neighbor(pq, pr, dir);
      const nt = after.get(key(n.q, n.r));
      if (!nt) crowned = false; // all 6 neighbor cells must be occupied
      else if (pt.edges[dir] === 'MT') {
        const f = nt.edges[opposite(dir)];
        if (f !== 'MT' && f !== 'RI') crowned = false; // engaged rock face only
      }
    }
    if (crowned) {
      structurePoints += s.structures.peakCrowned.points;
      tilesAwarded += s.structures.peakCrowned.tiles;
      next.crownedPeaks.add(pk);
      networkEvents.push({ type: 'peakCrowned', key: pk, points: s.structures.peakCrowned.points });
    }
  }

  // trade routes (§5.6)
  const newPairs = [];
  let railNetsAfter = null;
  for (const net of laneNetsAfter) {
    if (!net.completed) continue;
    const harbors = [...new Set(net.dockHarborKeys)];
    for (let i = 0; i < harbors.length; i++) {
      for (let j = i + 1; j < harbors.length; j++) {
        const pairKey = tradeRoutePairKey(harbors[i], harbors[j]);
        if (next.firedTradeRoutes.has(pairKey)) continue;
        if (!railNetsAfter) railNetsAfter = traceNetworks(after, 'RA');
        const ok = [harbors[i], harbors[j]].some((hk) => {
          const ht = after.get(hk);
          if (!ht.crane) return false;
          const rn = railNetsAfter.find((n) => n.keys.has(hk));
          return rn && rn.size >= s.structures.tradeRoute.minRailNetwork;
        });
        if (ok) newPairs.push(pairKey);
      }
    }
  }
  if (newPairs.length) {
    newPairs.sort(); // all new pairs are worth the same; fire deterministically
    newPairs.forEach((pairKey, i) => {
      const full = i === 0;
      const pts = full ? s.structures.tradeRoute.points : s.structures.tradeRoute.extraPairPoints;
      structurePoints += pts;
      if (full) tilesAwarded += s.structures.tradeRoute.tiles;
      next.firedTradeRoutes.add(pairKey);
      networkEvents.push({ type: 'tradeRoute', pair: pairKey, points: pts, extra: !full });
    });
  }

  // snowline (§5.4): once per mountain-group lineage; merges never re-fire
  const mtGroupsAfter = groups(after, 'MT');
  for (const g of mtGroupsAfter) {
    if (g.size < s.structures.snowline.groupSize || anyKeyIn(g, next.snowlineKeys)) continue;
    structurePoints += s.structures.snowline.points;
    addAll(g, next.snowlineKeys);
    networkEvents.push({ type: 'snowline', size: g.size, points: s.structures.snowline.points });
  }

  // --- trade income (§5.7): pays on placements after routes complete
  let tradeIncomePoints = 0;
  if (config.rules.tradeIncome && completedLanesBefore > 0) {
    tradeIncomePoints = Math.min(
      completedLanesBefore * s.tradeIncome.perRoute,
      s.tradeIncome.cap,
    );
  }

  // --- groups extended (for HUD/celebrations)
  const groupsExtended = [];
  for (const terrain of new Set(tile.edges)) {
    const g = groups(after, terrain).find((g) => g.has(k));
    if (g) groupsExtended.push({ terrain, size: g.size });
  }

  const points = edgePoints + junctionPoints + streakPoints + perfectPoints +
    structurePoints + tradeIncomePoints;

  const result = {
    tile, q, r,
    edgeMatches,
    points,
    breakdown: {
      edges: edgePoints,
      junctions: junctionPoints,
      streak: streakPoints,
      perfect: perfectPoints,
      structures: structurePoints,
      tradeIncome: tradeIncomePoints,
    },
    perfect,
    combo: next.streak,
    cleanliness,
    questsCompleted: [],  // filled by the quest layer
    questsProgressed: [], // filled by the quest layer
    tilesAwarded,
    groupsExtended,
    networkEvents,
  };
  return { result, next };
}

// Dry-run: no board/ctx mutation. Returns PlacementResult or null if illegal.
export function scorePlacement(board, tile, q, r, ctx = createScoringContext(), config = CONFIG) {
  const ev = evaluate(board, tile, q, r, ctx, config);
  return ev ? ev.result : null;
}

// Commits: places the tile and advances the scoring context in place.
export function applyPlacement(board, tile, q, r, ctx, config = CONFIG) {
  const ev = evaluate(board, tile, q, r, ctx, config);
  if (!ev) return null;
  board.set(key(q, r), tile);
  Object.assign(ctx, ev.next);
  return ev.result;
}

// §5.8 end-game bonuses.
export function endGameBonuses(board, config = CONFIG) {
  const e = config.scoring.endGame;
  const longest = (nets) => nets.reduce((m, n) => Math.max(m, n.size), 0);
  const largest = (gs) => gs.reduce((m, g) => Math.max(m, g.size), 0);
  const longestRail = longest(traceNetworks(board, 'RA'));
  const longestRiver = longest(traceNetworks(board, 'RI'));
  const largestMountain = largest(groups(board, 'MT'));
  const largestOcean = largest(groups(board, 'OC'));
  const breakdown = {
    longestRail: longestRail * e.longestRail,
    longestRiver: longestRiver * e.longestRiver,
    largestMountain: largestMountain * e.largestMountainGroup,
    largestOcean: largestOcean * e.largestOceanGroup,
  };
  return {
    longestRail, longestRiver, largestMountain, largestOcean,
    breakdown,
    points: breakdown.longestRail + breakdown.longestRiver +
      breakdown.largestMountain + breakdown.largestOcean,
  };
}
