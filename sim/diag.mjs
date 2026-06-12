#!/usr/bin/env node
// Scratch diagnostics for tuning rounds: per-epic completion, lane/quest
// economy, perfect-opportunity counts. Not part of the gate harness.
// node sim/diag.mjs [--games=100] [--seed=1001] [--config=overrides.json]

import { readFileSync } from 'node:fs';
import { CONFIG } from '../src/core/config.js';
import { runGame } from './autoplay.mjs';

function deepMerge(base, over) {
  if (base === null || over === null || Array.isArray(base) || Array.isArray(over) ||
      typeof base !== 'object' || typeof over !== 'object') return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  return out;
}

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a, true];
}));
const games = Number(args.games || 100);
const seed = Number(args.seed || 1001);
let config = CONFIG;
if (args.config) config = deepMerge(structuredClone(CONFIG), JSON.parse(readFileSync(args.config, 'utf8')));

const epicStats = {}; // id -> {n, done, progSum}
let comp = 0, rerolls = 0, perfects = 0, lanesDone = 0, laneTilesDrawn = 0, harborsDrawn = 0;
let tradeRoutes = 0, portCalls = 0, springs = 0, estuaries = 0, peaks = 0, snowlines = 0;
let placements = 0, tilesEarned = 0, flagsDone = 0, flagsFaded = 0, score = 0;
let largestLA = 0, largestOC = 0, discards = 0;
const laneDoneRuns = [];

for (let i = 0; i < games; i++) {
  const g = runGame({ policy: 'questAware', seed: (seed + i * 7919) >>> 0, config });
  const e = g.epic;
  if (e) {
    epicStats[e.id] ??= { n: 0, done: 0, progSum: 0 };
    epicStats[e.id].n++;
    if (e.done) epicStats[e.id].done++;
    epicStats[e.id].progSum += e.progress;
  }
  comp += g.standardQuestsCompleted;
  rerolls += g.rerollsUsed;
  perfects += g.perfects;
  lanesDone += g.structures.laneCompleted;
  laneDoneRuns.push(g.structures.laneCompleted);
  tradeRoutes += g.structures.tradeRoute;
  portCalls += g.structures.portCall;
  springs += g.structures.spring;
  estuaries += g.structures.estuary;
  peaks += g.structures.peakCrowned;
  snowlines += g.structures.snowline;
  laneTilesDrawn += g.drawCounts.lane || 0;
  harborsDrawn += g.drawCounts.harbor || 0;
  placements += g.placements;
  tilesEarned += g.tilesEarned;
  flagsDone += g.flagsCompleted;
  flagsFaded += g.flagsFaded;
  score += g.score;
  largestLA += g.largestGroups.LA;
  largestOC += g.largestGroups.OC;
  discards += g.discards;
}

const f = (v, d = 2) => (v / games).toFixed(d);
console.log(`games=${games} seed=${seed} score mean=${f(score, 0)}`);
console.log(`per-run: placements ${f(placements, 1)} tilesEarned ${f(tilesEarned, 1)} stdQuestsDone ${f(comp, 1)} rerolls ${f(rerolls, 2)} flagsDone ${f(flagsDone, 2)} flagsFaded ${f(flagsFaded, 2)} discards ${f(discards, 2)}`);
console.log(`structures/run: perfects ${f(perfects, 2)} lanesDone ${f(lanesDone, 2)} tradeRoutes ${f(tradeRoutes, 2)} portCalls ${f(portCalls, 2)} springs ${f(springs, 2)} estuaries ${f(estuaries, 2)} peaks ${f(peaks, 2)} snowlines ${f(snowlines, 2)}`);
console.log(`draws/run: lane ${f(laneTilesDrawn, 2)} harbor ${f(harborsDrawn, 2)}; largest LA ${f(largestLA, 2)} largest OC ${f(largestOC, 2)}`);
console.log(`lane-done distribution: 0:${laneDoneRuns.filter((x) => x === 0).length} 1:${laneDoneRuns.filter((x) => x === 1).length} 2+:${laneDoneRuns.filter((x) => x >= 2).length}`);
console.log('epics:');
for (const [id, s] of Object.entries(epicStats)) {
  console.log(`  ${id}: n=${s.n} done=${(s.done / s.n * 100).toFixed(0)}% avgProgress=${(s.progSum / s.n).toFixed(2)}`);
}
