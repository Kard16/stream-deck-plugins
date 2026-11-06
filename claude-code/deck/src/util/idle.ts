import { performance } from "node:perf_hooks";

import { type Clock, realClock, type TimerHandle } from "./clock.js";
import { LOG_LEVELS, type LogLevel } from "./log-level.js";
import type { Log } from "./log.js";

/**
 * Counts of the deck's work by kind, for the idle baseline (docs/claude-code/hardening.md, A1): scans, stats, folder
 * walks, lsappinfo spawns, model emits and views, polls, sends to the Stream Deck app and ticks. Process-wide and
 * always on: a count is one Map increment. At debug, startIdleLog writes them once a minute and starts them afresh.
 */
const counts = new Map<string, number>();

export function countIdle(kind: string, n = 1): void {
	counts.set(kind, (counts.get(kind) ?? 0) + n);
}

/** The counts since the last reset, sorted by kind. */
export function idleCounts(): Record<string, number> {
	return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function resetIdleCounts(): void {
	counts.clear();
}

/** How often the IDLE line goes. */
export const IDLE_LOG_MS = 60_000;

const round = (v: number, places: number): number => Math.round(v * 10 ** places) / 10 ** places;

/**
 * At debug or trace, logs one debug line every IDLE_LOG_MS and resets the counts: `IDLE {"s":…,"userMs":…,"sysMs":…,
 * "elu":…,"rssMB":…,"counts":{…}}`, with the seconds it covers, the CPU time the process took meanwhile
 * (process.cpuUsage), the event loop's utilization meanwhile, 0 to 1 (performance.eventLoopUtilization), the resident
 * set now in MB of 2^20 bytes, and the counts (idleCounts). Below debug it starts nothing and returns null; else a
 * stop. Its timer is unref'd, so it never keeps the process up.
 */
export function startIdleLog(log: Log, opts: { level: LogLevel; clock?: Clock; everyMs?: number }): (() => void) | null {
	if (LOG_LEVELS.indexOf(opts.level) < LOG_LEVELS.indexOf("debug")) return null;
	const clock = opts.clock ?? realClock;
	const everyMs = opts.everyMs ?? IDLE_LOG_MS;
	let at = clock.now();
	let cpu = process.cpuUsage();
	let elu = performance.eventLoopUtilization();
	let timer: TimerHandle | null = null;
	resetIdleCounts();
	const tick = (): void => {
		const now = clock.now();
		const cpuNow = process.cpuUsage();
		const eluNow = performance.eventLoopUtilization();
		// NaN when the loop's clock didn't move between the two readings, as a fake clock in a test can make it.
		const utilization = performance.eventLoopUtilization(eluNow, elu).utilization;
		const line = {
			s: round((now - at) / 1000, 1),
			userMs: round((cpuNow.user - cpu.user) / 1000, 1),
			sysMs: round((cpuNow.system - cpu.system) / 1000, 1),
			elu: Number.isFinite(utilization) ? round(utilization, 4) : 0,
			rssMB: round(process.memoryUsage.rss() / 2 ** 20, 1),
			counts: idleCounts(),
		};
		resetIdleCounts();
		at = now;
		cpu = cpuNow;
		elu = eluNow;
		log.debug(`IDLE ${JSON.stringify(line)}`);
		arm();
	};
	const arm = (): void => {
		timer = clock.setTimeout(tick, everyMs);
		(timer as { unref?: () => void }).unref?.();
	};
	arm();
	return () => {
		if (timer !== null) clock.clearTimeout(timer);
		timer = null;
	};
}
