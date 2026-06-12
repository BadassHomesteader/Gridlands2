// Forces the rarely-hit celebration paths in the real browser pipeline:
// snowline (snowcaps), peakCrowned (big cap + eagle), portCall, laneCompleted
// (ship spawn + horn), tradeRoute. Injects crafted tiles into game.hand and
// places them through testPlace -> applyResult -> effects.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const root = '/Users/juergs/Code/Gridlands2';
const PORT = 8718;
const server = spawn('node', ['tools/serve.mjs'], { cwd: root, env: { ...process.env, PORT } });
await new Promise((r) => setTimeout(r, 800));

const errors = [];
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

  // --- scenario 1: mountains -> snowline + peakCrowned ---
  await page.evaluate(() => window.GL2.testStart(99001));
  await page.waitForTimeout(600);
  const mtn = await page.evaluate(() => {
    const mk = (i, edges) => ({
      id: 'forced-mt-' + i, archetype: 'highMountain',
      edges, dockEdges: [], crane: false, flag: null, seed: 1000 + i, rotation: 0,
    });
    // peak (4 MT) at origin; ring tiles engage MT edges 0-3, GR elsewhere
    const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    const seq = [[mk(0, ['MT', 'MT', 'MT', 'MT', 'GR', 'GR']), 0, 0]];
    for (let i = 0; i < 6; i++) {
      const edges = ['GR', 'GR', 'GR', 'GR', 'GR', 'GR'];
      if (i < 4) edges[(i + 3) % 6] = 'MT';
      seq.push([mk(i + 1, edges), DIRS[i][0], DIRS[i][1]]);
    }
    const events = [];
    for (const [tile, q, r] of seq) {
      window.GL2.game.hand = tile;
      const res = window.GL2.testPlace(q, r, 0);
      if (!res) { events.push(`PLACE-FAILED @${q},${r}`); continue; }
      for (const e of res.networkEvents) events.push(e.type + (e.key ? '@' + e.key : ''));
    }
    return events;
  });
  console.log('mountain scenario events:', JSON.stringify(mtn));
  await page.waitForTimeout(2500); // let drops land + caps pop + eagle circle
  const snowState = await page.evaluate(() => {
    let snow = 0;
    let crowned = 0;
    // tiles map lives in the scene; sample via board keys through effects sync state
    document.querySelectorAll('canvas');
    return { ok: true, snow, crowned };
  });
  await page.screenshot({ path: `${root}/screenshots/shot-peak.png` });

  // --- scenario 2: harbors + lane + rails -> portCall, laneCompleted, tradeRoute ---
  await page.evaluate(() => window.GL2.testStart(99002));
  await page.waitForTimeout(600);
  const sea = await page.evaluate(() => {
    const t = (id, edges, extra = {}) => ({
      id, archetype: extra.archetype || 'harbor', edges,
      dockEdges: extra.dockEdges || [], crane: !!extra.crane, flag: null,
      seed: extra.seed || 7, rotation: 0,
    });
    const seq = [
      [t('hA', ['OC', 'OC', 'GR', 'HO', 'GR', 'GR'], { dockEdges: [0], seed: 11 }), 0, 0],
      [t('l1', ['LA', 'OC', 'OC', 'LA', 'OC', 'OC'], { archetype: 'lane', seed: 12 }), 1, 0],
      [t('hB', ['RA', 'GR', 'GR', 'OC', 'GR', 'GR'], { dockEdges: [3], crane: true, seed: 13 }), 2, 0],
      [t('r1', ['RA', 'GR', 'GR', 'RA', 'GR', 'GR'], { archetype: 'rail', seed: 14 }), 3, 0],
      [t('r2', ['RA', 'GR', 'GR', 'RA', 'GR', 'GR'], { archetype: 'rail', seed: 15 }), 4, 0],
      [t('r3', ['RA', 'GR', 'GR', 'RA', 'GR', 'GR'], { archetype: 'rail', seed: 16 }), 5, 0],
    ];
    const events = [];
    for (const [tile, q, r] of seq) {
      window.GL2.game.hand = tile;
      const res = window.GL2.testPlace(q, r, 0);
      if (!res) { events.push(`PLACE-FAILED @${q},${r}`); continue; }
      for (const e of res.networkEvents) {
        events.push(e.type + (e.points !== undefined ? `(+${e.points})` : ''));
      }
    }
    return events;
  });
  console.log('sea scenario events:', JSON.stringify(sea));
  await page.waitForTimeout(2500); // ship spawn sails, horn fired
  const ships = await page.evaluate(() => {
    // count ship meshes: vehicles live in a group; approximate via WebGL info
    const g = window.GL2.game;
    return {
      lanesCompletedCtx: [...g.ctx.lanesCompleted].length,
      tradeRoutes: [...g.ctx.firedTradeRoutes],
      score: g.score,
    };
  });
  console.log('sea state:', JSON.stringify(ships));
  await page.screenshot({ path: `${root}/screenshots/shot-traderoute.png` });

  await browser.close();
} catch (e) {
  errors.push('HARNESS: ' + e.stack);
  if (browser) await browser.close().catch(() => {});
} finally {
  server.kill();
}

if (errors.length) {
  console.log('CONSOLE/PAGE ERRORS:');
  for (const e of errors) console.log('  ' + e);
  process.exit(1);
}
console.log('celebrations check complete, no console errors');
