// Renders the harness state object as summary.md. Pure function of the state; never throws on odd data.

const dash = '—';

function cell(x) {
  if (x === null || x === undefined || x === '') return dash;
  return String(x).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function json(x, max = 500) {
  if (x === undefined) return dash;
  let s;
  try { s = JSON.stringify(x); } catch { s = String(x); }
  if (s === undefined) return dash;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function yn(b) {
  if (b === true) return 'yes';
  if (b === false) return '**no**';
  return dash;
}

function table(headers, rows) {
  const out = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const r of rows) out.push(`| ${r.map(cell).join(' | ')} |`);
  return out.join('\n');
}

function trio(s) {
  if (!s || !s.n) return dash;
  return `${s.med} / ${s.p95} / ${s.max}`;
}

function mb(bytes) {
  return typeof bytes === 'number' ? `${(bytes / 1048576).toFixed(1)} MB` : null;
}

function renderHeader(S) {
  const m = S.meta;
  const lines = ['# Spike harness summary', ''];
  let run = `- **Run:** ${m.runId}, started ${m.startedAt}, updated ${m.updatedAt}`;
  if (m.endedAt) run += `, ended ${m.endedAt} (${m.endReason})`;
  lines.push(run);
  lines.push(`- **Ports:** cmd ${m.cmdPort}, evt ${m.evtPort}. **Plugin dir:** \`${m.pluginDir}\`${m.quick ? '. Quick mode.' : ''}`);
  const h = S.hello;
  if (h) {
    lines.push(`- **Lightroom:** ${cell(h.lr)}, catalog \`${cell(h.catalog)}\` at \`${cell(h.path)}\`, guard ${cell(h.guard)}, writable ${cell(h.writable)}, inst ${cell(h.inst)}. First connected ${cell(S.firstConnectAt)}.`);
    const last = S.lastHello;
    if (last && last.inst !== h.inst) lines.push(`- **Current instance:** inst ${cell(last.inst)}, gen ${cell(last.gen)}, writable ${cell(last.writable)}.`);
  } else {
    lines.push('- **Lightroom:** not connected yet.');
  }
  const st = S.state;
  if (st) lines.push(`- **Last state:** module ${cell(st.module)}, photo ${cell(st.photo)} (${cell(st.file)}), flag ${cell(st.flag)}, rating ${cell(st.rating)}, label ${cell(st.label)}, selected ${cell(st.sel)}.`);
  const types = Object.entries(S.counts.byType).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${v}`).join(', ');
  lines.push(`- **Messages:** in ${S.counts.in}, out ${S.counts.out}${types ? ` (in by type: ${types})` : ''}.`);
  const link = S.link || {};
  if (link.okLines > 0) lines.push(`- **LrSocket receive mode replies \`ok\` per line** on the cmd socket: ${link.okLines} so far. They're counted, not errors, and give the time until Lightroom took each line.`);
  const hb = link.heartbeat;
  if (hb) lines.push(`- **Heartbeat:** ping every ${hb.intervalMs / 1000} s, ${hb.pings} pings, ${hb.pongs} pongs (${hb.latePongs} late), ${hb.staleReconnects} stale-sender reconnect(s), ${hb.pausedEpisodes} pause(s) waited out, ${hb.slowGraceEpisodes} slow-probe wait(s).`);
  if (S.guard.count > 0) {
    lines.push('', `> **GUARD:** ${S.guard.count} command(s) were refused with \`err guard\`. The active catalog isn't the test catalog, so every write was blocked. Commands refused: ${S.guard.samples.map((g) => g.cmd).filter(Boolean).slice(0, 10).join(', ') || dash}.`);
  }
  if (h && h.path && m.expectedCatalog && h.path !== m.expectedCatalog) {
    const caseOnly = h.path.toLowerCase() === m.expectedCatalog.toLowerCase();
    lines.push('', `> **Catalog ${caseOnly ? 'path differs in case only' : 'mismatch'}:** Lightroom reports \`${h.path}\`, expected \`${m.expectedCatalog}\`.`);
  }
  if (h && h.writable === false) lines.push('', '> **Not writable:** Lightroom says writes are refused right now.');
  return lines.join('\n');
}

function renderStatus(S) {
  const lc = S.lifecycle.events;
  const count = (k) => lc.filter((e) => e.kind.startsWith(k)).length;
  return ['## Status', '', table(['Spike', 'Status'], [
    ['S1 sockets', S.status.s1],
    ['S3 hot reload', S.status.s3],
    ['S5 probes', S.status.s5],
    ['S2 latency', S.status.s2],
    ['Before/After', S.status.beforeAfter],
    ['Auto Sync', S.status.autosync],
    ['Lifecycle', `${count('reload')} reload(s), ${count('quit')} quit(s), ${count('relaunch')} relaunch(es)`],
  ])].join('\n');
}

function renderS1(S) {
  const lines = ['## S1 sockets', '',
    'Cycles 1–10 drop both sockets and reconnect after 300 ms. Cycles 11–13 drop only cmd and reconnect it after 300 ms; Lightroom then recreates its sender, which closes our evt, and the pair rule reconnects that too. Cycles 14–16 lose evt the way the deck client handles it: the pair rule closes cmd as well, then reconnects both.',
    '',
    'A pure evt-only drop leaves Lightroom\'s sender stale: its send socket never notices the client went away and keeps writing to the dead socket, so no hello or reply arrives (observed in run 20261031-133539). Hence the pair rule.',
    '',
    'Pass: both sockets back, a `hello` after the drop, then a `pong`, all within 5 s of the reconnect starting. Times are from the drop; reconnects start after 300 ms (full and cmd drops) or the pair rule\'s 250 ms.', ''];
  if (S.s1.cycles.length === 0) {
    lines.push('Not run yet.');
  } else {
    lines.push(table(['#', 'Drop', 'OK', 'Connect ms', 'Hello ms', 'Ping ms', 'Total ms', 'gen', 'Note'],
      S.s1.cycles.map((c) => [c.n, c.kind, yn(c.ok), c.connectMs, c.helloMs, c.pingMs, c.totalMs, c.gen,
        [c.lrClosedEvt ? 'Lightroom closed evt' : null, c.pairClosed ? 'rule closed cmd' : null, c.retried ? 'retry' : null, c.note].filter(Boolean).join('; ')])));
  }
  if (S.s1.note) lines.push('', `Note: ${S.s1.note}`);
  return lines.join('\n');
}

function renderS3(S) {
  const s3 = S.s3;
  const lines = ['## S3 hot reload', '', 'Step 1 reads the module through `require`. Step 2 edits the file on disk. Steps 3 and 5 show whether `require` caches it; step 4 shows whether the `reload` command (loadstring) sees the edit; step 6 shows whether Reload Plug-in (or a relaunch) clears the cache.', ''];
  if (s3.steps.length === 0) {
    lines.push('Not run yet.');
  } else {
    lines.push(table(['Step', 'OK', 'v', 'Verdict', 'Detail'], s3.steps.map((st) => [st.step, yn(st.ok), st.v, st.verdict, json(st.detail, 400)])));
  }
  if (s3.followUpPending) lines.push('', 'Waiting for Reload Plug-in to run step 6.');
  if (s3.fileRestored === true) lines.push('', `SpikeVersion.lua restored to its original contents (${s3.restoreNote}).`);
  if (s3.fileRestored === false) lines.push('', `**SpikeVersion.lua is still modified** (${s3.restoreNote}). Restore it with \`cp '${s3.backup}' '${s3.file}'\`.`);
  return lines.join('\n');
}

function renderS5(S) {
  const lines = ['## S5 probes', ''];
  if (S.s5.runs.length === 0) return lines.concat(['Not run yet. Starts on `trigger tests`.']).join('\n');
  S.s5.runs.forEach((run, i) => {
    lines.push(`### Run ${i + 1} of ${S.s5.runs.length}, started ${run.startedAt}${run.endedAt ? `, ended ${run.endedAt}` : ''}`, '');
    lines.push(table(['Probe', 'OK', 'LR ms', 'RTT ms', 'Result'], run.probes.map((p) => [
      p.name, yn(p.ok), p.ms, p.rttMs,
      (p.ok ? json(p.data, 600) : `${p.msg ?? 'failed'}${p.data !== undefined ? ' ' + json(p.data, 300) : ''}`) + (p.late ? ` (late reply after ${p.late.afterMs} ms: ${json(p.late.reply, 300)})` : ''),
    ])));
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

function renderS2(S) {
  const lines = ['## S2 latency', '', 'ok: send to LrSocket\'s `ok` for that line. Ack: send to `ack`. Echo: send to the `vals` that carries the value. LR handler: the `ms` field of `ack`. Backlog compares the median echo latency in the first and last second of a burst; a large positive change means a growing queue. Drain: time from the last `set` to the last `ack` and the last `vals`.', ''];
  if (S.s2.runs.length === 0) return lines.concat(['Not run yet. Starts after the S5 probes.']).join('\n');
  S.s2.runs.forEach((run, i) => {
    const p = run.photo || {};
    lines.push(`### Run ${i + 1} of ${S.s2.runs.length}, started ${run.startedAt}${run.endedAt ? `, ended ${run.endedAt}` : ''}`, '');
    lines.push(`Photo: ${cell(p.file ?? p.name)}, ${cell(p.format)}, ${cell(mb(p.fileSize ?? p.size))}, ${cell(p.width)}×${cell(p.height)}. Base Exposure ${cell(run.base)}.${run.note ? ` Note: ${run.note}.` : ''}`, '');
    if (run.bursts.length) {
      lines.push(table(['Burst', 'Hz target / actual', 'Sets', 'Skipped', 'Drift p95 ms', 'ok med / p95 / max', 'Ack med / p95 / max', 'Missing acks', 'LR handler med / max', 'Echo med / p95 / max', 'Echoes / vals', 'Backlog echo ms', 'Drain ack / vals ms', 'cy', 'Errs'],
        run.bursts.map((b) => [
          `${b.hz}/s ${b.track ? 'tracked' : 'untracked'}`,
          `${b.hz} / ${b.actualHz}`,
          b.sent, b.skipped, b.drift.p95,
          trio(b.ok), trio(b.ack), b.missingAcks,
          b.lr && b.lr.n ? `${b.lr.med} / ${b.lr.max}` : dash,
          trio(b.echo),
          `${b.echo.n ?? 0} / ${b.vals ?? 0}`,
          b.backlog.echoFirst != null || b.backlog.echoLast != null ? `${cell(b.backlog.echoFirst)} → ${cell(b.backlog.echoLast)}` : dash,
          `${cell(b.drain.ackMs)} / ${cell(b.drain.valsMs)}`,
          (b.cySeen || []).join(','),
          b.errs ? `${b.errs} ${json(b.errSamples, 120)}` : 0,
        ])));
      const extra = run.bursts.filter((b) => b.unmatchedVals || b.dupVals || b.lateVals || b.sendFailures || b.maxBuffered > 0);
      if (extra.length) {
        lines.push('', 'Details: ' + extra.map((b) => `${b.hz}/s ${b.track ? 'tracked' : 'untracked'}: unmatched vals ${b.unmatchedVals}, duplicate ${b.dupVals}, out of order ${b.lateVals}, send failures ${b.sendFailures}, max bytes buffered ${b.maxBuffered}`).join('; ') + '.');
      }
    }
    if (run.restored) lines.push('', 'Exposure was set back to the base value afterwards. If every burst became one history step, History gained about 7 Exposure entries (6 bursts and the restore). Ask the user what they saw.');
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

function renderProbeList(title, list, extra) {
  const lines = [`## ${title}`, ''];
  if (!list.length) return lines.concat(['Not run yet.']).join('\n');
  lines.push(table(['At', 'OK', 'LR ms', 'Result'], list.map((p) => [p.at, yn(p.ok), p.ms, (extra ? extra(p) + ' ' : '') + (p.ok ? json(p.data, 600) : (p.msg ?? 'failed'))])));
  return lines.join('\n');
}

function renderLifecycle(S) {
  const lines = ['## Lifecycle', '', 'A new `inst` in `hello` means the plugin reloaded (Reload Plug-in) or Lightroom relaunched. `bye` is the plugin saying goodbye before its sockets close.', ''];
  const ev = S.lifecycle.events;
  if (!ev.length) return lines.concat(['Nothing yet.']).join('\n');
  lines.push(table(['At', 'Event', 'Details'], ev.map((e) => {
    const { kind, at, ...rest } = e;
    return [at, kind, json(rest, 400)];
  })));
  return lines.join('\n');
}

function renderMisc(S) {
  const lines = [];
  if (S.late.length) {
    lines.push('## Late replies', '', table(['At', 'id', 'After ms', 'Reply'], S.late.map((l) => [l.at, l.id, l.afterMs, json(l.reply, 300)])), '');
  }
  if (S.errors.length || S.unexpected.length) {
    lines.push('## Errors and unexpected messages', '');
    for (const e of S.errors) lines.push(`- ${e.at} [${e.phase}] ${cell(e.msg)}`);
    for (const u of S.unexpected) lines.push(`- ${u.at} unexpected (${u.why}): ${json(u.msg, 300)}`);
  }
  return lines.join('\n').trimEnd();
}

export function renderSummary(S) {
  const parts = [
    renderHeader(S),
    renderStatus(S),
    renderS1(S),
    renderS3(S),
    renderS5(S),
    renderS2(S),
    renderProbeList('Before/After', S.beforeAfter),
    renderProbeList('Auto Sync', S.autosync, (p) => p.text ? `**${p.text}**` : ''),
    renderLifecycle(S),
    renderMisc(S),
  ].filter(Boolean);
  return parts.join('\n\n') + '\n';
}
