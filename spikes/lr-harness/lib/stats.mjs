// Small numeric helpers for the harness summaries.

export function round(x, digits = 1) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function round2(x) {
  return Math.round(x * 100) / 100;
}

function sorted(values) {
  return values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
}

// Nearest-rank percentile on a sorted array.
function pct(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedValues.length);
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, rank - 1))];
}

export function median(values) {
  const s = sorted(values);
  if (s.length === 0) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// { n, min, med, p95, max } with values rounded to 0.1, or { n: 0 } when empty.
export function stats(values) {
  const s = sorted(values);
  if (s.length === 0) return { n: 0, min: null, med: null, p95: null, max: null };
  return {
    n: s.length,
    min: round(s[0]),
    med: round(median(s)),
    p95: round(pct(s, 95)),
    max: round(s[s.length - 1]),
  };
}

// Triangle wave in [-1, 1]: starts at 0, rises to 1 at a quarter period, falls to -1 at three quarters.
export function triangle(phaseCycles) {
  const p = phaseCycles - Math.floor(phaseCycles);
  if (p < 0.25) return 4 * p;
  if (p < 0.75) return 2 - 4 * p;
  return 4 * p - 4;
}
