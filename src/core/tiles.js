// Tile catalog (DESIGN §4) + the stage-weight draw engine (§4.1 / §4.2).
// Tile shape: { id, archetype, edges: [t0..t5], dockEdges: [i...], crane, flag, seed, rotation }.

import { CONFIG } from './config.js';
import { pick, shuffle, weighted } from './rng.js';

export const ARCHETYPES = [
  'meadow', 'hamlet', 'pureSoft', 'river', 'rail', 'foothills',
  'highMountain', 'coast', 'estuary', 'openOcean', 'harbor', 'lane',
];

export const FLAG_ELIGIBLE = new Set(['meadow', 'hamlet', 'pureSoft']);

const SOFT_FILL = ['GR', 'FO', 'FI'];

function pathEdges(rng, terrain, splits) {
  const split = weighted(rng, splits);
  const off = split === 'straight' ? 3 : split === 'wide' ? 2 : 1; // tight = adjacent
  const edges = new Array(6).fill(pick(rng, SOFT_FILL));
  edges[0] = terrain;
  edges[off] = terrain;
  return edges;
}

const GENERATORS = {
  meadow(rng, cfg) {
    const split = weighted(rng, cfg.tiles.meadow.splits);
    const t = shuffle(rng, ['GR', 'FO', 'FI']);
    let edges;
    if (split === '3-3') edges = [t[0], t[0], t[0], t[1], t[1], t[1]];
    else if (split === '4-2') edges = [t[0], t[0], t[0], t[0], t[1], t[1]];
    else edges = [t[0], t[0], t[1], t[1], t[2], t[2]];
    return { edges };
  },
  hamlet(rng, cfg) {
    const n = weighted(rng, cfg.tiles.hamlet.splits) === '2ho' ? 2 : 3;
    const edges = [];
    for (let i = 0; i < 6; i++) edges.push(i < n ? 'HO' : pick(rng, ['GR', 'FI']));
    return { edges };
  },
  pureSoft(rng) {
    return { edges: new Array(6).fill(pick(rng, ['FO', 'FI', 'HO'])) };
  },
  river(rng, cfg) {
    return { edges: pathEdges(rng, 'RI', cfg.tiles.river.splits) };
  },
  rail(rng, cfg) {
    return { edges: pathEdges(rng, 'RA', cfg.tiles.rail.splits) };
  },
  foothills(rng, cfg) {
    const off = weighted(rng, cfg.tiles.foothills.splits) === 'adjacent' ? 1 : 2;
    const edges = new Array(6).fill(pick(rng, SOFT_FILL));
    edges[0] = 'MT';
    edges[off] = 'MT';
    return { edges };
  },
  highMountain() {
    return { edges: ['MT', 'MT', 'MT', 'MT', 'GR', 'GR'] };
  },
  coast(rng, cfg) {
    const n = weighted(rng, cfg.tiles.coast.splits) === '2oc' ? 2 : 3;
    const edges = new Array(6).fill(pick(rng, SOFT_FILL));
    for (let i = 0; i < n; i++) edges[i] = 'OC';
    return { edges };
  },
  estuary(rng, cfg) {
    const riAt = weighted(rng, cfg.tiles.estuary.splits) === 'ri3' ? 3 : 4;
    const edges = new Array(6).fill(pick(rng, SOFT_FILL));
    edges[0] = 'OC';
    edges[1] = 'OC';
    edges[riAt] = 'RI';
    return { edges };
  },
  openOcean() {
    return { edges: new Array(6).fill('OC') };
  },
  harbor(rng, cfg) {
    const crane = rng() < cfg.tiles.harborCraneRate;
    return {
      edges: ['OC', 'OC', 'GR', 'HO', crane ? 'RA' : 'GR', 'GR'],
      dockEdges: [0],
      crane,
    };
  },
  lane(rng, cfg) {
    const straight = weighted(rng, cfg.tiles.lane.splits) === 'straight';
    return {
      edges: straight
        ? ['LA', 'OC', 'OC', 'LA', 'OC', 'OC']
        : ['LA', 'OC', 'LA', 'OC', 'OC', 'OC'],
    };
  },
};

export function makeTile(archetype, rng, config = CONFIG) {
  const gen = GENERATORS[archetype];
  if (!gen) throw new Error('unknown archetype: ' + archetype);
  const { edges, dockEdges = [], crane = false } = gen(rng, config);
  const seed = Math.floor(rng() * 0x7fffffff);
  return {
    id: archetype + '-' + seed.toString(36),
    archetype, edges, dockEdges, crane,
    flag: null, seed, rotation: 0,
  };
}

// One step = edges.unshift(edges.pop()); dock indices rotate identically.
export function rotateTile(tile, steps = 1) {
  const s = ((steps % 6) + 6) % 6;
  if (s === 0) return { ...tile, edges: tile.edges.slice(), dockEdges: tile.dockEdges.slice() };
  const edges = tile.edges.slice();
  for (let k = 0; k < s; k++) edges.unshift(edges.pop());
  return {
    ...tile,
    edges,
    dockEdges: tile.dockEdges.map((i) => (i + s) % 6),
    rotation: (tile.rotation + s) % 6,
  };
}

export function isPeakCandidate(tile, config = CONFIG) {
  let mt = 0;
  for (const e of tile.edges) if (e === 'MT') mt++;
  return mt >= config.scoring.structures.peakCrowned.minPrintedMtEdges;
}

// Stage for the upcoming draw, keyed to total placements so far (§4.1).
export function stageFor(placements, config = CONFIG) {
  const n = placements + 1;
  if (n <= config.stages.pastoral) return 'pastoral';
  if (n <= config.stages.highlands) return 'highlands';
  if (n <= config.stages.tide) return 'tide';
  return 'voyage';
}

// §4.2 strict order of operations. gameState (caller-maintained snapshot):
//   placements              total placements so far
//   stackRemaining          tiles left in stack incl. earned
//   largestOceanGroup       tiles in the largest ocean group
//   laneAdmissibleFrontier  # frontier cells admitting a Lane tile in some rotation
//   needyLaneRoute          any lane route with >=3 lane tiles and <=1 connected harbor
//   harborPityDrawsLeft     pity timer; caller sets to CONFIG.valves.harborPity.draws
//                           whenever needyLaneRoute holds, decrements each draw
//   uncrownedPeak           an un-crowned Peak candidate is on the board
//   activeFlags             flagged groups currently active (for the flag modifier)
export function computeWeights(gameState, config = CONFIG) {
  // 1. stage table
  const stage = stageFor(gameState.placements || 0, config);
  const w = { ...config.weights.table[stage] };

  // 2. lane tide gate — while closed, lane weight stays in the ocean family
  const gate = config.weights.laneTideGate;
  const gateOpen =
    (gameState.largestOceanGroup || 0) >= gate.minOceanGroup &&
    (gameState.laneAdmissibleFrontier || 0) >= gate.minAdmissibleFrontier;
  if (!gateOpen && w.lane > 0) {
    w.coast += w.lane * gate.redistribute.coast;
    w.openOcean += w.lane * gate.redistribute.openOcean;
    w.lane = 0;
  }

  // 3. harbor pity timer
  const pity = config.valves.harborPity;
  if (gameState.needyLaneRoute === true || (gameState.harborPityDrawsLeft || 0) > 0) {
    w.harbor *= pity.mult;
  }

  // 4. mountain pity — +pp to foothills, taken proportionally from soft archetypes
  if (gameState.uncrownedPeak) {
    const bonus = config.weights.mountainPity.foothillsBonus;
    const softs = config.weights.softArchetypes;
    const softSum = softs.reduce((s, a) => s + w[a], 0);
    if (softSum > 0) {
      for (const a of softs) w[a] -= bonus * (w[a] / softSum);
      w.foothills += bonus;
    }
  }

  // 5. finale
  const finale = (gameState.stackRemaining ?? Infinity) <= config.stack.finaleWindow;
  if (finale) {
    w.harbor *= config.weights.finale.harborMult;
    w.lane *= config.weights.finale.laneMult;
  }

  // 6. ocean-family cap — enforced LAST, scale family down, then renormalize
  const caps = config.weights.oceanFamilyCap;
  const capPct = finale ? caps.finale : (caps[stage] ?? caps.tide);
  const family = config.weights.oceanFamily;
  const famSum = family.reduce((s, a) => s + w[a], 0);
  let total = ARCHETYPES.reduce((s, a) => s + w[a], 0);
  const nonFam = total - famSum;
  const capFrac = capPct / 100;
  if (famSum > 0 && famSum / total > capFrac) {
    const scale = (nonFam * capFrac / (1 - capFrac)) / famSum;
    for (const a of family) w[a] *= scale;
    total = nonFam + famSum * scale;
  }

  // 7. renormalize to 100
  for (const a of ARCHETYPES) w[a] = (w[a] / total) * 100;
  return w;
}

export function drawTile(rng, gameState, config = CONFIG) {
  const w = computeWeights(gameState, config);
  const archetype = weighted(rng, ARCHETYPES.map((a) => [a, w[a]]));
  let tile = makeTile(archetype, rng, config);
  const rot = Math.floor(rng() * 6);
  if (rot) tile = rotateTile(tile, rot);
  if (
    FLAG_ELIGIBLE.has(archetype) &&
    (gameState.activeFlags || 0) < config.quests.maxFlags &&
    rng() < config.quests.flagRate
  ) {
    tile.flag = {}; // quest layer fills in target/details on placement
  }
  return tile;
}
