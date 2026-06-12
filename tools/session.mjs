// Simulated human session: real start button, real canvas clicks projected
// through the LIVE scene camera (window.GL2.scene hook — no replica, no
// drift), rotate via 'r', one undo, one discard, mute toggle. Captures
// console errors.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const root = '/Users/juergs/Code/Gridlands2';
const PORT = 8716;
const server = spawn('node', ['tools/serve.mjs'], { cwd: root, env: { ...process.env, PORT } });
await new Promise((r) => setTimeout(r, 800));

const errors = [];
const log = (...a) => console.log(...a);
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // 1. real start button
  await page.click('#btn-start');
  await page.waitForTimeout(1200);
  const started = await page.evaluate(() =>
    !!(window.GL2 && window.GL2.game && window.GL2.scene));
  log('started via #btn-start (game + scene hooks):', started);

  // real click projection: the live scene camera via the window.GL2.scene
  // hook (cellToWorld + worldToScreen) — replaces the old replica camera
  // that drifted as soon as centroid-follow / auto-zoom moved the real one.
  const projectCell = (q, r) => page.evaluate(([cq, cr]) => {
    const s = window.GL2.scene;
    const p = s.cellToWorld(cq, cr);
    const v = s.worldToScreen(p.x, 0, p.z);
    return { x: v.x, y: v.y };
  }, [q, r]);

  let clickPlacements = 0;
  let fallbacks = 0;
  let rotationsDone = 0;

  async function placeOne(i) {
    // nearest-to-origin legal cell + its first legal rotation
    const pick = await page.evaluate(() => {
      const g = window.GL2.game;
      const cells = g.legalPlacements();
      if (!cells.length) return null;
      cells.sort((a, b) => (a.q * a.q + a.r * a.r + a.q * a.r) - (b.q * b.q + b.r * b.r + b.q * b.r));
      const c = cells[0];
      return { q: c.q, r: c.r, rot: c.rotations[0] };
    });
    if (!pick) { log(`  [${i}] no legal placements`); return false; }
    for (let k = 0; k < pick.rot; k++) {
      await page.keyboard.press('r');
      rotationsDone++;
      await page.waitForTimeout(60);
    }
    const before = await page.evaluate(() => window.GL2.game.placements);
    let pt = await projectCell(pick.q, pick.r);
    await page.mouse.move(pt.x, pt.y);
    await page.waitForTimeout(120);
    // re-project right before the click: centroid-follow / auto-zoom may have
    // eased the camera during the hover pause
    pt = await projectCell(pick.q, pick.r);
    await page.mouse.move(pt.x, pt.y);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(450);
    const after = await page.evaluate(() => window.GL2.game.placements);
    if (after > before) {
      clickPlacements++;
      log(`  [${i}] placed at ${pick.q},${pick.r} rot ${pick.rot} via canvas click (${Math.round(pt.x)},${Math.round(pt.y)})`);
      return true;
    }
    fallbacks++;
    const res = await page.evaluate(([q, r]) => !!window.GL2.testPlace(q, r, 0), [pick.q, pick.r]);
    log(`  [${i}] canvas click missed -> testPlace fallback: ${res}`);
    return res;
  }

  for (let i = 0; i < 5; i++) await placeOne(i);

  // 2. undo once (Ctrl+Z), then re-place
  const beforeUndo = await page.evaluate(() => window.GL2.game.placements);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  const afterUndo = await page.evaluate(() => window.GL2.game.placements);
  log('undo:', beforeUndo, '->', afterUndo, afterUndo === beforeUndo - 1 ? 'OK' : 'FAIL');

  for (let i = 5; i < 8; i++) await placeOne(i);

  // 3. discard once via the real button (cost read from CONFIG, the authority)
  const discardCost = await page.evaluate(() => window.GL2.game.config.valves.discardCost);
  const dBefore = await page.evaluate(() => ({ s: window.GL2.game.score, d: window.GL2.game.stats.discards }));
  await page.click('#btn-discard');
  await page.waitForTimeout(300);
  const dAfter = await page.evaluate(() => ({ s: window.GL2.game.score, d: window.GL2.game.stats.discards }));
  log('discard:', JSON.stringify(dBefore), '->', JSON.stringify(dAfter),
    dAfter.d === dBefore.d + 1 && dAfter.s === dBefore.s + discardCost ? 'OK' : 'FAIL');

  // 4. one more placement after discard
  await placeOne(8);

  // 5. mute toggle (M key, then button back)
  await page.keyboard.press('m');
  await page.waitForTimeout(150);
  const muted = await page.evaluate(() => document.getElementById('mute-label').textContent);
  await page.click('#btn-mute');
  await page.waitForTimeout(150);
  const unmuted = await page.evaluate(() => document.getElementById('mute-label').textContent);
  log(`mute toggle: "${muted}" -> "${unmuted}"`, muted === 'Muted' && unmuted === 'Sound on' ? 'OK' : 'FAIL');

  const final = await page.evaluate(() => ({
    placements: window.GL2.game.placements,
    score: window.GL2.game.score,
    streak: window.GL2.game.ctx.streak,
    over: window.GL2.game.over,
  }));
  log('final state:', JSON.stringify(final));
  log('canvas-click placements:', clickPlacements, '| fallbacks:', fallbacks, '| rotations pressed:', rotationsDone);

  await page.screenshot({ path: `${root}/screenshots/shot-session.png` });
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
console.log('session complete, no console errors');
