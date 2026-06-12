// Map-backed board: key "q,r" -> tile. Validation, flood-fill groups,
// network tracing (rivers/rails/lanes), frontier, hinterland.

import { CONFIG } from './config.js';
import { key, parseKey, neighbor, neighbors, opposite } from './hex.js';
import { edgeRelation } from './terrain.js';
import { rotateTile } from './tiles.js';

export function createBoard() {
  return new Map();
}

export function tileAt(board, q, r) {
  return board.get(key(q, r)) || null;
}

function relationAt(board, tile, q, r, dir, config) {
  const n = neighbor(q, r, dir);
  const nt = board.get(key(n.q, n.r));
  if (!nt) return { neighborTile: null, rel: { legal: true, points: 0, junction: null } };
  const facing = opposite(dir);
  return {
    neighborTile: nt,
    neighborKey: key(n.q, n.r),
    rel: edgeRelation(tile.edges[dir], nt.edges[facing], {
      aDock: tile.dockEdges.includes(dir),
      bDock: nt.dockEdges.includes(facing),
      config,
    }),
  };
}

// Per-direction relations for a candidate placement (used by scoring too).
export function placementRelations(board, tile, q, r, config = CONFIG) {
  const out = [];
  for (let dir = 0; dir < 6; dir++) out.push({ dir, ...relationAt(board, tile, q, r, dir, config) });
  return out;
}

export function canPlace(board, tile, q, r, config = CONFIG) {
  if (board.has(key(q, r))) return { legal: false, reasons: ['occupied'] };
  const reasons = [];
  let placedNeighbors = 0;
  for (let dir = 0; dir < 6; dir++) {
    const { neighborTile, rel } = relationAt(board, tile, q, r, dir, config);
    if (!neighborTile) continue;
    placedNeighbors++;
    if (!rel.legal) {
      reasons.push(`edge ${dir}: ${tile.edges[dir]} vs ${neighborTile.edges[opposite(dir)]} illegal`);
    }
  }
  if (board.size > 0 && placedNeighbors === 0) reasons.push('not adjacent to any placed tile');
  return { legal: reasons.length === 0, reasons };
}

export function placeTile(board, tile, q, r, config = CONFIG) {
  const v = canPlace(board, tile, q, r, config);
  if (!v.legal) throw new Error(`illegal placement at ${q},${r}: ${v.reasons.join('; ')}`);
  board.set(key(q, r), tile);
  return tile;
}

// Empty cells adjacent to >=1 placed tile.
export function frontier(board) {
  const seen = new Map();
  for (const k of board.keys()) {
    const { q, r } = parseKey(k);
    for (const n of neighbors(q, r)) {
      const nk = key(n.q, n.r);
      if (!board.has(nk) && !seen.has(nk)) seen.set(nk, n);
    }
  }
  return [...seen.values()];
}

// All legal {q, r, rotation} for a tile (rotation relative to the tile as given).
export function validPlacements(board, tile, config = CONFIG) {
  const cells = board.size === 0 ? [{ q: 0, r: 0 }] : frontier(board);
  const out = [];
  for (let rot = 0; rot < 6; rot++) {
    const t = rot === 0 ? tile : rotateTile(tile, rot);
    for (const cell of cells) {
      if (canPlace(board, t, cell.q, cell.r, config).legal) {
        out.push({ q: cell.q, r: cell.r, rotation: rot });
      }
    }
  }
  return out;
}

// Maximal flood-fill of tiles sharing `terrain` through matched edges of that
// terrain. Returns [Set<key>] — a tile with the terrain but no matched edge of
// it is a singleton group.
export function groups(board, terrain) {
  const seen = new Set();
  const out = [];
  for (const [start, t0] of board) {
    if (seen.has(start) || !t0.edges.includes(terrain)) continue;
    const g = new Set([start]);
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const k = stack.pop();
      const { q, r } = parseKey(k);
      const t = board.get(k);
      for (let dir = 0; dir < 6; dir++) {
        if (t.edges[dir] !== terrain) continue;
        const n = neighbor(q, r, dir);
        const nk = key(n.q, n.r);
        if (seen.has(nk)) continue;
        const nt = board.get(nk);
        if (nt && nt.edges[opposite(dir)] === terrain) {
          seen.add(nk);
          g.add(nk);
          stack.push(nk);
        }
      }
    }
    out.push(g);
  }
  return out;
}

export function largestGroupSize(board, terrain) {
  return groups(board, terrain).reduce((m, g) => Math.max(m, g.size), 0);
}

// Network tracing for path terrains. Networks are sets (branches included).
// RI extras: sources (Ri edge faces Mt), mouths (Ri edge faces Oc), openEnds
//   (Ri edge faces empty); completed = sources >= 1 && mouths >= 1.
// LA extras: dockEnds + dockHarborKeys (La edge faces a dock Oc edge),
//   openWaterEnds (La edge faces plain Oc), openEnds (faces empty);
//   completed = every route end is a dock and there are >= 2 dock ends.
export function traceNetworks(board, terrain) {
  if (terrain === undefined) {
    return { RI: traceNetworks(board, 'RI'), RA: traceNetworks(board, 'RA'), LA: traceNetworks(board, 'LA') };
  }
  return groups(board, terrain).map((keys) => {
    const net = { terrain, keys, size: keys.size };
    if (terrain === 'RI') {
      net.sources = 0; net.mouths = 0; net.openEnds = 0;
    } else if (terrain === 'LA') {
      net.dockEnds = 0; net.dockHarborKeys = []; net.openWaterEnds = 0; net.openEnds = 0;
    }
    if (terrain === 'RI' || terrain === 'LA') {
      for (const k of keys) {
        const { q, r } = parseKey(k);
        const t = board.get(k);
        for (let dir = 0; dir < 6; dir++) {
          if (t.edges[dir] !== terrain) continue;
          const n = neighbor(q, r, dir);
          const nk = key(n.q, n.r);
          const nt = board.get(nk);
          const facing = nt ? nt.edges[opposite(dir)] : null;
          if (terrain === 'RI') {
            if (!nt) net.openEnds++;
            else if (facing === 'MT') net.sources++;
            else if (facing === 'OC') net.mouths++;
          } else {
            if (!nt) net.openEnds++;
            else if (facing === 'OC') {
              if (nt.dockEdges.includes(opposite(dir))) {
                net.dockEnds++;
                net.dockHarborKeys.push(nk);
              } else net.openWaterEnds++;
            }
          }
        }
      }
      if (terrain === 'RI') net.completed = net.sources >= 1 && net.mouths >= 1;
      else net.completed = net.dockEnds >= 2 && net.openEnds === 0 && net.openWaterEnds === 0;
    }
    return net;
  });
}

export function riverNetworks(board) { return traceNetworks(board, 'RI'); }
export function railNetworks(board) { return traceNetworks(board, 'RA'); }
export function laneRoutes(board) { return traceNetworks(board, 'LA'); }

// Size of the House group connected to the harbor's House edge (the harbor
// tile itself counts as part of its town); 0 if that edge is unmatched.
export function hinterland(board, harborKey) {
  const t = board.get(harborKey);
  if (!t) return 0;
  const { q, r } = parseKey(harborKey);
  let matched = false;
  for (let dir = 0; dir < 6 && !matched; dir++) {
    if (t.edges[dir] !== 'HO') continue;
    const n = neighbor(q, r, dir);
    const nt = board.get(key(n.q, n.r));
    if (nt && nt.edges[opposite(dir)] === 'HO') matched = true;
  }
  if (!matched) return 0;
  const g = groups(board, 'HO').find((g) => g.has(harborKey));
  return g ? g.size : 0;
}
