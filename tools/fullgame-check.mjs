// Full-game browser check: testStart + autoplay to game over, waits for the
// curtain-call flights and the tally screen. Captures console/page errors.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const root = '/Users/juergs/Code/Gridlands2';
const PORT = 8717;
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
  await page.evaluate(() => window.GL2.testStart(424242));
  await page.waitForTimeout(800);

  // drive to game over (autoplay places until over or n exhausted)
  await page.evaluate(() => window.GL2.testAutoplay(400));
  await page.waitForFunction(() => window.GL2.game && window.GL2.game.over, null, { timeout: 240000 });
  const stats = await page.evaluate(() => {
    const s = window.GL2.game.stats;
    return {
      score: s.score, placements: s.placements, structures: s.structures,
      stage: s.stage, deadBoard: s.deadBoard,
    };
  });
  console.log('game over:', JSON.stringify(stats));

  // curtain call: sunset + flights + tally screen
  await page.waitForFunction(
    () => !document.getElementById('gameover-screen').classList.contains('hidden'),
    null, { timeout: 120000 });
  console.log('gameover screen shown');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${root}/screenshots/shot-gameover.png` });
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
console.log('full game complete, no console errors');
