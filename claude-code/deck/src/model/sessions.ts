import path from "node:path";

import { type Command, CommandQueue, type CommandSpec, type PollReply } from "../bridge/commands.js";
import { HeldRequests } from "../bridge/held.js";
import type { BridgeRoutes, BridgeState, RouteAnswer } from "../bridge/server.js";
import { fingerprint, summary } from "../protocol/fingerprint.js";
import {
	ALLOW_DECISION,
	ASK_TOOLS,
	asHost,
	isObj,
	MODE_TOOL,
	type ModEvent,
	type ModRef,
	modRef,
	type Obj,
	parseEvent,
	parseHello,
	parsePermission,
	parsePoll,
	parseResult,
	PROTOCOL_VERSION,
} from "../protocol/wire.js";
import type { AppRecord } from "../records/records.js";
import { compareSessions, type RegistrySession } from "../registry/registry.js";
import { type Clock, realClock } from "../util/clock.js";
import { describeError, type Log, nullLog, quote } from "../util/log.js";
import { type SessionStatus, sessionStatus } from "./status.js";

/** One session as the deck shows it. */
export type SessionView = {
	/** What the deck keys the session by: its host, or `pid:<pid>` for a registry file without one. */
	key: string;
	/** The app's `local_…` id; null for a registry file without one. Jumps and commands need it. */
	host: string | null;
	/** The registry file's pid. */
	pid: string | null;
	title: string;
	status: SessionStatus;
	/** The summary of the main loop's latest unfinished tool, from the mod. */
	doing: string | null;
	/** Context use, %, from the mod's latest `measure`. */
	context: number | null;
	model: string | null;
	effort: string | null;
	mode: string | null;
	/** The bridge has heard from the session's mod, so it can take prompts and mode changes. */
	plugin: boolean;
	/** False only for a picked target whose registry file has gone: it has ended. */
	listed: boolean;
};

export type QueueResult = { ok: true; cmd: Command } | { ok: false; why: string };

/** A turn of the main loop. `endedAt` is when the deck got its `turn.end`, by the wall clock; null until then. */
type Turn = { id: string | null; ended: boolean; reason: string | null; failed: boolean; endedAt: number | null };
type RunningTool = { use: string | null; tool: string; summary: string; fp: string | null };

/** What the bridge has heard about one session, from its mod and from its PermissionRequests. */
type BridgeSession = {
	host: string;
	/**
	 * Every Claude Code session id its mod and its PermissionRequests have come with, since one can change during a
	 * session (PROTOCOL.md, Identity): the host fallback places a request by any of them.
	 */
	sids: Set<string>;
	/**
	 * The current mod instance, and every one seen for the session: one seen before never counts as a restart
	 * again. They go with the rest when the session ends.
	 */
	inst: string | null;
	insts: Set<string>;
	/** The last `seq` seen, per instance. */
	lastSeq: Map<string, number>;
	/** The mod has talked to the bridge (any route), so the session has the plugin. */
	mod: boolean;
	cwd: string | null;
	/** The latest from hello, `settings` events and PermissionRequests; each wins over the app's record. */
	settings: { model: string | null; mode: string | null; effort: string | null };
	/** The main loop's last turn. */
	turn: Turn | null;
	/**
	 * Until when, by the monotonic clock, the session's polls are answered at once while the registry says `busy`:
	 * AT_ONCE_MS after the main loop's turn ended. Null before the first turn end and from each main-loop `turn.start`;
	 * a time that has passed stays until then.
	 */
	pollsAtOnceUntil: number | null;
	/** The main loop's unfinished tool calls, oldest first. */
	tools: RunningTool[];
	context: number | null;
	/** Wall-clock ms of the latest `attach`: the session came on screen in the app. */
	onScreenAt: number | null;
};

const NO_HOST: RouteAnswer = { status: 400, body: { error: "unknown session: no host, and the registry doesn't know the sid" } };

/** The longest title kept; the strips and keys cut it further. */
const MAX_TITLE = 120;

/**
 * How long after the main loop's turn ends the session's polls are answered at once, while the registry still says
 * `busy` and no `turn.start` has come (PROTOCOL.md, Commands).
 */
const AT_ONCE_MS = 60_000;

export type SessionModelOptions = {
	log?: Log;
	/** Timers for the long poll and the in-flight limit, and the time since a turn ended for answering polls at once. */
	clock?: Clock;
	/** Wall-clock ms, compared with the registry's `statusUpdatedAt` and the records' `lastFocusedAt`. */
	wallNow?: () => number;
	inFlightMs?: number;
};

/**
 * The deck's session model (PROTOCOL.md, "The deck's session model"). It merges the registry, the app's
 * records and what the bridge hears, keyed by the app's `local_…` id; it's also the bridge's routes. It holds
 * the PermissionRequests, applies the release rules, queues the commands that key presses make, and works
 * out each session's status, settings and context, and the target session for prompts and mode.
 */
export class SessionModel implements BridgeRoutes {
	readonly held: HeldRequests;
	readonly commands: CommandQueue;
	readonly #log: Log;
	readonly #clock: Clock;
	readonly #wallNow: () => number;
	readonly #listeners = new Set<() => void>();
	readonly #bridge = new Map<string, BridgeSession>();
	#registry = new Map<string, RegistrySession>();
	#ordered: RegistrySession[] = [];
	/**
	 * By key, the wall-clock ms of the deck's first reading of each listed session's registry status: the first that
	 * showed it since one showed another, or the session's first. Status rule 3 takes it when `statusUpdatedAt` is
	 * missing.
	 */
	readonly #firstReadings = new Map<string, number>();
	/** Each listed session's status when the model last changed, by key, for the log. */
	#statuses = new Map<string, SessionStatus>();
	#records = new Map<string, AppRecord>();
	#picked: string | null = null;
	/** The picked session's title as last listed, for when it has ended. */
	#pickedTitle: string | null = null;
	#bridgeState: BridgeState = "stopped";

	constructor(opts: SessionModelOptions = {}) {
		this.#log = opts.log ?? nullLog;
		this.#clock = opts.clock ?? realClock;
		this.#wallNow = opts.wallNow ?? Date.now;
		this.held = new HeldRequests({ log: this.#log });
		this.commands = new CommandQueue({ clock: this.#clock, log: this.#log, inFlightMs: opts.inFlightMs });
		this.held.onChange(() => this.#emit());
		this.commands.onChange(() => this.#emit());
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Stops the command queue's timers. */
	dispose(): void {
		this.commands.dispose();
	}

	// ---- sources ----

	get online(): boolean {
		return this.#bridgeState === "listening";
	}

	setBridgeState(state: BridgeState): void {
		if (state === this.#bridgeState) return;
		this.#bridgeState = state;
		this.#emit();
	}

	/**
	 * A new list from the registry. Release rules 2–4 run on what changed: a session leaving `waiting` lets its
	 * only held request go if it came before the change; `idle` with a later `statusUpdatedAt` lets go every
	 * request that came before; a session whose file disappeared has ended. A session whose status changed, or
	 * that's new, has its first reading of that status now. A session whose reading turns `busy` while its polls are
	 * answered at once has the poll it held answered with none.
	 */
	setRegistry(sessions: readonly RegistrySession[]): void {
		const now = this.#wallNow();
		const next = new Map<string, RegistrySession>();
		for (const s of sessions) {
			const key = keyOf(s);
			const other = next.get(key);
			// Two files for one session (a restarted process whose old file lingers): the later start wins.
			if (!other || (s.startedAt ?? 0) > (other.startedAt ?? 0)) next.set(key, s);
		}
		const before = this.#registry;
		this.#registry = next;
		this.#ordered = [...next.values()].sort(compareSessions);
		// Each status's first reading (status rule 3), noted before a release below repaints the deck.
		for (const [key, s] of next) if (before.get(key)?.status !== s.status) this.#firstReadings.set(key, now);
		for (const key of this.#firstReadings.keys()) if (!next.has(key)) this.#firstReadings.delete(key);

		for (const [key, s] of next) {
			const host = asHost(s.hostSessionId);
			if (host === null) continue;
			const old = before.get(key);
			if (old?.status === "waiting" && s.status !== "waiting") {
				const mine = this.held.forHost(host);
				const changedAt = s.statusUpdatedAt ?? now;
				const only = mine.length === 1 ? mine[0] : undefined;
				if (only && only.at < changedAt) this.held.release(only.id, "the registry shows the session no longer waiting (rule 2)");
			}
			if (s.status === "idle") {
				const since = s.statusUpdatedAt ?? (old && old.status !== "idle" ? now : null);
				if (since !== null) for (const h of this.held.forHost(host)) if (h.at < since) this.held.release(h.id, "the registry shows the session idle (rule 3)");
			}
			// The reading has caught up with a busy after the main loop's turn ended. A poll held before it did, after a turn
			// shorter than the time to this scan or while the reading still said waiting after a Deny, keeps Claude Code
			// from turning the session idle, so it's answered with none now, as `next` would have answered it at once.
			if (s.status === "busy" && old?.status !== "busy") {
				const b = this.#bridge.get(host);
				if (b && this.#answersAtOnce(b)) this.#answerPoll(b, "the turn ended and the registry now says busy");
			}
		}
		for (const [key, old] of before) {
			if (next.has(key)) continue;
			const host = asHost(old.hostSessionId);
			if (host !== null) this.#ended(host);
		}
		// Requests that came without a usable host: the registry may know their sid now.
		for (const h of this.held.list()) {
			if (h.host !== null || h.sid === null) continue;
			const host = this.#hostForSid(h.sid);
			if (host !== null) this.held.setHost(h.id, host);
		}
		if (this.#picked !== null) {
			const picked = next.get(this.#picked);
			if (picked) this.#pickedTitle = this.#title(picked);
		}
		this.#emit();
	}

	/** The app's records of the listed sessions, by host. */
	setRecords(records: ReadonlyMap<string, AppRecord>): void {
		this.#records = new Map(records);
		this.#emit();
	}

	/** The hosts the registry lists, whose app records the deck reads. */
	hosts(): string[] {
		return this.#ordered.map((s) => asHost(s.hostSessionId)).filter((h): h is string => h !== null);
	}

	// ---- the bridge's routes ----

	permission(body: unknown, deckHost: string | undefined, reply: PollReply): void {
		const p = parsePermission(body);
		if (!p) {
			this.#log.info("PERMISSION refused: the body isn't a PermissionRequest (no tool_name)");
			reply.send(400, JSON.stringify({ error: "not a PermissionRequest" }));
			return;
		}
		const host = asHost(deckHost) ?? this.#hostForSid(p.sid);
		if (host !== null) {
			const b = this.#bridgeFor(host);
			if (p.sid) b.sids.add(p.sid);
			if (p.mode) b.settings.mode = p.mode;
			if (p.effort) b.settings.effort = p.effort;
		}
		// Kind mode: the deck's own mode change, in flight, raised this. The only answer without a key press.
		if (host !== null && p.tool === MODE_TOOL && isObj(p.input) && p.input.session_id === "self") {
			const cmd = this.commands.inFlightMode(host, p.input.mode);
			if (cmd) {
				cmd.allowed = true;
				reply.send(200, JSON.stringify(ALLOW_DECISION));
				this.#log.info(`ALLOWED the mode change to ${quote(String(p.input.mode), 20)} for ${host}: the deck's own command ${cmd.id}`);
				this.#emit();
				return;
			}
		}
		const held = this.held.hold(
			{
				at: this.#wallNow(),
				host,
				sid: p.sid,
				tool: p.tool,
				kind: ASK_TOOLS.has(p.tool) ? "ask" : "tool",
				summary: summary(p.tool, p.input),
				fp: fingerprintOrNull(p.tool, p.input),
			},
			reply,
		);
		reply.onClose(() => this.held.close(held.id));
	}

	hello(body: Obj): RouteAnswer {
		const h = parseHello(body);
		if (h.v !== PROTOCOL_VERSION) {
			this.#log.warn(`HELLO from ${h.host ?? "an unknown session"} speaks version ${showVersion(h.v)}; the deck speaks ${PROTOCOL_VERSION}`);
			return { status: 200, body: { v: PROTOCOL_VERSION, ok: false, error: "version" } };
		}
		const b = this.#modSession(h);
		if (!b) return NO_HOST;
		if (h.cwd) b.cwd = h.cwd;
		if (h.model) b.settings.model = h.model;
		if (h.mode) b.settings.mode = h.mode;
		if (h.effort) b.settings.effort = h.effort;
		this.#log.info(`HELLO ${b.host} inst ${quote(h.inst, 40)} plugin ${quote(h.plugin, 20)} cc ${quote(h.cc, 20)}`);
		this.#emit();
		return { status: 200, body: { v: PROTOCOL_VERSION, ok: true } };
	}

	events(body: Obj): RouteAnswer {
		const ref = modRef(body);
		const b = this.#modSession(ref);
		if (!b) return NO_HOST;
		const inst = ref.inst ?? "";
		const seq = typeof body.seq === "number" && Number.isFinite(body.seq) ? body.seq : null;
		const last = b.lastSeq.get(inst) ?? 0;
		// A retry, or a request older than one already applied.
		if (seq === null || seq <= last) {
			this.#log.debug(`EVENTS from ${b.host} dropped: seq ${seq ?? "missing"} isn't above ${last}`);
			return { status: 204 };
		}
		b.lastSeq.set(inst, seq);
		const events: unknown[] = Array.isArray(body.events) ? body.events : [];
		for (const raw of events) {
			const e = parseEvent(raw);
			if (!e) continue;
			if (e.t === "tool.start" || e.t === "tool.end") this.#log.debug(`EVENT ${b.host} ${e.t} ${quote(e.tool, 60)} fp ${e.fp ?? "none"}${e.agent ? ` agent ${quote(e.agent, 40)}` : ""}`);
			else this.#log.debug(`EVENT ${b.host} ${e.t}`);
			try {
				this.#apply(b, e);
			} catch (err) {
				this.#log.error(`event ${e.t} from ${b.host} failed: ${describeError(err)}`);
			}
		}
		this.#emit();
		return { status: 204 };
	}

	next(query: URLSearchParams, reply: PollReply): void {
		const q = parsePoll(query);
		const b = this.#modSession(q);
		if (!b) {
			reply.send(NO_HOST.status, JSON.stringify(NO_HOST.body));
			return;
		}
		// From an instance older than the session's newest: answered at once with none, so it neither displaces the
		// newest one's poll nor takes its commands, and doesn't count as the newest one polling.
		if (q.inst !== b.inst) {
			this.#log.debug(`POLL ${b.host} from older mod instance ${quote(q.inst, 40)}: answered with none`);
			reply.send(200, JSON.stringify({ cmds: [] }));
			return;
		}
		if (this.#answersAtOnce(b)) {
			this.#log.debug(`POLL ${b.host} answered at once: the turn ended and the registry still says busy`);
			this.commands.poll(b.host, q.inst, 0, reply);
		} else {
			this.#log.debug(`POLL ${b.host} wait ${q.wait} s`);
			this.commands.poll(b.host, q.inst, q.wait, reply);
		}
		this.#emit();
	}

	result(body: Obj): RouteAnswer {
		const r = parseResult(body);
		const b = this.#modSession(r);
		if (!b) return NO_HOST;
		if (r.id !== null) this.commands.result(b.host, r.inst, r.id, r.state, r.error, r.detail);
		return { status: 204 };
	}

	// ---- views ----

	/** The running sessions, oldest first. */
	sessions(): SessionView[] {
		return this.#ordered.map((s) => this.#view(s));
	}

	/** A listed session by key. */
	session(key: string): SessionView | null {
		const s = this.#registry.get(key);
		return s ? this.#view(s) : null;
	}

	/** A session's title for a held request: the registry's, the record's, the folder's; else "Unknown session". */
	titleFor(host: string | null): string {
		if (host === null) return "Unknown session";
		const s = this.#registry.get(host);
		if (s) return this.#title(s);
		const rec = this.#records.get(host)?.title;
		if (rec) return rec;
		const cwd = this.#bridge.get(host)?.cwd;
		return cwd ? path.basename(cwd) : "Unknown session";
	}

	/**
	 * The session prompts and mode go to: the one last picked on the Sessions dial, even after it has ended
	 * (presses then do nothing but alert, kickoff answer 4); until one is picked, the one most recently on
	 * screen in the app, by its latest `attach` or its record's `lastFocusedAt`, whichever is later.
	 */
	target(): SessionView | null {
		if (this.#picked !== null) {
			const listed = this.session(this.#picked);
			if (listed) return listed;
			return {
				key: this.#picked,
				host: asHost(this.#picked),
				pid: null,
				title: this.#pickedTitle ?? this.#picked,
				status: "idle",
				doing: null,
				context: null,
				model: null,
				effort: null,
				mode: null,
				plugin: false,
				listed: false,
			};
		}
		let best: RegistrySession | null = null;
		let bestAt = -Infinity;
		for (const s of this.#ordered) {
			const host = asHost(s.hostSessionId);
			if (host === null) continue;
			const at = Math.max(this.#bridge.get(host)?.onScreenAt ?? -Infinity, this.#records.get(host)?.lastFocusedAt ?? -Infinity);
			if (at > bestAt) {
				bestAt = at;
				best = s;
			}
		}
		return best ? this.#view(best) : null;
	}

	/** Whether a session was picked on the Sessions dial (rather than the target following the app). */
	get picked(): string | null {
		return this.#picked;
	}

	/** The Sessions dial picked a session: it's the target from now on. */
	pick(key: string): void {
		const s = this.#registry.get(key);
		if (s) this.#pickedTitle = this.#title(s);
		if (this.#picked === key) return;
		this.#picked = key;
		this.#log.info(`TARGET ${key}: picked on the Sessions dial`);
		this.#emit();
	}

	/**
	 * Queues a command that a key press made, for a listed session with the plugin; anything else is refused
	 * with the reason, and the key alerts.
	 */
	queue(key: string, spec: CommandSpec): QueueResult {
		const view = this.session(key);
		if (!view) return { ok: false, why: `${this.#pickedTitle && key === this.#picked ? quote(this.#pickedTitle) : key} has ended` };
		if (view.host === null) return { ok: false, why: `${quote(view.title)} has no app id` };
		if (!view.plugin) return { ok: false, why: `${quote(view.title)} doesn't have the plugin` };
		return { ok: true, cmd: this.commands.queue(view.host, spec) };
	}

	// ---- internals ----

	#apply(b: BridgeSession, e: ModEvent): void {
		switch (e.t) {
			case "turn.start":
				if (e.agent !== null) return;
				b.turn = { id: e.turn, ended: false, reason: null, failed: false, endedAt: null };
				b.tools = [];
				b.pollsAtOnceUntil = null;
				return;
			case "turn.end": {
				if (e.agent !== null) return;
				// A `failed` for this same turn stays: the status says failed, whatever the reason.
				const same = b.turn !== null && (e.turn === null || b.turn.id === null || b.turn.id === e.turn);
				b.turn = { id: e.turn ?? b.turn?.id ?? null, ended: true, reason: e.reason, failed: same && (b.turn?.failed ?? false), endedAt: this.#wallNow() };
				b.tools = [];
				b.pollsAtOnceUntil = this.#clock.now() + AT_ONCE_MS;
				this.#answerPoll(b, "the turn ended");
				return;
			}
			case "failed":
				if (e.agent !== null) return;
				b.turn = { id: b.turn?.id ?? null, ended: true, reason: b.turn?.reason ?? null, failed: true, endedAt: b.turn?.endedAt ?? null };
				b.tools = [];
				this.#log.info(`FAILED turn in ${b.host}${e.error ? `: ${quote(e.error, 120)}` : ""}`);
				b.pollsAtOnceUntil = this.#clock.now() + AT_ONCE_MS;
				this.#answerPoll(b, "the turn failed");
				return;
			case "tool.start":
				if (e.agent !== null) return;
				if (e.use !== null) b.tools = b.tools.filter((t) => t.use !== e.use);
				b.tools.push({ use: e.use, tool: e.tool, summary: e.summary, fp: e.fp });
				return;
			case "tool.end": {
				if (e.agent === null) {
					const i = e.use !== null ? b.tools.findIndex((t) => t.use === e.use) : b.tools.findIndex((t) => t.fp !== null && t.fp === e.fp);
					if (i >= 0) b.tools.splice(i, 1);
				}
				// Rule 1, for the main loop and subagents alike: the call a held request was for has ended.
				if (e.fp !== null) {
					const match = this.held.forHost(b.host).find((h) => h.fp === e.fp);
					if (match) this.held.release(match.id, `the session reported the call's end (rule 1, fp ${e.fp})`);
				}
				return;
			}
			case "measure":
				// The latest measure's, which has none until the engine has a response to count: a fresh session,
				// or one just compacted, whose old figure no longer holds.
				b.context = e.percent;
				return;
			case "settings":
				if (e.model) b.settings.model = e.model;
				if (e.mode) b.settings.mode = e.mode;
				if (e.effort) b.settings.effort = e.effort;
				return;
			case "attach":
				b.onScreenAt = this.#wallNow();
				return;
			case "detach":
				return;
			case "end":
				this.#log.info(`END ${b.host}: ${quote(e.reason, 60)}`);
				return;
		}
	}

	/**
	 * The main loop's turn ended, or the deck's reading of the registry turned `busy` after it did: the session's open
	 * poll, if it has one, is answered with none at once, since Claude Code keeps the session `busy` in the registry
	 * until a moment after the turn when the mod has no request open (PROTOCOL.md, Commands).
	 */
	#answerPoll(b: BridgeSession, why: string): void {
		if (this.commands.turnEnded(b.host)) this.#log.debug(`POLL ${b.host} answered with none: ${why}`);
	}

	/**
	 * Whether the session's poll is answered at once, with its queued commands or none: the main loop's turn ended
	 * less than AT_ONCE_MS ago, no main-loop `turn.start` has come since, and the registry still says `busy`. A poll
	 * held then would keep the session `busy` until it ran out, since Claude Code waits for a moment after the turn
	 * when the mod has no request open; the mod waits out the rest of a second after an early empty answer, which
	 * gives it that moment (PROTOCOL.md, Commands). The deck reads the registry once a second, so after a turn shorter
	 * than that, or while its reading still says `waiting` after a Deny, a poll can come before the reading says
	 * `busy`: it's held, and answered with none once the reading does (`setRegistry`).
	 */
	#answersAtOnce(b: BridgeSession): boolean {
		return b.pollsAtOnceUntil !== null && this.#clock.now() < b.pollsAtOnceUntil && this.#registry.get(b.host)?.status === "busy";
	}

	/**
	 * The session of a mod request, by its host or else its sid. An `inst` not seen before means the mod
	 * restarted: the session's current tool and in-flight commands are forgotten, and a poll the old instance
	 * left open is answered with none.
	 */
	#modSession(ref: ModRef): BridgeSession | null {
		const host = ref.host ?? this.#hostForSid(ref.sid);
		if (host === null) return null;
		const b = this.#bridgeFor(host);
		if (ref.sid) b.sids.add(ref.sid);
		b.mod = true;
		if (ref.inst !== null && !b.insts.has(ref.inst)) {
			if (b.inst !== null) {
				this.#log.info(`RESTART ${host}: mod instance ${quote(ref.inst, 40)} replaces ${quote(b.inst, 40)}; its current tool and in-flight commands are forgotten, and any poll the old one left open is answered`);
				b.tools = [];
				this.commands.restarted(host, ref.inst, "the mod restarted");
			}
			b.insts.add(ref.inst);
			b.inst = ref.inst;
		}
		return b;
	}

	#bridgeFor(host: string): BridgeSession {
		let b = this.#bridge.get(host);
		if (!b) {
			b = {
				host,
				sids: new Set(),
				inst: null,
				insts: new Set(),
				lastSeq: new Map(),
				mod: false,
				cwd: null,
				settings: { model: null, mode: null, effort: null },
				turn: null,
				pollsAtOnceUntil: null,
				tools: [],
				context: null,
				onScreenAt: null,
			};
			this.#bridge.set(host, b);
		}
		return b;
	}

	/** The registry's host for a Claude Code session id, else the one a mod request or PermissionRequest named with it. */
	#hostForSid(sid: string | null): string | null {
		if (sid === null) return null;
		for (const s of this.#ordered) if (s.sessionId === sid) return asHost(s.hostSessionId);
		for (const b of this.#bridge.values()) if (b.sids.has(sid)) return b.host;
		return null;
	}

	/** Release rule 4: the registry file disappeared, so the session has ended. */
	#ended(host: string): void {
		for (const h of this.held.forHost(host)) this.held.release(h.id, "the session's registry file disappeared (rule 4)");
		this.commands.failHost(host, "the session ended");
		this.#bridge.delete(host);
		this.#log.info(`ENDED ${host}: its registry file disappeared`);
	}

	#view(s: RegistrySession): SessionView {
		const host = asHost(s.hostSessionId);
		const b = host === null ? undefined : this.#bridge.get(host);
		const rec = host === null ? undefined : this.#records.get(host);
		const held = host === null ? [] : this.held.forHost(host);
		return {
			key: keyOf(s),
			host,
			pid: s.key,
			title: this.#title(s),
			status: sessionStatus({
				heldTool: held.filter((h) => h.kind === "tool").length,
				heldAsk: held.filter((h) => h.kind === "ask").length,
				registry: s.status,
				statusUpdatedAt: s.statusUpdatedAt,
				firstReadingAt: this.#firstReadings.get(keyOf(s)) ?? null,
				turn: b?.turn ?? null,
				recordCategory: rec?.turnCategory ?? null,
			}),
			doing: b?.tools.at(-1)?.summary ?? null,
			context: b?.context ?? null,
			model: b?.settings.model ?? rec?.model ?? null,
			effort: b?.settings.effort ?? rec?.effort ?? null,
			mode: b?.settings.mode ?? rec?.permissionMode ?? null,
			plugin: b?.mod ?? false,
			listed: true,
		};
	}

	/** The sidebar title; else the app's record's; else the folder's name; else the pid. */
	#title(s: RegistrySession): string {
		const name = s.name?.trim();
		if (name) return name.length > MAX_TITLE ? `${name.slice(0, MAX_TITLE)}…` : name;
		const host = asHost(s.hostSessionId);
		const rec = host === null ? null : (this.#records.get(host)?.title ?? null);
		if (rec) return rec;
		const cwd = s.cwd ?? (host === null ? null : (this.#bridge.get(host)?.cwd ?? null));
		const folder = cwd ? path.basename(cwd) : "";
		return folder !== "" ? folder : `Session ${s.key}`;
	}

	/** Each listed session's status when it changes, at debug, so a hardware test can time it from the log. */
	#logStatuses(): void {
		const statuses = new Map<string, SessionStatus>();
		for (const { key, status } of this.sessions()) {
			const was = this.#statuses.get(key);
			if (status !== was) this.#log.debug(`STATUS ${key} ${was === undefined ? "" : `${was} `}→ ${status}`);
			statuses.set(key, status);
		}
		this.#statuses = statuses;
	}

	#emit(): void {
		// Only a log line: a throw here mustn't escape into a hold, a release or a route.
		try {
			this.#logStatuses();
		} catch (err) {
			this.#log.error(`logging statuses threw: ${describeError(err)}`);
		}
		for (const listener of [...this.#listeners]) {
			try {
				listener();
			} catch (err) {
				this.#log.error(`a listener threw: ${describeError(err)}`);
			}
		}
	}
}

/** The deck keys sessions by host; a registry file without one by its pid. */
export function keyOf(s: RegistrySession): string {
	return asHost(s.hostSessionId) ?? `pid:${s.key}`;
}

/**
 * A hello's `v` for the log: a string, number, boolean or null as JSON, quoted and cut; an object or array only by
 * its kind, since writing out one nested deeply enough would overflow the stack, and the hello would get 500.
 */
function showVersion(v: unknown): string {
	if (Array.isArray(v)) return "an array";
	if (typeof v === "object" && v !== null) return "an object";
	return quote(JSON.stringify(v) ?? "none", 20);
}

/**
 * A PermissionRequest's fingerprint, or null when its `tool_input` is nested too deeply to write out: canonical()
 * recurses, and the stack runs out first. The bridge still holds such a request, without one, so the key can
 * answer it and rules 2–5 release it; only rule 1 can't.
 */
function fingerprintOrNull(tool: string, input: unknown): string | null {
	try {
		return fingerprint(tool, input);
	} catch (err) {
		if (err instanceof RangeError) return null;
		throw err;
	}
}
