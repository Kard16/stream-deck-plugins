// Spike control for spikes/cc-ask/server.mjs. Reads the deck's token from its file, so it never reaches argv.
//   node spikes/cc-ask/ctl.mjs held                 the held requests, with their input
//   node spikes/cc-ask/ctl.mjs wait [seconds]       waits (default 120 s) until a request is held, then lists them
//   node spikes/cc-ask/ctl.mjs answer <id> <json>   sends <json> (inline, or @file) to held request <id>
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TOKEN = readFileSync(path.join(ROOT, 'claude-code/deck/com.karimdhanji.claude.sdPlugin/run/token'), 'utf8').trim()
const BASE = 'http://127.0.0.1:47610'
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

async function held() {
  const res = await fetch(`${BASE}/held`, { headers: auth })
  return res.json()
}

const [cmd, ...args] = process.argv.slice(2)
if (cmd === 'held') {
  console.log(JSON.stringify(await held(), null, 2))
} else if (cmd === 'wait') {
  const until = Date.now() + Number(args[0] ?? 120) * 1000
  for (;;) {
    const list = await held()
    if (list.length > 0) {
      console.log(JSON.stringify(list, null, 2))
      break
    }
    if (Date.now() > until) {
      console.log('nothing held')
      process.exitCode = 1
      break
    }
    await new Promise(r => setTimeout(r, 500))
  }
} else if (cmd === 'answer') {
  const [id, json] = args
  const text = json.startsWith('@') ? readFileSync(json.slice(1), 'utf8') : json
  const res = await fetch(`${BASE}/answer`, { method: 'POST', headers: auth, body: JSON.stringify({ id: Number(id), body: JSON.parse(text) }) })
  console.log(res.status, await res.text())
} else {
  console.log('usage: held | wait [seconds] | answer <id> <json|@file>')
  process.exitCode = 2
}
