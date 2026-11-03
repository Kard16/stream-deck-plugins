import path from "node:path";

import { type Command, CommandQueue, type CommandSpec, IN_FLIGHT_MS, type PollReply } from "../bridge/commands.js";
import { HeldRequests } from "../bridge/held.js";
import type { BridgeRoutes, BridgeState, RouteAnswer } from "../bridge/server.js";
import { fingerprint, summary } from "../protocol/fingerprint.js";
import {
	ALLOW_DECISION,
	ASK_TOOLS,
	asHost,
	type Hello,
	type HookRequest,
	isObj,
	MODE_TOOL,
	type ModEvent,
	type ModRef,
	modRef,
	NO_DECISION,
	type Obj,
	parseEvent,
	parseHello,
	parseHook,
	parsePermission,
	parsePoll,
	parseResult,
	type PermissionRequest,
	PRETOOL_ALLOW,
	PROTOCOL_VERSION,
	ROUTES,
} from "../protocol/wire.js";
import type { AppRecord } from "../records/records.js";
import { compareSessions, type RegistrySession } from "../registry/registry.js";
import { type Clock, realClock } from "../util/clock.js";
import { describeError, type Log, nullLog, quote } from "../util/log.js";
import { QuietLog } from "../util/quiet-log.js";
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
	/** The session's mod has said hello, so it has a current instance to take prompts and mode changes. */
	plugin: boolean;
	/** False only for a picked target whose registry file has gone: it has ended. */
	listed: boolean;
};

export type QueueResult = { ok: true; cmd: Command } | { ok: false; why: string };

/**
 * A turn of the main loop. `startedAt` is when the deck got its `turn.start`, and `endedAt` its `turn.end`, by the
 * wall clock: `endedAt` null until then, and `startedAt` null for a turn whose start the deck didn't get.
 */
type Turn = { id: string | null; ended: boolean; reason: string | null; failed: boolean; startedAt: number | null; endedAt: number | null };
type RunningTool = { use: string | null; tool: string; summary: string; fp: string | null };

/** What the bridge has heard about one session, from its mod and from its PermissionRequests. */
type BridgeSession = {
	host: string;
	/**
	 * Every Claude Code session id its mod has come with, since one can change during a session (PROTOCOL.md,
	 * Identity): the host fallback places a mod request without a usable host by any of them.
	 */
	sids: Set<string>;
	/**
	 * The current mod instance: the last to say hello that hadn't before. Null until one does, and only a hello
	 * makes one current (PROTOCOL.md, Identity). Only its polls are held and get commands. While it's null, every
	 * poll for the session gets 409 `hello first` (#noHello). It goes back to null when the session ends, and when
	 * it has gone IN_FLIGHT_MS with no poll open and none sent (#unpolled).
	 */
	inst: string | null;
	/**
	 * The instances that have said hello for the session, oldest first, the last HELLOS_KEPT of them: a hello from
	 * one of these never counts as a restart again. Empty whenever no instance is current: they go with the rest
	 * when the session ends, and alone when the current one stops polling (#unpolled).
	 */
	hellos: Set<string>;
	/**
	 * The instance that was current until it went IN_FLIGHT_MS with no poll open and none sent (#unpolled); null
	 * once a hello makes an instance current again. A press says so while it's set.
	 */
	unpolled: string | null;
	/**
	 * The mod instance whose poll, events or result came last while no instance was current ("" for one without an
	 * inst), or null if none has: read only while none is, when it means the session's mod is there, and has been
	 * asked for a hello, but takes no commands until it says one. See #noHello.
	 */
	noHelloFrom: string | null;
	/** The last `seq` seen, per instance. */
	lastSeq: Map<string, number>;
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

/** A hello from a host the registry lists under another session id (PROTOCOL.md, Desktop sessions only). */
const NOT_THIS_SESSION = { error: "not this session" };

/** A poll for a session no instance has said hello for: the deck asks for one (PROTOCOL.md, Identity). */
const HELLO_FIRST = { error: "hello first" };

/** How many of a session's instances that said hello the deck remembers. The protocol asks for at least 8. */
export const HELLOS_KEPT = 64;

/** The longest title kept; the strips and keys cut it further. */
const MAX_TITLE = 120;

/**
 * How long after the main loop's turn ends the session's polls are answered at once, while the registry still says
 * `busy` and no `turn.start` has come (PROTOCOL.md, Commands).
 */
const AT_ONCE_MS = 60_000;

/**
 * How the registry's latest reading lists a host: with the given session id among its files'; with other session
 * ids only; or not at all, which includes files that name no session id.
 */
type Listing = "this" | "other" | "none";

export type SessionModelOptions = {
	log?: Log;
	/**
	 * Timers for the long poll and the in-flight limit, the time since a turn ended for answering polls at once, and
	 * the quiet logging of refused requests.
	 */
	clock?: Clock;
	/** Wall-clock ms, compared with the registry's `statusUpdatedAt` and the records' `lastFocusedAt`. */
	wallNow?: () => number;
	/**
	 * The protocol's 60 s (IN_FLIGHT_MS), shorter in tests: the command queue's limits, and how long the current
	 * mod instance may go with no poll open and none sent before it stops counting (PROTOCOL.md, Identity).
	 */
	inFlightMs?: number;
	/**
	 * Reads the registry again now, rather than at its next scan, and resolves once setRegistry has had any change
	 * (the watcher's scanNow). A hook's request or a hello the latest reading doesn't confirm waits for that one more
	 * reading (PROTOCOL.md, Desktop sessions only). Without it, the latest reading is all there is.
	 */
	rescan?: () => Promise<void>;
};

/**
 * The deck's session model (PROTOCOL.md, "The deck's session model"). It merges the registry, the app's
 * records and what the bridge hears, keyed by the app's `local_…` id; it's also the bridge's routes. It holds
 * the PermissionRequests, answers the mode checks, applies the release rules, queues the commands that key
 * presses make, and works out each session's status, settings and context, and the target session for prompts
 * and mode. It lists only the sessions the registry lists, and takes the hooks' requests only from those
 * (PROTOCOL.md, Desktop sessions only).
 */
export class SessionModel implements BridgeRoutes {
	readonly held: HeldRequests;
	readonly commands: CommandQueue;
	readonly #log: Log;
	readonly #clock: Clock;
	readonly #wallNow: () => number;
	readonly #inFlightMs: number;
	readonly #rescan: (() => Promise<void>) | null;
	/** Refused hellos and unconfirmed hook requests, keyed by route and reason (Phase 6's quiet logs). */
	readonly #refusals: QuietLog;
	/** The 409s that ask a listed session's mod for a hello, keyed by host: see #noHello. */
	readonly #noHellos: QuietLog;
	readonly #listeners = new Set<() => void>();
	readonly #bridge = new Map<string, BridgeSession>();
	#registry = new Map<string, RegistrySession>();
	#ordered: RegistrySession[] = [];
	/**
	 * By host, the session ids the registry's files list it with, every file counted, a lingering one of a restarted
	 * process included: what confirms a hook's request or a hello (PROTOCOL.md, Desktop sessions only).
	 */
	#listed = new Map<string, Set<string>>();
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
		this.#rescan = opts.rescan ?? null;
		this.#refusals = new QuietLog(this.#log, { clock: this.#clock });
		this.#noHellos = new QuietLog(this.#log, { clock: this.#clock });
		this.held = new HeldRequests({ log: this.#log });
		this.commands = new CommandQueue({ clock: this.#clock, log: this.#log, inFlightMs: opts.inFlightMs });
		this.#inFlightMs = opts.inFlightMs ?? IN_FLIGHT_MS;
		this.held.onChange(() => this.#emit());
		this.commands.onChange(() => this.#emit());
		this.commands.onUnpolled((host) => this.#unpolled(host));
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
	 * A new list from the registry. Two files for one host, as for a moment when a session's process restarts: the
	 * one with the later `startedAt` is shown, and either confirms its session id. Release rules 2–4 run on what
	 * changed: a session leaving `waiting` lets its only held request go if it came before the change; `idle` with
	 * a later `statusUpdatedAt` lets go every request that came before; a session no file lists any more has ended.
	 * A session whose status changed, or that's new, has its first reading of that status now. A session whose
	 * reading turns `busy` while its polls are answered at once has the poll it held answered with none. A reading
	 * that couldn't list the folder never gets here: the reader gives the last one again (RegistryReader's `scan`).
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
		this.#listed = new Map();
		for (const s of sessions) {
			const host = asHost(s.hostSessionId);
			if (host === null) continue;
			const sids = this.#listed.get(host) ?? new Set<string>();
			if (s.sessionId !== null) sids.add(s.sessionId);
			this.#listed.set(host, sids);
		}
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

	/**
	 * `POST /v1/permission`, from a confirmed session only: the deck's own mode change in flight is allowed at once
	 * (kind mode), and anything else is held. A request from any other process gets no decision at once.
	 */
	permission(body: unknown, deckHost: string | undefined, reply: PollReply): void | Promise<void> {
		// When it arrived, for release rules 2 and 3, before any second reading of the registry.
		const at = this.#wallNow();
		const p = parsePermission(body);
		if (!p) {
			this.#log.info("PERMISSION refused: the body isn't a PermissionRequest (no tool_name)");
			reply.send(400, JSON.stringify({ error: "not a PermissionRequest" }));
			return;
		}
		return this.#fromConfirmed(ROUTES.permission, deckHost, p.sid, reply, (host) => this.#takePermission(p, host, at, reply));
	}

	/**
	 * `POST /v1/pretool`, the mode check: answered at once and never held. Allowed only for the deck's own mode
	 * change in flight, from a confirmed session; anything else gets no decision (PROTOCOL.md, Mode checks).
	 */
	pretool(body: unknown, deckHost: string | undefined, reply: PollReply): void | Promise<void> {
		const p = parseHook(body);
		if (!p) {
			this.#log.debug("PRETOOL: no decision: the body isn't a PreToolUse (no tool_name)");
			reply.send(200, JSON.stringify(NO_DECISION));
			return;
		}
		return this.#fromConfirmed(ROUTES.pretool, deckHost, p.sid, reply, (host) => this.#checkMode(p, host, reply));
	}

	/**
	 * `POST /v1/hello`. Refused with 409 when the registry lists its host under another session id; taken
	 * otherwise, from a host the registry doesn't list yet included, as from one of the app's spare processes
	 * (PROTOCOL.md, Desktop sessions only). When the latest reading doesn't list the host with the hello's session
	 * id, the registry is read once more first.
	 */
	hello(body: Obj): RouteAnswer | Promise<RouteAnswer> {
		const h = parseHello(body);
		if (h.v !== PROTOCOL_VERSION) {
			this.#log.warn(`HELLO from ${h.host ?? "an unknown session"} speaks version ${showVersion(h.v)}; the deck speaks ${PROTOCOL_VERSION}`);
			return { status: 200, body: { v: PROTOCOL_VERSION, ok: false, error: "version" } };
		}
		const host = h.host ?? this.#hostForSid(h.sid);
		if (host === null) return NO_HOST;
		if (this.#rescan === null || this.#listing(host, h.sid) === "this") return this.#greet(h, host);
		return this.#readAgain().then(() => this.#greet(h, host));
	}

	events(body: Obj): RouteAnswer {
		const ref = modRef(body);
		const b = this.#modSession(ref);
		if (!b) return NO_HOST;
		this.#noHello(b, ref.inst, "sends events");
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
		const current = b.inst;
		// No instance is current, so none takes commands: whatever the poll's inst, a missing one included, the deck
		// asks for a hello, which makes the mod's instance current (#noHello).
		if (current === null) {
			reply.send(409, JSON.stringify(HELLO_FIRST));
			this.#noHello(b, q.inst, "polls");
			return;
		}
		// From an instance that isn't the session's current one, replaced since or never said hello to this deck:
		// answered at once with none, so it neither displaces the current one's poll nor takes its commands, and
		// doesn't count as the session's mod polling (PROTOCOL.md, Identity).
		if (q.inst !== current) {
			this.#log.debug(`POLL ${b.host} from mod instance ${quote(q.inst, 40)}, not the current one: answered with none`);
			reply.send(200, JSON.stringify({ cmds: [] }));
			return;
		}
		if (this.#answersAtOnce(b)) {
			this.#log.debug(`POLL ${b.host} answered at once: the turn ended and the registry still says busy`);
			this.commands.poll(b.host, current, 0, reply);
		} else {
			this.#log.debug(`POLL ${b.host} wait ${q.wait} s`);
			this.commands.poll(b.host, current, q.wait, reply);
		}
		this.#emit();
	}

	result(body: Obj): RouteAnswer {
		const r = parseResult(body);
		const b = this.#modSession(r);
		if (!b) return NO_HOST;
		this.#noHello(b, r.inst, "sends a result");
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
	titleFor(host: string): string {
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
		if (!view.plugin) {
			const b = this.#bridge.get(view.host);
			// Its current instance stopped polling, so none is current until a hello, which its mod's next poll asks for.
			if ((b?.unpolled ?? null) !== null) return { ok: false, why: `${quote(view.title)}'s mod has had no poll open for ${this.#inFlightMs / 1000} s, so it can't take commands until it says hello again` };
			// Its mod talks, but hasn't said hello to this deck yet: it has the plugin, and can't take commands until its
			// hello, which its next poll asks for (#noHello).
			const talking = (b?.noHelloFrom ?? null) !== null;
			return { ok: false, why: talking ? `${quote(view.title)}'s mod hasn't said hello to this deck, so it can't take commands until it does` : `${quote(view.title)} doesn't have the plugin` };
		}
		return { ok: true, cmd: this.commands.queue(view.host, spec) };
	}

	// ---- internals ----

	#apply(b: BridgeSession, e: ModEvent): void {
		switch (e.t) {
			case "turn.start":
				if (e.agent !== null) return;
				// When the deck got it, on its wall clock: status rule 3 compares it with when the registry's idle began.
				b.turn = { id: e.turn, ended: false, reason: null, failed: false, startedAt: this.#wallNow(), endedAt: null };
				b.tools = [];
				b.pollsAtOnceUntil = null;
				return;
			case "turn.end": {
				if (e.agent !== null) return;
				// A `failed` for this same turn stays: the status says failed, whatever the reason.
				const same = b.turn !== null && (e.turn === null || b.turn.id === null || b.turn.id === e.turn);
				b.turn = { id: e.turn ?? b.turn?.id ?? null, ended: true, reason: e.reason, failed: same && (b.turn?.failed ?? false), startedAt: same ? (b.turn?.startedAt ?? null) : null, endedAt: this.#wallNow() };
				b.tools = [];
				b.pollsAtOnceUntil = this.#clock.now() + AT_ONCE_MS;
				this.#answerPoll(b, "the turn ended");
				return;
			}
			case "failed":
				if (e.agent !== null) return;
				b.turn = { id: b.turn?.id ?? null, ended: true, reason: b.turn?.reason ?? null, failed: true, startedAt: b.turn?.startedAt ?? null, endedAt: b.turn?.endedAt ?? null };
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
	 * The session of a mod request, by its host or else its sid: the registry's, then the pairs mods have sent. It
	 * doesn't touch which instance is current: only a hello does that (#greet).
	 */
	#modSession(ref: ModRef): BridgeSession | null {
		const host = ref.host ?? this.#hostForSid(ref.sid);
		if (host === null) return null;
		const b = this.#bridgeFor(host);
		if (ref.sid) b.sids.add(ref.sid);
		return b;
	}

	/**
	 * A mod request for a session with no current instance: none has said hello since the deck started, since
	 * release rule 4 forgot the session after a registry reading that missed it, or since the current one went
	 * IN_FLIGHT_MS without a poll (#unpolled), as a restarted process's predecessor does. Its mod is there all the
	 * same, and nothing it sent need have failed: between a poll answered within a second and its next, as after
	 * every turn's end, the mod waits out the rest of that second with nothing open, so a deck that restarts then
	 * fails none of its requests, and nor does a reading that misses the session. So the deck asks for a hello: it
	 * answers each of the session's polls at once with 409 `hello first` (`next`), which the mod takes as a fetch
	 * that rejected, with a quiet hello about 100 ms later (PROTOCOL.md, Identity; Failure and recovery). The 409
	 * goes only to a session with no current instance, so it never displaces one. The session's events and results
	 * are still taken, and until a hello makes an instance current, a press on it is refused, saying why.
	 *
	 * The log says the deck asked: a poll's 409 at info the first time, then at most once in 10 minutes with the
	 * count since, and the rest at debug; afresh once a hello makes an instance current, or the session ends. Events
	 * and results go only at debug, and so does everything from a session the registry doesn't list, which takes no
	 * presses: one that's ending, say, whose mod polled again once the deck answered its poll at release rule 4.
	 */
	#noHello(b: BridgeSession, inst: string | null, sends: "polls" | "sends events" | "sends a result"): void {
		if (b.inst !== null) return;
		b.noHelloFrom = inst ?? "";
		const what = `${b.host}: mod instance ${quote(inst, 40)} ${sends}, but no instance has said hello to this deck for the session`;
		if (sends !== "polls") this.#log.debug(`NO HELLO ${what}; taken all the same`);
		else if (!this.#registry.has(b.host)) this.#log.debug(`HELLO FIRST ${what}, so the deck answers 409 to ask for one; the registry doesn't list it`);
		else this.#noHellos.note(b.host, `HELLO FIRST ${what}, so the deck answers 409 to ask for one`);
	}

	/**
	 * A hello, once the registry has been read again if need be: refused with 409 when the registry lists its host
	 * under another session id, as for a `claude` started inside that session, and taken otherwise, from a host the
	 * registry doesn't list yet included. The session then stays unlisted until the registry lists it, since
	 * `sessions()` lists only the registry's.
	 */
	#greet(h: Hello, host: string): RouteAnswer {
		if (this.#listing(host, h.sid) === "other") {
			this.#refusals.note(
				`${ROUTES.hello} not this session`,
				`HELLO refused with 409 for ${host} inst ${quote(h.inst, 40)} sid ${quote(h.sid, 40)}: the registry lists that host under another session id`,
			);
			return { status: 409, body: NOT_THIS_SESSION, logged: true };
		}
		const b = this.#bridgeFor(host);
		if (h.sid) b.sids.add(h.sid);
		const current = this.#makeCurrent(b, h.inst);
		if (current === null) {
			// Its events and results are still taken, but its hello's settings may be stale, and its polls get none.
			this.#log.info(`HELLO ${b.host} inst ${quote(h.inst, 40)}, which ${h.inst === null ? "has no inst" : "said hello before"}: taken, but not the current instance, which stays ${quote(b.inst, 40)}`);
			return { status: 200, body: { v: PROTOCOL_VERSION, ok: true } };
		}
		if (h.cwd) b.cwd = h.cwd;
		if (h.model) b.settings.model = h.model;
		if (current === "again") {
			// The current instance's hello, said again, as after every rejected fetch (each Deny, each Esc): its mode and
			// effort are what the mod has already sent or queued as `settings`, while the deck may since have taken a
			// newer one from a PermissionRequest, so they stay the deck's (PROTOCOL.md, Identity). Normal use: debug.
			this.#log.debug(`HELLO ${b.host} inst ${quote(h.inst, 40)} again: its cwd and model taken, its mode and effort not`);
		} else {
			if (h.mode) b.settings.mode = h.mode;
			if (h.effort) b.settings.effort = h.effort;
			this.#log.info(`HELLO ${b.host} inst ${quote(h.inst, 40)} plugin ${quote(h.plugin, 20)} cc ${quote(h.cc, 20)}${this.#listing(host, h.sid) === "none" ? "; the registry doesn't list it yet" : ""}`);
		}
		this.#emit();
		return { status: 200, body: { v: PROTOCOL_VERSION, ok: true } };
	}

	/**
	 * Makes a hello's instance the session's current one, unless it has said hello before: "new" when it's made
	 * current now, "again" when it was already, null when it isn't. A new instance replacing another means the mod
	 * restarted: the session's current tool and in-flight commands are forgotten, and a poll the old instance left
	 * open is answered with none (PROTOCOL.md, Identity). An instance made current, by its first hello or a restart,
	 * has its time without a poll counted from now (CommandQueue's `watch`); a hello said again doesn't reset it.
	 */
	#makeCurrent(b: BridgeSession, inst: string | null): "new" | "again" | null {
		if (inst === null) return null;
		if (inst === b.inst) return "again";
		if (b.hellos.has(inst)) return null;
		if (b.inst !== null) {
			this.#log.info(`RESTART ${b.host}: mod instance ${quote(inst, 40)} replaces ${quote(b.inst, 40)}; its current tool and in-flight commands are forgotten, and any poll the old one left open is answered`);
			b.tools = [];
			this.commands.restarted(b.host, inst, "the mod restarted");
		}
		b.inst = inst;
		b.hellos.add(inst);
		b.unpolled = null;
		// A mod the deck asked for a hello (#noHello) has said one: should that happen again, its first 409 goes at info.
		this.#noHellos.forget(b.host);
		for (const old of b.hellos) {
			if (b.hellos.size <= HELLOS_KEPT) break;
			b.hellos.delete(old);
		}
		this.commands.watch(b.host);
		return "new";
	}

	/**
	 * The session's current instance has gone IN_FLIGHT_MS with no poll open and none sent, so it stops counting
	 * (PROTOCOL.md, Identity), at the moment the command queue fails the session's waiting prompts. The deck forgets
	 * which instances said hello for the session, so none is current and the hellos are empty, as after release
	 * rule 4, and keeps the rest: settings, held requests, queued and in-flight commands, and seqs. A press on the
	 * session then alerts, its mod's next poll gets 409 `hello first` (#noHello), and that mod's hello makes its
	 * instance current, which isn't a restart, since none was. Without this, the predecessor of a restarted process
	 * whose hello landed last after a deck restart would stay current for good, and the live mod's polls would be
	 * answered at once with none.
	 *
	 * One line at info; at debug for a session the registry doesn't list, which takes no presses, such as a spare
	 * process that went before it was claimed.
	 */
	#unpolled(host: string): void {
		const b = this.#bridge.get(host);
		if (!b || b.inst === null) return;
		const was = b.inst;
		b.inst = null;
		b.hellos.clear();
		b.unpolled = was;
		const line = `UNPOLLED ${host}: mod instance ${quote(was, 40)} has had no poll open for ${this.#inFlightMs / 1000} s, so it's no longer the current one, and the deck forgets which instances said hello; the mod's next poll gets 409 to ask for one`;
		if (this.#registry.has(host)) this.#log.info(line);
		else this.#log.debug(line);
		this.#emit();
	}

	/**
	 * Runs `take` for a hook's request from a confirmed session: one the registry lists under the request's
	 * `X-Deck-Host`, with a `sessionId` equal to its `session_id`. When the latest reading doesn't show that, the
	 * registry is read once more first. A request still not confirmed gets no decision at once, and nothing else
	 * comes of it: nothing held, no settings taken (PROTOCOL.md, Desktop sessions only). Returns a promise only
	 * when it reads the registry again.
	 */
	#fromConfirmed(route: string, deckHost: string | undefined, sid: string | null, reply: PollReply, take: (host: string) => void): void | Promise<void> {
		const host = asHost(deckHost);
		if (host !== null && this.#listing(host, sid) === "this") {
			take(host);
			return;
		}
		// Without a host or a session id to look for, another reading can't confirm it.
		if (host === null || sid === null || this.#rescan === null) {
			this.#unconfirmed(route, host, sid, reply);
			return;
		}
		return this.#readAgain().then(() => {
			// The client may have gone while the registry was read: then there's nothing to answer or hold.
			if (!reply.open) return;
			if (this.#listing(host, sid) === "this") take(host);
			else this.#unconfirmed(route, host, sid, reply);
		});
	}

	/** A hook's request from a session the registry doesn't confirm: no decision, at once, logged quietly. */
	#unconfirmed(route: string, host: string | null, sid: string | null, reply: PollReply): void {
		reply.send(200, JSON.stringify(NO_DECISION));
		const [reason, why] =
			host === null
				? ["no host", "no X-Deck-Host that's an app id"]
				: sid === null
					? ["no session id", "no session_id"]
					: this.#listing(host, sid) === "other"
						? ["another session", "the registry lists that host under another session id"]
						: ["not listed", "the registry doesn't list that host"];
		this.#refusals.note(`${route} ${reason}`, `UNCONFIRMED ${route} from ${host ?? "no host"} sid ${quote(sid, 40)}: ${why}, so no decision`);
	}

	/** How the registry's latest reading lists `host`: with `sid`, with other session ids only, or not at all. */
	#listing(host: string, sid: string | null): Listing {
		const sids = this.#listed.get(host);
		if (!sids || sids.size === 0) return "none";
		return sid !== null && sids.has(sid) ? "this" : "other";
	}

	/** Reads the registry once more, through `rescan`; a failure leaves the latest reading as it is. */
	async #readAgain(): Promise<void> {
		if (this.#rescan === null) return;
		try {
			await this.#rescan();
		} catch (err) {
			this.#log.warn(`reading the registry again failed: ${describeError(err)}`);
		}
	}

	/**
	 * A PermissionRequest from a confirmed session. Its settings are the session's. Kind mode, the deck's own mode
	 * change in flight, is allowed at once, once per command; anything else is held (PROTOCOL.md, Permission
	 * requests).
	 */
	#takePermission(p: PermissionRequest, host: string, at: number, reply: PollReply): void {
		const b = this.#bridgeFor(host);
		if (p.mode) b.settings.mode = p.mode;
		if (p.effort) b.settings.effort = p.effort;
		// Kind mode: the deck's own mode change, in flight, raised this. One of the two answers the bridge gives
		// without a key press, along with the mode check's allow; a key press started both.
		if (p.tool === MODE_TOOL && isObj(p.input) && p.input.session_id === "self") {
			const cmd = this.commands.inFlightMode(host, p.input.mode, "permission");
			if (cmd) {
				cmd.allowed.permission = true;
				reply.send(200, JSON.stringify(ALLOW_DECISION));
				this.#log.info(`ALLOWED the mode change to ${quote(String(p.input.mode), 20)} for ${host}: the deck's own command ${cmd.id}`);
				this.#emit();
				return;
			}
		}
		const held = this.held.hold(
			{ at, host, tool: p.tool, kind: ASK_TOOLS.has(p.tool) ? "ask" : "tool", summary: summary(p.tool, p.input), fp: fingerprintOrNull(p.tool, p.input) },
			reply,
		);
		reply.onClose(() => this.held.close(held.id));
	}

	/**
	 * A mode check from a confirmed session: the allow for the first check of the deck's own mode change in flight
	 * for that mode, counted apart from kind mode's PermissionRequest; no decision for anything else (PROTOCOL.md,
	 * Mode checks).
	 */
	#checkMode(p: HookRequest, host: string, reply: PollReply): void {
		const self = p.tool === MODE_TOOL && isObj(p.input) && p.input.session_id === "self";
		const mode = self && isObj(p.input) ? p.input.mode : undefined;
		const cmd = self ? this.commands.inFlightMode(host, mode, "pretool") : null;
		if (!cmd) {
			reply.send(200, JSON.stringify(NO_DECISION));
			const why = self ? `no mode command in flight for ${typeof mode === "string" ? quote(mode, 20) : "that mode"} that hasn't had its check allowed` : `${quote(p.tool, 60)} isn't the app's mode tool for the session itself`;
			this.#log.debug(`PRETOOL ${host}: no decision: ${why}`);
			return;
		}
		cmd.allowed.pretool = true;
		reply.send(200, JSON.stringify(PRETOOL_ALLOW));
		this.#log.info(`ALLOWED the mode check for the change to ${quote(String(mode), 20)} for ${host}: the deck's own command ${cmd.id}`);
	}

	#bridgeFor(host: string): BridgeSession {
		let b = this.#bridge.get(host);
		if (!b) {
			b = {
				host,
				sids: new Set(),
				inst: null,
				hellos: new Set(),
				unpolled: null,
				noHelloFrom: null,
				lastSeq: new Map(),
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

	/** The registry's host for a Claude Code session id, else the one a mod request named with it. */
	#hostForSid(sid: string | null): string | null {
		if (sid === null) return null;
		for (const s of this.#ordered) if (s.sessionId === sid) return asHost(s.hostSessionId);
		for (const b of this.#bridge.values()) if (b.sids.has(sid)) return b.host;
		return null;
	}

	/**
	 * Release rule 4: no registry file lists the session's host any more, so the session has ended. What the bridge
	 * knew of it goes, its instances included, so should its mod still be there, its next poll gets 409 and its
	 * hello makes it current again (#noHello).
	 */
	#ended(host: string): void {
		for (const h of this.held.forHost(host)) this.held.release(h.id, "no registry file lists the session any more (rule 4)");
		this.commands.failHost(host, "the session ended");
		this.#bridge.delete(host);
		this.#noHellos.forget(host);
		this.#log.info(`ENDED ${host}: no registry file lists it any more`);
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
			plugin: (b?.inst ?? null) !== null,
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
