// Runs every *.test.mjs in this folder, for `node --test claude-code/tools/test/`.
//
// Node 24's test runner takes its arguments as glob patterns, so a folder matches only itself and is run as
// one module. package.json's `main` makes that module this file, which imports the tests, so the command in
// README.md works as written. `node --test claude-code/tools/test/*.test.mjs` runs the same tests, one
// process per file.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
for (const name of fs.readdirSync(here).filter((n) => n.endsWith('.test.mjs')).sort()) {
  await import(pathToFileURL(path.join(here, name)).href)
}
