// Boot + input wiring + game loop (DESIGN §7.5, SPEC test hooks).
// start screen -> new Game -> scene.init -> rAF loop. Exposes window.GL2.

import { Game } from './core/game.js';
import { CONFIG } from './core/config.js';
import { mulberry32 } from './core/rng.js';
import { parseKey } from './core/hex.js';
import { traceNetworks } from './core/board.js';
import { init as initScene } from './render/scene.js';
import { createUI } from './ui.js';
import * as audio from './audio.js';
import { POLICIES } from '../sim/autoplay.mjs';

const VERSION = '0.1.0';

let game = null;
let sceneH = null;
let gameOverDone = false;
let rafId = 0;
let lastT = 0;

const $ = (id) => document.getElementById(id);

const ui = createUI({
  onReroll(index) {
    if (!game || game.over) return;
    const fresh = game.rerollQuest(index);
    if (fresh) {
      audio.breeze();
      ui.toast('Quest rerolled');
      ui.refresh();
    } else {
      ui.toast(game.quests.rerolls > 0
        ? 'No fresh quest fits this late in the run'
        : 'No rerolls left');
    }
  },
});

// --- placement pipeline (shared by click, testPlace, testAutoplay) ---

function refreshGhost() {
  if (!sceneH) return;
  const cell = sceneH.getHoverCell();
  if (cell && game && !game.over && game.currentTile) {
    sceneH.setGhost(game.currentTile, cell.q, cell.r);
  } else {
    sceneH.clearGhost();
  }
}

function handleEvents(events = []) {
  for (const e of events) {
    if (e.type === 'stage') {
      ui.banner(e.stage);
    } else if (e.type === 'finale') {
      ui.banner('finale', `the last ${e.stackRemaining} tiles`);
    } else if (e.type === 'windsShift') {
      ui.toast('The winds shift — a fresh tile blows in');
    } else if (e.type === 'rerollGranted') {
      ui.toast('Quest reroll earned');
    } else if (e.type === 'questRefreshed') {
      // Fun-fix round 4 (DESIGN §6.1): sealed/unsatisfiable refreshes are the
      // loud ones — the quest could never complete, so the free re-deal is
      // "a new opportunity", never a loss. 'pace' keeps its silent fade.
      if (e.reason === 'sealed' || e.reason === 'unsatisfiable') {
        ui.toast('A new opportunity — that quest could no longer be finished');
      }
    } else if (e.type === 'gameOver') {
      // normally fired again by the scene once the final tile settles
      setTimeout(() => handleGameOver(e.deadBoard), 4000);
    }
  }
}

// Celebration ∝ payout: popup size and fanfare scale with the actual points
// in the PlacementResult, so retuned junction/route values stay coherent.
function magFor(points) {
  if (points >= 200) return 1.85;
  if (points >= 80) return 1.5;
  if (points >= 40) return 1.3;
  if (points >= 15) return 1.05;
  if (points >= 8) return 0.95;
  return 0.82;
}

function applyResult(result) {
  sceneH.placeTileVisual(result); // effects pipeline fires when the tile lands
  sceneH.clearGhost();
  audio.place();

  const p = sceneH.cellToWorld(result.q, result.r);
  const pos = sceneH.worldToScreen(p.x, 0.8, p.z);
  let idx = 0;
  const pop = (text, channel, sub, mag = 1) => {
    if (!pos.behind) ui.popup(pos.x, pos.y - idx * 26, text, channel, 280 + idx * 220, sub, mag);
    idx++;
  };
  const b = result.breakdown;
  if (b.edges > 0) pop(`+${b.edges}`, 'edges', '', magFor(b.edges));
  if (b.streak > 0) pop(`+${b.streak}`, 'streak', `streak ×${result.combo}`, magFor(b.streak));
  if (result.perfect) pop(`Perfect! +${b.perfect}`, 'perfect', '', magFor(b.perfect));
  const structPts = b.junctions + b.structures;
  if (structPts > 0) pop(`+${structPts}`, 'structures', '', magFor(structPts));
  if (b.tradeIncome > 0) ui.pulseTrade(b.tradeIncome); // income pays at the pip
  let questPts = 0;
  for (const q of result.questsCompleted) {
    questPts += q.points;
    pop(`+${q.points}`, 'quests', ui.questName(q), magFor(q.points));
  }

  const matches = result.edgeMatches.filter((m) => m.matched).length;
  if (matches > 0) setTimeout(() => audio.chime(matches, result.combo), 300);
  if (result.perfect) setTimeout(() => audio.perfect(game.ctx.consecutivePerfects || 1), 550);
  if (result.questsCompleted.length) setTimeout(() => audio.quest(questPts), 750);
  // payout-scaled flourish for big structure points; lane/trade completions
  // already get the full ship horn via the scene event, so skip those here
  const hasHorn = result.networkEvents.some(
    (e) => e.type === 'laneCompleted' || e.type === 'tradeRoute');
  if (!hasHorn && structPts >= 30) setTimeout(() => audio.fanfare(structPts), 480);

  for (const e of result.networkEvents) ui.junctionTip(e.type);
  // first harbor: the dock lesson (lanes need open water to reach it)
  if (result.tile.dockEdges && result.tile.dockEdges.length) ui.junctionTip('harborDock');
  handleEvents(result.events);
  ui.bumpScore();
  ui.refresh();
  refreshGhost();
}

function onCellClick(q, r) {
  if (!game || game.over || !game.currentTile) return;
  const check = game.canPlace(q, r);
  const result = game.place(q, r);
  if (!result) {
    sceneH.denyFlash(q, r);
    audio.denied();
    if (check.reasons.some((s) => /MT vs OC|OC vs MT/.test(s))) ui.junctionTip('mountainCoast');
    return;
  }
  applyResult(result);
}

function onHover(q, r) {
  if (!game || game.over || !game.currentTile) {
    sceneH.clearGhost();
    return;
  }
  sceneH.setGhost(game.currentTile, q, r);
}

function onSceneEvent(ev) {
  if (ev.type === 'sting') audio.sting(ev.stage);
  else if (ev.type === 'shipHorn') audio.shipHorn(ev.event);
  else if (ev.type === 'windsShift') audio.breeze();
  else if (ev.type === 'gameOver') handleGameOver(ev.deadBoard);
}

// --- discard / undo ---

function doDiscard() {
  if (!game || game.over || !game.currentTile) return;
  const cost = game.config.valves.discardCost; // CONFIG is the authority (DESIGN §11)
  const res = game.discard();
  if (!res) return;
  audio.discard();
  const r = $('btn-discard').getBoundingClientRect();
  ui.popup(r.left + r.width / 2, r.top - 12, `−${Math.abs(cost)}`, 'bad');
  for (const e of res.events) {
    if (e.type === 'windsShift') audio.breeze();
  }
  handleEvents(res.events);
  ui.refresh();
  refreshGhost();
  sceneH.refreshPerfectSpots(); // new tile in hand -> re-rate the gold rings
  if (game.over) {
    const dead = res.events.some((e) => e.type === 'gameOver' && e.deadBoard);
    setTimeout(() => handleGameOver(dead), 500);
  }
}

function doUndo() {
  if (!game || game.over) return;
  if (game.undo()) {
    sceneH.rebuild();
    sceneH.clearGhost();
    audio.undoSound();
    ui.toast('Time rewinds one tile');
    ui.refresh();
  } else {
    ui.toast('Nothing to undo');
  }
}

// --- game over: sunset, finale camera flight, tally screen (DESIGN §7.3) ---

// Nearest-neighbor ordering so the CatmullRom flight doesn't zigzag
// (traceNetworks returns flood-fill order).
function orderPath(keys) {
  const pts = keys.map((k) => {
    const { q, r } = parseKey(k);
    return { k, ...sceneH.cellToWorld(q, r) };
  });
  let cx = 0;
  let cz = 0;
  for (const p of pts) { cx += p.x; cz += p.z; }
  cx /= pts.length;
  cz /= pts.length;
  let si = 0;
  let far = -1;
  pts.forEach((p, i) => {
    const d = (p.x - cx) ** 2 + (p.z - cz) ** 2;
    if (d > far) { far = d; si = i; }
  });
  const out = [pts.splice(si, 1)[0]];
  while (pts.length) {
    const last = out[out.length - 1];
    let bi = 0;
    let bd = Infinity;
    pts.forEach((p, i) => {
      const d = (p.x - last.x) ** 2 + (p.z - last.z) ** 2;
      if (d < bd) { bd = d; bi = i; }
    });
    out.push(pts.splice(bi, 1)[0]);
  }
  return out.map((p) => p.k);
}

function gameOverFlights() {
  const flights = [];
  const longestOf = (terrain) =>
    traceNetworks(game.board, terrain).reduce((m, n) => (!m || n.size > m.size ? n : m), null);
  const river = longestOf('RI');
  if (river && river.size >= 3) flights.push([...river.keys]);
  const rail = longestOf('RA');
  if (rail && rail.size >= 3) flights.push([...rail.keys]);
  for (const lane of traceNetworks(game.board, 'LA')) {
    if (lane.completed) flights.push([...lane.keys]);
  }
  return flights.slice(0, 4).map(orderPath);
}

async function handleGameOver(deadBoard = false) {
  if (gameOverDone || !game) return;
  gameOverDone = true;
  sceneH.clearGhost();
  sceneH.refreshPerfectSpots(); // game over -> the invitations retire
  sceneH.effects.sunset();
  audio.curtain();
  ui.toast(deadBoard ? 'No room remains for the last tiles' : 'The last tile settles — curtain call');
  await sleep(1400);
  for (const keys of gameOverFlights()) {
    await sceneH.cameraFlyAlong(keys, { height: 8 });
    await sleep(250);
  }
  ui.showGameOver(game, { deadBoard });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- boot ---

function cryptoSeed() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}

function startGame({ seed, tileCount, zen }) {
  if (sceneH) {
    sceneH.dispose();
    sceneH = null;
  }
  game = new Game({ seed, tileCount, zen });
  window.GL2.game = game;
  gameOverDone = false;
  audio.init();
  sceneH = initScene($('game-canvas'), game);
  window.GL2.scene = sceneH; // test hook: real camera projection for tools/*.mjs
  sceneH.onCellClick(onCellClick);
  sceneH.onHover(onHover);
  sceneH.onEvent(onSceneEvent);
  $('start-screen').classList.add('hidden');
  $('gameover-screen').classList.add('hidden');
  $('sky-glow').classList.remove('hidden');
  ui.bindGame(game);
  // keep HUD copy synced to CONFIG (the authority on every tunable number)
  const costEl = $('btn-discard').querySelector('.cost');
  if (costEl) costEl.textContent = `−${Math.abs(game.config.valves.discardCost)}`;
  ui.setMuted(audio.isMuted());
  ui.banner('pastoral');
  ui.toast('Lay your first tile — click anywhere');
  startLoop();
}

function startLoop() {
  cancelAnimationFrame(rafId);
  lastT = performance.now();
  const frame = (t) => {
    const dt = Math.min((t - lastT) / 1000, 0.1);
    lastT = t;
    if (sceneH) sceneH.update(dt);
    ui.update(dt);
    rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);
}

// start screen — slider range/default come from CONFIG (the authority on
// every tunable number; the balance gates are verified at stack.start)
const slider = $('tile-count');
slider.min = String(CONFIG.stack.slider[0]);
slider.max = String(CONFIG.stack.slider[1]);
slider.value = String(CONFIG.stack.start);
$('tile-count-out').textContent = slider.value;
slider.addEventListener('input', () => {
  $('tile-count-out').textContent = slider.value;
});
$('btn-start').addEventListener('click', () => {
  startGame({
    seed: cryptoSeed(),
    tileCount: Number(slider.value),
    zen: $('zen-toggle').checked,
  });
});
$('btn-again').addEventListener('click', () => window.location.reload());

// tray buttons
$('btn-discard').addEventListener('click', doDiscard);
$('btn-undo').addEventListener('click', doUndo);
$('btn-mute').addEventListener('click', () => ui.setMuted(audio.toggleMute()));

// keys: R rotate, D discard, M mute, Ctrl+Z undo (§7.5; arrows live in scene.js)
window.addEventListener('keydown', (e) => {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'm') {
    ui.setMuted(audio.toggleMute());
    return;
  }
  if (!game || game.over) return;
  if (k === 'r') {
    game.rotate(1);
    audio.rotateTick();
    refreshGhost();
    sceneH.refreshPerfectSpots(); // rotation may make a gold ring fillable
    ui.refreshPreviews();
  } else if (k === 'd') {
    doDiscard();
  } else if (k === 'z' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    doUndo();
  }
});

// --- test hooks (SPEC; used by tools/screenshot.mjs) ---

window.GL2 = {
  game: null,
  version: VERSION,
  testStart(seed = 1337) {
    // tileCount omitted -> Game uses CONFIG.stack.start (the tuned economy)
    startGame({ seed: seed >>> 0, zen: false });
    return true;
  },
  testPlace(q, r, rot = 0) {
    if (!game || game.over || !game.currentTile) return null;
    if (rot) game.rotate(rot);
    const result = game.place(q, r);
    if (result) applyResult(result);
    return result;
  },
  testAutoplay(n = 10) {
    const rng = mulberry32(0xa11ce);
    let left = n;
    return new Promise((resolve) => {
      const tick = setInterval(() => {
        if (!game || game.over || left <= 0) {
          clearInterval(tick);
          resolve(game ? game.placements : 0);
          return;
        }
        const action = POLICIES.greedy(game, rng, { noReroll: true });
        if (action.type === 'place') {
          if (action.rotation) game.rotate(action.rotation);
          const result = game.place(action.q, action.r);
          if (result) {
            applyResult(result);
            left--;
            return;
          }
        }
        game.discard();
        ui.refresh();
      }, 80);
    });
  },
};
