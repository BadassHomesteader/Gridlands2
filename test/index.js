// Entry point so `node --test test/` works on Node >= 23, where a directory
// argument is resolved as a module instead of being scanned. Imports every
// *.test.js suite so the whole directory runs as one entry.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
for (const f of readdirSync(here).sort()) {
  if (f.endsWith('.test.js')) await import('./' + f);
}
