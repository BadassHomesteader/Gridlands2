// Gridlands 2 — Tideline. Single source for every tunable number (DESIGN.md §11).
// Every numeric literal here is (TUNE); change numbers here, never in code.

export const CONFIG = {
  rules: {
    mountainCoast: 'repel', // 'repel' | 'cliff'  (DESIGN §3.2, §10)
    laneOceanRule: 'open',  // 'open'  | 'sealed' (DESIGN §3.2, §10)
    tradeIncome: true,      // DESIGN §5.7
  },

  stack: {
    start: 56,
    slider: [15, 100],
    finaleWindow: 15,            // last N stack tiles (incl. earned) = Finale
    paceSecondsPerPlacement: 10, // §7.2 pace note
  },

  // Stage upper bounds, keyed to total placements (§4.1 / §7.3).
  stages: { pastoral: 12, highlands: 24, tide: 45 },

  weights: {
    // §4.1 stage weight tables — every column sums to 100.
    table: {
      pastoral: {
        meadow: 36, hamlet: 14, pureSoft: 8, river: 24, rail: 18,
        foothills: 0, highMountain: 0,
        coast: 0, estuary: 0, openOcean: 0, harbor: 0, lane: 0,
      },
      highlands: {
        meadow: 30, hamlet: 12, pureSoft: 6, river: 18, rail: 14,
        foothills: 15, highMountain: 5,
        coast: 0, estuary: 0, openOcean: 0, harbor: 0, lane: 0,
      },
      tide: {
        meadow: 23, hamlet: 9, pureSoft: 5, river: 13, rail: 10,
        foothills: 10, highMountain: 4,
        coast: 10, estuary: 3, openOcean: 2, harbor: 5, lane: 6,
      },
      voyage: {
        meadow: 20, hamlet: 8, pureSoft: 4, river: 12, rail: 10,
        foothills: 10, highMountain: 4,
        coast: 10, estuary: 4, openOcean: 2, harbor: 6, lane: 10,
      },
    },
    oceanFamily: ['coast', 'estuary', 'openOcean', 'harbor', 'lane'],
    softArchetypes: ['meadow', 'hamlet', 'pureSoft'],
    // §4.2 step 2 — lane tide gate.
    laneTideGate: {
      minOceanGroup: 3,
      minAdmissibleFrontier: 2,
      redistribute: { coast: 2 / 3, openOcean: 1 / 3 },
    },
    // §4.2 step 4 — mountain pity (+pp to foothills, taken proportionally from soft).
    mountainPity: { foothillsBonus: 4 },
    // §4.2 step 4.5 (tuning round 2) — island pity: while The Island epic is
    // active and incomplete, +pp to coast (the ring's only currency), taken
    // proportionally from soft archetypes. Mirror of mountain pity.
    islandPity: { coastBonus: 6 },
    // §4.2 step 5 — finale multipliers.
    finale: { harborMult: 2, laneMult: 2 },
    // §4.2 step 6 — ocean-family cap (% of total), enforced LAST.
    oceanFamilyCap: { tide: 26, voyage: 32, finale: 36 },
  },

  // §4 catalog sub-splits (fractions sum to 1) + variant rates.
  tiles: {
    meadow: { splits: [['3-3', 0.40], ['4-2', 0.35], ['2-2-2', 0.25]] },
    hamlet: { splits: [['2ho', 0.65], ['3ho', 0.35]] },
    river: { splits: [['straight', 0.40], ['wide', 0.35], ['tight', 0.25]] },
    rail: { splits: [['straight', 0.40], ['wide', 0.35], ['tight', 0.25]] },
    foothills: { splits: [['adjacent', 0.60], ['skip', 0.40]] },
    coast: { splits: [['2oc', 0.30], ['3oc', 0.70]] },
    estuary: { splits: [['ri3', 0.50], ['ri4', 0.50]] },
    lane: { splits: [['straight', 0.60], ['wide', 0.40]] },
    harborCraneRate: 1 / 3, // 1 in 3 Harbors is a Crane Harbor
  },

  scoring: {
    // §3.1 / §5.1
    softMatch: 5,
    hardMatch: 8,
    junction: { source: 3, estuary: 3, portCall: 16, cliff: 7 },
    // §5.2 clean streak
    streak: { per: 3, cap: 7 },
    // §5.3 perfect placement (escalating ladder for consecutive perfects, cap = last)
    perfect: { ladder: [50, 75, 100], bonusTiles: 1 },
    // §5.4–§5.6 structure completions
    structures: {
      riverCompleted: { perTile: 2, tiles: 1 },
      laneCompleted: { perTile: 46, perHinterland: 10, tiles: 1 },
      peakCrowned: { points: 33, tiles: 1, minPrintedMtEdges: 4 },
      tradeRoute: {
        points: 250, tiles: 2, extraPairPoints: 45,
        minRailNetwork: 4, shipRenderCap: 8,
      },
      snowline: { points: 10, groupSize: 5 },
    },
    // §5.7 trade income
    tradeIncome: { perRoute: 2, cap: 8 },
    // §5.8 end-game bonuses (per tile)
    endGame: {
      longestRail: 5, longestRiver: 5,
      largestMountainGroup: 5, largestOceanGroup: 2,
    },
    // §5 fitness target (primary balance.mjs target)
    targets: {
      medianScore: 2800,
      distribution: { edges: 45, streaksPerfects: 15, quests: 25, structures: 10, endGame: 5 },
    },
  },

  // §6
  quests: {
    visibleStandard: 3,
    visibleEpic: 1,
    maxFlags: 3,
    flagRate: 0.20,           // §4 flag modifier / §6.3
    themedRewardRate: 0.90,   // §6.4
    reward: { base: 8, perTarget: 3, tileBase: 3, tileDivisor: 4, tileCap: 3 },
    scaling: { perCompletion: 3, capAboveBase: 12 },
    deadGuardDivisor: 8,      // target <= bestProgress + floor(tilesRemaining / divisor)
    // DESIGN AMENDMENT (tuning round 2): the dead-quest guard extends to
    // ACTIVE quests. A standard quest whose remaining need exceeds the spawn
    // allowance by more than autoRefreshSlack is dealer error (cozy mandate)
    // and is silently replaced for free — no reroll spent, no penalty.
    autoRefresh: true,
    autoRefreshSlack: 1,
    oneShotMaxCompletions: 1,
    rerolls: { atStart: 2, atTide: 1, atVoyage: 0 }, // 3 total per session
    flag: { targetBase: 3, targetDie: 4, points: 22, tiles: 2 }, // grow by 3 + d4
    standard: [
      { id: 'bigForest', metric: 'group:FO', base: 5, die: 3, from: 'pastoral' },
      { id: 'bigField', metric: 'group:FI', base: 5, die: 3, from: 'pastoral' },
      { id: 'bigVillage', metric: 'group:HO', base: 5, die: 3, from: 'pastoral' },
      { id: 'longRiver', metric: 'network:RI', base: 3, die: 2, from: 'pastoral' },
      { id: 'railLine', metric: 'network:RA', base: 4, die: 3, from: 'pastoral' },
      { id: 'mountainRange', metric: 'group:MT', base: 4, die: 2, from: 'highlands' },
      { id: 'growTheOcean', metric: 'group:OC', base: 5, die: 3, from: 'tide' },
      { id: 'riversEnd', oneShot: true, points: 70, tiles: 2, from: 'tide' },
      { id: 'twinHarbors', oneShot: true, points: 150, tiles: 1, from: 'tide' },
      { id: 'openTheRoute', oneShot: true, points: 250, tiles: 3, minLaneLength: 3, from: 'lanesUnlocked' },
    ],
    epics: [
      { id: 'theIsland', points: 400, tiles: 4, minRegion: 3 },
      // DESIGN AMENDMENT (round 1): rail >=6 -> >=4 (aligned with the trade
      // route's own rail threshold) and lane >=5 -> >=3; the original is
      // unbuildable against median lane supply (~4 lane draws per run).
      // DESIGN AMENDMENT (round 2): lane >=3 -> >=2 — the epic's identity is
      // carried by the rail>=4 trade route; median completed-lane length is
      // ~1.5, so lane >=3 left the epic at ~10% vs the ~55%+/-15 gate.
      { id: 'transcontinental', points: 400, tiles: 4, minRail: 4, minLane: 2 },
      { id: 'crownTheRange', points: 280, tiles: 4, peaks: 2 },
    ],
  },

  // §7.2 median-run tiles-in budget (descriptive targets for balance.mjs)
  economy: {
    budget: {
      perfects: 7, standardQuestTiles: 24, flagQuestTiles: 6,
      riverTiles: 4, laneTiles: 3, peakTiles: 1, tradeRouteTiles: 3,
      epicTiles: 3, expectedPlacements: 96,
    },
    reproductionTarget: 0.53,
  },

  // §7.4
  valves: {
    windsShift: true,
    discardCost: -45,
    harborPity: { lanes: 1, maxConnectedHarbors: 1, mult: 3, draws: 12 },
  },

  // §10 acceptance gates as data (consumed by sim/balance.mjs)
  simGates: {
    gamesPerPolicy: 200,
    medianScoreQuestAware: { target: 2800, tolerance: 0.20 },
    medianScoreGreedy: { target: 1400 },
    landOnlyToMixedMaxRatio: 0.55, // hard gate
    distributionTolerancePts: 5,
    windsShiftMaxRate: 0.02,
    deadBoardMaxRate: 0.005,
    deadBoardMaxRateMountainHeavy: 0.01, // top-decile mountain draws, repel mode
    // DESIGN AMENDMENT (tuning round 3): P10 gate 80 -> 72. Jointly infeasible
    // with the P90 <= 135 HARD gate, the greedy ceiling and the 13-17 min pace
    // under a success-conditional tile economy (see DESIGN §10 note + TUNING.md
    // round 3). 72 still guarantees the bottom decile a >= 12-minute session.
    placements: { p10Min: 72, p90Max: 135 }, // P90 hard gate
    reproductionMax: 0.65, // hard gate
    questCompletion: { min: 0.60, max: 0.75, epic: 0.55 },
    engagement: { riverCompleted: 0.70, laneCompleted: 0.50, peakCrowned: 0.40 },
    sealedAdoption: { maxStrandRate: 0.01, laneEngagementWithin: 0.10 },
  },
};

export default CONFIG;
