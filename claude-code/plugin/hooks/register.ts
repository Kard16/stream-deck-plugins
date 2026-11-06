// streamdeck-bridge: the mod, one instance per session (PROTOCOL.md, "Parties"). It says hello to the Stream Deck
// bridge, reports the session's events, and fetches and runs the deck's commands. The PermissionRequest hook in
// hooks.json is the plugin's other half.
//
// Every Claude Code process that reads ~/.claude/settings.json loads this mod, but it talks to the bridge only in a
// desktop session of its own (desktop.ts). Anywhere else it sends nothing, logs once why, and its hooks pass through.
//
// Every hook hands its news to the bridge and returns next(e)'s own result: nothing waits on the deck, nothing is
// rewritten, and no error of this plugin reaches the session (a gating hook's .catch passes the call on, as if
// the plugin weren't loaded). The bridge starts on the first hook to run, normally session.start, and its hello
// runs detached, so the session's start and first prompt never wait for it.
//
// API: the app's Claude Code's mods API, early access (claude-code/vendor/mods-api/claude-code.d.ts). The
// engine reads `$` off the source and won't load a module that stores it or hands it to a method, so adapter()
// wraps the calls this plugin makes in closures, and the rest of the plugin never sees `$`.

import type { EngineInterface, Register } from 'claude-code'
import { createBridge, type Bridge, type BridgeHost } from './bridge'
import { runCommand, type CommandHost } from './commands'
import * as ev from './events'

type Dollar = EngineInterface

let bridge: Bridge | undefined

/** Every call this plugin makes on the engine. `$.env.get` takes string literals only: one closure per variable. */
function adapter($: Dollar): BridgeHost & CommandHost {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    after: (ms, fn) => $.clock.after(ms, fn),
    log: text => $.ui.log(text, { to: 'debug' }),
    token: () => $.env.get('DECK_TOKEN'),
    hostId: () => $.env.get('CLAUDE_CODE_HOST_SESSION_ID'),
    entrypoint: () => $.env.get('CLAUDE_CODE_ENTRYPOINT'),
    claudeCode: () => $.env.get('CLAUDECODE'),
    childSession: () => $.env.get('CLAUDE_CODE_CHILD_SESSION'),
    tags: () => $.env.get('CLAUDE_CODE_TAGS'),
    sid: () => $.session.id(),
    cwd: () => $.session.cwd(),
    model: () => $.session.model(),
    version: async () => (await $.session.version()).version,
    submit: async text => {
      const r = await $.prompt.submit({ text, asUser: true })
      return r.drop === undefined ? {} : { drop: r.drop }
    },
  }
}

/** The bridge, made and started by the first hook to run. */
function link($: Dollar): Bridge {
  if (bridge === undefined) {
    const host = adapter($)
    const made: Bridge = createBridge(host, cmd => void runCommand(cmd, host, made))
    bridge = made
    made.start()
  }
  return bridge
}

/** Runs a hook's reporting. What fails there is dropped: the session goes on as if this plugin weren't loaded. */
function attempt<T>(f: () => T): T | undefined {
  try {
    return f()
  } catch {
    return undefined
  }
}

export const register: Register = on => {
  on('session.start', ($, e, next) => {
    const started = next(e)
    // The bridge starts once the session's own start step has run, as in the spikes; the hook doesn't wait for it.
    started.then(
      () => attempt(() => link($)),
      () => attempt(() => link($)),
    )
    return started
  })

  on('session.end', ($, e, next) => {
    attempt(() => link($).emit(ev.end(e)))
    const ended = next(e)
    // A /clear or a resume goes on in this process under a new session id.
    ended.then(
      () => attempt(() => link($).sidMayHaveChanged()),
      () => {},
    )
    return ended
  })

  // Which session is on screen in the app (S3): the deck's target until one is picked on the dial.
  on('session.attach', ($, e, next) => {
    attempt(() => link($).emit(ev.attach(e)))
    return next(e)
  })

  on('session.detach', ($, e, next) => {
    attempt(() => link($).emit(ev.detach(e)))
    return next(e)
  })

  on('session.measure', ($, e, next) => {
    attempt(() => {
      const measured = ev.measure(e)
      if (measured !== undefined) link($).emit(measured)
    })
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    attempt(() => {
      const b = link($)
      b.emit(ev.turnStart(e))
      if (ev.mainLoop(e.agentId)) b.sidMayHaveChanged()
    })
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    attempt(() => {
      const b = link($)
      b.emit(ev.turnEnd(e))
      // The model: `$.session.model()` after each of the main loop's turns (PROTOCOL.md, "Events").
      if (ev.mainLoop(e.agentId)) b.checkModel()
    })
    return next(e)
  })

  // tool.start before next, tool.end once next settles: the call may wait on a permission dialog in between,
  // and the held request's fingerprint is the call's.
  on('tool.call', ($, e, next) => {
    const call = attempt(() => ev.toolCall(e as unknown as Record<string, unknown>))
    if (call !== undefined) attempt(() => link($).emit(ev.toolStart(call)))
    const ran = next(e)
    if (call !== undefined) {
      ran.then(
        r => attempt(() => link($).emit(ev.toolEnd(call, r))),
        () => attempt(() => link($).emit(ev.toolEnd(call, undefined))),
      )
    }
    return ran
  }).catch(($, e, next) => next(e))

  // The permission mode and effort ride on the classic hooks' inputs (BaseHookInput), so the deck hears a change
  // made in the app or by Claude at the next prompt, tool result or turn end. The bridge sends only changes.
  on('classic.UserPromptSubmit', ($, e, next) => {
    attempt(() => link($).observe(ev.settingsOf(e)))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', ($, e, next) => {
    attempt(() => link($).observe(ev.settingsOf(e)))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUseFailure', ($, e, next) => {
    attempt(() => link($).observe(ev.settingsOf(e)))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', ($, e, next) => {
    attempt(() => link($).observe(ev.settingsOf(e)))
    return next(e)
  }).catch(($, e, next) => next(e))

  // A turn that died on an API error: the deck shows the session as failed.
  on('classic.StopFailure', ($, e, next) => {
    attempt(() => {
      const b = link($)
      b.emit(ev.failed(e))
      b.observe(ev.settingsOf(e))
    })
    return next(e)
  }).catch(($, e, next) => next(e))
}
