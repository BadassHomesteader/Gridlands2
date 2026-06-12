#!/usr/bin/env node
// Balance harness (DESIGN §10, SPEC "Simulation metrics").
// node sim/balance.mjs [--games=200] [--seed=1] [--policy=all|name[,name..]]
//                      [--config=overrides.json] [--modes] [--timestamp=tag]
// Prints a metrics table per policy + a GATES table, writes JSON to
// sim/results/run-<timestamp-or-seed>.json. Exits 0 even on gate failures —
// gates inform tuning; only crashes are fatal.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CONFIG } from '../src/core/config.js';
import { TERRAINS } from '../src/core/terrain.js';
import { runGame, POLICY_NAMES } from './autoplay.mjs';

const CHANNELS = ['edges', 'streaksPerfects', 'quests', 'structures', 'endGame'];

function parseArgs(argv) {
  const o = { games: 200, seed: 1, policy: 'all', config: null, modes: false, timestamp: null };
  for (const a of argv) {
    if (a === '--modes') { o.modes = true; continue; }
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'games') o.games = Number(v);
    else if (k === 'seed') o.seed = Number(v);
    else if (k === 'policy') o.policy = v;
    else if (k === 'config') o.config = v;
    else if (k === 'timestamp') o.timestamp = v;
    else if (k === 'modes') o.modes = v !== 'false';
  }
  return o;
}

function deepMerge(base, over) {
  if (base === null || over === null || Array.isArray(base) || Array.isArray(over) ||
      typeof base !== 'object' || typeof over !== 'object') return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function runBatch(policy, games, baseSeed, config) {
  const out = [];
  for (let i = 0; i < games; i++) {
    out.push(runGame({ policy, seed: (baseSeed + i * 7919) >>> 0, config }));
  }
  return out;
}

function summarize(games) {
  const n = games.length;
  const sorted = (f) => games.map(f).sort((a, b) => a - b);
  const mean = (f) => (n ? games.reduce((s, g) => s + f(g), 0) / n : 0);
  const frac = (f) => (n ? games.filter(f).length / n : 0);
  const scores = sorted((g) => g.score);
  const places = sorted((g) => g.placements);
  const chSum = Object.fromEntries(CHANNELS.map((c) => [c, 0]));
  for (const g of games) for (const c of CHANNELS) chSum[c] += g.channels[c];
  const chTotal = CHANNELS.reduce((s, c) => s + chSum[c], 0) || 1;
  const channelPct = Object.fromEntries(CHANNELS.map((c) => [c, (chSum[c] / chTotal) * 100]));
  const totalDraws = games.reduce((s, g) => s + g.draws, 0);
  const totalFires = games.reduce((s, g) => s + g.windsShiftFires, 0);
  const byMtn = games.slice().sort((a, b) => b.mountainDrawShare - a.mountainDrawShare);
  const decile = byMtn.slice(0, Math.max(1, Math.ceil(n / 10)));
  const largestGroups = Object.fromEntries(
    TERRAINS.map((t) => [t, mean((g) => g.largestGroups[t] || 0)]));
  return {
    n,
    score: {
      mean: mean((g) => g.score),
      median: percentile(scores, 0.5),
      p10: percentile(scores, 0.1),
      p90: percentile(scores, 0.9),
    },
    placements: {
      mean: mean((g) => g.placements),
      p10: percentile(places, 0.1),
      p90: percentile(places, 0.9),
    },
    draws: mean((g) => g.draws),
    discards: mean((g) => g.discards),
    tilesEarned: mean((g) => g.tilesEarned),
    reproduction: mean((g) => g.reproduction),
    perfectRate: mean((g) => g.perfectRate),
    maxStreak: mean((g) => g.maxStreak),
    questCompletionRate: mean((g) => g.questCompletionRate),
    epicRate: frac((g) => g.epicDone),
    flagsCompleted: mean((g) => g.flagsCompleted),
    windsShiftRate: totalDraws ? totalFires / totalDraws : 0,
    stuckMean: mean((g) => g.stuckStates),
    deadRate: frac((g) => g.deadBoard),
    mountainHeavyDeadRate: decile.length
      ? decile.filter((g) => g.deadBoard).length / decile.length : 0,
    mountainHeavyN: decile.length,
    endsWithLegal: frac((g) => g.legalMovesRemaining > 0),
    engagement: {
      river: frac((g) => g.engagement.riverCompleted),
      lane: frac((g) => g.engagement.laneCompleted),
      peak: frac((g) => g.engagement.peakCrowned),
    },
    channelPct,
    largestGroups,
  };
}

// --- printing -------------------------------------------------------------

const fix = (v, d = 0) => Number(v).toFixed(d);
const pct = (v, d = 1) => (v * 100).toFixed(d);

function printMetricsTable(summaries, order) {
  const policies = order.filter((p) => summaries[p]);
  const COL = 12;
  const LABEL = 30;
  const line = (label, fn) =>
    console.log(label.padEnd(LABEL) + policies.map((p) => String(fn(summaries[p])).padStart(COL)).join(''));
  console.log('\nMETRICS' + ' '.repeat(LABEL - 7) + policies.map((p) => p.padStart(COL)).join(''));
  console.log('-'.repeat(LABEL + COL * policies.length));
  line('games', (s) => s.n);
  line('score mean', (s) => fix(s.score.mean));
  line('score median', (s) => fix(s.score.median));
  line('score p10', (s) => fix(s.score.p10));
  line('score p90', (s) => fix(s.score.p90));
  line('placements mean', (s) => fix(s.placements.mean, 1));
  line('placements p10', (s) => fix(s.placements.p10, 1));
  line('placements p90', (s) => fix(s.placements.p90, 1));
  line('session proxy (min)', (s) => fix((s.placements.mean * CONFIG.stack.paceSecondsPerPlacement) / 60, 1));
  line('draws mean', (s) => fix(s.draws, 1));
  line('discards mean', (s) => fix(s.discards, 1));
  line('tiles earned mean', (s) => fix(s.tilesEarned, 1));
  line('reproduction R mean', (s) => fix(s.reproduction, 3));
  line('perfect rate %', (s) => pct(s.perfectRate));
  line('max streak mean', (s) => fix(s.maxStreak, 1));
  line('quest completion %', (s) => pct(s.questCompletionRate));
  line('epic done %', (s) => pct(s.epicRate, 0));
  line('flags completed mean', (s) => fix(s.flagsCompleted, 1));
  line('winds-shift rate %', (s) => pct(s.windsShiftRate, 2));
  line('stuck states / game', (s) => fix(s.stuckMean, 2));
  line('dead-board %', (s) => pct(s.deadRate, 1));
  line('ends w/ legal moves %', (s) => pct(s.endsWithLegal, 0));
  line('engagement river %', (s) => pct(s.engagement.river, 0));
  line('engagement lane %', (s) => pct(s.engagement.lane, 0));
  line('engagement peak %', (s) => pct(s.engagement.peak, 0));
  for (const c of CHANNELS) line(`channel ${c} %`, (s) => fix(s.channelPct[c], 1));
  for (const t of TERRAINS) line(`largest ${t} mean`, (s) => fix(s.largestGroups[t], 1));
}

// --- gates ----------------------------------------------------------------

function evalGates(summaries, config, modes) {
  const G = config.simGates;
  const qa = summaries.questAware;
  const gr = summaries.greedy;
  const lo = summaries.landOnly;
  const rows = [];
  const row = (name, target, actual, pass) =>
    rows.push({ name, target, actual, result: pass === null ? 'n-a' : pass ? 'PASS' : 'FAIL' });

  {
    const t = G.medianScoreQuestAware;
    if (qa) row('median score questAware', `${t.target} +/-${t.tolerance * 100}%`, fix(qa.score.median),
      Math.abs(qa.score.median - t.target) <= t.target * t.tolerance);
    else row('median score questAware', `${t.target} +/-${t.tolerance * 100}%`, '-', null);
  }
  {
    const t = G.medianScoreGreedy.target;
    const tol = G.medianScoreQuestAware.tolerance; // DESIGN gives ~1400 with no tolerance; reuse +/-20%
    if (gr) row('median score greedy', `~${t} +/-${tol * 100}%`, fix(gr.score.median),
      Math.abs(gr.score.median - t) <= t * tol);
    else row('median score greedy', `~${t}`, '-', null);
  }
  if (lo && qa && qa.score.median > 0) {
    const ratio = lo.score.median / qa.score.median;
    row('landOnly/questAware median (hard)', `<= ${G.landOnlyToMixedMaxRatio}`, fix(ratio, 3),
      ratio <= G.landOnlyToMixedMaxRatio);
  } else row('landOnly/questAware median (hard)', `<= ${G.landOnlyToMixedMaxRatio}`, '-', null);

  const dist = config.scoring.targets.distribution;
  for (const c of CHANNELS) {
    const target = dist[c];
    if (qa) row(`distribution ${c} (questAware)`, `${target} +/-${G.distributionTolerancePts}pp`,
      fix(qa.channelPct[c], 1), Math.abs(qa.channelPct[c] - target) <= G.distributionTolerancePts);
    else row(`distribution ${c} (questAware)`, `${target} +/-${G.distributionTolerancePts}pp`, '-', null);
  }

  if (qa) {
    row('winds-shift fire rate', `< ${pct(G.windsShiftMaxRate, 0)}% draws`, pct(qa.windsShiftRate, 2) + '%',
      qa.windsShiftRate < G.windsShiftMaxRate);
    row('dead-board rate', `< ${pct(G.deadBoardMaxRate, 1)}%`, pct(qa.deadRate, 2) + '%',
      qa.deadRate < G.deadBoardMaxRate);
    if (config.rules.mountainCoast === 'repel') {
      row(`dead-board mtn-heavy (n=${qa.mountainHeavyN}, repel)`, `< ${pct(G.deadBoardMaxRateMountainHeavy, 0)}%`,
        pct(qa.mountainHeavyDeadRate, 2) + '%',
        qa.mountainHeavyDeadRate < G.deadBoardMaxRateMountainHeavy);
    } else row('dead-board mtn-heavy (repel)', `< ${pct(G.deadBoardMaxRateMountainHeavy, 0)}%`, 'cliff mode', null);
    row('placements p10', `>= ${G.placements.p10Min}`, fix(qa.placements.p10, 1),
      qa.placements.p10 >= G.placements.p10Min);
    row('placements p90 (hard)', `<= ${G.placements.p90Max}`, fix(qa.placements.p90, 1),
      qa.placements.p90 <= G.placements.p90Max);
    row('reproduction R (hard)', `< ${G.reproductionMax}`, fix(qa.reproduction, 3),
      qa.reproduction < G.reproductionMax);
    row('quest completion rate', `${pct(G.questCompletion.min, 0)}-${pct(G.questCompletion.max, 0)}%`,
      pct(qa.questCompletionRate, 1) + '%',
      qa.questCompletionRate >= G.questCompletion.min && qa.questCompletionRate <= G.questCompletion.max);
    row('epic completion', `~${pct(G.questCompletion.epic, 0)}% +/-15pp`, pct(qa.epicRate, 0) + '%',
      Math.abs(qa.epicRate - G.questCompletion.epic) <= 0.15);
    row('engagement: river completed', `>= ${pct(G.engagement.riverCompleted, 0)}%`,
      pct(qa.engagement.river, 0) + '%', qa.engagement.river >= G.engagement.riverCompleted);
    row('engagement: lane completed', `>= ${pct(G.engagement.laneCompleted, 0)}%`,
      pct(qa.engagement.lane, 0) + '%', qa.engagement.lane >= G.engagement.laneCompleted);
    row('engagement: peak crowned', `>= ${pct(G.engagement.peakCrowned, 0)}%`,
      pct(qa.engagement.peak, 0) + '%', qa.engagement.peak >= G.engagement.peakCrowned);
  } else {
    for (const name of ['winds-shift fire rate', 'dead-board rate', 'dead-board mtn-heavy (repel)',
      'placements p10', 'placements p90 (hard)', 'reproduction R (hard)', 'quest completion rate',
      'epic completion', 'engagement: river completed', 'engagement: lane completed',
      'engagement: peak crowned']) row(name, 'questAware required', '-', null);
  }

  if (modes && modes.mountainCoast) {
    const r = modes.mountainCoast.repel;
    row('ADOPT mountainCoast repel', `mtn-heavy dead < ${pct(G.deadBoardMaxRateMountainHeavy, 0)}%`,
      pct(r.mountainHeavyDeadRate, 2) + '%',
      r.mountainHeavyDeadRate < G.deadBoardMaxRateMountainHeavy);
  } else row('ADOPT mountainCoast repel', 'run with --modes', '-', null);
  if (modes && modes.laneOceanRule) {
    const A = G.sealedAdoption;
    const op = modes.laneOceanRule.open;
    const se = modes.laneOceanRule.sealed;
    const ok = se.windsShiftRate < A.maxStrandRate &&
      se.engagement.lane >= op.engagement.lane * (1 - A.laneEngagementWithin);
    row('ADOPT laneOceanRule sealed', `strand < ${pct(A.maxStrandRate, 0)}% & laneEng within ${pct(A.laneEngagementWithin, 0)}%`,
      `strand ${pct(se.windsShiftRate, 2)}% laneEng ${pct(se.engagement.lane, 0)}% (open ${pct(op.engagement.lane, 0)}%)`, ok);
  } else row('ADOPT laneOceanRule sealed', 'run with --modes', '-', null);

  return rows;
}

function printGatesTable(rows, config) {
  console.log(`\nGATES (rules: mountainCoast=${config.rules.mountainCoast}, laneOceanRule=${config.rules.laneOceanRule}, tradeIncome=${config.rules.tradeIncome})`);
  const W = [42, 28, 42, 6];
  console.log('gate'.padEnd(W[0]) + 'target'.padEnd(W[1]) + 'actual'.padEnd(W[2]) + 'result');
  console.log('-'.repeat(W[0] + W[1] + W[2] + W[3]));
  for (const r of rows) {
    console.log(String(r.name).padEnd(W[0]) + String(r.target).padEnd(W[1]) +
      String(r.actual).padEnd(W[2]) + r.result);
  }
}

// --- mode adoption tests (§10) ---------------------------------------------

function runModes(games, seed, baseConfig, reuse) {
  const out = { mountainCoast: {}, laneOceanRule: {} };
  for (const mode of ['repel', 'cliff']) {
    if (reuse && baseConfig.rules.mountainCoast === mode) {
      out.mountainCoast[mode] = reuse;
      continue;
    }
    const cfg = structuredClone(baseConfig);
    cfg.rules.mountainCoast = mode;
    out.mountainCoast[mode] = summarize(runBatch('questAware', games, seed, cfg));
  }
  for (const mode of ['open', 'sealed']) {
    if (reuse && baseConfig.rules.laneOceanRule === mode) {
      out.laneOceanRule[mode] = reuse;
      continue;
    }
    const cfg = structuredClone(baseConfig);
    cfg.rules.laneOceanRule = mode;
    out.laneOceanRule[mode] = summarize(runBatch('questAware', games, seed, cfg));
  }
  return out;
}

function printModes(modes, games) {
  console.log(`\nMODES — mountainCoast (questAware, ${games} games/mode)`);
  console.log('mode '.padEnd(8) + 'dead%'.padStart(8) + 'mtnHeavyDead%'.padStart(15) +
    'medianScore'.padStart(13) + 'windsShift%'.padStart(13));
  for (const m of ['repel', 'cliff']) {
    const s = modes.mountainCoast[m];
    console.log(m.padEnd(8) + pct(s.deadRate, 2).padStart(8) +
      pct(s.mountainHeavyDeadRate, 2).padStart(15) + fix(s.score.median).padStart(13) +
      pct(s.windsShiftRate, 2).padStart(13));
  }
  console.log(`\nMODES — laneOceanRule (questAware, ${games} games/mode)`);
  console.log('mode '.padEnd(8) + 'strand%'.padStart(9) + 'laneEng%'.padStart(10) +
    'medianScore'.padStart(13) + 'dead%'.padStart(8));
  for (const m of ['open', 'sealed']) {
    const s = modes.laneOceanRule[m];
    console.log(m.padEnd(8) + pct(s.windsShiftRate, 2).padStart(9) +
      pct(s.engagement.lane, 0).padStart(10) + fix(s.score.median).padStart(13) +
      pct(s.deadRate, 2).padStart(8));
  }
}

// --- main -------------------------------------------------------------------

function gameRecord(g) {
  return {
    seed: g.seed, score: g.score, placements: g.placements, draws: g.draws,
    discards: g.discards, reproduction: g.reproduction, perfects: g.perfects,
    maxStreak: g.maxStreak, windsShiftFires: g.windsShiftFires,
    deadBoard: g.deadBoard, finished: g.finished,
    questCompletionRate: g.questCompletionRate, epicDone: g.epicDone,
    flagsCompleted: g.flagsCompleted, channels: g.channels,
    engagement: g.engagement, structures: g.structures,
    largestGroups: g.largestGroups, mountainDrawShare: g.mountainDrawShare,
    legalMovesRemaining: g.legalMovesRemaining,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let config = CONFIG;
  let overrides = null;
  if (opts.config) {
    overrides = JSON.parse(readFileSync(opts.config, 'utf8'));
    config = deepMerge(structuredClone(CONFIG), overrides);
  }
  const policies = opts.policy === 'all'
    ? POLICY_NAMES
    : opts.policy.split(',').map((s) => s.trim());
  for (const p of policies) {
    if (!POLICY_NAMES.includes(p)) throw new Error(`unknown policy '${p}' (have: ${POLICY_NAMES.join(', ')})`);
  }

  console.log(`Gridlands 2 balance run — ${opts.games} games/policy, seed ${opts.seed}, policies: ${policies.join(', ')}` +
    (opts.config ? `, config overrides: ${opts.config}` : ''));

  const t0 = Date.now();
  const batches = {};
  const summaries = {};
  for (const p of policies) {
    const start = Date.now();
    batches[p] = runBatch(p, opts.games, opts.seed, config);
    summaries[p] = summarize(batches[p]);
    console.log(`  ${p}: ${opts.games} games in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  }

  let modes = null;
  if (opts.modes) {
    console.log('  running --modes adoption batches (questAware)...');
    modes = runModes(opts.games, opts.seed, config, summaries.questAware || null);
  }

  printMetricsTable(summaries, POLICY_NAMES);
  const gateRows = evalGates(summaries, config, modes);
  printGatesTable(gateRows, config);
  if (modes) printModes(modes, opts.games);

  const elapsed = (Date.now() - t0) / 1000;
  console.log(`\ntotal ${elapsed.toFixed(1)}s`);

  const resultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
  mkdirSync(resultsDir, { recursive: true });
  const stamp = opts.timestamp ?? String(opts.seed);
  const outPath = path.join(resultsDir, `run-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({
    meta: {
      date: new Date().toISOString(),
      games: opts.games,
      seed: opts.seed,
      policies,
      rules: config.rules,
      configOverrides: overrides,
      elapsedSeconds: elapsed,
    },
    summaries,
    gates: gateRows,
    modes,
    games: Object.fromEntries(policies.map((p) => [p, batches[p].map(gameRecord)])),
  }, null, 2));
  console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
  process.exitCode = 0; // gates inform tuning; only crashes are fatal
}

main();
