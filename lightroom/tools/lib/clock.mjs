// Clocks for the mock Lightroom. RealClock is wall time. ManualClock only moves when a test calls
// advance(), which is how offline fixture runners "own the clock" (PROTOCOL.md, Fixtures).
import { performance } from 'node:perf_hooks';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export class RealClock {
  constructor() {
    this.kind = 'real';
  }

  now() { return performance.now(); }
  wall() { return Date.now(); }
  setTimeout(fn, ms) { return setTimeout(fn, Math.max(0, ms)); }
  clearTimeout(handle) { clearTimeout(handle); }
  setInterval(fn, ms) { return setInterval(fn, ms); }
  clearInterval(handle) { clearInterval(handle); }
  // Real time passes by itself.
  advance(ms) { return sleep(ms); }
}

export class ManualClock {
  constructor({ wallStart = Date.now() } = {}) {
    this.kind = 'manual';
    this.t = 0;
    this.wallStart = wallStart;
    this.timers = new Map();
    this.seq = 0;
    this.onError = (err) => { process.stderr.write(`manual clock: timer threw: ${err && err.stack ? err.stack : err}\n`); };
  }

  now() { return this.t; }
  wall() { return this.wallStart + this.t; }

  setTimeout(fn, ms) {
    const id = ++this.seq;
    this.timers.set(id, { id, due: this.t + Math.max(0, ms), every: 0, fn });
    return id;
  }

  clearTimeout(id) { this.timers.delete(id); }

  setInterval(fn, ms) {
    const id = ++this.seq;
    const every = Math.max(1, ms);
    this.timers.set(id, { id, due: this.t + every, every, fn });
    return id;
  }

  clearInterval(id) { this.timers.delete(id); }

  pending() { return this.timers.size; }

  // Earliest timer due by `end`; ties go to the one created first.
  _next(end) {
    let best = null;
    for (const tm of this.timers.values()) {
      if (tm.due > end) continue;
      if (!best || tm.due < best.due || (tm.due === best.due && tm.id < best.id)) best = tm;
    }
    return best;
  }

  // Runs every timer due within ms, in order, including ones those timers schedule.
  advanceSync(ms) {
    const end = this.t + Math.max(0, ms);
    for (let n = 0; n < 1e6; n += 1) {
      const tm = this._next(end);
      if (!tm) break;
      this.t = Math.max(this.t, tm.due);
      if (tm.every > 0) tm.due += tm.every;
      else this.timers.delete(tm.id);
      try { tm.fn(); } catch (err) { this.onError(err); }
    }
    this.t = end;
  }

  advance(ms) {
    this.advanceSync(ms);
    return Promise.resolve();
  }
}

export function makeClock(kind) {
  if (kind && typeof kind === 'object') return kind;
  if (kind === 'manual') return new ManualClock();
  if (kind == null || kind === 'real') return new RealClock();
  throw new Error(`unknown clock "${kind}": use "real" or "manual"`);
}
