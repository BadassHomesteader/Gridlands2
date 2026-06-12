// Terrain enum + the legality/scoring edge matrix (DESIGN §3.1 / §3.2).

import { CONFIG } from './config.js';

export const T = {
  GR: 'GR', FO: 'FO', FI: 'FI', HO: 'HO',
  RI: 'RI', RA: 'RA', MT: 'MT', OC: 'OC', LA: 'LA',
};

export const TERRAINS = ['GR', 'FO', 'FI', 'HO', 'RI', 'RA', 'MT', 'OC', 'LA'];

export const TERRAIN_NAMES = {
  GR: 'Grass', FO: 'Forest', FI: 'Field', HO: 'House',
  RI: 'River', RA: 'Rail', MT: 'Mountain', OC: 'Ocean', LA: 'Lane',
};

export const SOFT = new Set(['GR', 'FO', 'FI', 'HO']);
export const HARD = new Set(['RI', 'RA', 'MT', 'OC', 'LA']);

export function isSoft(t) {
  return SOFT.has(t);
}

const ILLEGAL = Object.freeze({ legal: false, points: 0, junction: null });

// edgeRelation(a, b, { aDock, bDock, config }) -> { legal, points, junction }
// `points` = guaranteed per-edge points. `junction` names a junction whose bonus
// (CONFIG.scoring.junction[name]) is applied by scoring.js — source/estuary are
// capped per river network there; portCall/cliff always pay on creation.
// b === null/undefined means the edge faces empty space (always legal, 0).
export function edgeRelation(a, b, opts = {}) {
  const { aDock = false, bDock = false, config = CONFIG } = opts;
  const s = config.scoring;
  if (a == null || b == null) return { legal: true, points: 0, junction: null };
  const aSoft = isSoft(a);
  const bSoft = isSoft(b);
  if (aSoft && bSoft) {
    return { legal: true, points: a === b ? s.softMatch : 0, junction: null };
  }
  if (aSoft || bSoft) return ILLEGAL; // soft may never face a hard edge
  if (a === b) return { legal: true, points: s.hardMatch, junction: null }; // dock irrelevant for Oc↔Oc
  const pair = a < b ? a + b : b + a;
  if (pair === 'MTRI') return { legal: true, points: s.hardMatch, junction: 'source' };
  if (pair === 'OCRI') return { legal: true, points: s.hardMatch, junction: 'estuary' };
  if (pair === 'MTOC') {
    if (config.rules.mountainCoast === 'cliff') {
      return { legal: true, points: 0, junction: 'cliff' };
    }
    return ILLEGAL; // repel: the range needs land before the sea
  }
  if (pair === 'LAOC') {
    const dock = a === 'OC' ? aDock : bDock;
    if (dock) return { legal: true, points: s.hardMatch, junction: 'portCall' };
    if (config.rules.laneOceanRule === 'open') {
      return { legal: true, points: 0, junction: null }; // legal to waste, costly to waste
    }
    return ILLEGAL; // sealed
  }
  return ILLEGAL;
}
