#!/usr/bin/env node
// S4: summarise dial ticks and dial/touch input from the deck plugin's log.
//
//   node spikes/s4-ticks/analyze.mjs [log files or dirs...] [--since <ISO time | epoch ms>] [--json]
//
// With no paths it reads lightroom/deck/com.karimdhanji.lightroom.sdPlugin/logs/*.log.
// The Develop Dial action logs one line per event:
//   TICK  {"t":<Date.now()>,"hr":<performance.now()>,"col":c,"ticks":n,"pressed":b}
//   INPUT {"t":…,"hr":…,"ev":"dialDown"|"dialUp"|"touchTap","col":c,…}
//   STARTUP {"pid":…,"node":…,"t":…}
// The SDK starts a fresh .0.log on every plugin start, so each file is one process and
// `hr` (performance.now) is comparable within a file. Times below are in milliseconds.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOGS = path.join(here, "..", "..", "lightroom", "deck", "com.karimdhanji.lightroom.sdPlugin", "logs");
/** A pause this long ends a spin. */
const SPIN_GAP_MS = 300;
/** Intervals at least this long are idle gaps, not part of a spin's cadence. */
const IDLE_GAP_MS = 1000;
const LINE = /\b(TICK|INPUT|STARTUP) (\{.*\})\s*$/;

function parseArgs(argv) {
	const opts = { paths: [], since: undefined, json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--json") opts.json = true;
		else if (a === "--since") {
			const v = argv[++i];
			const n = Number(v);
			opts.since = Number.isFinite(n) ? n : Date.parse(v);
			if (!Number.isFinite(opts.since)) throw new Error(`--since: can't parse ${v}`);
		} else if (a === "-h" || a === "--help") {
			console.log("usage: analyze.mjs [log files or dirs...] [--since <ISO time | epoch ms>] [--json]");
			process.exit(0);
		} else opts.paths.push(a);
	}
	if (opts.paths.length === 0) opts.paths.push(DEFAULT_LOGS);
	return opts;
}

function logFiles(paths) {
	const files = [];
	for (const p of paths) {
		const st = statSync(p);
		if (st.isDirectory()) {
			for (const name of readdirSync(p)) if (name.endsWith(".log")) files.push(path.join(p, name));
		} else files.push(p);
	}
	return files.sort();
}

/** One run per file: its STARTUP record and its events in log order. */
function readRuns(files, since) {
	const runs = [];
	for (const file of files) {
		const run = { file: path.basename(file), startup: null, events: [] };
		const lines = readFileSync(file, "utf8").split("\n");
		lines.forEach((line, i) => {
			const m = LINE.exec(line);
			if (!m) return;
			let rec;
			try {
				rec = JSON.parse(m[2]);
			} catch {
				return;
			}
			if (m[1] === "STARTUP") {
				run.startup = rec;
				return;
			}
			if (since !== undefined && rec.t < since) return;
			run.events.push({ kind: m[1], line: i + 1, ...rec });
		});
		if (run.startup || run.events.length) runs.push(run);
	}
	// Oldest run first (rotated files have higher indexes).
	return runs.sort((a, b) => (a.startup?.t ?? a.events[0]?.t ?? 0) - (b.startup?.t ?? b.events[0]?.t ?? 0));
}

function percentile(sorted, p) {
	if (!sorted.length) return null;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const round = (v, d = 1) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);
/** Event time within a run: performance.now when present, else wall clock. */
const at = (e) => (typeof e.hr === "number" ? e.hr : e.t);

function newColumn(col) {
	return {
		col,
		events: 0,
		ticks: 0,
		absTicks: 0,
		maxAbsTicks: 0,
		histogram: {},
		clockwise: 0,
		counterClockwise: 0,
		pressedEvents: 0,
		pressedTicks: 0,
		intervals: [],
		idleGaps: 0,
		busiest: { events: 0, ticks: 0 },
		spins: [],
		dialDown: 0,
		dialUp: 0,
		releasesAfterTurn: 0,
		pressDurations: [],
		taps: 0,
		longTouches: 0,
		tapPositions: [],
	};
}

function analyze(runs) {
	const cols = new Map();
	const column = (c) => {
		if (!cols.has(c)) cols.set(c, newColumn(c));
		return cols.get(c);
	};

	for (const run of runs) {
		const ticksByCol = new Map();
		const downAt = new Map();
		for (const e of run.events) {
			const c = column(e.col);
			if (e.kind === "TICK") {
				const abs = Math.abs(e.ticks);
				c.events++;
				c.ticks += e.ticks;
				c.absTicks += abs;
				c.maxAbsTicks = Math.max(c.maxAbsTicks, abs);
				c.histogram[abs] = (c.histogram[abs] ?? 0) + 1;
				if (e.ticks > 0) c.clockwise++;
				else c.counterClockwise++;
				if (e.pressed) {
					c.pressedEvents++;
					c.pressedTicks += abs;
				}
				if (!ticksByCol.has(e.col)) ticksByCol.set(e.col, []);
				ticksByCol.get(e.col).push(e);
			} else if (e.ev === "dialDown") {
				c.dialDown++;
				downAt.set(e.col, at(e));
			} else if (e.ev === "dialUp") {
				c.dialUp++;
				if (e.turned) c.releasesAfterTurn++;
				if (downAt.has(e.col)) c.pressDurations.push(at(e) - downAt.get(e.col));
				downAt.delete(e.col);
			} else if (e.ev === "touchTap") {
				if (e.hold) c.longTouches++;
				else c.taps++;
				if (Array.isArray(e.tapPos)) c.tapPositions.push(e.tapPos);
			}
		}

		// Cadence, busiest second and spins are measured within one process, per column.
		for (const [col, ticks] of ticksByCol) {
			const c = column(col);
			for (let i = 1; i < ticks.length; i++) {
				const dt = at(ticks[i]) - at(ticks[i - 1]);
				if (dt >= IDLE_GAP_MS) c.idleGaps++;
				else c.intervals.push(dt);
			}
			let lo = 0;
			let windowTicks = 0;
			for (let hi = 0; hi < ticks.length; hi++) {
				windowTicks += Math.abs(ticks[hi].ticks);
				while (at(ticks[hi]) - at(ticks[lo]) >= 1000) windowTicks -= Math.abs(ticks[lo++].ticks);
				const events = hi - lo + 1;
				if (events > c.busiest.events) c.busiest.events = events;
				if (windowTicks > c.busiest.ticks) c.busiest.ticks = windowTicks;
			}
			let spin = null;
			for (const e of ticks) {
				if (!spin || at(e) - spin.end >= SPIN_GAP_MS) {
					spin = { start: at(e), end: at(e), t: e.t, events: 0, ticks: 0, maxAbsTicks: 0, pressed: false };
					c.spins.push(spin);
				}
				spin.end = at(e);
				spin.events++;
				spin.ticks += Math.abs(e.ticks);
				spin.maxAbsTicks = Math.max(spin.maxAbsTicks, Math.abs(e.ticks));
				spin.pressed ||= Boolean(e.pressed);
			}
		}
	}

	return [...cols.values()]
		.sort((a, b) => a.col - b.col)
		.map((c) => {
			const intervals = [...c.intervals].sort((x, y) => x - y);
			const spins = c.spins
				.map((s) => {
					const ms = s.end - s.start;
					return {
						at: new Date(s.t).toISOString(),
						ms: round(ms),
						events: s.events,
						ticks: s.ticks,
						maxAbsTicks: s.maxAbsTicks,
						ticksPerSec: ms > 0 ? round((s.ticks / ms) * 1000) : null,
						eventsPerSec: ms > 0 ? round((s.events / ms) * 1000) : null,
						pressed: s.pressed,
					};
				})
				.sort((a, b) => (b.ticksPerSec ?? 0) - (a.ticksPerSec ?? 0));
			const presses = [...c.pressDurations].sort((x, y) => x - y);
			return {
				col: c.col,
				rotate: {
					events: c.events,
					netTicks: c.ticks,
					absTicks: c.absTicks,
					maxAbsTicks: c.maxAbsTicks,
					ticksPerEvent: c.histogram,
					clockwiseEvents: c.clockwise,
					counterClockwiseEvents: c.counterClockwise,
					pressedEvents: c.pressedEvents,
					pressedTicks: c.pressedTicks,
					intervalMs: {
						count: intervals.length,
						min: round(intervals[0] ?? null),
						median: round(percentile(intervals, 0.5)),
						p95: round(percentile(intervals, 0.95)),
						idleGapsOver1s: c.idleGaps,
					},
					busiestSecond: c.busiest,
					spins: { count: spins.length, fastest: spins.slice(0, 3) },
				},
				press: {
					dialDown: c.dialDown,
					dialUp: c.dialUp,
					releasesAfterTurn: c.releasesAfterTurn,
					durationMs: { median: round(percentile(presses, 0.5)), max: round(presses.at(-1) ?? null) },
				},
				touch: { taps: c.taps, longTouches: c.longTouches, tapPositions: c.tapPositions.slice(0, 10) },
			};
		});
}

function printText(runs, cols, files) {
	console.log(`Logs: ${files.map((f) => path.relative(process.cwd(), f)).join(", ")}`);
	console.log(`Plugin runs: ${runs.length}`);
	for (const r of runs) {
		const s = r.startup;
		const started = s ? `${new Date(s.t).toISOString()} pid ${s.pid} node ${s.node}` : "no STARTUP line";
		console.log(`  ${r.file}: ${started}, ${r.events.length} events`);
	}
	if (!cols.length) {
		console.log("\nNo TICK or INPUT lines found.");
		return;
	}
	for (const c of cols) {
		const r = c.rotate;
		console.log(`\nColumn ${c.col}`);
		console.log(`  rotate: ${r.events} events, ${r.absTicks} ticks (net ${r.netTicks >= 0 ? "+" : ""}${r.netTicks}), max |ticks| per event ${r.maxAbsTicks}`);
		const hist = Object.entries(r.ticksPerEvent)
			.sort(([a], [b]) => Number(a) - Number(b))
			.map(([k, v]) => `${k}:${v}`)
			.join("  ");
		console.log(`  |ticks| per event: ${hist || "—"}`);
		console.log(`  direction: ${r.clockwiseEvents} clockwise, ${r.counterClockwiseEvents} counter-clockwise events`);
		const iv = r.intervalMs;
		console.log(`  interval between events (gaps under 1 s, ms): min ${iv.min ?? "—"}, median ${iv.median ?? "—"}, p95 ${iv.p95 ?? "—"} (n=${iv.count}; ${iv.idleGapsOver1s} idle gaps)`);
		console.log(`  busiest 1 s: ${r.busiestSecond.events} events, ${r.busiestSecond.ticks} ticks`);
		console.log(`  pressed rotation: ${r.pressedEvents ? `yes, ${r.pressedEvents} events / ${r.pressedTicks} ticks` : "not seen"}`);
		console.log(`  spins (split at ${SPIN_GAP_MS} ms pauses): ${r.spins.count}; fastest:`);
		for (const s of r.spins.fastest) {
			console.log(`    ${s.at}  ${s.ms} ms, ${s.events} events, ${s.ticks} ticks, ${s.ticksPerSec ?? "—"} ticks/s, ${s.eventsPerSec ?? "—"} events/s, max |ticks| ${s.maxAbsTicks}${s.pressed ? ", pressed" : ""}`);
		}
		const p = c.press;
		console.log(`  press: ${p.dialDown} down, ${p.dialUp} up (${p.releasesAfterTurn} after push + turn); hold median ${p.durationMs.median ?? "—"} ms, max ${p.durationMs.max ?? "—"} ms`);
		const t = c.touch;
		const pos = t.tapPositions.map((xy) => `(${xy.join(",")})`).join(" ");
		console.log(`  touch: ${t.taps} taps, ${t.longTouches} long-touches${pos ? `; positions ${pos}` : ""}`);
	}
}

const opts = parseArgs(process.argv.slice(2));
const files = logFiles(opts.paths);
const runs = readRuns(files, opts.since);
const cols = analyze(runs);
if (opts.json) {
	console.log(JSON.stringify({ runs: runs.map((r) => ({ file: r.file, startup: r.startup, events: r.events.length })), columns: cols }, null, 2));
} else printText(runs, cols, files);
