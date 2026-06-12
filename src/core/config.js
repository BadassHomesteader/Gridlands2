// Gridlands 2 — Tideline. Single source for every tunable number (DESIGN.md §11).
// Every numeric literal here is (TUNE); change numbers here, never in code.

export const CONFIG = {
  rules: {
    mountainCoast: 'repel', // 'repel' | 'cliff'  (DESIGN §3.2, §10)
    laneOceanRule: 'open',  // 'open'  | 'sealed' (DESIGN §3.2, §10)
    tradeIncome: true,      // DESIGN §5.7
  },

  stack: {
    start: 45,
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
        meadow: 24, hamlet: 9, pureSoft: 5, river: 13, rail: 10,
        foothills: 10, highMountain: 4,
        coast: 12, estuary: 3, openOcean: 3, harbor: 4, lane: 3,
      },
      voyage: {
        meadow: 22, hamlet: 8, pureSoft: 4, river: 12, rail: 10,
        foothills: 10, highMountain: 4,
        coast: 12, estuary: 4, openOcean: 4, harbor: 5, lane: 5,
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
    // §4.2 step 5 — finale multipliers.
    finale: { harborMult: 2, laneMult: 2 },
    // §4.2 step 6 — ocean-family cap (% of total), enforced LAST.
    oceanFamilyCap: { tide: 25, voyage: 30, finale: 35 },
  },

  // §4 catalog sub-splits (fractions sum to 1) + variant rates.
  tiles: {
    meadow: { splits: [['3-3', 0.40], ['4-2', 0.35], ['2-2-2', 0.25]] },
    hamlet: { splits: [['2ho', 0.65], ['3ho', 0.35]] },
    river: { splits: [['straight', 0.40], ['wide', 0.35], ['tight', 0.25]] },
    rail: { splits: [['straight', 0.40], ['wide', 0.35], ['tight', 0.25]] },
    foothills: { splits: [['adjacent', 0.60], ['skip', 0.40]] },
    coast: { splits: [['2oc', 0.60], ['3oc', 0.40]] },
    estuary: { splits: [['ri3', 0.50], ['ri4', 0.50]] },
    lane: { splits: [['straight', 0.60], ['wide', 0.40]] },
    harborCraneRate: 1 / 3, // 1 in 3 Harbors is a Crane Harbor
  },

  scoring: {
    // §3.1 / §5.1
    softMatch: 10,
    hardMatch: 15,
    junction: { source: 30, estuary: 40, portCall: 25, cliff: 10 },
    // §5.2 clean streak
    streak: { per: 5, cap: 50 },
    // §5.3 perfect placement (escalating ladder for consecutive perfects, cap = last)
    perfect: { ladder: [50, 75, 100], bonusTiles: 1 },
    // §5.4–§5.6 structure completions
    structures: {
      riverCompleted: { perTile: 12, tiles: 2 },
      laneCompleted: { perTile: 20, perHinterland: 5, tiles: 2 },
      peakCrowned: { points: 60, tiles: 1, minPrintedMtEdges: 4 },
      tradeRoute: {
        points: 150, tiles: 4, extraPairPoints: 50,
        minRailNetwork: 4, shipRenderCap: 8,
      },
      snowline: { points: 25, groupSize: 5 },
    },
    // §5.7 trade income
    tradeIncome: { perRoute: 2, cap: 10 },
    // §5.8 end-game bonuses (per tile)
    endGame: {
      longestRail: 10, longestRiver: 10,
      largestMountainGroup: 8, largestOceanGroup: 5,
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
    themedRewardRate: 0.60,   // §6.4
    reward: { base: 100, perTarget: 10, tileBase: 2, tileDivisor: 4, tileCap: 4 },
    scaling: { perCompletion: 2, capAboveBase: 8 },
    deadGuardDivisor: 4,      // target <= bestProgress + floor(tilesRemaining / 4)
    oneShotMaxCompletions: 2,
    rerolls: { atStart: 1, atTide: 1, atVoyage: 1 }, // 3 total per session
    flag: { targetBase: 3, targetDie: 4, points: 60, tiles: 2 }, // grow by 3 + d4
    standard: [
      { id: 'bigForest', metric: 'group:FO', base: 6, die: 3, from: 'pastoral' },
      { id: 'bigField', metric: 'group:FI', base: 6, die: 3, from: 'pastoral' },
      { id: 'bigVillage', metric: 'group:HO', base: 6, die: 3, from: 'pastoral' },
      { id: 'longRiver', metric: 'network:RI', base: 4, die: 3, from: 'pastoral' },
      { id: 'railLine', metric: 'network:RA', base: 4, die: 3, from: 'pastoral' },
      { id: 'mountainRange', metric: 'group:MT', base: 5, die: 3, from: 'highlands' },
      { id: 'growTheOcean', metric: 'group:OC', base: 6, die: 4, from: 'tide' },
      { id: 'riversEnd', oneShot: true, points: 100, tiles: 2, from: 'tide' },
      { id: 'twinHarbors', oneShot: true, points: 150, tiles: 3, from: 'tide' },
      { id: 'openTheRoute', oneShot: true, points: 180, tiles: 4, minLaneLength: 5, from: 'lanesUnlocked' },
    ],
    epics: [
      { id: 'theIsland', points: 400, tiles: 6, minRegion: 3 },
      { id: 'transcontinental', points: 400, tiles: 6, minRail: 6, minLane: 5 },
      { id: 'crownTheRange', points: 350, tiles: 5, peaks: 2 },
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
    discardCost: -25,
    harborPity: { lanes: 3, maxConnectedHarbors: 1, mult: 3, draws: 10 },
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
    placements: { p10Min: 80, p90Max: 135 }, // P90 hard gate
    reproductionMax: 0.65, // hard gate
    questCompletion: { min: 0.60, max: 0.75, epic: 0.55 },
    engagement: { riverCompleted: 0.70, laneCompleted: 0.50, peakCrowned: 0.40 },
    sealedAdoption: { maxStrandRate: 0.01, laneEngagementWithin: 0.10 },
  },
};

export default CONFIG;
