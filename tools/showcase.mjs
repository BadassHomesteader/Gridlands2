// Standardized visual showcase: identical seed, identical board, identical
// camera moves — so tile-art variants can be compared side by side fairly.
// Usage: node tools/showcase.mjs [--port=8721] [--out=showcase] [--dir=screenshots]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const PORT = args.port || 8721;
const out = args.out || 'showcase';
const dir = `${root}/${args.dir || 'screenshots'}`;
mkdirSync(dir, { recursive: true });

const server = spawn('node', ['tools/serve.mjs'], { cwd: root, env: { ...process.env, PORT } });
await new Promise(r => setTimeout(r, 800));

const errors = [];
try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.GL2.testStart(4242));
  await page.waitForTimeout(800);

  const autoplay = async n => {
    await page.evaluate(k => window.GL2.testAutoplay(k), n);
    await page.waitForTimeout(n * 80 + 2500);
  };
  const wheel = async (ticks) => {
    const dy = ticks > 0 ? 120 : -120;
    for (let i = 0; i < Math.abs(ticks); i++) { await page.mouse.wheel(0, dy); await page.waitForTimeout(60); }
    await page.waitForTimeout(900);
  };
  const shot = name => page.screenshot({ path: `${dir}/${out}-${name}.png` });

  await page.mouse.move(720, 450);
  await autoplay(30);
  await shot('p30-wide');
  await wheel(-6); await shot('p30-mid');
  await wheel(-6); await shot('p30-close');
  await wheel(12);
  await autoplay(30);
  await shot('p60-wide');
  await wheel(-6); await shot('p60-mid');
  await wheel(-7); await shot('p60-close');
  await browser.close();
} finally {
  server.kill();
}
if (errors.length) {
  console.log('CONSOLE ERRORS:'); errors.forEach(e => console.log('  ' + e));
  process.exit(1);
}
console.log(`showcase saved: ${dir}/${out}-{p30,p60}-{wide,mid,close}.png`);
