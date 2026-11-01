#!/usr/bin/env node
// Tiny CLI for the spike bridge's control endpoints (TCP only).
//   node ctl.mjs state
//   node ctl.mjs policy '{"permission":{"action":"deny","message":"no"}}'
//   node ctl.mjs answer p1 allow ['{"updatedPermissions":[...]}']
//   node ctl.mjs answer oldest deny '{"message":"not now","interrupt":true}'
//   node ctl.mjs queue <session id or *> '{"t":"status","text":"hi"}'
// PORT from the environment (default 47600). Sends the bridge token from
// run/token (BRIDGE_TOKEN_FILE overrides) when it can read it; never prints it.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT || 47600)
const tokenFile = process.env.BRIDGE_TOKEN_FILE || path.join(HERE, 'run', 'token')

function usage(message) {
  if (message) process.stderr.write(`ctl: ${message}\n`)
  process.stderr.write(`usage:
  node ctl.mjs state
  node ctl.mjs policy '<json>'
  node ctl.mjs answer <p1|oldest> <allow|deny|none> ['<json extras: message, interrupt, updatedPermissions, updatedInput>']
  node ctl.mjs queue <sid|*> '<command json>'
`)
  process.exit(2)
}

function json(text, what) {
  try {
    return JSON.parse(text)
  } catch (err) {
    usage(`${what} is not JSON: ${err.message}`)
  }
}

async function call(method, route, body) {
  const headers = { 'content-type': 'application/json' }
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim()
    if (token) headers.authorization = `Bearer ${token}`
  } catch {}
  let res
  try {
    res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (err) {
    process.stderr.write(`ctl: no bridge on 127.0.0.1:${port} (${err.cause?.code ?? err.message})\n`)
    process.exit(1)
  }
  const text = await res.text()
  let out = text
  try {
    out = JSON.stringify(JSON.parse(text), null, 2)
  } catch {}
  process.stdout.write(`${out}\n`)
  if (!res.ok) process.exit(1)
}

const [cmd, ...args] = process.argv.slice(2)
switch (cmd) {
  case 'state':
    await call('GET', '/control/state')
    break
  case 'policy':
    if (args.length !== 1) usage('policy takes one JSON argument')
    await call('POST', '/control/policy', json(args[0], 'the policy'))
    break
  case 'answer': {
    const [id, decision, extras] = args
    if (!id || !decision) usage('answer takes an id and a decision')
    await call('POST', '/control/answer', { ...(extras ? json(extras, 'the extras') : {}), id, decision })
    break
  }
  case 'queue':
    if (args.length !== 2) usage('queue takes a session id and a command')
    await call('POST', '/control/queue', { sid: args[0], cmd: json(args[1], 'the command') })
    break
  default:
    usage(cmd ? `unknown command ${cmd}` : undefined)
}
