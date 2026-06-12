// Screenshot harness: starts the dev server, loads the game, performs scripted
// actions, and saves screenshots to screenshots/. Also dumps console errors.
// Usage: node tools/screenshot.mjs [--actions=start,place5] [--out=name]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8719;
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const outName = args.out || 'shot';

mkdirSync(`${root}/screenshots`, { recursive: true });
const server = spawn('node', ['tools/serve.mjs'], { cwd: root, env: { ...process.env, PORT } });
await new Promise(r => setTimeout(r, 800));

const errors = [];
try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${root}/screenshots/${outName}-menu.png` });

  // If the game exposes a test hook, use it to start + autoplay some moves.
  const hooked = await page.evaluate(() => {
    if (window.GL2 && window.GL2.testStart) { window.GL2.testStart(); return true; }
    return false;
  });
  if (hooked) {
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${root}/screenshots/${outName}-start.png` });
    await page.evaluate(() => window.GL2.testAutoplay && window.GL2.testAutoplay(15));
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${root}/screenshots/${outName}-midgame.png` });
  }
  await browser.close();
} finally {
  server.kill();
}
if (errors.length) {
  console.log('CONSOLE ERRORS:');
  errors.forEach(e => console.log('  ' + e));
  process.exit(1);
}
console.log('screenshots saved, no console errors');
