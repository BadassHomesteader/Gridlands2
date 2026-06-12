// Shared test utilities.
import { CONFIG } from '../src/core/config.js';
import { key } from '../src/core/hex.js';

let n = 0;

// Hand-crafted test tile.
export function tt(edges, opts = {}) {
  return {
    id: opts.id || 'test-' + n++,
    archetype: opts.archetype || 'test',
    edges,
    dockEdges: opts.dockEdges || [],
    crane: !!opts.crane,
    flag: opts.flag ?? null,
    seed: 0,
    rotation: 0,
  };
}

// Direct board write, bypassing validation (for scenario setup).
export function put(board, edges, q, r, opts = {}) {
  const tile = Array.isArray(edges) ? tt(edges, opts) : edges;
  board.set(key(q, r), tile);
  return tile;
}

// Deep-cloned CONFIG with rule overrides.
export function cfg(rules = {}, mutate = null) {
  const c = structuredClone(CONFIG);
  Object.assign(c.rules, rules);
  if (mutate) mutate(c);
  return c;
}

export const ALL = (t) => new Array(6).fill(t);
