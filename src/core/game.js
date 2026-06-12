// Game class (SPEC "Core API contract"): orchestrates board, scoring, quests,
// the draw stack with dynamic weights, valves (winds shift / discard), stage
// announcements, undo and serialization. Pure core: seeded rng only.

import { CONFIG } from './config.js';
import { mulberry32 } from './rng.js';
import {
  createBoard, canPlace as canPlaceOn, validPlacements, frontier,
  largestGroupSize, traceNetworks,
} from './board.js';
import { makeTile, rotateTile, drawTile, stageFor, isPeakCandidate } from './tiles.js';
import { createScoringContext, applyPlacement, endGameBonuses } from './scoring.js';
import {
  createQuestState, processPlacement as processQuests, grantReroll, useReroll,
  drawQuestRewardTile,
} from './quests.js';

// rng wrapper that counts calls so serialize/deserialize can replay state.
function countingRng(seed, calls = 0) {
  const base = mulberry32(seed);
  for (let i = 0; i < calls; i++) base();
  const rng = () => { rng.calls++; return base(); };
  rng.calls = calls;
  return rng;
}

function probe(archetype, edges) {
  return { id: 'probe-' + archetype, archetype, edges, dockEdges: [], crane: false, flag: null, seed: 0, rotation: 0 };
}

const LANE_PROBE = probe('lane', ['LA', 'OC', 'OC', 'LA', 'OC', 'OC']);
const SOFT_PROBE = probe('meadow', ['GR', 'GR', 'GR', 'GR', 'GR', 'GR']);

const TERRAIN_LIST = ['GR', 'FO', 'FI', 'HO', 'RI', 'RA', 'MT', 'OC', 'LA'];

const STRUCTURE_EVENTS = [
  'riverCompleted', 'laneCompleted', 'peakCrowned', 'tradeRoute', 'snowline',
  'estuary', 'spring', 'portCall', 'cliff',
];

export class Game {
  constructor({ seed = 1, tileCount, zen = false, config = CONFIG } = {}) {
    this.config = config;
    this.seed = seed >>> 0;
    this.zen = !!zen;
    this.tileCount = tileCount ?? config.stack.start;
    this.rng = countingRng(this.seed);
    this.board = createBoard();
    this.ctx = createScoringContext();
    this.placements = 0;
    this.score = 0;
    this.channels = { edges: 0, streaksPerfects: 0, quests: 0, structures: 0, endGame: 0 };
    this.stackRemaining = this.zen ? Infinity : this.tileCount;
    this.lookahead = [];
    this.questRewardPending = 0;
    this.harborPityDrawsLeft = 0;
    this.lanesUnlocked = false;
    this.finaleAnnounced = false;
    this.over = false;
    this.hand = null;
    this.endGameResult = null;
    this._snapshot = null;
    this._counters = {
      draws: 0, discards: 0,
      windsShiftFires: 0, windsShiftMeadowFallbacks: 0,
      perfects: 0, maxStreak: 0,
      tilesEarned: 0, tilesEarnedFromQuests: 0,
      questsCompleted: 0,
      deadBoard: false,
      structures: Object.fromEntries(STRUCTURE_EVENTS.map((e) => [e, 0])),
    };
    this.quests = createQuestState(this._questEnv(), this.rng, config);
    this._draw([]);
  }

  get currentTile() {
    return this.hand;
  }

  _questEnv() {
    return {
      board: this.board,
      stage: stageFor(this.placements, this.config),
      lanesUnlocked: this.lanesUnlocked,
      tilesRemaining: this.stackRemaining,
    };
  }

  // Snapshot consumed by the draw-weight engine (tiles.computeWeights).
  _gameState() {
    const pity = this.config.valves.harborPity;
    let needy = false;
    for (const net of traceNetworks(this.board, 'LA')) {
      if (net.size >= pity.lanes && new Set(net.dockHarborKeys).size <= pity.maxConnectedHarbors) {
        needy = true;
        break;
      }
    }
    let uncrowned = false;
    for (const [k, t] of this.board) {
      if (isPeakCandidate(t, this.config) && !this.ctx.crownedPeaks.has(k)) {
        uncrowned = true;
        break;
      }
    }
    const laneCells = new Set(
      validPlacements(this.board, LANE_PROBE, this.config).map((p) => p.q + ',' + p.r));
    return {
      placements: this.placements,
      stackRemaining: this.stackRemaining,
      largestOceanGroup: largestGroupSize(this.board, 'OC'),
      laneAdmissibleFrontier: laneCells.size,
      needyLaneRoute: needy,
      harborPityDrawsLeft: this.harborPityDrawsLeft,
      uncrownedPeak: uncrowned,
      activeFlags: this.quests ? this.quests.flags.length : 0,
    };
  }

  // One tile from the stack: pending quest rewards first (60% themed), then
  // the dynamic stage-weight table. Override point for tests.
  _generateTile(gs) {
    if (this.questRewardPending > 0) {
      this.questRewardPending--;
      const themed = drawQuestRewardTile(this.quests, this.rng, this.config);
      if (themed) return themed;
    }
    return drawTile(this.rng, gs, this.config);
  }

  _finish(events, deadBoard = false) {
    const eg = endGameBonuses(this.board, this.config);
    this.endGameResult = eg;
    this.score += eg.points;
    this.channels.endGame += eg.points;
    this.over = true;
    this.hand = null;
    if (deadBoard) this._counters.deadBoard = true;
    events.push({ type: 'gameOver', deadBoard, endGame: eg });
  }

  // Draw the next tile into hand, running the winds-shift valve (§7.4.1).
  _draw(events) {
    if (this.over) return;
    if (this.stackRemaining <= 0) {
      this._finish(events);
      return;
    }
    const gs = this._gameState();
    if (gs.needyLaneRoute) this.harborPityDrawsLeft = this.config.valves.harborPity.draws;
    else if (this.harborPityDrawsLeft > 0) this.harborPityDrawsLeft--;
    const gate = this.config.weights.laneTideGate;
    if (!this.lanesUnlocked &&
        gs.largestOceanGroup >= gate.minOceanGroup &&
        gs.laneAdmissibleFrontier >= gate.minAdmissibleFrontier) {
      this.lanesUnlocked = true;
    }
    this.stackRemaining--;
    this._counters.draws++;
    let tile = this.lookahead.length ? this.lookahead.shift() : this._generateTile(gs);
    if (this.config.valves.windsShift && this.board.size > 0 &&
        validPlacements(this.board, tile, this.config).length === 0) {
      this._counters.windsShiftFires++;
      events.push({ type: 'windsShift' });
      tile = this._generateTile(gs); // free auto-reroll, no extra stack cost
      if (validPlacements(this.board, tile, this.config).length === 0) {
        this._counters.windsShiftMeadowFallbacks++;
        tile = makeTile('meadow', this.rng, this.config); // guaranteed all-soft
        if (validPlacements(this.board, tile, this.config).length === 0) {
          this._finish(events, true); // dead board even after both valves
          return;
        }
      }
    }
    this.hand = tile;
  }

  nextTiles(n = 1) {
    if (this.over) return [];
    const limit = Math.min(n, this.stackRemaining);
    while (this.lookahead.length < limit) {
      this.lookahead.push(this._generateTile(this._gameState()));
    }
    return this.lookahead.slice(0, limit);
  }

  rotate(dir = 1) {
    if (!this.hand) return null;
    this.hand = rotateTile(this.hand, dir);
    return this.hand;
  }

  canPlace(q, r) {
    if (!this.hand) return { legal: false, reasons: ['no tile in hand'] };
    return canPlaceOn(this.board, this.hand, q, r, this.config);
  }

  // All legal spots for the tile in hand: [{ q, r, rotations: [r0..] }],
  // rotations relative to the current orientation.
  legalPlacements() {
    if (!this.hand) return [];
    const cells = new Map();
    for (const p of validPlacements(this.board, this.hand, this.config)) {
      const k = p.q + ',' + p.r;
      if (!cells.has(k)) cells.set(k, { q: p.q, r: p.r, rotations: [] });
      cells.get(k).rotations.push(p.rotation);
    }
    return [...cells.values()];
  }

  place(q, r) {
    if (this.over || !this.hand) return null;
    const snapshot = JSON.stringify(this._serializeData());
    const result = applyPlacement(this.board, this.hand, q, r, this.ctx, this.config);
    if (!result) return null;
    this._snapshot = snapshot;
    this.placements++;
    this.hand = null;
    const events = [];

    this.channels.edges += result.breakdown.edges;
    this.channels.streaksPerfects += result.breakdown.streak + result.breakdown.perfect;
    this.channels.structures +=
      result.breakdown.junctions + result.breakdown.structures + result.breakdown.tradeIncome;
    if (result.perfect) this._counters.perfects++;
    this._counters.maxStreak = Math.max(this._counters.maxStreak, result.combo);
    for (const e of result.networkEvents) {
      if (this._counters.structures[e.type] !== undefined) this._counters.structures[e.type]++;
    }

    // quests: progress, completions, respawns; themed rewards feed the stack
    const qres = processQuests(this.quests, this._questEnv(), result, this.rng, this.config);
    result.questsCompleted = qres.completed;
    result.questsProgressed = qres.progressed;
    result.breakdown.quests = qres.points;
    result.points += qres.points;
    this.channels.quests += qres.points;
    this._counters.questsCompleted += qres.completed.length;

    // tile awards (perfects + structures from scoring, plus quest rewards)
    const questTiles = qres.tiles;
    result.tilesAwarded += questTiles;
    this.stackRemaining += result.tilesAwarded;
    this.questRewardPending += questTiles;
    this._counters.tilesEarned += result.tilesAwarded;
    this._counters.tilesEarnedFromQuests += questTiles;

    this.score += result.points;

    // stage transitions (§7.3) + reroll grants (§6.1)
    const prevStage = stageFor(this.placements - 1, this.config);
    const newStage = stageFor(this.placements, this.config);
    if (newStage !== prevStage) {
      events.push({ type: 'stage', stage: newStage });
      if (newStage === 'tide') {
        grantReroll(this.quests, this.config.quests.rerolls.atTide);
        events.push({ type: 'rerollGranted', stage: 'tide' });
      } else if (newStage === 'voyage') {
        grantReroll(this.quests, this.config.quests.rerolls.atVoyage);
        events.push({ type: 'rerollGranted', stage: 'voyage' });
      }
    }
    if (!this.finaleAnnounced && this.stackRemaining <= this.config.stack.finaleWindow) {
      this.finaleAnnounced = true;
      events.push({ type: 'finale', stackRemaining: this.stackRemaining });
    }

    this._draw(events);
    result.events = events;
    return result;
  }

  // Strategic discard (§7.4.2): always available, costs points, never free.
  discard() {
    if (this.over || !this.hand) return null;
    this._snapshot = JSON.stringify(this._serializeData());
    this.score += this.config.valves.discardCost;
    this._counters.discards++;
    this.hand = null;
    const events = [{ type: 'discard', cost: this.config.valves.discardCost }];
    this._draw(events);
    return { events, tile: this.hand };
  }

  // Spend a standard-quest reroll on slot `index`.
  rerollQuest(index) {
    if (this.over) return null;
    return useReroll(this.quests, index, this._questEnv(), this.rng, this.config);
  }

  // Single-level undo: restores the full state snapshot taken before the
  // last place()/discard().
  undo() {
    if (!this._snapshot) return false;
    this._restore(JSON.parse(this._snapshot));
    this._snapshot = null;
    return true;
  }

  get stats() {
    const c = this._counters;
    const largestGroups = {};
    for (const t of TERRAIN_LIST) largestGroups[t] = largestGroupSize(this.board, t);
    const probeTile = this.hand || SOFT_PROBE;
    return {
      seed: this.seed,
      zen: this.zen,
      score: this.score,
      placements: this.placements,
      channels: { ...this.channels },
      stage: stageFor(this.placements, this.config),
      stackRemaining: this.stackRemaining,
      draws: c.draws,
      discards: c.discards,
      tilesEarned: c.tilesEarned,
      tilesEarnedFromQuests: c.tilesEarnedFromQuests,
      reproduction: this.placements > 0 ? c.tilesEarned / this.placements : 0,
      perfects: c.perfects,
      perfectRate: this.placements > 0 ? c.perfects / this.placements : 0,
      maxStreak: c.maxStreak,
      windsShiftFires: c.windsShiftFires,
      windsShiftRate: c.draws > 0 ? c.windsShiftFires / c.draws : 0,
      windsShiftMeadowFallbacks: c.windsShiftMeadowFallbacks,
      stuckStates: c.windsShiftFires,
      deadBoard: c.deadBoard,
      questsCompleted: c.questsCompleted,
      standardQuestsCompleted: this.quests.completedStandard,
      flagsCompleted: this.quests.flagsCompleted,
      flagsFaded: this.quests.flagsFaded,
      epic: this.quests.epic
        ? { id: this.quests.epic.id, done: this.quests.epic.done, progress: this.quests.epic.progress }
        : null,
      rerollsLeft: this.quests.rerolls,
      rerollsUsed: this.quests.rerollsUsed,
      structures: { ...c.structures },
      engagement: {
        riverCompleted: c.structures.riverCompleted > 0,
        laneCompleted: c.structures.laneCompleted > 0,
        peakCrowned: c.structures.peakCrowned > 0,
      },
      largestGroups,
      endGame: this.endGameResult
        ? { ...this.endGameResult.breakdown, points: this.endGameResult.points }
        : null,
      legalMovesRemaining: validPlacements(this.board, probeTile, this.config).length,
      frontierCells: frontier(this.board).length,
    };
  }

  _serializeData() {
    return {
      v: 1,
      seed: this.seed,
      rngCalls: this.rng.calls,
      zen: this.zen,
      tileCount: this.tileCount,
      placements: this.placements,
      score: this.score,
      channels: { ...this.channels },
      stackRemaining: this.stackRemaining === Infinity ? null : this.stackRemaining,
      questRewardPending: this.questRewardPending,
      harborPityDrawsLeft: this.harborPityDrawsLeft,
      lanesUnlocked: this.lanesUnlocked,
      finaleAnnounced: this.finaleAnnounced,
      over: this.over,
      hand: this.hand,
      lookahead: this.lookahead,
      endGameResult: this.endGameResult,
      board: [...this.board.entries()],
      ctx: {
        streak: this.ctx.streak,
        consecutivePerfects: this.ctx.consecutivePerfects,
        sourcePaid: [...this.ctx.sourcePaid],
        estuaryPaid: [...this.ctx.estuaryPaid],
        riversCompleted: [...this.ctx.riversCompleted],
        lanesCompleted: [...this.ctx.lanesCompleted],
        crownedPeaks: [...this.ctx.crownedPeaks],
        snowlineKeys: [...this.ctx.snowlineKeys],
        firedTradeRoutes: [...this.ctx.firedTradeRoutes],
      },
      quests: this.quests,
      counters: this._counters,
    };
  }

  serialize() {
    return JSON.stringify(this._serializeData());
  }

  // d must be freshly parsed/cloned data the Game may own.
  _restore(d) {
    this.seed = d.seed;
    this.zen = d.zen;
    this.tileCount = d.tileCount;
    this.rng = countingRng(d.seed, d.rngCalls);
    this.placements = d.placements;
    this.score = d.score;
    this.channels = d.channels;
    this.stackRemaining = d.stackRemaining === null ? Infinity : d.stackRemaining;
    this.questRewardPending = d.questRewardPending;
    this.harborPityDrawsLeft = d.harborPityDrawsLeft;
    this.lanesUnlocked = d.lanesUnlocked;
    this.finaleAnnounced = d.finaleAnnounced;
    this.over = d.over;
    this.hand = d.hand;
    this.lookahead = d.lookahead;
    this.endGameResult = d.endGameResult;
    this.board = new Map(d.board);
    this.ctx = {
      streak: d.ctx.streak,
      consecutivePerfects: d.ctx.consecutivePerfects,
      sourcePaid: new Set(d.ctx.sourcePaid),
      estuaryPaid: new Set(d.ctx.estuaryPaid),
      riversCompleted: new Set(d.ctx.riversCompleted),
      lanesCompleted: new Set(d.ctx.lanesCompleted),
      crownedPeaks: new Set(d.ctx.crownedPeaks),
      snowlineKeys: new Set(d.ctx.snowlineKeys),
      firedTradeRoutes: new Set(d.ctx.firedTradeRoutes),
    };
    this.quests = d.quests;
    this._counters = d.counters;
  }

  static deserialize(json, config = CONFIG) {
    const d = typeof json === 'string' ? JSON.parse(json) : structuredClone(json);
    const g = Object.create(Game.prototype);
    g.config = config;
    g._snapshot = null;
    g._restore(d);
    return g;
  }
}
