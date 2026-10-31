// The fixture matcher from PROTOCOL.md's Fixtures section ("Matching lr lines"):
// - every field in an expected message must be present and equal; extra fields are allowed
//   (so vals and ranges match on a key subset);
// - "*" matches any value; numbers match within 1e-6;
// - arrays match when they have the same length and each element matches, in order.
// Inbox applies the stream rules: expected messages in order, extra state/vals/ranges/pong allowed
// in between, never lines active until the next expected message matches, anything else fails.
//
// With { ops: true } (the fake deck's scripts only, never fixtures), an object with a single
// "$"-key is an operator: {"$not": pattern}, {"$type": "number"|"string"|"boolean"|"object"|"array"|"null"}.
import { performance } from 'node:perf_hooks';

export const NUMBER_TOLERANCE = 1e-6;
export const EXTRA_TYPES = Object.freeze(['state', 'vals', 'ranges', 'pong']);

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const now = () => performance.now();

export function short(x, max = 160) {
  let s;
  try { s = JSON.stringify(x); } catch { s = String(x); }
  if (s === undefined) s = String(x);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const at = (path) => path || 'message';
const join = (path, key) => (path ? `${path}.${key}` : String(key));

function typeName(x) {
  if (x === null) return 'null';
  if (Array.isArray(x)) return 'array';
  return typeof x;
}

function opKey(pattern) {
  if (!isObject(pattern)) return null;
  const keys = Object.keys(pattern);
  return keys.length === 1 && keys[0].startsWith('$') ? keys[0] : null;
}

function applyOp(op, arg, actual, path, opts) {
  switch (op) {
    case '$not':
      return mismatch(arg, actual, opts, path) === null ? `${at(path)}: expected anything but ${short(arg)}, got ${short(actual)}` : null;
    case '$type':
      return typeName(actual) === arg ? null : `${at(path)}: expected a ${arg}, got ${short(actual)}`;
    default:
      return `${at(path)}: unknown pattern operator ${op}`;
  }
}

// Null when `actual` matches `expected`, else a short reason naming the first field that differs.
export function mismatch(expected, actual, opts = {}, path = '') {
  if (expected === '*') return actual === undefined ? `${at(path)}: missing` : null;
  if (opts.ops) {
    const op = opKey(expected);
    if (op) return applyOp(op, expected[op], actual, path, opts);
  }
  if (typeof expected === 'number') {
    if (typeof actual === 'number' && Math.abs(actual - expected) <= NUMBER_TOLERANCE) return null;
    return `${at(path)}: expected ${expected}, got ${short(actual)}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${at(path)}: expected an array, got ${short(actual)}`;
    if (actual.length !== expected.length) return `${at(path)}: expected ${expected.length} items, got ${actual.length}`;
    for (let i = 0; i < expected.length; i += 1) {
      const m = mismatch(expected[i], actual[i], opts, `${path}[${i}]`);
      if (m) return m;
    }
    return null;
  }
  if (isObject(expected)) {
    if (!isObject(actual)) return `${at(path)}: expected an object, got ${short(actual)}`;
    for (const key of Object.keys(expected)) {
      if (!Object.prototype.hasOwnProperty.call(actual, key)) return `${join(path, key)}: missing`;
      const m = mismatch(expected[key], actual[key], opts, join(path, key));
      if (m) return m;
    }
    return null;
  }
  return actual === expected ? null : `${at(path)}: expected ${short(expected)}, got ${short(actual)}`;
}

export const match = (expected, actual, opts = {}) => mismatch(expected, actual, opts) === null;

export class MatchError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MatchError';
    Object.assign(this, details);
  }
}

const summarize = (list) => {
  if (list.length === 0) return 'nothing';
  const counts = new Map();
  for (const m of list) {
    const k = isObject(m) && typeof m.t === 'string' ? m.t : short(m, 40);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ');
};

export class Inbox {
  constructor({ extras = EXTRA_TYPES, ops = false } = {}) {
    this.extras = new Set(extras);
    this.opts = { ops };
    this.queue = [];
    this.nevers = [];
    this.waiter = null;
    this.received = 0;
  }

  push(msg, t = now()) {
    this.received += 1;
    this.queue.push({ msg, t });
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  clear() {
    this.queue = [];
  }

  // Lightroom must not send a message matching `pattern` until the next expected message matches.
  never(pattern) {
    this.nevers.push(pattern);
  }

  isExtra(msg) {
    return isObject(msg) && this.extras.has(msg.t);
  }

  // Throws if `msg` is neither an allowed extra nor allowed by the never lines. `waiting` is the
  // pattern being waited for, for the message.
  _screen(msg, waiting, skipped) {
    const bad = this.nevers.find((p) => match(p, msg, this.opts));
    const tail = waiting ? ` while waiting for ${short(waiting)}` : '';
    if (bad) throw new MatchError(`got ${short(msg)}, which a never line forbids (${short(bad)})${tail}`, { kind: 'never', msg, pattern: bad, skipped });
    if (this.isExtra(msg)) return;
    const sameType = isObject(waiting) && isObject(msg) && waiting.t !== undefined && waiting.t === msg.t;
    const why = sameType ? ` (${mismatch(waiting, msg, this.opts)})` : '';
    throw new MatchError(`unexpected ${short(msg)}${tail}${why}`, { kind: 'unexpected', msg, skipped });
  }

  _closest(pattern, skipped) {
    const t = isObject(pattern) ? pattern.t : undefined;
    const same = skipped.filter((m) => isObject(m) && m.t === t);
    if (same.length === 0) return '';
    const last = same[same.length - 1];
    return `; the last ${t} differed at ${mismatch(pattern, last, this.opts)}`;
  }

  // Waits for the next message matching `pattern`. Resolves { msg, t, skipped }; throws MatchError.
  // timeoutMs 0 looks only at what has already arrived.
  async expect(pattern, { timeoutMs = 2000 } = {}) {
    const skipped = [];
    const deadline = now() + timeoutMs;
    for (;;) {
      while (this.queue.length > 0) {
        const { msg, t } = this.queue.shift();
        if (match(pattern, msg, this.opts)) {
          this.nevers = [];
          return { msg, t, skipped };
        }
        this._screen(msg, pattern, skipped);
        skipped.push(msg);
      }
      const left = deadline - now();
      if (left <= 0) {
        const how = timeoutMs > 0 ? `nothing matched within ${timeoutMs} ms` : 'nothing matched';
        throw new MatchError(`${how}: expected ${short(pattern)}; skipped ${summarize(skipped)}${this._closest(pattern, skipped)}`, { kind: 'timeout', pattern, skipped });
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (this.waiter === done) this.waiter = null;
          resolve();
        }, left);
        const done = () => { clearTimeout(timer); resolve(); };
        this.waiter = done;
      });
    }
  }

  // Consumes everything that has arrived: only allowed extras, and nothing a never line forbids.
  check() {
    const skipped = [];
    while (this.queue.length > 0) {
      const { msg } = this.queue.shift();
      this._screen(msg, null, skipped);
      skipped.push(msg);
    }
    return skipped;
  }
}
