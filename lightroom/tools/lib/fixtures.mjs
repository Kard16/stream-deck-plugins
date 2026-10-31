// Reads the fixture conversations in lightroom/protocol/fixtures (PROTOCOL.md, Fixtures).
// Each line is one JSON object with exactly one key: note, setup, deck, raw, lr, never, user, wait or expect.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../protocol/fixtures');
export const LINE_KINDS = Object.freeze(['note', 'setup', 'deck', 'raw', 'lr', 'never', 'user', 'wait', 'expect']);

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export class FixtureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FixtureError';
  }
}

// Returns { name, setup, lines: [{ kind, value, line, text }] }. Throws FixtureError on a malformed file.
export function parseFixture(text, name = 'fixture') {
  const lines = [];
  let setup = null;
  let sawContent = false;
  const rows = text.split('\n');
  for (let i = 0; i < rows.length; i += 1) {
    const raw = rows[i].replace(/\r$/, '');
    if (raw.trim() === '') continue;
    const where = `${name}:${i + 1}`;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      throw new FixtureError(`${where}: not JSON (${err.message})`);
    }
    if (!isObject(obj)) throw new FixtureError(`${where}: each line must be a JSON object`);
    const keys = Object.keys(obj);
    if (keys.length !== 1 || !LINE_KINDS.includes(keys[0])) {
      throw new FixtureError(`${where}: a line needs exactly one of ${LINE_KINDS.join(', ')}; got ${keys.join(', ') || 'nothing'}`);
    }
    const kind = keys[0];
    const value = obj[kind];
    switch (kind) {
      case 'note':
        break;
      case 'setup':
        if (sawContent || setup) throw new FixtureError(`${where}: setup must be the first line (after notes)`);
        if (!isObject(value)) throw new FixtureError(`${where}: setup must be an object`);
        setup = value;
        break;
      case 'raw':
        if (typeof value !== 'string') throw new FixtureError(`${where}: raw must be a string`);
        break;
      case 'wait':
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new FixtureError(`${where}: wait must be a number of ms`);
        break;
      default:
        if (!isObject(value)) throw new FixtureError(`${where}: ${kind} must be an object`);
    }
    if (kind !== 'note' && kind !== 'setup') sawContent = true;
    lines.push({ kind, value, line: i + 1, text: raw });
  }
  return { name, setup: setup ?? {}, lines };
}

export function readFixture(file) {
  return { file, ...parseFixture(fs.readFileSync(file, 'utf8'), path.basename(file)) };
}

export function listFixtures(dir = FIXTURES_DIR) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(dir, f));
}
