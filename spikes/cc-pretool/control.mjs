// Spike control: queue a mode for a session's spike poller, or arm the spike's PreToolUse answer.
// Usage: mise exec -- node spikes/cc-pretool/control.mjs <local_…> [mode=<mode>] [answer=allow|none]
// Reads the deck's token from its file, so the token never reaches argv or the output.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TOKEN = readFileSync(path.join(ROOT, 'claude-code/deck/com.karimdhanji.claude.sdPlugin/run/token'), 'utf8').trim()
const [host, ...pairs] = process.argv.slice(2)
const body = { host }
for (const p of pairs) {
  const [k, v] = p.split('=')
  body[k] = v
}
const res = await fetch('http://127.0.0.1:47610/control', {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
console.log(res.status, await res.text())
