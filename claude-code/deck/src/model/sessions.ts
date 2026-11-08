import path from "node:path";

import { type Command, CommandQueue, type CommandSpec, IN_FLIGHT_MS, type PollReply } from "../bridge/commands.js";
import { type Held, HeldRequests } from "../bridge/held.js";
import type { BridgeRoutes, BridgeState, RouteAnswer } from "../bridge/server.js";
import { fingerprint, summary } from "../protocol/fingerprint.js";
import {
	ASK_TOOLS,
	asHost,
	EXIT_PLAN,
	type Hello,
	type ModEvent,
	type ModRef,
	modRef,
	NO_DECISION,
	type Obj,
	parseEvent,
	parseHello,
	parsePermission,
	parsePoll,
	parseResult,
	type PermissionRequest,
	PROTOCOL_VERSION,
	ROUTES,
	type Threads,
} from "../protocol/wire.js";
import type { AppRecord } from "../records/records.js";
import { compareSessions, type RegistrySession } from "../registry/registry.js";
import { type Clock, realClock } from "../util/clock.js";
import { countIdle } from "../util/idle.js";
import { describeError, type Log, nullLog, quote } from "../util/log.js";
import { QuietLog } from "../util/quiet-log.js";
import { activeRun, projectName, runLabel } from "./format.js";
import { type FrontCheck, FrontWatcher } from "./front.js";
import { type SessionState, type SessionStatus, sessionState } from "./status.js";
import { asVersion, type VersionCheck } from "./versions.js";

/**
 * What a session waits on (session-keys.md, What each session shows): `approval`, a held `tool` request; `question`,
 * a held AskUserQuestion; `plan`, a held ExitPlanMode; `input`, the registry's `waiting` with nothing held, or the
 * app's own needs-input sign. It follows the session's oldest held request, which its Session Slot dial shows, so with
 * several held it can differ from the status, which puts a `tool` request first.
 */
export type Need = "approval" | "question" | "plan" | "input";

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
	/**
	 * The session's other loops, the latest `threads` its current mod instance sent, `running` 0 included; null before
	 * one, and from a new instance's hello until it sends one (PROTOCOL.md, Events: threads).
	 */
	threads: Threads | null;
	/** Context use, %, from the mod's latest `measure`. */
	context: number | null;
	model: string | null;
	effort: string | null;
	mode: string | null;
	/** The session has a current mod instance, which only a hello makes so, to take prompts. */
	plugin: boolean;
	/**
	 * Its Claude Code version, x.y.z, as the hello of a current mod instance last gave it; null before one, and when it
	 * gave `unknown` or anything else that isn't x.y.z. A session's Setup page shows it (slots/strip.ts).
	 */
	cc: string | null;
	/** `cc` is newer than the Claude Code version the repo was checked against (VersionCheck's `newer`), which the Setup page marks. */
	ccNewer: boolean;
	/** False for a picked target whose registry file has gone, which has ended, and for a slotted session that isn't running. */
	listed: boolean;
	/**
	 * In the registry: its process runs. The same as `listed`. A slotted session that isn't running comes from its app
	 * record alone (slotView): title, model, effort, mode, summary, project, archived; the rest is null or idle.
	 */
	running: boolean;
	/** What it waits on, or null. */
	need: Need | null;
	/**
	 * Wall-clock ms when the current status began: the held request's arrival (the oldest one), the registry's
	 * `statusUpdatedAt` (or the deck's first reading of that status without it), the `turn.start` the deck got before
	 * the registry said busy, or the turn's end, whichever the status came from; for background, the later of the main
	 * loop's last turn end and the moment other loops' `running` last went above 0. For a session that isn't running, its
	 * record's `lastActivityAt`. Null when unknown. Shown as `30s`, `4m`… (format.ts's sinceText).
	 */
	since: number | null;
	/**
	 * For a session whose last turn ended (done, failed, interrupted), and for an idle one: whether the user has looked
	 * at it since. Null for any other status, and for a session that isn't running. See SessionModel's `seen`.
	 */
	seen: boolean | null;
	/** Context tokens and the context window, from the mod's latest `measure`; null until it has them. */
	tokens: number | null;
	window: number | null;
	/** The session's cost so far in USD, from the latest `measure` that had one. */
	cost: number | null;
	/** What the last turn did, from the app's record (AppRecord's `summary`). */
	summary: string | null;
	/** What the app says it needs from the user, from its record (AppRecord's `needs`). */
	needs: string | null;
	/** The last segment of its `cwd`: the registry's, else the mod's hello's, else the record's. */
	project: string | null;
	/** The registry's `startedAt`: the slots fill with the newest first. */
	startedAt: number | null;
	/** Its app record says `isArchived`. */
	archived: boolean;
};

export type QueueResult = { ok: true; cmd: Command } | { ok: false; why: string };

/**
 * A turn of the main loop. `startedAt` is when the deck got its `turn.start`, and `endedAt` its `turn.end`, by the
 * wall clock: `endedAt` null until then, and `startedAt` null for a turn whose start the deck didn't get. `failedAt`
 * is when it got the turn's `failed`, null without one.
 */
type Turn = { id: string | null; ended: boolean; reason: string | null; failed: boolean; startedAt: number | null; endedAt: number | null; failedAt: number | null };
type RunningTool = { use: string | null; tool: string; summary: string; fp: string | null };

/** Where the deck took a session's mode or effort from (PROTOCOL.md, The deck's session model). */
type Source = "hello" | "settings" | "permission";

/** What the bridge has heard about one session, from its mod and from its PermissionRequests. */
type BridgeSession = {
	host: string;
	/**
	 * Every Claude Code session id its mod has come with, since one can change during a session (PROTOCOL.md,
	 * Identity): the host fallback places a mod request without a usable host by any of them.
	 */
	sids: Set<string>;
	/**
	 * The current mod instance, which only a hello makes so (PROTOCOL.md, Identity): while another is current, one
	 * from an instance not in `hellos`, a restart; while none is, any instance's, one in `hellos` included
	 * (#makeCurrent). Only its polls are held and get commands. Null until a hello makes one current, and while it's
	 * null, every poll for the session gets 409 `hello first` (#noHello). It goes back to null when it has gone
	 * IN_FLIGHT_MS with no poll open and none sent (#unpolled), and when the session ends.
	 */
	inst: string | null;
	/**
	 * The instances that have said hello for the session, oldest first, the last HELLOS_KEPT of them, the current one
	 * included: one made current moves to the newest place. While one is current, a hello from any other of these
	 * changes nothing, never a restart; while none is, any instance's hello makes it current (#makeCurrent). The list
	 * stays when the current instance stops polling (#unpolled), and goes only with the rest when the session ends.
	 */
	hellos: Set<string>;
	/**
	 * The instance that was current until it went IN_FLIGHT_MS with no poll open and none sent (#unpolled); null
	 * once a hello makes an instance current again. A press says so while it's set, and so does the log line of a
	 * 409 that asks for a hello (#noHello).
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
	/** Its Claude Code version, x.y.z, from the latest hello that counted (#greet); null without one (SessionView's `cc`). */
	cc: string | null;
	/**
	 * The latest from hello, `settings` events and PermissionRequests, each over the app's record. A hello counts for
	 * less: the current instance's said again gives only the model, and none replaces a mode or effort from a
	 * PermissionRequest (`from`).
	 */
	settings: { model: string | null; mode: string | null; effort: string | null };
	/**
	 * Where the deck last took the mode in `settings` from, and where the effort, each on its own; null until it took
	 * one. No hello replaces one taken from a PermissionRequest, while a `settings` event or a later PermissionRequest
	 * does (`take`).
	 */
	from: { mode: Source | null; effort: Source | null };
	/** The main loop's last turn. */
	turn: Turn | null;
	/**
	 * Until when, by the monotonic clock, the session's polls are answered at once while the registry says `busy`:
	 * AT_ONCE_MS after the main loop's turn ended with no other loop in a turn, or after the last of them left their
	 * turn once it had. Null before the first, from each main-loop `turn.start`, and while other loops are in a turn; a
	 * time that has passed stays until then.
	 */
	pollsAtOnceUntil: number | null;
	/**
	 * The latest `threads` from the instance named, the current one when it came, and by the wall clock when its
	 * `running` last went above 0 (background's `since`) and when it last came back to 0 (the work's end: workEndedAt);
	 * null before one, and once another instance is made current.
	 */
	threads: { inst: string; latest: Threads; runningSince: number | null; runningEndedAt: number | null } | null;
	/** The main loop's unfinished tool calls, oldest first. */
	tools: RunningTool[];
	/** The latest `measure`'s percent and tokens, null while the engine has none; its window; the latest cost it had. */
	context: number | null;
	tokens: number | null;
	window: number | null;
	cost: number | null;
	/** Wall-clock ms of the desktop app's latest `attach` (DESKTOP_SURFACE): the session came on screen in the app. */
	onScreenAt: number | null;
	/** Wall-clock ms of the desktop app's latest `detach`: it left the screen. */
	offScreenAt: number | null;
	/** The later of the two, as they came: the session is on screen while it's `attach`. */
	screen: "attach" | "detach" | null;
	/** Wall-clock ms when the deck last found the session on screen with Claude the app in front (`seen`). */
	frontSeenAt: number | null;
};

const NO_HOST: RouteAnswer = { status: 400, body: { error: "unknown session: no host, and the registry doesn't know the sid" } };

/** A hello from a host the registry lists under another session id (PROTOCOL.md, Desktop sessions only). */
const NOT_THIS_SESSION = { error: "not this session" };

/** A poll for a session no instance has said hello for: the deck asks for one (PROTOCOL.md, Identity). */
const HELLO_FIRST = { error: "hello first" };

/**
 * The surface the desktop app's own client attaches from (the mods API's RenderSurface). Only its `attach` and `detach`
 * put a session on screen in the app or take it off: a phone's, or VS Code's, are other clients on the same session,
 * and the engine sends each client's on its own.
 */
export const DESKTOP_SURFACE = "desktop";

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
	/**
	 * Whether Claude is the app in front (front.ts's lsappinfoCheck in the plugin), for `seen`. It's asked only while
	 * some session whose last turn ended unseen is on screen in the app, and something on a connected Stream Deck shows
	 * `seen` (showsSeen, setDeckConnected): every second at first, less often the longer that lasts (front.ts's
	 * frontIntervalMs), and every second again after an attach, a detach, a press on the deck or a wake (userPresent).
	 * Without it, nothing asks, and a turn's end is seen only by an attach, the record's `lastFocusedAt` or a press.
	 */
	front?: FrontCheck;
	/**
	 * What each hello that counts is held to: the Claude Code version the repo was checked against, and its plugin's
	 * (versions.ts, hardening.md C1). It logs the drift, and says which sessions' versions are newer. Without it, none is.
	 */
	versions?: VersionCheck;
};

/**
 * The deck's session model (PROTOCOL.md, "The deck's session model"). It merges the registry, the app's
 * records and what the bridge hears, keyed by the app's `local_…` id; it's also the bridge's routes. It holds
 * the PermissionRequests, applies the release rules, queues the commands that key presses make, and works out
 * each session's status, settings and context, and the target session for prompts. It lists only the sessions
 * the registry lists, and takes the hook's requests only from those (PROTOCOL.md, Desktop sessions only).
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
	/** The hosts the latest records scan looked for and found no file for (RecordsReader's `missing`). */
	#missing: ReadonlySet<string> = new Set();
	/** Hosts whose records are read, and whose view is kept, even while the registry doesn't list them: the slotted ones. */
	#kept: ReadonlySet<string> = new Set();
	/** Whether setRegistry has had a reading yet: until then, no session counts as not listed. */
	#registryRead = false;
	/** By host, the wall-clock ms the user last pressed its slot key or jumped from its dial (`seen`). */
	readonly #pressedAt = new Map<string, number>();
	#picked: string | null = null;
	/** The picked session's title as last listed, for when it has ended. */
	#pickedTitle: string | null = null;
	#bridgeState: BridgeState = "stopped";
	/**
	 * The listed sessions' views as of the latest change, built at most once per change however many listeners and keys
	 * read them (B2): null until something asks after an emit. Nothing in a view depends on the moment it's built: its
	 * times are when things happened, and what shows them, `since` say, takes the time itself. Every change emits, and
	 * every emit drops them first. Each view is frozen, since they're shared.
	 */
	#views: { list: SessionView[]; byKey: Map<string, SessionView> } | null = null;
	readonly #front: FrontWatcher | null;
	/** What on the deck shows `seen` now (the slot keys, the Others keys): the front-app check runs only while one does. */
	readonly #seenShown = new Set<object>();
	/** Whether a Stream Deck is connected: the front-app check runs only while one is (agents-and-wake.md, C3). */
	#deckConnected = true;
	readonly #versions: VersionCheck | null;

	constructor(opts: SessionModelOptions = {}) {
		this.#log = opts.log ?? nullLog;
		this.#clock = opts.clock ?? realClock;
		this.#wallNow = opts.wallNow ?? Date.now;
		this.#rescan = opts.rescan ?? null;
		this.#versions = opts.versions ?? null;
		this.#refusals = new QuietLog(this.#log, { clock: this.#clock });
		this.#noHellos = new QuietLog(this.#log, { clock: this.#clock });
		this.held = new HeldRequests({ log: this.#log });
		this.commands = new CommandQueue({ clock: this.#clock, log: this.#log, inFlightMs: opts.inFlightMs });
		this.#inFlightMs = opts.inFlightMs ?? IN_FLIGHT_MS;
		this.#front = opts.front ? new FrontWatcher(opts.front, () => this.#claudeInFront(), { clock: this.#clock, log: this.#log }) : null;
		this.held.onChange(() => this.#emit());
		this.commands.onChange(() => this.#emit());
		this.commands.onUnpolled((host) => this.#unpolled(host));
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Stops the command queue's timers, and the front-app check's. */
	dispose(): void {
		this.commands.dispose();
		this.#front?.dispose();
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
		this.#registryRead = true;
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

	/**
	 * The app's records of the listed sessions and the kept ones, by host, and the hosts the scan looked for and found
	 * no file for (RecordsWatcher's listener).
	 */
	setRecords(records: ReadonlyMap<string, AppRecord>, missing: ReadonlySet<string> = new Set()): void {
		this.#records = new Map(records);
		this.#missing = new Set(missing);
		this.#emit();
	}

	/**
	 * The hosts whose app records the deck reads: the ones the registry lists, in its order, then the kept ones it
	 * doesn't list (keepHosts), sorted.
	 */
	hosts(): string[] {
		const listed = this.#ordered.map((s) => asHost(s.hostSessionId)).filter((h): h is string => h !== null);
		const seen = new Set(listed);
		return [...listed, ...[...this.#kept].filter((h) => !seen.has(h)).sort()];
	}

	/**
	 * Hosts whose records the deck reads, and whose view slotView keeps, while the registry doesn't list them: the
	 * slotted sessions (src/slots/slots.ts). Hosts that don't match the app's id pattern are left out.
	 */
	keepHosts(hosts: Iterable<string>): void {
		const next = new Set([...hosts].filter((h) => asHost(h) !== null));
		if (next.size === this.#kept.size && [...next].every((h) => this.#kept.has(h))) return;
		this.#kept = next;
		this.#emit();
	}

	/** Whether the registry has been read at least once: until then, no session counts as gone from it. */
	get registryRead(): boolean {
		return this.#registryRead;
	}

	/** Whether the registry's latest reading lists the host. */
	isListed(host: string): boolean {
		return this.#registry.has(host);
	}

	/** The host's app record, if the deck has one. */
	record(host: string): AppRecord | null {
		return this.#records.get(host) ?? null;
	}

	/**
	 * Whether the latest records scan looked for the host's file and found none: with the registry not listing it
	 * either, a slot lets the session go (session-keys.md, Stay put). False while the deck can't tell, as before the
	 * first scan that looked for it, or while a folder can't be listed.
	 */
	recordMissing(host: string): boolean {
		return this.#missing.has(host);
	}

	// ---- the bridge's routes ----

	/**
	 * `POST /v1/permission`, held, from a confirmed session only. A request from any other process gets no decision
	 * at once.
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
			// A threads event has its own line (#takeThreads).
			else if (e.t !== "threads") this.#log.debug(`EVENT ${b.host} ${e.t}`);
			try {
				this.#apply(b, e, ref.inst);
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
			countIdle("poll.hello");
			reply.send(409, JSON.stringify(HELLO_FIRST));
			this.#noHello(b, q.inst, "polls");
			return;
		}
		// From an instance that isn't the session's current one, replaced since or never said hello to this deck:
		// answered at once with none, so it neither displaces the current one's poll nor takes its commands, and
		// doesn't count as the session's mod polling (PROTOCOL.md, Identity).
		if (q.inst !== current) {
			countIdle("poll.stray");
			this.#log.debug(`POLL ${b.host} from mod instance ${quote(q.inst, 40)}, not the current one: answered with none`);
			reply.send(200, JSON.stringify({ cmds: [] }));
			return;
		}
		if (this.#answersAtOnce(b)) {
			countIdle("poll.now");
			this.#log.debug(`POLL ${b.host} answered at once: the turn ended and the registry still says busy`);
			this.commands.poll(b.host, current, 0, reply);
		} else {
			countIdle("poll.held");
			this.#log.debug(`POLL ${b.host} wait ${q.wait} s`);
			this.commands.poll(b.host, current, q.wait, reply);
		}
		// No emit (B2): a poll changes nothing a view or a key reads. The commands it takes change state, and the queue
		// says so itself; an instance becomes current only by its hello, which emits; and a session the deck hadn't heard
		// from gets a record that reads as none.
	}

	result(body: Obj): RouteAnswer {
		const r = parseResult(body);
		const b = this.#modSession(r);
		if (!b) return NO_HOST;
		this.#noHello(b, r.inst, "sends a result");
		if (r.id !== null) this.commands.result(b.host, r.inst, r.id, r.state, r.error);
		return { status: 204 };
	}

	// ---- views ----

	/** The running sessions, oldest first. */
	sessions(): SessionView[] {
		return [...this.#built().list];
	}

	/** A listed session by key. */
	session(key: string): SessionView | null {
		return this.#built().byKey.get(key) ?? null;
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
	 * The session prompts go to (PROTOCOL.md, The deck's session model): the one last jumped to from a Session Slot or
	 * Other Sessions (`pick`), even after it has ended (presses then do nothing but alert, kickoff answer 4); until one
	 * is, the one most recently on screen in the app, by its latest `attach` or its record's `lastFocusedAt`, whichever
	 * is later.
	 */
	target(): SessionView | null {
		if (this.#picked !== null) {
			const listed = this.session(this.#picked);
			if (listed) return listed;
			return { ...notRunning(this.#picked, this.#pickedTitle ?? this.#picked), host: asHost(this.#picked), since: null };
		}
		const best = this.#onScreenSession();
		return best ? this.session(keyOf(best)) : null;
	}

	/**
	 * The session on screen in the app: of the running sessions, the one with the latest of its last `attach` (when the
	 * deck got it) and its record's `lastFocusedAt`; null when none has either. A long press on a slot key takes it
	 * (session-keys.md, Slots), and until a session is jumped to it's the target.
	 */
	onScreen(): SessionView | null {
		const best = this.#onScreenSession();
		return best ? this.session(keyOf(best)) : null;
	}

	/**
	 * A slotted session's view: the registry's, as `session` gives it, while the registry lists it; else one from its
	 * app record alone, `running` false (session-keys.md, What each session shows): its title, model, effort, mode,
	 * summary, needs, project and archived, with `since` the record's `lastActivityAt`. A host without a record yet reads
	 * as "Unknown session". Null for a host that isn't an app id.
	 */
	slotView(host: string): SessionView | null {
		const h = asHost(host);
		if (h === null) return null;
		if (this.#registry.has(h)) return this.session(h);
		const rec = this.#records.get(h);
		return {
			...notRunning(h, rec?.title ?? projectName(rec?.cwd) ?? "Unknown session"),
			model: rec?.model ?? null,
			effort: rec?.effort ?? null,
			mode: rec?.permissionMode ?? null,
			since: rec?.lastActivityAt ?? null,
			summary: rec?.summary ?? null,
			needs: rec?.needs ?? null,
			project: projectName(rec?.cwd),
			archived: rec?.isArchived ?? false,
		};
	}

	/**
	 * Whether `who` (the slot keys, the Others keys) shows `seen` on the deck now. The front-app check runs only while
	 * something does, so a deck with none of those keys never asks lsappinfo.
	 */
	showsSeen(who: object, shows: boolean): void {
		const before = this.#seenShown.size > 0;
		if (shows) this.#seenShown.add(who);
		else this.#seenShown.delete(who);
		const now = this.#seenShown.size > 0;
		if (now === before) return;
		this.#log.debug(`SEEN ${now ? "shown on the deck: the front-app check may run" : "shown nowhere on the deck: the front-app check stops"}`);
		try {
			this.#front?.want(this.#wantsFront(this.sessions()));
		} catch (err) {
			this.#log.error(`starting or stopping the front-app check threw: ${describeError(err)}`);
		}
	}

	/**
	 * Whether a Stream Deck is connected (agents-and-wake.md, C3). While none is, nothing on the deck shows `seen`, so
	 * the front-app check doesn't run; the sessions' state keeps up all the same. True until told otherwise.
	 */
	setDeckConnected(connected: boolean): void {
		if (connected === this.#deckConnected) return;
		this.#deckConnected = connected;
		try {
			this.#front?.want(this.#wantsFront(this.sessions()));
		} catch (err) {
			this.#log.error(`starting or stopping the front-app check threw: ${describeError(err)}`);
		}
	}

	/**
	 * The user pressed the session's slot key, or jumped to it from its dial: a turn's end before now counts as seen
	 * (session-keys.md, `seen`). Only for a session the registry lists.
	 */
	markSeen(host: string): void {
		if (!this.#registry.has(host)) return;
		this.#pressedAt.set(host, this.#wallNow());
		this.#emit();
	}

	/**
	 * The user is likely at the Mac: a press on any of this plugin's keys or dials, or the Mac waking up (plugin.ts).
	 * They may look at the app soon, so while the front-app check for `seen` runs, it asks every second again
	 * (hardening.md, B5).
	 */
	userPresent(): void {
		this.#front?.reset();
	}

	/** The wall clock the model's times are on (`since`, `seen`), for what reads them against now: the slots' repaint tick. */
	wallNow(): number {
		return this.#wallNow();
	}

	/** The session last jumped to (`pick`), which is the target; null while the target follows the app. */
	get picked(): string | null {
		return this.#picked;
	}

	/**
	 * A jump to a session: from its slot key or dial, or from Other Sessions (slots/jump.ts). It's the target from now on.
	 * `via` names where, for the log.
	 */
	pick(key: string, via: string): void {
		const s = this.#registry.get(key);
		if (s) this.#pickedTitle = this.#title(s);
		else if (this.#picked !== key) this.#pickedTitle = this.slotView(key)?.title ?? null;
		if (this.#picked === key) return;
		this.#picked = key;
		this.#log.info(`TARGET ${key}: picked on ${via}`);
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

	#apply(b: BridgeSession, e: ModEvent, inst: string | null): void {
		switch (e.t) {
			case "turn.start":
				if (e.agent !== null) return;
				// When the deck got it, on its wall clock: status rule 3 compares it with when the registry's idle began.
				b.turn = { id: e.turn, ended: false, reason: null, failed: false, startedAt: this.#wallNow(), endedAt: null, failedAt: null };
				b.tools = [];
				b.pollsAtOnceUntil = null;
				return;
			case "turn.end": {
				if (e.agent !== null) return;
				// A `failed` for this same turn stays: the status says failed, whatever the reason.
				const same = b.turn !== null && (e.turn === null || b.turn.id === null || b.turn.id === e.turn);
				b.turn = {
					id: e.turn ?? b.turn?.id ?? null,
					ended: true,
					reason: e.reason,
					failed: same && (b.turn?.failed ?? false),
					startedAt: same ? (b.turn?.startedAt ?? null) : null,
					endedAt: this.#wallNow(),
					failedAt: same ? (b.turn?.failedAt ?? null) : null,
				};
				b.tools = [];
				this.#turnOver(b, "the turn ended");
				return;
			}
			case "failed":
				if (e.agent !== null) return;
				b.turn = { id: b.turn?.id ?? null, ended: true, reason: b.turn?.reason ?? null, failed: true, startedAt: b.turn?.startedAt ?? null, endedAt: b.turn?.endedAt ?? null, failedAt: this.#wallNow() };
				b.tools = [];
				this.#log.info(`FAILED turn in ${b.host}${e.error ? `: ${quote(e.error, 120)}` : ""}`);
				this.#turnOver(b, "the turn failed");
				return;
			case "threads":
				this.#takeThreads(b, e.threads, inst);
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
				// Rule 1: the call a held request was for has ended, in the same loop. A request with no agent, the main loop's,
				// matches only an event with none, so one agent's finished call can't release another's identical request.
				if (e.fp !== null) {
					const match = this.held.forHost(b.host).find((h) => h.fp === e.fp && h.agent === e.agent);
					if (match) this.held.release(match.id, `the session reported the call's end (rule 1, fp ${e.fp}${e.agent === null ? "" : `, agent ${quote(e.agent, 40)}`})`);
				}
				return;
			}
			case "measure":
				// The latest measure's, which has none until the engine has a response to count: a fresh session,
				// or one just compacted, whose old figure no longer holds. The same for its tokens. The window is
				// always sent, and the cost only once the engine has one, which then only grows: the last stays.
				b.context = e.percent;
				b.tokens = e.tokens;
				if (e.window !== null) b.window = e.window;
				if (e.usd !== null) b.cost = e.usd;
				return;
			case "settings":
				if (e.model) b.settings.model = e.model;
				take(b, "mode", e.mode, "settings");
				take(b, "effort", e.effort, "settings");
				return;
			case "attach":
			case "detach":
				// Each client on the session sends its own: only the desktop app's says it's on screen in the app.
				if (e.surface !== DESKTOP_SURFACE) {
					this.#log.debug(`SCREEN ${b.host}: ${e.t} from ${e.surface === null ? "no surface" : `the ${quote(e.surface, 40)} surface`} ignored: only the desktop app's counts`);
					return;
				}
				if (e.t === "attach") b.onScreenAt = this.#wallNow();
				else b.offScreenAt = this.#wallNow();
				b.screen = e.t;
				// The user is in the app, or was a moment ago: the front-app check asks every second again (B5).
				this.#front?.reset();
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
	 * The main loop's turn ended, with a `turn.end` or a `failed`: its open poll is answered with none, and its polls
	 * at once for AT_ONCE_MS while the registry says busy. Not while other loops are in a turn: they keep the registry
	 * busy whatever the mod has open, so answering at once would only spin the mod, and the window closes instead,
	 * until they leave their turn (#takeThreads; PROTOCOL.md, Commands: "While other loops are at work").
	 */
	#turnOver(b: BridgeSession, why: string): void {
		if ((b.threads?.latest.running ?? 0) > 0) {
			b.pollsAtOnceUntil = null;
			return;
		}
		b.pollsAtOnceUntil = this.#clock.now() + AT_ONCE_MS;
		this.#answerPoll(b, why);
	}

	/**
	 * A `threads` snapshot, kept only from the session's current mod instance (PROTOCOL.md, Events: threads). Other
	 * loops coming into a turn close the poll window and are timed for background's `since`; the last of them leaving it
	 * is timed as the work's end, for the done that follows (workEndedAt), and while the main loop isn't in a turn it
	 * answers the open poll and opens the window, as a turn's end does, so the registry can go idle (PROTOCOL.md,
	 * Commands). Each is logged at debug, and running leaving 0 or coming back at info.
	 */
	#takeThreads(b: BridgeSession, t: Threads, inst: string | null): void {
		if (inst === null || inst !== b.inst) {
			this.#log.debug(`THREADS ${b.host} from mod instance ${quote(inst, 40)}, not the current one: dropped`);
			return;
		}
		const before = b.threads?.latest.running ?? 0;
		const now = this.#wallNow();
		b.threads = {
			inst,
			latest: t,
			runningSince: t.running > 0 && before === 0 ? now : (b.threads?.runningSince ?? null),
			runningEndedAt: t.running === 0 && before > 0 ? now : (b.threads?.runningEndedAt ?? null),
		};
		this.#log.debug(`THREADS ${b.host}: running ${t.running}, runs ${t.runs.length === 0 ? "none" : t.runs.map(runLabel).join(", ")}`);
		if (t.running > 0) {
			b.pollsAtOnceUntil = null;
			const run = activeRun(t);
			if (before === 0) this.#log.info(`THREADS ${b.host}: ${t.running} in a turn${run === null ? "" : ` (${runLabel(run)})`}`);
		} else if (before > 0) {
			this.#log.info(`THREADS ${b.host}: none in a turn`);
			if (b.turn === null || b.turn.ended) {
				b.pollsAtOnceUntil = this.#clock.now() + AT_ONCE_MS;
				this.#answerPoll(b, "the session's other loops left their turns");
			}
		}
	}

	/**
	 * Whether the session's poll is answered at once, with its queued commands or none: the main loop's turn ended
	 * less than AT_ONCE_MS ago, no main-loop `turn.start` has come since, and the registry still says `busy`. A poll
	 * held then would keep the session `busy` until it ran out, since Claude Code waits for a moment after the turn
	 * when the mod has no request open; the mod waits out the rest of a second after an early empty answer, which
	 * gives it that moment (PROTOCOL.md, Commands). The deck reads the registry a moment after it changes (about 50 ms
	 * after its watch's event, B4), so after a turn shorter than that, or while its reading still says `waiting` after
	 * a Deny, a poll can come before the reading says `busy`: it's held, and answered with none once the reading does
	 * (`setRegistry`). While other loops are in a turn the window is closed, so neither applies (#turnOver, #takeThreads).
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
	 * A mod request for a session with no current instance. Either the deck has no hello for it at all, since the
	 * deck started or since release rule 4 forgot the session after a registry reading that missed it; or none has
	 * come since the current instance went IN_FLIGHT_MS without a poll (#unpolled), as a restarted process's
	 * predecessor does, and the deck still knows which instances said hello before. Its mod is there all the same,
	 * and nothing it sent need have failed: between a poll answered within a second and its next, as after every
	 * turn's end, the mod waits out the rest of that second with nothing open, so a deck that restarts then fails
	 * none of its requests, and nor does a reading that misses the session. So the deck asks for a hello: it answers
	 * each of the session's polls at once with 409 `hello first` (`next`), which the mod takes as a fetch that
	 * rejected, with a quiet hello about 100 ms later (PROTOCOL.md, Identity; Failure and recovery). The 409 goes only
	 * to a session with no current instance, so it never displaces one. The session's events and results are still
	 * taken, and until a hello makes an instance current, a press on it is refused, saying why.
	 *
	 * The log says the deck asked, and which of the two it is: a poll's 409 at info the first time, then at most once
	 * in 10 minutes with the count since, and the rest at debug; afresh once a hello makes an instance current, or the
	 * session ends. Events and results go only at debug, and so does everything from a session the registry doesn't
	 * list, which takes no presses: one that's ending, say, whose mod polled again once the deck answered its poll at
	 * release rule 4.
	 */
	#noHello(b: BridgeSession, inst: string | null, sends: "polls" | "sends events" | "sends a result"): void {
		if (b.inst !== null) return;
		b.noHelloFrom = inst ?? "";
		const none = b.unpolled !== null ? `no instance has said hello since ${quote(b.unpolled, 40)}, which was current, stopped polling` : "no instance has said hello to this deck for the session";
		const what = `${b.host}: mod instance ${quote(inst, 40)} ${sends}, but ${none}`;
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
		// Its Claude Code version, and the drift, held to the repo's, before the emit below builds the views afresh
		// (hardening.md, C1). Only a hello that counts: a replaced instance's may be an older process's. A throw there
		// mustn't cost the hello.
		b.cc = asVersion(h.cc);
		try {
			this.#versions?.hello(b.host, h.cc, h.plugin);
		} catch (err) {
			this.#log.error(`checking ${b.host}'s versions threw: ${describeError(err)}`);
		}
		if (current === "again") {
			// The current instance's hello, said again, as after every rejected fetch (each Deny, each Esc): its mode and
			// effort are what the mod has already sent or queued as `settings`, while the deck may since have taken a
			// newer one from a PermissionRequest, so they stay the deck's (PROTOCOL.md, Identity). Normal use: debug.
			this.#log.debug(`HELLO ${b.host} inst ${quote(h.inst, 40)} again: its cwd and model taken, its mode and effort not`);
		} else {
			// A hello that makes its instance current gives its mode and effort too, but not in place of either one the
			// deck took from a PermissionRequest, which can be newer: after a deck restart, or once the current instance
			// has gone 60 s without a poll, a PermissionRequest can come before this hello (PROTOCOL.md, The deck's
			// session model).
			const kept = (["mode", "effort"] as const).filter((field) => h[field] && !take(b, field, h[field], "hello"));
			const unlisted = this.#listing(host, h.sid) === "none" ? "; the registry doesn't list it yet" : "";
			const note = kept.length > 0 ? `; its ${kept.join(" and ")} not taken, as the deck's came from a PermissionRequest` : "";
			this.#log.info(`HELLO ${b.host} inst ${quote(h.inst, 40)} plugin ${quote(h.plugin, 20)} cc ${quote(h.cc, 20)}${unlisted}${note}`);
		}
		this.#emit();
		return { status: 200, body: { v: PROTOCOL_VERSION, ok: true } };
	}

	/**
	 * Makes a hello's instance the session's current one, if its hello counts: "new" when it's made current now,
	 * "again" when it was already, null when it isn't (PROTOCOL.md, Identity).
	 * - While another is current, only an instance that hasn't said hello before counts, and it means the mod
	 *   restarted: the session's current tool and in-flight commands are forgotten, and a poll the old instance left
	 *   open is answered with none. A listed instance's hello changes nothing: a replaced one's, or a predecessor's
	 *   whose process lives on.
	 * - While none is current, any instance's hello makes it current, one that has said hello before included, such
	 *   as the live mod's once a predecessor that was current has stopped polling. That isn't a restart: nothing is
	 *   failed or forgotten.
	 *
	 * An instance made current moves to the newest place in the session's `hellos`, and has its time without a poll
	 * counted from now (CommandQueue's `watch`); a hello said again doesn't reset it.
	 */
	#makeCurrent(b: BridgeSession, inst: string | null): "new" | "again" | null {
		if (inst === null) return null;
		if (inst === b.inst) return "again";
		if (b.inst !== null) {
			if (b.hellos.has(inst)) return null;
			this.#log.info(`RESTART ${b.host}: mod instance ${quote(inst, 40)} replaces ${quote(b.inst, 40)}; its current tool and in-flight commands are forgotten, and any poll the old one left open is answered`);
			b.tools = [];
			this.commands.restarted(b.host, inst, "the mod restarted");
		}
		// Another instance's picture of the other loops: a mod starts with an empty one (PROTOCOL.md, Events: threads).
		if (b.threads !== null && b.threads.inst !== inst) {
			if (b.threads.latest.running > 0) this.#log.info(`THREADS ${b.host}: none in a turn`);
			b.threads = null;
		}
		b.inst = inst;
		// The newest place, for one that said hello before too: the list forgets its oldest first.
		b.hellos.delete(inst);
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
	 * (PROTOCOL.md, Identity), at the moment the command queue fails the session's waiting prompts. None is current
	 * then, and the deck keeps the rest: settings, held requests, queued and in-flight commands, the current tool, seqs,
	 * and which instances have said hello. A press on the session then alerts, its mods' polls get 409 `hello first`
	 * (#noHello), and the first hello to come makes its instance current, one that said hello before included, which
	 * isn't a restart, since none was current (#makeCurrent). From then on the others count as before: a listed one's
	 * hello changes nothing, and an unlisted one's is a restart.
	 *
	 * Without this, the predecessor of a restarted process whose hello landed last after a deck restart would stay
	 * current for good, and the live mod's polls would be answered at once with none. Had the deck forgotten which
	 * instances said hello, as in round 3, that predecessor's next hello, as after one of its fetches rejects, would be
	 * a restart over the live mod made current again, failing its commands, and its polls would get none for another
	 * minute (round 3's review of Phase 6).
	 *
	 * One line at info; at debug for a session the registry doesn't list, which takes no presses, such as a spare
	 * process that went before it was claimed.
	 */
	#unpolled(host: string): void {
		const b = this.#bridge.get(host);
		if (!b || b.inst === null) return;
		const was = b.inst;
		b.inst = null;
		b.unpolled = was;
		const line = `UNPOLLED ${host}: mod instance ${quote(was, 40)} has had no poll open for ${this.#inFlightMs / 1000} s, so it's no longer the current one; the mod's next poll gets 409 to ask for a hello, and the first instance to say one is made current`;
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
	 * A PermissionRequest from a confirmed session. Its mode and effort are the session's, the engine's own at that
	 * moment, which no hello replaces (`take`). It's held (PROTOCOL.md, Permission requests), and nothing of its
	 * `tool_input` is kept beyond its summary and fingerprint (Held requests).
	 */
	#takePermission(p: PermissionRequest, host: string, at: number, reply: PollReply): void {
		const b = this.#bridgeFor(host);
		take(b, "mode", p.mode, "permission");
		take(b, "effort", p.effort, "permission");
		const kind = ASK_TOOLS.has(p.tool) ? "ask" : "tool";
		const held = this.held.hold({ at, host, tool: p.tool, kind, summary: summary(p.tool, p.input), fp: fingerprintOrNull(p.tool, p.input), agent: p.agent }, reply);
		reply.onClose(() => this.held.close(held.id));
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
				cc: null,
				settings: { model: null, mode: null, effort: null },
				from: { mode: null, effort: null },
				turn: null,
				pollsAtOnceUntil: null,
				threads: null,
				tools: [],
				context: null,
				tokens: null,
				window: null,
				cost: null,
				onScreenAt: null,
				offScreenAt: null,
				screen: null,
				frontSeenAt: null,
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
		this.#pressedAt.delete(host);
		this.#noHellos.forget(host);
		this.#log.info(`ENDED ${host}: no registry file lists it any more`);
	}

	/** The listed sessions' views as the model stands, built now if the latest change dropped them (#views). */
	#built(): { list: SessionView[]; byKey: Map<string, SessionView> } {
		if (this.#views === null) {
			const list: SessionView[] = this.#ordered.map((s) => Object.freeze(this.#view(s)));
			this.#views = { list, byKey: new Map(list.map((v) => [v.key, v])) };
		}
		return this.#views;
	}

	#view(s: RegistrySession): SessionView {
		countIdle("view");
		const host = asHost(s.hostSessionId);
		const b = host === null ? undefined : this.#bridge.get(host);
		const rec = host === null ? undefined : this.#records.get(host);
		const held = host === null ? [] : this.held.forHost(host);
		const firstReadingAt = this.#firstReadings.get(keyOf(s)) ?? null;
		const state = sessionState({
			heldTool: held.filter((h) => h.kind === "tool").length,
			heldAsk: held.filter((h) => h.kind === "ask").length,
			registry: s.status,
			statusUpdatedAt: s.statusUpdatedAt,
			firstReadingAt,
			turn: b?.turn ?? null,
			recordCategory: rec?.turnCategory ?? null,
			running: b?.threads?.latest.running ?? 0,
		});
		const oldest = held[0] ?? null;
		return {
			key: keyOf(s),
			host,
			pid: s.key,
			title: this.#title(s),
			status: state.status,
			doing: b?.tools.at(-1)?.summary ?? null,
			threads: b?.threads?.latest ?? null,
			context: b?.context ?? null,
			model: b?.settings.model ?? rec?.model ?? null,
			effort: b?.settings.effort ?? rec?.effort ?? null,
			mode: b?.settings.mode ?? rec?.permissionMode ?? null,
			plugin: (b?.inst ?? null) !== null,
			cc: b?.cc ?? null,
			ccNewer: this.#versions?.newer(b?.cc ?? null) ?? false,
			listed: true,
			running: true,
			need: needOf(state, oldest),
			since: since(state, s.statusUpdatedAt ?? firstReadingAt, b?.turn ?? null, oldest, b?.threads ?? null),
			seen: this.#seen(state, host, b, rec),
			tokens: b?.tokens ?? null,
			window: b?.window ?? null,
			cost: b?.cost ?? null,
			summary: rec?.summary ?? null,
			needs: rec?.needs ?? null,
			project: projectName(s.cwd ?? b?.cwd ?? rec?.cwd),
			startedAt: s.startedAt,
			archived: rec?.isArchived ?? false,
		};
	}

	/**
	 * Whether the user has looked at the session since its last turn ended (session-keys.md, `seen`), for a done,
	 * failed or interrupted session, and for an idle one; null for any other status. When the session's other loops
	 * worked on past the turn, their work's end stands for the turn's (workEndedAt): a look while they worked doesn't see
	 * it. A turn's end is seen once, at or after it, by any of:
	 * - an `attach` the deck got, or the record's `lastFocusedAt`: the session came on screen;
	 * - the front-app check finding the session on screen (its last `attach` after its last `detach`) with Claude in
	 *   front (#claudeInFront);
	 * - a press on its slot key, or a jump from its dial (markSeen).
	 * An idle session, whose turn end the deck didn't see (after a deck restart, say), is unseen when its record's
	 * `lastActivityAt` is later than its `lastFocusedAt`, until one of those comes after that activity.
	 */
	#seen(state: SessionState, host: string | null, b: BridgeSession | undefined, rec: AppRecord | undefined): boolean | null {
		let unseenSince: number | null;
		if (state.status === "done" || state.status === "failed" || state.status === "interrupted") unseenSince = b?.turn ? workEndedAt(b.turn, b.threads) : null;
		else if (state.status === "idle") {
			const activity = rec?.lastActivityAt ?? null;
			unseenSince = activity !== null && activity > (rec?.lastFocusedAt ?? -Infinity) ? activity : null;
		} else return null;
		if (unseenSince === null) return true;
		const looked = Math.max(b?.onScreenAt ?? -Infinity, rec?.lastFocusedAt ?? -Infinity, b?.frontSeenAt ?? -Infinity, (host === null ? undefined : this.#pressedAt.get(host)) ?? -Infinity);
		return looked >= unseenSince;
	}

	/** The listed session with the latest of its last `attach` and its record's `lastFocusedAt`; null when none has either. */
	#onScreenSession(): RegistrySession | null {
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
		return best;
	}

	/** Whether the mod last said its session came on screen (`attach`), not that it left it. */
	#onScreenNow(host: string | null): boolean {
		return host !== null && this.#bridge.get(host)?.screen === "attach";
	}

	/**
	 * Whether the front-app check is needed: some session whose last turn ended unseen is on screen in the app, and
	 * something on a connected Stream Deck shows `seen`.
	 */
	#wantsFront(views: readonly SessionView[]): boolean {
		return this.#deckConnected && this.#seenShown.size > 0 && views.some((v) => v.seen === false && this.#onScreenNow(v.host));
	}

	/**
	 * The front-app check found Claude in front: each session on screen whose last turn ended unseen is seen now. One
	 * debug line each, so a hardware test can time it from the log.
	 */
	#claudeInFront(): void {
		const now = this.#wallNow();
		let any = false;
		for (const v of this.sessions()) {
			if (v.seen !== false || !this.#onScreenNow(v.host) || v.host === null) continue;
			const b = this.#bridge.get(v.host);
			if (!b) continue;
			b.frontSeenAt = now;
			any = true;
			this.#log.debug(`SEEN ${v.host}: on screen with Claude in front`);
		}
		if (any) this.#emit();
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
	#logStatuses(views: readonly SessionView[]): void {
		const statuses = new Map<string, SessionStatus>();
		for (const { key, status } of views) {
			const was = this.#statuses.get(key);
			if (status !== was) this.#log.debug(`STATUS ${key} ${was === undefined ? "" : `${was} `}→ ${status}`);
			statuses.set(key, status);
		}
		this.#statuses = statuses;
	}

	#emit(): void {
		countIdle("emit");
		// Something changed: the views are built afresh, once, when next asked for.
		this.#views = null;
		// Only a log line and a timer: a throw here mustn't escape into a hold, a release or a route.
		try {
			const views = this.sessions();
			this.#logStatuses(views);
			this.#front?.want(this.#wantsFront(views));
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

/** A view of a session the registry doesn't list, with nothing known but its key and title. */
function notRunning(key: string, title: string): SessionView {
	countIdle("view");
	return {
		key,
		host: key,
		pid: null,
		title,
		status: "idle",
		doing: null,
		threads: null,
		context: null,
		model: null,
		effort: null,
		mode: null,
		plugin: false,
		cc: null,
		ccNewer: false,
		listed: false,
		running: false,
		need: null,
		since: null,
		seen: null,
		tokens: null,
		window: null,
		cost: null,
		summary: null,
		needs: null,
		project: null,
		startedAt: null,
		archived: false,
	};
}

/** When the main loop's last turn ended, by the deck's wall clock: the later of its `turn.end` and its `failed`. */
function endedAt(turn: Turn): number | null {
	const times = [turn.endedAt, turn.failedAt].filter((t): t is number => t !== null);
	return times.length === 0 ? null : Math.max(...times);
}

/** The later of the times given, ignoring nulls; null with none. */
function latest(...times: (number | null)[]): number | null {
	const known = times.filter((t): t is number => t !== null);
	return known.length === 0 ? null : Math.max(...known);
}

/**
 * When the session's work ended, for the done, failed or stopped that follows, by the deck's wall clock: the main loop's
 * last turn end, or the other loops' later end, when their `running` came back to 0 after it. So a workflow that ends
 * ten minutes after the turn reads Done 0s then, unseen, not Done 10m and seen by a look while it ran.
 */
function workEndedAt(turn: Turn, threads: { runningEndedAt: number | null } | null): number | null {
	return latest(endedAt(turn), threads?.runningEndedAt ?? null);
}

/**
 * When the status began, by the rule it came from (SessionView's `since`): the oldest held request's arrival; the
 * registry's `registryAt` (its `statusUpdatedAt`, else the deck's first reading of that status); the `turn.start`
 * the deck got; or the work's end (workEndedAt). For the app's needs-input sign, the turn's end when the deck saw one,
 * else the registry's idle. For background, the later of the main loop's last turn end and `runningSince`, when other
 * loops' `running` last went above 0 (PROTOCOL.md, status rule 3).
 */
function since(state: SessionState, registryAt: number | null, turn: Turn | null, oldest: Held | null, threads: { runningSince: number | null; runningEndedAt: number | null } | null): number | null {
	switch (state.from) {
		case "held-tool":
		case "held-ask":
			return oldest?.at ?? null;
		case "background":
			return latest(turn ? endedAt(turn) : null, threads?.runningSince ?? null);
		case "waiting":
		case "busy":
		case "idle":
			return registryAt;
		case "started":
			return turn?.startedAt ?? null;
		case "failed":
		case "interrupted":
		case "done":
			return turn ? workEndedAt(turn, threads) : null;
		case "record":
			return (turn?.ended ? endedAt(turn) : null) ?? registryAt;
	}
}

/** What the session waits on: its oldest held request's kind, else `input` while its status says it needs you. */
function needOf(state: SessionState, oldest: Held | null): Need | null {
	if (oldest) return oldest.kind === "tool" ? "approval" : oldest.tool === EXIT_PLAN ? "plan" : "question";
	return state.status === "needs-you" ? "input" : null;
}

/**
 * Takes the session's mode or effort from `source`, if it gives one, and returns whether it took it. A hello's never
 * replaces one the deck took from a PermissionRequest: a hello's mode and effort are what its mod has already sent as
 * `settings`, or queued to send, so they can be older than a PermissionRequest's, which are the engine's own at that
 * moment. A `settings` event, or a later PermissionRequest, replaces it as usual. Each field goes by where the deck
 * last took it from, so a hello can still give the effort when only the mode came from a PermissionRequest
 * (PROTOCOL.md, The deck's session model).
 */
function take(b: BridgeSession, field: "mode" | "effort", value: string | null, source: Source): boolean {
	if (!value) return false;
	if (source === "hello" && b.from[field] === "permission") return false;
	b.settings[field] = value;
	b.from[field] = source;
	return true;
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
