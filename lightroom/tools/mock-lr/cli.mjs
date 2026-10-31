#!/usr/bin/env node
// Mock Lightroom on the command line, with a REPL on stdin for the things a user does in Lightroom.
//
//   mise exec -- node lightroom/tools/mock-lr/cli.mjs [--ports 59780,59781] [--scenario file.json] [--set-ms N] [--quiet|--verbose]
//
// Ports default to DeckBridge's 58780/58781, which the real Lightroom uses, so the mock can stand in
// for it. If they're taken, it says so and exits with code 2. Type "help" for the REPL commands.
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { startMock, loadScenario, PortInUseError, SetupError } from './index.mjs';
import { CMD_PORT, EVT_PORT, parsePorts } from '../lib/params.mjs';

const USAGE = `usage: node lightroom/tools/mock-lr/cli.mjs [--ports cmd,evt] [--scenario file.json] [--set-ms N] [--quiet|--verbose]
  --ports      default ${CMD_PORT},${EVT_PORT} (DeckBridge's); 0 picks a free port
  --scenario   a JSON file shaped like a fixture's setup line (default: mock-lr/default-scenario.json)
  --set-ms     each set takes this long, and later lines wait (default 0)
  --quiet      only errors and the REPL's answers; --verbose also logs every event sent`;

const HELP = `REPL commands (what a user does in Lightroom):
  photo <id>                 click a photo: it becomes the only selected one and the target
  select [<id> ...]          change the selection; the first id is the target; none leaves no target
  edit <param> <v> [...]     a mouse edit on the target photo, e.g. edit Exposure 0.8 Contrast -12
  module <name>              library, develop, map, book, slideshow, print or web
  flag pick|reject|none      flag with P, X or U; rating <0-5>; label <red|yellow|green|blue|purple|none>
  autoadvance on|off         Lightroom's own Auto Advance
  lock <id> [on|off]         a background AI update locks the photo, so presets skip it
  busy <secs>                the catalog is busy: preset waits up to 3 s, then err busy
  guard on|off               Config.GUARD (only the user turns it off)
  catalog <path>             open another catalog: Lightroom relaunches with it
  pause <secs>               an open menu: no ok, no reads, no events until it closes
  stale                      the send socket goes stale: events vanish until the cmd socket closes
  close [cmd|evt|both]       Lightroom closes the client connection(s) by itself
  quit-and-relaunch [secs]   quit (no goodbye) and come back after secs (default 3) with a new inst
  reload-plugin              Reload Plug-in: like quit-and-relaunch, but back in 0.5 s
  state                      show the target photo, module, gesture and clients
  exit                       stop the mock`;

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

let opt;
try {
  opt = parseArgs({
    options: {
      ports: { type: 'string' },
      scenario: { type: 'string' },
      'set-ms': { type: 'string' },
      quiet: { type: 'boolean', short: 'q' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  }).values;
} catch (err) {
  process.stderr.write(`${err.message}\n${USAGE}\n`);
  process.exit(2);
}
if (opt.help) {
  process.stdout.write(`${USAGE}\n\n${HELP}\n`);
  process.exit(0);
}

const say = (text) => process.stdout.write(`${text}\n`);
const QUIET_KINDS = new Set(['error', 'bezel']);
const log = (kind, text) => {
  if (kind === 'evt' && !opt.verbose) return;
  if (opt.quiet && !QUIET_KINDS.has(kind)) return;
  say(`[mock ${stamp()}] ${kind.padEnd(5)} ${text}`);
};

let ports;
let scenario;
try {
  ports = opt.ports ? parsePorts(opt.ports) : [CMD_PORT, EVT_PORT];
  scenario = loadScenario(opt.scenario ? path.resolve(opt.scenario) : undefined);
} catch (err) {
  process.stderr.write(`mock: ${err.message}\n`);
  process.exit(2);
}

let mock;
try {
  mock = await startMock({ ports, scenario, log, setCostMs: Number(opt['set-ms'] ?? 0) || 0 });
} catch (err) {
  if (err instanceof PortInUseError || err instanceof SetupError) {
    process.stderr.write(`mock: ${err.message}\n`);
    process.exit(2);
  }
  throw err;
}

const { control } = mock;
const banner = () => {
  const s = control.state();
  return `mock Lightroom ${s.lr} listening: cmd ${mock.cmdPort}, evt ${mock.evtPort} (inst ${s.inst}). Catalog ${path.basename(s.catalog)}, ${s.writable ? 'writable' : 'writes refused by the guard'}. ${s.order.length} photos, ${s.presets.length} presets. Type help.`;
};
say(banner());

function describeState() {
  const s = control.state();
  const ph = s.target ? s.photos[s.target] : null;
  const c = s.clients;
  return [
    `module ${s.module}, view ${s.view}, target ${s.target ?? 'none'}${ph ? ` (${ph.file}, flag ${ph.flag}, rating ${ph.rating}, ${ph.label})` : ''}, selected ${s.selected.join(',') || 'none'}`,
    ph ? `values ${Object.entries(ph.values).map(([k, v]) => `${k} ${v}`).join(', ')}` : 'no values',
    `gesture ${s.gesture ? `${s.gesture.p} g ${s.gesture.g}` : 'none'}, watch ${s.watch.join(',') || 'nothing'}, autoAdvance ${s.autoAdvance}, guard ${s.guard ? 'on' : 'off'}${s.writable ? '' : ' (refusing writes)'}`,
    `clients: cmd ${c.cmd ? 'yes' : 'no'}, evt ${c.evt ? (c.stale ? 'stale' : 'yes') : 'no'}${c.backlog ? `, ${c.backlog} waiting unserved` : ''}; events written ${c.written}, lost ${c.lost}${s.paused ? '; PAUSED' : ''}, inst ${s.inst}`,
  ].join('\n');
}

const onOff = (word) => {
  if (word === 'on' || word === 'true' || word === undefined) return true;
  if (word === 'off' || word === 'false') return false;
  throw new Error('say on or off');
};

async function command(line) {
  const [cmd, ...args] = line.trim().split(/\s+/);
  switch (cmd) {
    case '':
      return null;
    case 'help':
      return HELP;
    case 'state':
      return describeState();
    case 'photo':
      if (!args[0]) throw new Error('photo <id>');
      control.user({ photo: args[0] });
      return `target ${args[0]}`;
    case 'select':
      control.user({ selected: args });
      return args.length ? `selected ${args.join(', ')}; target ${args[0]}` : 'nothing selected: no target photo';
    case 'edit': {
      if (args.length < 2 || args.length % 2) throw new Error('edit <param> <value> [<param> <value> ...]');
      const edit = {};
      for (let i = 0; i < args.length; i += 2) {
        const v = Number(args[i + 1]);
        if (!Number.isFinite(v)) throw new Error(`${args[i + 1]} isn't a number`);
        edit[args[i]] = v;
      }
      control.user({ edit });
      return `edited ${Object.entries(edit).map(([k, v]) => `${k} ${v}`).join(', ')}`;
    }
    case 'module':
      control.user({ module: args[0] });
      return `module ${args[0]}`;
    case 'flag':
      control.user({ flag: args[0] });
      return `flag ${args[0]}`;
    case 'rating':
      control.user({ rating: Number(args[0]) });
      return `rating ${args[0]}`;
    case 'label':
      control.user({ label: args[0] });
      return `label ${args[0]}`;
    case 'autoadvance':
      control.options({ autoAdvance: onOff(args[0]) });
      return `Auto Advance ${control.state().autoAdvance ? 'on' : 'off'}`;
    case 'lock':
      if (!args[0]) throw new Error('lock <id> [on|off]');
      control.options({ lock: { [args[0]]: onOff(args[1]) } });
      return `photo ${args[0]} ${control.state().photos[args[0]].locked ? 'locked' : 'unlocked'}`;
    case 'busy': {
      const secs = Number(args[0] ?? 5);
      control.busy(secs * 1000);
      return `catalog busy for ${secs} s`;
    }
    case 'guard':
      control.options({ guard: onOff(args[0]) });
      return `guard ${control.state().guard ? 'on' : 'off'}; writable ${control.state().writable} (the deck sees it in the next hello)`;
    case 'catalog': {
      const file = args.join(' ');
      if (!file) throw new Error('catalog <path>');
      say('Lightroom relaunches to open another catalog');
      await control.relaunch({ catalog: file, downMs: 2000 });
      return banner();
    }
    case 'pause': {
      const secs = Number(args[0] ?? 5);
      if (!Number.isFinite(secs) || secs < 0) throw new Error('pause <secs>');
      control.pause(secs * 1000);
      return `paused for ${secs} s`;
    }
    case 'stale':
      return control.stale() ? 'the send socket is stale until the cmd socket closes' : 'no event client to go stale';
    case 'close':
      control.close(args[0] ?? 'both');
      return `closed ${args[0] ?? 'both'}`;
    case 'quit-and-relaunch':
    case 'relaunch': {
      const secs = Number(args[0] ?? 3);
      await control.relaunch({ downMs: secs * 1000 });
      return banner();
    }
    case 'reload-plugin':
      await control.relaunch({ downMs: 500 });
      return banner();
    case 'exit':
    case 'quit':
      await shutdown(0);
      return null;
    default:
      throw new Error(`unknown command "${cmd}" (type help)`);
  }
}

let closing = false;
async function shutdown(code) {
  if (closing) return;
  closing = true;
  await mock.stop();
  process.exit(code);
}
process.on('SIGINT', () => { shutdown(0); });
process.on('SIGTERM', () => { shutdown(0); });

// One command at a time, in order. When stdin ends the mock keeps running until a signal.
const rl = readline.createInterface({ input: process.stdin, terminal: false });
let chain = Promise.resolve();
rl.on('line', (line) => {
  chain = chain.then(async () => {
    try {
      const out = await command(line);
      if (out) say(out);
    } catch (err) {
      say(`error: ${err.message}`);
    }
  });
});
