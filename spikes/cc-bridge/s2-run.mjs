// Spike S2 driver: approve and deny, run in one throwaway session while the user watches it in the app.
//
//   mise exec -- node spikes/cc-bridge/s2-run.mjs <claude-code-session-id> <registry-pid> [parts]
//
// parts, comma-separated, runs only those: step numbers 1-6, `lower` (first, the mod sets the session to
// Default, which needs no one) and `raise` (last, the mod raises it to Accept edits, which shows the user
// a card). Without parts, steps 1-6 and the raise run.
//
// Each step is submitted into the session through the spike mod (`submit`, asUser), so it shows in the
// session as a message starting "S2 step N of 6 (what to do)". The bridge holds the session's
// PermissionRequest http hook; this script answers it, or leaves it for the user to answer in the app,
// then waits for the turn to end before the next step. A request still held after its turn ended is the
// finding "the hook isn't cancelled"; the script then answers it with no decision. Needs the bridge running
// (spikes/cc-bridge/bridge.mjs). Results: s2-summary.json in the bridge's run folder.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = 'http://127.0.0.1:47600'
const TOKEN = fs.readFileSync(path.join(HERE, 'run', 'token'), 'utf8').trim()
const [sid, pid, parts] = process.argv.slice(2)
if (!sid || !pid) {
  console.error('usage: s2-run.mjs <claude-code-session-id> <registry-pid> [parts]')
  process.exit(2)
}
const want = (part) => !parts || parts.split(',').includes(String(part))

const control = async (route, body) => {
  const res = await fetch(BRIDGE + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res.json()
}

const { runDir } = await control('/control/state')
const eventsFile = path.join(runDir, 'events.jsonl')
const registryFile = path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`)

// Every events.jsonl line written from now on, parsed, in order.
let offset = fs.statSync(eventsFile).size
const lines = []
function readNew() {
  const size = fs.statSync(eventsFile).size
  if (size <= offset) return
  const fd = fs.openSync(eventsFile, 'r')
  const buf = Buffer.alloc(size - offset)
  fs.readSync(fd, buf, 0, buf.length, offset)
  fs.closeSync(fd)
  const text = buf.toString('utf8')
  const end = text.lastIndexOf('\n')
  if (end < 0) return
  offset += Buffer.byteLength(text.slice(0, end + 1))
  for (const l of text.slice(0, end).split('\n')) if (l.trim()) lines.push(JSON.parse(l))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${s}`)
const status = () => { try { return JSON.parse(fs.readFileSync(registryFile, 'utf8')).status ?? null } catch { return null } }

/** The first line at or after `from` that matches, waiting up to timeoutMs; null on timeout. */
async function waitFor(from, pred, timeoutMs, label) {
  const until = Date.now() + timeoutMs
  for (;;) {
    readNew()
    for (let i = from; i < lines.length; i++) if (pred(lines[i])) return lines[i]
    if (Date.now() > until) { log(`  (timed out waiting for ${label})`); return null }
    await sleep(200)
  }
}
const isReq = (l, p) => l.kind === 'request' && l.path === p
const isTurnEnd = (l) => (isReq(l, '/mod/event') && l.body?.event === 'turn.complete' && !l.body?.agentId) ||
  isReq(l, '/hook/Stop') || isReq(l, '/hook/StopFailure')
const isHeld = (l) => isReq(l, '/permission')
const endOf = (id) => (l) => l.id === id && l.kind !== 'request' && !!l.end

const summary = { sid, parts: parts ?? 'all', started: new Date().toISOString(), steps: [] }

async function step(n, what, text, handle) {
  if (!want(n)) return
  log(`step ${n}: ${what}`)
  readNew()
  const mark = lines.length
  const statuses = new Set()
  const watch = setInterval(() => { const s = status(); if (s) statuses.add(s) }, 100)
  const out = { n, what }
  await control('/control/queue', { sid, cmd: { id: `s2-${n}`, t: 'submit', text: `S2 step ${n} of 6 (${what}): ${text}`, asUser: true } })
  out.promptSeen = !!(await waitFor(mark, (l) => isReq(l, '/hook/UserPromptSubmit') && String(l.body?.prompt ?? '').includes(`S2 step ${n} of 6`), 30_000, 'the step prompt'))
  await handle(out, mark)
  const ended = await waitFor(mark, isTurnEnd, out.endWaitMs ?? 300_000, 'the turn to end')
  await sleep(2000)
  readNew()
  clearInterval(watch)
  // Anything this step left held: the hook wasn't cancelled when the turn went on without it.
  const mine = lines.slice(mark)
  const open = mine.filter(isHeld).filter((h) => !mine.some(endOf(h.id)))
  if (open.length) {
    out.stillHeldAfterTurn = open.map((h) => `${h.id}:${h.body?.tool_name}`)
    for (const h of open) await control('/control/answer', { id: h.id, decision: 'none' })
    await sleep(300)
    readNew()
  }
  const all = lines.slice(mark)
  out.ended = ended ? (ended.path === '/mod/event' ? 'turn.complete' : ended.path.slice(6)) : null
  out.hooks = [...new Set(all.filter((l) => l.kind === 'request' && l.path?.startsWith('/hook/') && l.path !== '/hook/MessageDisplay').map((l) => l.path.slice(6)))]
  out.modEvents = [...new Set(all.filter((l) => isReq(l, '/mod/event')).map((l) => l.body?.event + (l.body?.reason ? `:${l.body.reason}` : '')))]
  out.requests = all.filter(isHeld).map((l) => `${l.id}:${l.body?.tool_name}`)
  out.endings = all.filter((l) => l.path === '/permission' && l.kind !== 'request' && l.end).map((l) => ({ id: l.id, end: l.end, by: l.by, decision: l.decision, heldMs: l.heldMs }))
  out.registryStatuses = [...statuses]
  out.lastMessage = String([...all].reverse().find((l) => isReq(l, '/hook/Stop'))?.body?.last_assistant_message ?? '').slice(0, 240)
  summary.steps.push(out)
  log(`  ended by ${out.ended}; requests ${out.requests.join(' ') || 'none'}; endings ${JSON.stringify(out.endings)}${out.stillHeldAfterTurn ? `; STILL HELD after the turn: ${out.stillHeldAfterTurn}` : ''}; statuses ${out.registryStatuses.join(',')}`)
}

/** Waits for this step's held request, or for the turn to end first. */
async function heldOrEnd(out, mark, timeoutMs) {
  const hit = await waitFor(mark, (l) => isHeld(l) || isTurnEnd(l), timeoutMs, 'a held request')
  if (hit && isHeld(hit)) { out.heldTool = hit.body?.tool_name ?? null; return hit }
  out.heldTool = null
  return null
}
/** For steps the user answers in the app: waits for the request to end, or for the turn to end. */
async function userAnswers(out, mark) {
  const held = await heldOrEnd(out, mark, 180_000)
  if (!held) return
  const hit = await waitFor(mark, (l) => endOf(held.id)(l) || isTurnEnd(l), 300_000, `${held.id} or the turn`)
  if (hit && endOf(held.id)(hit)) { out.howEnded = hit.end; out.heldMsAtEnd = hit.heldMs }
  else out.howEnded = 'turn ended first'
}

/** S4: the mod sets its own session's mode through the app's tool. The call raises a PermissionRequest, so not under hold. */
async function setMode(id, mode) {
  readNew()
  const mark = lines.length
  await control('/control/queue', { sid, cmd: { id, t: 'mcp', server: 'ccd_session_mgmt', tool: 'set_session_permission_mode', args: { session_id: 'self', mode } } })
  const done = await waitFor(mark, (l) => isReq(l, '/mod/result') && l.body?.id === id, 300_000, `the mode change to ${mode}`)
  const out = done ? { ok: done.body.ok, result: done.body.result, ms: done.body.ms } : null
  log(`  mode ${mode}: ${JSON.stringify(out).slice(0, 400)}`)
  return out
}

if (want('lower')) {
  await control('/control/policy', { permission: { via: 'http', action: 'none' } })
  log('S4: the mod sets this session to Default')
  summary.modeLower = await setMode('s4-lower', 'default')
}

await control('/control/policy', { permission: { via: 'http', action: 'hold', updatedPermissions: null } })
log(`policy: hold. session ${sid}, registry ${pid}.json, events ${eventsFile}`)

await step(1, 'approve the plan yourself in the app, keeping approvals on',
  'Plan, in one line, creating s7.txt in this folder containing: seven. Then call ExitPlanMode. Once the plan is approved, stop: do not create the file.',
  userAnswers)

await step(2, 'the deck answers Allow after 8 seconds', 'Use the Write tool to create s4.txt in this folder containing: four', async (out, mark) => {
  const held = await heldOrEnd(out, mark, 60_000)
  if (!held) return
  await sleep(8000)
  out.answer = await control('/control/answer', { id: held.id, decision: 'allow' })
  log(`  answered allow: ${JSON.stringify(out.answer)}`)
})

await step(3, 'click Allow yourself in the app', 'Use the Write tool to create s5.txt in this folder containing: five', async (out, mark) => {
  await userAnswers(out, mark)
  const post = await waitFor(mark, (l) => isReq(l, '/hook/PostToolUse') && String(l.body?.tool_input?.file_path ?? '').endsWith('s5.txt'), 5_000, 'PostToolUse s5')
  const end = lines.slice(mark).find((l) => l.path === '/permission' && l.kind !== 'request' && l.end)
  out.requestEndMinusToolMs = end && post ? end.t - post.t : null
})

await step(4, 'the deck answers Deny after 8 seconds', 'Use the Write tool to create s6.txt in this folder containing: six', async (out, mark) => {
  const held = await heldOrEnd(out, mark, 60_000)
  out.endWaitMs = 60_000
  if (!held) return
  await sleep(8000)
  out.answer = await control('/control/answer', { id: held.id, decision: 'deny', message: 'Denied from the Stream Deck (spike S2).', interrupt: true })
  log(`  answered deny: ${JSON.stringify(out.answer)}`)
})

await step(5, 'answer the question yourself in the app', 'Use the AskUserQuestion tool to ask me one question: red or blue? Then reply with my answer.', userAnswers)

await step(6, 'press Esc in the app while the story is being written',
  'The sandbox CLAUDE.md now allows long replies when a message asks. Write a 1,500-word story about a lighthouse keeper, as plain text. A long reply is wanted.',
  async (out) => { out.endWaitMs = 300_000 })

await control('/control/policy', { permission: { via: 'http', action: 'none' } })

// S4: the app's own mode tool, called by the mod for its own session, going up (the user sees a card).
if (want('raise')) {
  log('S4: the mod asks the app to raise this session to Accept edits')
  summary.modeRaise = await setMode('s4-raise', 'acceptEdits')
}

summary.finished = new Date().toISOString()
const summaryFile = path.join(runDir, `s2-summary${parts ? `-${parts.replaceAll(',', '-')}` : ''}.json`)
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + '\n')
log(`done. policy back to none. summary: ${summaryFile}`)
