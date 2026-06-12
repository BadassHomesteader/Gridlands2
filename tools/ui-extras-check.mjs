// Quick UI checks not covered elsewhere: zen mode via the real start screen
// (slider + toggle), the stack infinity pill, and the quest reroll button.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const root = '/Users/juergs/Code/Gridlands2';
const PORT = 8715;
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

  // zen mode via real controls
  await page.fill('#tile-count', '60');
  await page.click('.switch .knob'); // the visible toggle a player actually clicks
  const checked = await page.evaluate(() => document.getElementById('zen-toggle').checked);
  console.log('zen knob click sets checkbox:', checked ? 'OK' : 'FAIL');
  await page.click('#btn-start');
  await page.waitForTimeout(1000);
  const zen = await page.evaluate(() => ({
    zen: window.GL2.game.zen,
    stackText: document.getElementById('stack').textContent,
    stackRemaining: window.GL2.game.stackRemaining,
  }));
  console.log('zen start:', JSON.stringify(zen),
    zen.zen && zen.stackText === '∞' ? 'OK' : 'FAIL');

  // quest reroll via the panel button
  const before = await page.evaluate(() => ({
    ids: window.GL2.game.quests.standard.map((q) => q.id),
    rerolls: window.GL2.game.quests.rerolls,
  }));
  await page.click('#quest-list .btn-reroll');
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    ids: window.GL2.game.quests.standard.map((q) => q.id),
    rerolls: window.GL2.game.quests.rerolls,
  }));
  const changed = before.ids[0] !== after.ids[0] && after.rerolls === before.rerolls - 1;
  console.log('reroll:', JSON.stringify(before), '->', JSON.stringify(after), changed ? 'OK' : 'FAIL');

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
console.log('ui extras check complete, no console errors');
