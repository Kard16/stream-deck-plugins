import { execFile as nodeExecFile } from "node:child_process";

import { type Clock, realClock, type TimerHandle } from "../util/clock.js";
import { countIdle } from "../util/idle.js";
import { describeError, type Log, nullLog } from "../util/log.js";

/**
 * Whether the Claude app is the app in front, for `seen` (session-keys.md, What each session shows): a turn's end
 * counts as seen once the session is on screen in the app and Claude is in front. A failure counts as not in front.
 */
export type FrontCheck = () => Promise<boolean>;

/** The Claude desktop app's bundle id. */
export const CLAUDE_BUNDLE_ID = "com.anthropic.claudefordesktop";

export const LSAPPINFO = "/usr/bin/lsappinfo";

/** How long each `lsappinfo` call may take before it counts as a failure. It takes under a millisecond (2026-11-04). */
export const FRONT_TIMEOUT_MS = 1000;

/** How often the deck asks while something needs it, at first. */
export const FRONT_CHECK_MS = 1000;

/**
 * How long the deck waits between asks, by how long the check has been wanted since it was last wanted anew or reset
 * (FrontWatcher's `reset`: an attach, a detach, a press on the deck, a wake): every second for the first 30 s, every 5 s
 * until 2 minutes, every 15 s until 10 minutes, then once a minute (hardening.md, B5; the user's choice, 2026-11-06).
 * While the user is in another app, the check can be wanted for hours; it's two lsappinfo spawns an ask.
 */
export function frontIntervalMs(wantedMs: number): number {
	if (wantedMs < 30_000) return FRONT_CHECK_MS;
	if (wantedMs < 120_000) return 5000;
	if (wantedMs < 600_000) return 15_000;
	return 60_000;
}

/**
 * How long a check may go unanswered before the watcher gives up on it, logs a warn line and asks again: well past its
 * two calls' timeouts, so only a check that never settles meets it.
 */
export const FRONT_STUCK_MS = 5000;

/** child_process.execFile's shape, as the check calls it, so tests can stand in for it without spawning anything. */
export type ExecFile = (
	file: string,
	args: readonly string[],
	opts: { timeout: number; killSignal: "SIGKILL"; encoding: "utf8" },
	callback: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

const nodeExec: ExecFile = (file, args, opts, callback) => {
	nodeExecFile(file, [...args], opts, (err, stdout, stderr) => callback(err, String(stdout), String(stderr)));
};

/** `lsappinfo front`'s answer, `ASN:0x0-0x620620:`, checked; null for anything else. */
export function parseFrontAsn(stdout: string): string | null {
	const asn = stdout.trim();
	return /^ASN:0x[0-9a-f]+-0x[0-9a-f]+:$/i.test(asn) ? asn : null;
}

/** `lsappinfo info -only bundleid <asn>`'s answer, `"CFBundleIdentifier"="com.anthropic.claudefordesktop"`; null for `[ NULL ]` or anything else. */
export function parseBundleId(stdout: string): string | null {
	return /"CFBundleIdentifier"="([^"]*)"/.exec(stdout)?.[1] ?? null;
}

/**
 * The check as the deck runs it: `/usr/bin/lsappinfo front`, then `/usr/bin/lsappinfo info -only bundleid <asn>`,
 * each through execFile (no shell) with a FRONT_TIMEOUT_MS timeout, after which the call is killed with SIGKILL, so a
 * hung lsappinfo can't keep the check from settling; and the bundle id compared with Claude's. It needs no permission.
 * Any failure, an answer it can't read included, is false; the first of each kind is logged at warn, the rest at debug.
 */
export function lsappinfoCheck(opts: { execFile?: ExecFile; timeoutMs?: number; log?: Log } = {}): FrontCheck {
	const exec = opts.execFile ?? nodeExec;
	const timeout = opts.timeoutMs ?? FRONT_TIMEOUT_MS;
	const log = opts.log ?? nullLog;
	const warned = new Set<string>();
	const failed = (why: string): false => {
		if (warned.has(why)) log.debug(`front app check: ${why}; counted as not in front`);
		else {
			warned.add(why);
			log.warn(`front app check: ${why}; counted as not in front`);
		}
		return false;
	};
	const run = (args: readonly string[]): Promise<string> =>
		new Promise((resolve, reject) => {
			countIdle("lsappinfo");
			exec(LSAPPINFO, args, { timeout, killSignal: "SIGKILL", encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
		});
	return async () => {
		let asn: string | null;
		try {
			asn = parseFrontAsn(await run(["front"]));
		} catch (err) {
			return failed(`lsappinfo front failed: ${describeError(err).split("\n")[0] ?? "error"}`);
		}
		if (asn === null) return failed("lsappinfo front gave no app");
		let bundle: string | null;
		try {
			bundle = parseBundleId(await run(["info", "-only", "bundleid", asn]));
		} catch (err) {
			return failed(`lsappinfo info failed: ${describeError(err).split("\n")[0] ?? "error"}`);
		}
		return bundle === CLAUDE_BUNDLE_ID;
	};
}

/**
 * Asks the front-app check only while `wanted` says something needs it: some session whose last turn ended unseen is on
 * screen in the app, and something on the deck shows `seen` (SessionModel calls `want` on every change). It asks every
 * second at first, then less often the longer it stays wanted (frontIntervalMs), and every second again from a `reset`
 * or when it becomes wanted anew. The first ask comes as soon as it's wanted, unless one came less than a second before;
 * never two at once, except that a check still unanswered after FRONT_STUCK_MS is given up on: a warn line (the first
 * time; debug after), and the next ask goes, while that check's late answer, if any, counts for nothing. When Claude is
 * in front, `onFront` runs, which marks those sessions seen.
 */
export class FrontWatcher {
	readonly #check: FrontCheck;
	readonly #clock: Clock;
	readonly #stuckMs: number;
	readonly #log: Log;
	readonly #onFront: () => void;
	#wanted = false;
	/** On the clock, when it became wanted anew or was last reset: the back-off counts from then. Null while not wanted. */
	#since: number | null = null;
	#timer: TimerHandle | null = null;
	#stuckTimer: TimerHandle | null = null;
	#inFlight = false;
	/** Which ask is the current one: an answer from an earlier one, given up on, counts for nothing. */
	#current = 0;
	#warnedStuck = false;
	#lastAt = -Infinity;
	#disposed = false;
	#asked = 0;

	constructor(check: FrontCheck, onFront: () => void, opts: { clock?: Clock; stuckMs?: number; log?: Log } = {}) {
		this.#check = check;
		this.#onFront = onFront;
		this.#clock = opts.clock ?? realClock;
		this.#stuckMs = opts.stuckMs ?? FRONT_STUCK_MS;
		this.#log = opts.log ?? nullLog;
	}

	/** How many times it has asked, for tests and the log. */
	get asked(): number {
		return this.#asked;
	}

	/** Whether something needs the check now. Wanted anew, it asks every second again. */
	want(wanted: boolean): void {
		if (this.#disposed) return;
		if (wanted && !this.#wanted) this.#since = this.#clock.now();
		this.#wanted = wanted;
		if (!wanted) {
			this.#since = null;
			if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
			this.#timer = null;
			return;
		}
		this.#schedule();
	}

	/**
	 * Something says the user may look at the app soon (an attach, a detach, a press on the deck, a wake): while wanted,
	 * it asks every second again, the next ask a second after the last, or at once if that has passed.
	 */
	reset(): void {
		if (this.#disposed || !this.#wanted) return;
		this.#since = this.#clock.now();
		if (this.#timer === null) return;
		this.#clock.clearTimeout(this.#timer);
		this.#timer = null;
		this.#schedule();
	}


	dispose(): void {
		this.#disposed = true;
		this.#wanted = false;
		if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
		this.#timer = null;
		if (this.#stuckTimer !== null) this.#clock.clearTimeout(this.#stuckTimer);
		this.#stuckTimer = null;
	}

	#schedule(): void {
		if (this.#disposed || !this.#wanted || this.#timer !== null || this.#inFlight) return;
		const wait = this.#lastAt + frontIntervalMs(this.#clock.now() - (this.#since ?? this.#clock.now())) - this.#clock.now();
		if (wait <= 0) {
			this.#ask();
			return;
		}
		this.#timer = this.#clock.setTimeout(() => {
			this.#timer = null;
			this.#ask();
		}, wait);
	}

	#ask(): void {
		if (this.#disposed || !this.#wanted) return;
		const ask = ++this.#current;
		this.#inFlight = true;
		this.#lastAt = this.#clock.now();
		this.#asked++;
		countIdle("front.ask");
		this.#stuckTimer = this.#clock.setTimeout(() => {
			this.#stuckTimer = null;
			if (ask !== this.#current || !this.#inFlight) return;
			const line = `front app check: no answer in ${this.#stuckMs} ms; given up on, and asked again`;
			if (this.#warnedStuck) this.#log.debug(line);
			else this.#log.warn(line);
			this.#warnedStuck = true;
			this.#current++;
			this.#inFlight = false;
			this.#schedule();
		}, this.#stuckMs);
		let front = false;
		let started: Promise<boolean>;
		try {
			started = this.#check();
		} catch (err) {
			started = Promise.reject(err);
		}
		started
			.then(
				(v) => {
					front = v === true;
				},
				(err: unknown) => this.#log.debug(`front app check threw: ${describeError(err)}`),
			)
			.finally(() => {
				// Given up on (FRONT_STUCK_MS), or disposed: this answer counts for nothing.
				if (ask !== this.#current) return;
				if (this.#stuckTimer !== null) this.#clock.clearTimeout(this.#stuckTimer);
				this.#stuckTimer = null;
				this.#inFlight = false;
				if (this.#disposed) return;
				if (front && this.#wanted) {
					try {
						this.#onFront();
					} catch (err) {
						this.#log.error(`marking sessions seen threw: ${describeError(err)}`);
					}
				}
				this.#schedule();
			});
	}
}
