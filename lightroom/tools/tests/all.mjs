// Entry point for `node --test lightroom/tools/`. Node 24 runs a directory given to --test as a module,
// so lightroom/tools/package.json's "main" points here, and this imports every *.test.mjs beside it.
// `node --test 'lightroom/tools/tests/*.test.mjs'` runs the same files in parallel processes instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const file of fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort()) {
  await import(pathToFileURL(path.join(here, file)).href);
}
