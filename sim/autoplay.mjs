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
import { edgeRelation } from '../src/core/terrain.js';
import { placementRelations, groups, canPlace, traceNetworks } from '../src/core/board.js';
import { scorePlacement } from '../src/core/scoring.js';
import { isIslandRinged, isSeaTile, transcontinentalSatisfied } from '../src/core/quests.js';

// Sim-only policy weights. These tune the bots, not the game — every game
// number stays in CONFIG.
export const HEURISTICS = {
  topK: 12,            // candidates fully scored via scorePlacement
  extraPool: 18,       // extra junction/crowning/island/lane/hole candidates
  questStep: 36,       // per tile of progress toward an active numeric quest
  twinHarborsLikely: 0.5, // fraction of quest points for a probable twin-harbor
  flagStep: 20,
  epicRailStep: 6,
  epicPeakFace: 20,
  epicIslandStep: 90,  // per point of island-template cost-to-go removed (theIsland)
  epicLaneStep: 35,    // extra per La↔La link while chasing transcontinental
  epicTransStep: 80,   // per point of transcontinental cost-to-go removed
  transIdleCost: 12,   // assumed cost while no crane harbor is on the board
  transPrematureFire: 420, // firing a trade route that misses the epic burns the pair
  islandIdleCost: 15,  // assumed cost when no valid island template exists
                       // (full template costs 13: 6 ring tiles x2 + center)
  islandBudgetFactor: 2, // chase a template only while cost*factor <= stack left
                       // (each ring tile is a specific 3-Oc coast draw; doomed
                       // flowers tank the run's whole quest economy)
  oneShotDeadStack: 20, // reroll a zero-progress sea one-shot when this little
                       // stack remains and its groundwork is missing (the slot
                       // converts to a guard-clamped numeric quest instead)
  tradeRouteEpicBonus: 100,
  junctionSetup: 15,   // open river end left near mountain/ocean (cappable later)
  crowdEndPenalty: 8,  // per river continuation cell the candidate crowds
  laneCrowdPenalty: 35, // squatting a lane end's cell costs the whole route
  harborSetup: 20,     // dock facing a lane continuation cell
  portCallSetup: 70,   // per port call created (a route end finds its dock)
  laneCompleteBonus: 140, // completing a lane route (engagement intent)
  laneFirstCompleteBonus: 360, // a run's first completed route is the engagement gate
  riverCompleteBonus: 60, // completing a river (source-to-sea is the game's heart)
  riverFirstCompleteBonus: 150, // a run's first completed river
  estuarySetup: 25,    // creating a mouth (estuary junction event)
  springSetup: 18,     // creating a source (spring junction event)
  laneExtend: 12,      // per La↔La match: grow routes before docking them
  laneBrickPenalty: 45, // per La/Oc edge pair left unmatched (dead route end)
  laneEndDockable: 30, // open La end faces a cell where a harbor could sit
  laneEndStranded: 35, // open La end faces a cell no harbor can ever reach
  laneEndBesieged: 12, // per occupied neighbor already crowding an open end
  craneRailLink: 30,   // crane harbor's rail edge matched into a rail network
  riverEarlyCapPenalty: 50, // capping a river shorter than an active longRiver
  staleQuestSlack: 2,  // reroll when need > stackRemaining/guardDivisor + slack
  discardMinStack: 20, // strategic discard only with this much stack left
  // perfect engineering (round 3): a perfect (§5.3) needs a 6-ring whose
  // inward edges all match the filler — only a pureSoft tile fills a uniform
  // FO/FI/HO ring, so shape forming holes toward one agreeing soft terrain.
  holeShapeBonus: 6,   // x ring depth x fillability when extending a project ring
  holePoisonPenalty: 14, // x ring depth when an edge makes a project unfillable
  holeShapeMinN: 4,    // ignore rings with fewer neighbors (phantom holes)
  holePoisonMinN: 4,   // only nearly-complete rings are worth tiptoeing around
  holePoolMax: 6,      // ring shapers admitted to the dry-run pool per turn
  holeClosePerPct: 20, // per % of per-draw fill probability when closing a ring
  holeSealPenalty: 20, // closing a ring no drawable tile can ever fill
  holeShapeProbRef: 0.015, // fill prob worth a 1x shape bonus (cap 2x)
  holeProjects: 2,     // committed ring projects at a time — shaping gradients
                       // apply only to these (unbounded shaping turns the bot
                       // into a ring-obsessive that forgets quests: 2.3
                       // perfects/run but -880 median, measured in expD)
};

// --- perfect-fill probability ------------------------------------------------
// P(a random draw can perfectly fill a closed 6-hole with this inward pattern,
// in some rotation). Variants enumerate the §4 catalog weighted by the voyage
// column (the phase where rings get closed and filled); hamlet's random GR/FI
// fill edges use the best single rotation (slight underestimate). Junction
// matches count via edgeRelation — a source/estuary fill is a perfect too.
const FILL_VARIANTS = new WeakMap(); // config -> [{ prob, edges, dockEdges }]
const HAMLET_RND = 'GR|FI'; // marker: edge drawn uniformly from GR/FI

function fillVariants(config) {
  let list = FILL_VARIANTS.get(config);
  if (list) return list;
  list = [];
  const w = config.weights.table.voyage;
  let total = 0;
  for (const a in w) total += w[a];
  const push = (arch, frac, edges, dockEdges = []) =>
    list.push({ prob: (w[arch] / total) * frac, edges, dockEdges });
  const softs = ['GR', 'FO', 'FI'];
  const pairs = [];
  for (const a of softs) for (const b of softs) if (a !== b) pairs.push([a, b]);
  for (const [split, frac] of config.tiles.meadow.splits) {
    for (const [a, b] of pairs) {
      if (split === '3-3') push('meadow', frac / 6, [a, a, a, b, b, b]);
      else if (split === '4-2') push('meadow', frac / 6, [a, a, a, a, b, b]);
      else {
        const c = softs.find((s) => s !== a && s !== b);
        push('meadow', frac / 6, [a, a, b, b, c, c]);
      }
    }
  }
  for (const [split, frac] of config.tiles.hamlet.splits) {
    const n = split === '2ho' ? 2 : 3;
    const edges = [];
    for (let i = 0; i < 6; i++) edges.push(i < n ? 'HO' : HAMLET_RND);
    push('hamlet', frac, edges);
  }
  for (const t of ['FO', 'FI', 'HO']) push('pureSoft', 1 / 3, new Array(6).fill(t));
  for (const [arch, terrain] of [['river', 'RI'], ['rail', 'RA']]) {
    for (const [split, frac] of config.tiles[arch].splits) {
      const off = split === 'straight' ? 3 : split === 'wide' ? 2 : 1;
      for (const f of softs) {
        const edges = new Array(6).fill(f);
        edges[0] = terrain;
        edges[off] = terrain;
        push(arch, frac / 3, edges);
      }
    }
  }
  for (const [split, frac] of config.tiles.foothills.splits) {
    const off = split === 'adjacent' ? 1 : 2;
    for (const f of softs) {
      const edges = new Array(6).fill(f);
      edges[0] = 'MT';
      edges[off] = 'MT';
      push('foothills', frac / 3, edges);
    }
  }
  push('highMountain', 1, ['MT', 'MT', 'MT', 'MT', 'GR', 'GR']);
  for (const [split, frac] of config.tiles.coast.splits) {
    const n = split === '2oc' ? 2 : 3;
    for (const f of softs) {
      const edges = new Array(6).fill(f);
      for (let i = 0; i < n; i++) edges[i] = 'OC';
      push('coast', frac / 3, edges);
    }
  }
  for (const [split, frac] of config.tiles.estuary.splits) {
    const riAt = split === 'ri3' ? 3 : 4;
    for (const f of softs) {
      const edges = new Array(6).fill(f);
      edges[0] = 'OC';
      edges[1] = 'OC';
      edges[riAt] = 'RI';
      push('estuary', frac / 3, edges);
    }
  }
  push('openOcean', 1, new Array(6).fill('OC'));
  const crane = config.tiles.harborCraneRate;
  push('harbor', 1 - crane, ['OC', 'OC', 'GR', 'HO', 'GR', 'GR'], [0]);
  push('harbor', crane, ['OC', 'OC', 'GR', 'HO', 'RA', 'GR'], [0]);
  for (const [split, frac] of config.tiles.lane.splits) {
    push('lane', frac, split === 'straight'
      ? ['LA', 'OC', 'OC', 'LA', 'OC', 'OC']
      : ['LA', 'OC', 'LA', 'OC', 'OC', 'OC']);
  }
  FILL_VARIANTS.set(config, list);
  return list;
}

// `pattern` entries may be null for ring spots not yet placed — treated as
// wildcards, so a partial ring's value is its OPTIMISTIC fill probability
// (0 means the ring is already unfillable no matter how it gets finished).
export function fillProb(pattern, dock, config) {
  let p = 0;
  for (const v of fillVariants(config)) {
    let best = 0;
    for (let rot = 0; rot < 6 && best < 1; rot++) {
      let pr = 1;
      for (let pos = 0; pos < 6 && pr > 0; pos++) {
        if (pattern[pos] == null) continue; // unplaced ring spot: wildcard
        const i = (pos - rot + 6) % 6; // base edge index sitting at pos
        const e = v.edges[i];
        if (e === HAMLET_RND) {
          pr *= pattern[pos] === 'GR' || pattern[pos] === 'FI' ? 0.5 : 0;
          continue;
        }
        const rel = edgeRelation(e, pattern[pos], {
          aDock: v.dockEdges.includes(i), bDock: !!dock[pos], config,
        });
        if (!rel.legal || (rel.points <= 0 && !rel.junction)) pr = 0;
      }
      if (pr > best) best = pr;
    }
    p += v.prob * best;
  }
  return p;
}

// Distinct rotations of the tile in hand (rotational symmetry deduped) mapped
// over the legal cells: [{ q, r, rotation, tile }].
export function enumerateCandidates(game) {
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
export function cheapScore(game, c) {
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
  c.nbs = nbs;
  return pts;
}

// Island plan (epic theIsland): the smallest buildable island is a 7-tile
// flower — six coasts with their three Oc edges facing outward around one
// all-soft center (DESIGN AMENDMENT in quests.isIslandRinged). Free-form
// region growth stalls in unfillable convex shapes, so the bot plans the
// flower explicitly: enumerate candidate centers near the board, keep the
// cheapest valid template, and pay per point of its cost-to-go removed.
// Cost: 2 per missing ring tile + 1 for the missing center; 0 = island.
const WATERY = (e) => e === 'OC' || e === 'LA';
const SOFTE = (e) => e === 'GR' || e === 'FO' || e === 'FI' || e === 'HO';

export function islandPlan(board, H = HEURISTICS, preferCenter = null) {
  const centers = new Set();
  for (const [k, t] of board) {
    const { q, r } = parseKey(k);
    if (t.edges.every(SOFTE)) centers.add(k); // filled center candidate
    for (const n1 of neighbors(q, r)) {
      const k1 = key(n1.q, n1.r);
      if (!board.has(k1)) centers.add(k1);
      for (const n2 of neighbors(n1.q, n1.r)) {
        const k2 = key(n2.q, n2.r);
        if (!board.has(k2)) centers.add(k2);
      }
    }
  }
  let best = H.islandIdleCost;
  let bestCells = null;
  let bestCenter = null;
  let prefCost = Infinity;
  let prefCells = null;
  for (const ck of centers) {
    const { q: cq, r: cr } = parseKey(ck);
    const centerFilled = board.has(ck);
    let cost = centerFilled ? 0 : 1;
    let valid = true;
    let anchored = centerFilled;
    const cells = centerFilled ? [] : [ck];
    for (let d = 0; d < 6 && valid; d++) {
      const rc = neighbor(cq, cr, d);
      const rk = key(rc.q, rc.r);
      const rt = board.get(rk);
      const out = [(d + 5) % 6, d, (d + 1) % 6];      // edges facing away
      const inn = [(d + 2) % 6, (d + 3) % 6, (d + 4) % 6]; // mates + center
      if (rt) {
        // an existing tile only fits the template as a correct ring piece
        anchored = true;
        if (!out.every((od) => WATERY(rt.edges[od])) ||
            !inn.every((id) => SOFTE(rt.edges[id]))) valid = false;
      } else {
        cost += 2;
        cells.push(rk);
        for (const od of out) {
          const nb = neighbor(rc.q, rc.r, od);
          const nt = board.get(key(nb.q, nb.r));
          if (!nt) continue;
          anchored = true;
          // a neighbor facing the ring with anything but water kills the
          // template (the ring tile's Oc edge could never legally sit there)
          if (!WATERY(nt.edges[(od + 3) % 6])) { valid = false; break; }
        }
      }
    }
    if (!valid || !anchored) continue;
    if (ck === preferCenter) { prefCost = cost; prefCells = cells; }
    if (cost >= best) continue;
    best = cost;
    bestCells = cells;
    bestCenter = ck;
  }
  // hysteresis: a committed flower within 1 cost of the cheapest plan keeps
  // priority — re-planning across the map every turn buys ring tiles that
  // never join the same island (template thrash)
  if (prefCells && prefCost <= best + 1) {
    return { cost: prefCost, cells: new Set(prefCells), center: preferCenter };
  }
  return { cost: best, cells: bestCells ? new Set(bestCells) : null, center: bestCenter };
}

// Transcontinental cost-to-go: the cheapest crane harbor's missing rail tiles
// plus missing lane tiles plus the missing far dock. Drives multi-turn play
// toward the epic the way islandCost does for theIsland.
function transCost(board, epic, H) {
  let best = H.transIdleCost;
  let rails = null;
  let lanes = null;
  for (const [k, t] of board) {
    if (!t.crane) continue;
    if (!rails) {
      rails = traceNetworks(board, 'RA');
      lanes = traceNetworks(board, 'LA');
    }
    const rn = rails.find((n) => n.keys.has(k));
    const railNeed = Math.max(0, epic.minRail - (rn ? rn.size : 0));
    const ln = lanes.find((n) => n.dockHarborKeys.includes(k));
    let laneNeed;
    if (!ln) laneNeed = epic.minLane + 1; // the lanes plus the far dock
    else if (ln.completed && ln.size < epic.minLane) continue; // doomed crane:
    // a completed route can never grow, so this dock is lost to the epic
    else {
      laneNeed = Math.max(0, epic.minLane - ln.size) + (ln.completed ? 0 : 1);
    }
    const cost = railNeed + laneNeed;
    if (cost < best) best = cost;
  }
  return best;
}

// Could a harbor legally sit at (q, r) with its dock facing direction
// `dockDir`? Probes both harbor layouts (second Oc edge on either side).
const DOCKABLE_BASES = [
  ['OC', 'OC', 'GR', 'GR', 'GR', 'GR'], // dock at 0, Oc at 1
  ['OC', 'GR', 'GR', 'GR', 'GR', 'OC'], // dock at 0, Oc at 5
];

function dockableCell(board, q, r, dockDir, config) {
  for (const base of DOCKABLE_BASES) {
    const edges = new Array(6);
    for (let i = 0; i < 6; i++) edges[(i + dockDir) % 6] = base[i];
    const probe = {
      id: 'probe-harbor', archetype: 'harbor', edges,
      dockEdges: [dockDir], crane: false, flag: null, seed: 0, rotation: 0,
    };
    if (canPlace(board, probe, q, r, config).legal) return true;
  }
  return false;
}

// Per-game island-plan commitment (hysteresis across turns; sim-only state —
// policies stay pure with respect to game mutation).
const ISLAND_COMMIT = new WeakMap();

// Per-game committed ring projects (same hysteresis idea: gradients thrash
// when the "best hole" jumps across the map every turn).
const HOLE_COMMIT = new WeakMap();

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
export function turnContext(game) {
  const board = game.board;
  const capTargets = new Set(); // tiles with MT or OC edges (river cap partners)
  const riverEndCells = new Set();
  const laneEndCells = new Set();
  const dockFrontCells = new Set(); // empty cells an unmatched dock edge faces
  const peaks = new Set();
  // perfect-hole ledger: empty cell -> { n: placed neighbors, terrain: the
  // agreed soft inward terrain, or null once the ring disagrees / goes hard }
  const holes = new Map();
  let dockCount = 0;
  for (const [k, t] of board) {
    let hasCap = false;
    const { q, r } = parseKey(k);
    for (let dir = 0; dir < 6; dir++) {
      const e = t.edges[dir];
      if (e === 'MT' || e === 'OC') hasCap = true;
      if (t.dockEdges.includes(dir)) {
        const n = neighbor(q, r, dir);
        if (!board.has(key(n.q, n.r))) dockFrontCells.add(key(n.q, n.r));
      }
      {
        const n = neighbor(q, r, dir);
        const nk = key(n.q, n.r);
        if (!board.has(nk)) {
          let h = holes.get(nk);
          if (!h) {
            h = { n: 0, pattern: new Array(6).fill(null), dock: new Array(6).fill(false), pOpt: 0 };
            holes.set(nk, h);
          }
          h.n++;
          const i = opposite(dir); // the filler edge index that faces this tile
          h.pattern[i] = e;
          h.dock[i] = t.dockEdges.includes(dir);
        }
      }
      if (e !== 'RI' && e !== 'LA') continue;
      const n = neighbor(q, r, dir);
      const nk = key(n.q, n.r);
      if (!board.has(nk)) (e === 'RI' ? riverEndCells : laneEndCells).add(nk);
    }
    if (hasCap) capTargets.add(k);
    if (t.dockEdges.length) dockCount++;
    if (!game.ctx.crownedPeaks.has(k) && isPeakCandidate(t, game.config)) peaks.add(k);
  }
  // optimistic fill probability for forming rings (deep enough to matter);
  // 0 = already unfillable, ignore. Computed once per turn per hole.
  for (const [, h] of holes) {
    if (h.n >= HEURISTICS.holeShapeMinN) {
      h.pOpt = fillProb(h.pattern, h.dock, game.config);
    }
  }
  // ring projects: keep committed holes that still qualify, then top up with
  // the deepest most-fillable candidates (n < 6 — closed rings need no work)
  const committed = HOLE_COMMIT.get(game) || new Set();
  const projectHoles = new Set();
  for (const k of committed) {
    const h = holes.get(k);
    if (h && h.n >= HEURISTICS.holeShapeMinN && h.n < 6 && h.pOpt > 0 &&
        projectHoles.size < HEURISTICS.holeProjects) projectHoles.add(k);
  }
  if (projectHoles.size < HEURISTICS.holeProjects) {
    const cands = [];
    for (const [k, h] of holes) {
      if (!projectHoles.has(k) && h.n >= HEURISTICS.holeShapeMinN && h.n < 6 &&
          h.pOpt > 0) cands.push([k, h]);
    }
    cands.sort((a, b) => b[1].n - a[1].n || b[1].pOpt - a[1].pOpt);
    for (const [k] of cands) {
      if (projectHoles.size >= HEURISTICS.holeProjects) break;
      projectHoles.add(k);
    }
  }
  HOLE_COMMIT.set(game, projectHoles);
  const flagGroups = game.quests.flags.map((f) => ({
    flag: f,
    members: groups(board, f.terrain).find((g) => g.has(f.key)) || new Set([f.key]),
  }));
  const epic = game.quests.epic;
  const island = epic && !epic.done && epic.id === 'theIsland';
  let plan = island
    ? islandPlan(board, HEURISTICS, ISLAND_COMMIT.get(game) ?? null) : null;
  // feasibility triage: each ring tile is a specific 3-Oc coast draw, so a
  // template the remaining stack cannot plausibly fund is a trap — a doomed
  // flower seals frontier and starves the run's whole quest economy. Walk
  // away entirely (no chase bonus, no template-cell protection).
  if (plan && plan.cost * HEURISTICS.islandBudgetFactor > game.stackRemaining) plan = null;
  if (island) {
    if (plan && plan.center) ISLAND_COMMIT.set(game, plan.center);
    else ISLAND_COMMIT.delete(game);
  }
  const transBefore = epic && !epic.done && epic.id === 'transcontinental'
    ? transCost(board, epic, HEURISTICS) : null;
  return {
    capTargets, riverEndCells, laneEndCells, dockFrontCells, peaks, dockCount,
    holes, projectHoles, flagGroups,
    islandBefore: plan ? plan.cost : null,
    islandCells: plan ? plan.cells : null,
    islandCenter: plan ? plan.center : null,
    transBefore,
  };
}

// Heuristic bonus on top of dry-run points: quest/epic/flag progress, junction
// setup, keeping rivers cappable and lanes harborable.
export function questBonus(game, c, result, tctx) {
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
      const after = new Map(game.board);
      after.set(key(c.q, c.r), c.tile);
      // plan the crane-rail-lane-dock program like an island: pay per point
      // of cost-to-go removed, symmetric so the plan is not built over
      bonus += H.epicTransStep * (tctx.transBefore - transCost(after, epic, H));
      if (events.some((e) => e.type === 'tradeRoute')) {
        // a fired pair never re-fires: a trade route that misses the epic's
        // thresholds burns the pair, so check the full condition before
        // choosing to complete the lane. Pairs fired by rail growth on an
        // already-short completed route were lost anyway: take the points.
        if (transcontinentalSatisfied(after, events, epic)) {
          bonus += epic.points + H.tradeRouteEpicBonus;
        } else if (events.some((e) => e.type === 'laneCompleted')) {
          bonus -= H.transPrematureFire;
        }
      }
    } else if (epic.id === 'theIsland' && tctx.islandBefore !== null) {
      // chase the best island template: reward placements that reduce its
      // cost-to-go — and, symmetrically, punish placements that wreck it
      // (a wrong tile on a template cell kills that plan for good)
      const after = new Map(game.board);
      after.set(key(c.q, c.r), c.tile);
      const costAfter = islandPlan(after, H, tctx.islandCenter).cost;
      bonus += H.epicIslandStep * (tctx.islandBefore - costAfter);
      if (costAfter === 0 && isIslandRinged(after, epic.minRegion)) bonus += epic.points;
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
  // (a crowded lane end can never take its harbor — the route dies with it)
  for (const n of neighbors(c.q, c.r)) {
    const nk = key(n.q, n.r);
    if (tctx.riverEndCells.has(nk)) bonus -= H.crowdEndPenalty;
    if (tctx.laneEndCells.has(nk) && !tctx.laneEndCells.has(key(c.q, c.r))) {
      bonus -= H.laneCrowdPenalty;
    }
  }

  // harbor setup: a dock facing a lane continuation cell invites a port call
  for (const di of c.tile.dockEdges) {
    const n = neighbor(c.q, c.r, di);
    if (tctx.laneEndCells.has(key(n.q, n.r))) bonus += H.harborSetup;
  }

  // perfect engineering (§5.3: 6 neighbors, 6 matches). Two decisions:
  // (1) while a ring forms, keep its inward edges on one soft terrain (the
  //     cheap proxy for fillability); (2) when CLOSING the 6th ring neighbor,
  //     pay by the actual per-draw probability that some catalog tile fills
  //     the hole perfectly — a sealed unfillable ring is a dead cell forever.
  for (let dir = 0; dir < 6; dir++) {
    const n = neighbor(c.q, c.r, dir);
    const nk = key(n.q, n.r);
    const hole = tctx.holes.get(nk);
    if (!hole || hole.n < H.holeShapeMinN || hole.pOpt <= 0) continue;
    const isProject = tctx.projectHoles.has(nk);
    if (hole.n !== 5 && !isProject) continue; // shaping gradients: projects only
    const pattern = hole.pattern.slice();
    const dock = hole.dock.slice();
    const i = opposite(dir);
    pattern[i] = c.tile.edges[dir];
    dock[i] = c.tile.dockEdges.includes(dir);
    const p = fillProb(pattern, dock, game.config);
    if (hole.n === 5) {
      // closing the 6th ring neighbor: pay by actual fill probability
      bonus += p > 0 ? H.holeClosePerPct * p * 100 : -H.holeSealPenalty;
    } else if (p > 0) {
      bonus += H.holeShapeBonus * hole.n * Math.min(p / H.holeShapeProbRef, 2);
    } else if (hole.n >= H.holePoisonMinN) {
      bonus -= H.holePoisonPenalty * hole.n;
    }
  }
  // an imperfect tile squatting a fillable open hole spends a future perfect
  if (c.nbs === 6 && !result.perfect) {
    const hole = tctx.holes.get(key(c.q, c.r));
    if (hole) bonus -= H.holeClosePerPct * fillProb(hole.pattern, hole.dock, game.config) * 100;
  }

  // lane-route intent: routes only pay when finished, so plan toward docks
  const transActive = epic && !epic.done && epic.id === 'transcontinental';
  for (const e of events) {
    if (e.type === 'laneCompleted') {
      // a short completion during transcontinental can consume the crane's
      // dock for good (completed routes never grow) — even the engagement
      // bonus must not tempt the bot into burning the epic's geometry
      if (transActive && e.length < epic.minLane) bonus += 0;
      else if (game.ctx.lanesCompleted.size === 0) bonus += H.laneFirstCompleteBonus;
      else bonus += H.laneCompleteBonus;
    } else if (e.type === 'portCall') bonus += H.portCallSetup;
    else if (e.type === 'estuary') bonus += H.estuarySetup;
    else if (e.type === 'spring') bonus += H.springSetup;
    else if (e.type === 'riverCompleted') {
      // capping a river shorter than an active Long River quest wastes the
      // quest's only network (rivers never grow past a finished mouth+source)
      const lr = game.quests.standard.find((q) => q.id === 'longRiver');
      if (lr && e.length < lr.target) bonus -= H.riverEarlyCapPenalty;
    }
  }
  for (const m of result.edgeMatches) {
    if (m.terrain === 'LA' && m.matched) {
      bonus += H.laneExtend + (transActive ? H.epicLaneStep : 0);
    }
    // an unmatched La or Oc facing edge is La↔plain-Oc: that route end can
    // never reach a dock anymore — legal to waste, costly to waste
    if ((m.terrain === 'LA' || m.terrain === 'OC') && !m.matched) {
      bonus -= H.laneBrickPenalty;
    }
  }

  // lane ends must stay harborable: a dock can only sit where the land meets
  // the sea, so shape routes along the coastline, not out into open water
  if (c.tile.edges.includes('LA')) {
    let after = null;
    for (let dir = 0; dir < 6; dir++) {
      if (c.tile.edges[dir] !== 'LA') continue;
      const n = neighbor(c.q, c.r, dir);
      const nk = key(n.q, n.r);
      if (game.board.has(nk)) continue; // matched or bricked: handled above
      if (!after) {
        after = new Map(game.board);
        after.set(key(c.q, c.r), c.tile);
      }
      bonus += dockableCell(after, n.q, n.r, opposite(dir), game.config)
        ? H.laneEndDockable : -H.laneEndStranded;
      // ends in besieged cells get walled off before their harbor arrives
      let crowd = 0;
      for (const nn of neighbors(n.q, n.r)) {
        if (after.has(key(nn.q, nn.r))) crowd++;
      }
      bonus -= H.laneEndBesieged * Math.max(0, crowd - 1);
    }
  }

  // crane harbors only bridge land and sea while their rail edge is connected
  // — pays both when placing the crane onto rail and when railing up a crane
  for (const m of result.edgeMatches) {
    if (m.terrain !== 'RA' || !m.matched) continue;
    const n = neighbor(c.q, c.r, m.dir);
    const nt = game.board.get(key(n.q, n.r));
    if (c.tile.crane || (nt && nt.crane)) bonus += H.craneRailLink;
  }
  return bonus;
}

// Index of a standard quest worth rerolling, or -1. A quest is stale when its
// remaining need exceeds what the dead-quest guard would allow at spawn time;
// landOnly also dumps ocean-dependent quests it can never progress.
const OCEAN_QUESTS = new Set(['growTheOcean', 'riversEnd', 'twinHarbors', 'openTheRoute']);

// A sea one-shot is dead when its medium never materialized and the stack is
// nearly out: the game's auto-refresh only covers numeric quests, so the free
// rerolls are the only valve for these slots.
function deadOneShot(game, q) {
  if (game.stackRemaining >= HEURISTICS.oneShotDeadStack || q.progress > 0) return false;
  if (q.id === 'openTheRoute') {
    // groundwork = a lane network at least (minLane - 1) long; anything less
    // cannot become a docked >= minLane route on the remaining stack
    const need = (q.minLaneLength || 1) - 1;
    return !traceNetworks(game.board, 'LA').some((n) => n.size >= need);
  }
  if (q.id === 'twinHarbors') {
    let docks = 0;
    for (const [, t] of game.board) if (t.dockEdges.length) docks++;
    return docks < 1;
  }
  return false;
}

function staleQuestIndex(game, landOnly) {
  if (game.quests.rerolls <= 0) return -1;
  const div = game.config.quests.deadGuardDivisor;
  const allowance = Math.floor(game.stackRemaining / div) + HEURISTICS.staleQuestSlack;
  for (let i = 0; i < game.quests.standard.length; i++) {
    const q = game.quests.standard[i];
    if (landOnly && OCEAN_QUESTS.has(q.id)) return i;
    if (q.oneShot && deadOneShot(game, q)) return i;
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

  const tctx = aware ? turnContext(game) : null;
  const pool = cands.slice(0, HEURISTICS.topK);
  const crowns = crowningCells(game);
  let extra = 0;
  let shapers = 0;
  for (let i = HEURISTICS.topK; i < cands.length && extra < HEURISTICS.extraPool; i++) {
    const c = cands[i];
    // junction setups, peak crownings, 5/6-neighbor holes (perfect bait),
    // island ring spots, lane extensions and perfect-ring shapers are worth a
    // full dry-run even when their immediate edge points miss the top-K cut.
    // Shapers have their own sub-cap so they never crowd out island/crown
    // candidates further down the cheap-score order.
    const ck = key(c.q, c.r);
    const planned = tctx && (
      (tctx.islandCells && tctx.islandCells.has(ck)) ||
      (tctx.laneEndCells.has(ck) && c.tile.edges.includes('LA')));
    let shapesRing = false;
    if (tctx && !planned && !c.hasJunction && c.nbs < 5 && !crowns.has(ck) &&
        shapers < HEURISTICS.holePoolMax) {
      for (let dir = 0; dir < 6 && !shapesRing; dir++) {
        const n = neighbor(c.q, c.r, dir);
        const nk = key(n.q, n.r);
        const hole = tctx.holes.get(nk);
        if (hole && hole.pOpt > 0 && (hole.n === 5 || tctx.projectHoles.has(nk))) {
          shapesRing = true;
        }
      }
      if (shapesRing) shapers++;
    }
    if (c.hasJunction || c.nbs >= 5 || planned || crowns.has(ck) || shapesRing) {
      pool.push(c);
      extra++;
    }
  }
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
  // auto-refreshed quests were offered and not completed (the player saw
  // them); spawn-guard redraws never were — only the former join the base.
  const offered = stats.standardQuestsCompleted + stats.rerollsUsed +
    stats.questsAutoRefreshed + activeStandard;
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
