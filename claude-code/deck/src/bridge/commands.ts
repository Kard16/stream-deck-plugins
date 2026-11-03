import type { CommandWire, Mode } from "../protocol/wire.js";
import { type Clock, realClock, type TimerHandle } from "../util/clock.js";
import { describeError, type Log, nullLog, quote } from "../util/log.js";
import type { Responder } from "./held.js";

/**
 * queued: not yet answered to a poll. delivered: answered to a poll, no result yet. waiting: the mod took a
 * prompt and waits for the engine, for as long as the session's turn lasts. done, refused, failed: final
 * (PROTOCOL.md, Commands).
 */
export type CommandState = "queued" | "delivered" | "waiting" | "done" | "refused" | "failed";

export const FINAL_STATES: ReadonlySet<CommandState> = new Set(["done", "refused", "failed"]);

export type CommandSpec = { t: "prompt"; text: string } | { t: "mode"; mode: Mode };

export type Command = CommandSpec & {
	/** "c1", "c2"… unique within the bridge's run. */
	readonly id: string;
	readonly host: string;
	state: CommandState;
	/** The mod instance it was delivered to. */
	inst: string | null;
	deliveredAt: number | null;
	/** `error` from a refused or failed result, or why the deck gave up on it. */
	error: string | null;
	detail: string | null;
	/** A mode command's PermissionRequest was allowed (kind mode): one allow per command. */
	allowed: boolean;
};

/** A held HTTP request the queue can also be told closed early. */
export interface PollReply extends Responder {
	/** Called once if the client goes away before an answer. */
	onClose(fn: () => void): void;
}

/**
 * The protocol's 60 s (PROTOCOL.md, Commands). A queued command that no poll has taken this long after it was
 * queued counts as failed, with "not delivered": the session's mod isn't polling. A delivered command without a
 * final result counts as failed, with "no result", this long after delivery, unless it's a prompt the mod said
 * it's waiting with: the engine holds a prompt until the session's turn ends, which can take far longer than
 * this. Such a prompt ends with its final result, the mod's restart or the session's end instead, or fails with
 * "no result" once its session has gone this long without an open poll, since a live mod always keeps one open.
 */
export const IN_FLIGHT_MS = 60_000;

/** Finished commands kept for the keys to read, beyond which the oldest finished ones are forgotten. */
const KEEP = 200;

type Poll = { host: string; inst: string | null; reply: PollReply; timer: TimerHandle | null };

/** A session's time without an open poll: since when, and the timer that then fails its waiting prompts. */
type Unpolled = { since: number; timer: TimerHandle | null };

/**
 * The commands the deck queues for sessions when the user presses a key, and the mod's long polls for them.
 * One open poll per session. A queued command waits up to 60 s for a poll to take it; a command answered to a
 * poll is in flight until its final result, or for 60 s without one, a limit a prompt's `waiting` lifts for as
 * long as its session keeps a poll open.
 */
export class CommandQueue {
	readonly #clock: Clock;
	readonly #log: Log;
	readonly #inFlightMs: number;
	readonly #commands = new Map<string, Command>();
	readonly #polls = new Map<string, Poll>();
	readonly #timers = new Map<string, TimerHandle>();
	readonly #unpolled = new Map<string, Unpolled>();
	readonly #listeners = new Set<() => void>();
	#nextId = 1;

	constructor(opts: { clock?: Clock; log?: Log; inFlightMs?: number } = {}) {
		this.#clock = opts.clock ?? realClock;
		this.#log = opts.log ?? nullLog;
		this.#inFlightMs = opts.inFlightMs ?? IN_FLIGHT_MS;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	get(id: string): Command | null {
		return this.#commands.get(id) ?? null;
	}

	list(): Command[] {
		return [...this.#commands.values()];
	}

	/** Whether a poll from `host` is open now. */
	polling(host: string): boolean {
		return this.#polls.get(host)?.reply.open ?? false;
	}

	/** Queues a command for a session and hands it to its open poll, if there is one. */
	queue(host: string, spec: CommandSpec): Command {
		const cmd: Command = { ...spec, id: `c${this.#nextId++}`, host, state: "queued", inst: null, deliveredAt: null, error: null, detail: null, allowed: false };
		this.#commands.set(cmd.id, cmd);
		this.#log.info(`QUEUED ${cmd.id} ${describe(cmd)} for ${host}`);
		this.#prune();
		// Until a poll takes it. That frees a Saved Prompt key waiting on it when the session's mod isn't polling.
		this.#limit(cmd, "not delivered");
		const poll = this.#polls.get(host);
		if (poll) {
			this.#endPoll(poll);
			this.#deliver(poll.reply, host, poll.inst);
		}
		this.#emit();
		return cmd;
	}

	/**
	 * `GET /v1/next`: answers at once with the session's queued commands, oldest first, or holds the request up
	 * to `waitS` seconds until one is queued. A newer poll from the same session answers the older with none.
	 */
	poll(host: string, inst: string | null, waitS: number, reply: PollReply): void {
		const older = this.#polls.get(host);
		if (older) {
			this.#endPoll(older);
			send(older.reply, []);
		}
		if (this.#queuedFor(host).length > 0 || waitS <= 0) {
			this.#deliver(reply, host, inst);
			// Answered at once: the session had a poll just now, and has none open until its next.
			this.#pollEnded(host);
			return;
		}
		const poll: Poll = { host, inst, reply, timer: null };
		poll.timer = this.#clock.setTimeout(() => {
			poll.timer = null;
			if (this.#polls.get(host) !== poll) return;
			this.#endPoll(poll);
			send(reply, []);
		}, waitS * 1000);
		this.#polls.set(host, poll);
		this.#watchPolls(host);
		reply.onClose(() => {
			if (this.#polls.get(host) === poll) this.#endPoll(poll);
		});
	}

	/**
	 * `POST /v1/result`. Returns false when it was ignored: an unknown or finished command, one delivered to
	 * another session or mod instance, or a state the protocol doesn't have.
	 */
	result(host: string, inst: string | null, id: string, state: string | null, error: string | null, detail: string | null): boolean {
		const cmd = this.#commands.get(id);
		const ignore = (why: string): false => {
			this.#log.info(`RESULT ${quote(id, 20)} ${quote(state, 20)} from ${host} ignored: ${why}`);
			return false;
		};
		if (!cmd) return ignore("no such command");
		if (cmd.host !== host) return ignore(`it was for ${cmd.host}`);
		if (FINAL_STATES.has(cmd.state)) return ignore(`it already ended ${cmd.state}`);
		if (cmd.state === "queued") return ignore("it wasn't delivered");
		if (cmd.inst !== null && inst !== null && cmd.inst !== inst) return ignore("it was delivered to another mod instance");
		if (state === "waiting") {
			if (cmd.state === "waiting") return ignore("already waiting");
			cmd.state = "waiting";
			// The mod has the prompt, and the engine sends it when the session's turn ends, however long that
			// takes, so the 60 s no longer applies: the session's polls bound it instead. Mode commands skip
			// waiting; a stray one keeps its 60 s, so the window in which the bridge allows that mode change
			// without a press stays bounded.
			if (cmd.t === "prompt") this.#stopTimer(cmd.id);
		} else if (state === "done" || state === "refused" || state === "failed") {
			cmd.state = state;
			cmd.error = state === "done" ? null : (error ?? "no reason given");
			cmd.detail = detail;
			this.#stopTimer(cmd.id);
		} else return ignore("not a state");
		this.#watchPolls(host);
		this.#log.info(`RESULT ${cmd.id} ${cmd.state}${cmd.error ? `: ${quote(cmd.error, 120)}` : ""}`);
		this.#emit();
		return true;
	}

	/** The session's mode command in flight for `mode` that hasn't had its PermissionRequest allowed yet. */
	inFlightMode(host: string, mode: unknown): Command | null {
		for (const cmd of this.#commands.values()) {
			if (cmd.host !== host || cmd.t !== "mode" || cmd.mode !== mode || cmd.allowed) continue;
			if (cmd.state === "delivered" || cmd.state === "waiting") return cmd;
		}
		return null;
	}

	/**
	 * The mod reported that the main loop's turn ended, with a `turn.end` or `failed`: the session's open poll, if it
	 * has one, is answered with none at once. Claude Code keeps a session `busy` in the registry until a moment after
	 * the turn when the mod has no request open, so a poll held past the turn's end would keep it `busy` for up to
	 * 20 s more (PROTOCOL.md, Commands). The mod then polls again, and the queue holds that poll for the wait it's
	 * given, which the session model makes none while the registry still says `busy` (SessionModel's `next`). A poll
	 * it held because the session model's reading didn't say `busy` yet is answered here too, once the reading does
	 * (SessionModel's `setRegistry`). Returns whether a poll was answered.
	 */
	turnEnded(host: string): boolean {
		const poll = this.#polls.get(host);
		if (!poll) return false;
		const answered = poll.reply.open;
		this.#endPoll(poll);
		send(poll.reply, []);
		return answered;
	}

	/**
	 * The mod restarted, as instance `inst`: its delivered and waiting commands are lost, so they fail, and queued
	 * ones stay queued. A poll the old instance left open is answered with none, so commands queued from now on
	 * wait for the new instance's poll.
	 */
	restarted(host: string, inst: string, why: string): void {
		let any = false;
		for (const cmd of this.#commands.values()) {
			if (cmd.host !== host || (cmd.state !== "delivered" && cmd.state !== "waiting")) continue;
			this.#fail(cmd, why);
			any = true;
		}
		const poll = this.#polls.get(host);
		if (poll && poll.inst !== inst) {
			this.#endPoll(poll);
			send(poll.reply, []);
		}
		this.#watchPolls(host);
		if (any) this.#emit();
	}

	/**
	 * The session ended (release rule 4): nothing can deliver its queued commands or report on its in-flight
	 * ones, so all of them fail, and its open poll is answered with none.
	 */
	failHost(host: string, why: string): void {
		let any = false;
		for (const cmd of this.#commands.values()) {
			if (cmd.host !== host || FINAL_STATES.has(cmd.state)) continue;
			this.#fail(cmd, why);
			any = true;
		}
		const poll = this.#polls.get(host);
		if (poll) {
			this.#endPoll(poll);
			send(poll.reply, []);
		}
		this.#stopUnpolled(host);
		this.#unpolled.delete(host);
		if (any) this.#emit();
	}

	/** Stops every timer. Open polls stay open; the server drops their connections when it stops. */
	dispose(): void {
		for (const poll of this.#polls.values()) if (poll.timer !== null) this.#clock.clearTimeout(poll.timer);
		this.#polls.clear();
		for (const handle of this.#timers.values()) this.#clock.clearTimeout(handle);
		this.#timers.clear();
		for (const host of this.#unpolled.keys()) this.#stopUnpolled(host);
		this.#unpolled.clear();
	}

	#queuedFor(host: string): Command[] {
		return [...this.#commands.values()].filter((c) => c.host === host && c.state === "queued");
	}

	#waitingPrompts(host: string): Command[] {
		return [...this.#commands.values()].filter((c) => c.host === host && c.t === "prompt" && c.state === "waiting");
	}

	/** The session's open poll ended, or one was answered at once: its time without a poll counts from now. */
	#pollEnded(host: string): void {
		this.#stopUnpolled(host);
		this.#unpolled.set(host, { since: this.#clock.now(), timer: null });
		this.#watchPolls(host);
	}

	/**
	 * Arms the session's no-poll limit while it has a waiting prompt and no open poll, and disarms it otherwise.
	 * IN_FLIGHT_MS after its last poll ended, its waiting prompts fail with "no result" (PROTOCOL.md, Commands).
	 */
	#watchPolls(host: string): void {
		if (this.#polls.has(host) || this.#waitingPrompts(host).length === 0) {
			this.#stopUnpolled(host);
			return;
		}
		// A waiting prompt was delivered by a poll that has since ended, so `since` is set; now is only a fallback.
		const unpolled = this.#unpolled.get(host) ?? { since: this.#clock.now(), timer: null };
		this.#unpolled.set(host, unpolled);
		if (unpolled.timer !== null) return;
		unpolled.timer = this.#clock.setTimeout(() => {
			unpolled.timer = null;
			const waiting = this.#polls.has(host) ? [] : this.#waitingPrompts(host);
			if (waiting.length === 0) return;
			this.#log.info(`UNPOLLED ${host}: no open poll for ${this.#inFlightMs / 1000} s, so its waiting prompts fail`);
			for (const cmd of waiting) this.#fail(cmd, "no result");
			this.#emit();
		}, unpolled.since + this.#inFlightMs - this.#clock.now());
	}

	#stopUnpolled(host: string): void {
		const unpolled = this.#unpolled.get(host);
		if (!unpolled || unpolled.timer === null) return;
		this.#clock.clearTimeout(unpolled.timer);
		unpolled.timer = null;
	}

	/** Answers a poll with the session's queued commands. A client that has gone gets nothing, and they stay queued. */
	#deliver(reply: PollReply, host: string, inst: string | null): void {
		if (!reply.open) return;
		const cmds = this.#queuedFor(host);
		const now = this.#clock.now();
		for (const cmd of cmds) {
			cmd.state = "delivered";
			cmd.inst = inst;
			cmd.deliveredAt = now;
			this.#limit(cmd, "no result");
		}
		send(reply, cmds);
		if (cmds.length > 0) {
			this.#log.info(`DELIVERED ${cmds.map((c) => c.id).join(", ")} to ${host}`);
			this.#emit();
		}
	}

	/**
	 * Fails the command with `why` IN_FLIGHT_MS from now, in place of any limit it had. Each step that changes
	 * the limit sets or stops this timer: delivery sets "no result", a prompt's `waiting` stops it, and so does
	 * a final state.
	 */
	#limit(cmd: Command, why: string): void {
		this.#stopTimer(cmd.id);
		this.#timers.set(
			cmd.id,
			this.#clock.setTimeout(() => {
				this.#timers.delete(cmd.id);
				if (FINAL_STATES.has(cmd.state)) return;
				this.#fail(cmd, why);
				this.#emit();
			}, this.#inFlightMs),
		);
	}

	#fail(cmd: Command, why: string): void {
		cmd.state = "failed";
		cmd.error = why;
		this.#stopTimer(cmd.id);
		this.#log.info(`FAILED ${cmd.id} for ${cmd.host}: ${why}`);
	}

	#stopTimer(id: string): void {
		const handle = this.#timers.get(id);
		if (handle !== undefined) this.#clock.clearTimeout(handle);
		this.#timers.delete(id);
	}

	#endPoll(poll: Poll): void {
		if (poll.timer !== null) this.#clock.clearTimeout(poll.timer);
		poll.timer = null;
		if (this.#polls.get(poll.host) !== poll) return;
		this.#polls.delete(poll.host);
		this.#pollEnded(poll.host);
	}

	#prune(): void {
		if (this.#commands.size <= KEEP) return;
		for (const cmd of this.#commands.values()) {
			if (this.#commands.size <= KEEP) break;
			if (FINAL_STATES.has(cmd.state)) this.#commands.delete(cmd.id);
		}
	}

	#emit(): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener();
			} catch (err) {
				this.#log.error(`a listener threw: ${describeError(err)}`);
			}
		}
	}
}

/** A command as the poll answers it. */
export function toWire(cmd: Command): CommandWire {
	return cmd.t === "prompt" ? { id: cmd.id, t: "prompt", text: cmd.text } : { id: cmd.id, t: "mode", mode: cmd.mode };
}

function describe(cmd: Command): string {
	return cmd.t === "prompt" ? `prompt (${cmd.text.length} characters)` : `mode ${cmd.mode}`;
}

function send(reply: PollReply, cmds: Command[]): void {
	if (!reply.open) return;
	reply.send(200, JSON.stringify({ cmds: cmds.map(toWire) }));
}
