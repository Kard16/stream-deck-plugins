import net from "node:net";

import { describeError, Emitter } from "../util/emitter.js";
import { nullLog, type Log } from "../util/log.js";
import { LineSplitter } from "./framing.js";
import {
	type Command,
	type CommandType,
	DEFAULT_CMD_PORT,
	DEFAULT_EVT_PORT,
	type ErrEvt,
	type HelloEvt,
	type LrEvent,
	parseEvent,
	PROTOCOL_VERSION,
	REPLY_TYPE,
	type RequestCommand,
	type RequestInput,
} from "./protocol.js";
import { validateCommand } from "./validate.js";

/**
 * - **offline**: a socket is down, or both are up but Lightroom hasn't said hello yet.
 * - **online**: both sockets are up and Lightroom said hello with protocol v1.
 * - **busy**: Lightroom stopped taking lines (its `ok`s stopped): a menu, dialog or the Plug-in Manager is open.
 * - **mismatch**: Lightroom said hello with another protocol version. Only `hello` and `ping` go out.
 */
export type ConnState = "offline" | "online" | "busy" | "mismatch";

export type ClientTiming = {
	/** First reconnect delay; it doubles on every failed attempt. */
	backoffMinMs: number;
	backoffMaxMs: number;
	pingIntervalMs: number;
	/** No event at all for this long, while `ok`s keep coming, means the event socket is stale. */
	staleMs: number;
	/** A line without its `ok` for this long means Lightroom isn't taking lines: busy. */
	okWindowMs: number;
	/**
	 * A pong proves Lightroom took every line up to its ping, since it takes lines in order. Lines up to the
	 * ping still waiting for an `ok` this long after the pong lost theirs, and stop counting; otherwise one
	 * lost `ok` would leave the busy check a line behind for the rest of the session. It must stay well under
	 * okWindowMs, and above the few ms by which a pong can beat its own ping's `ok` (they use different sockets).
	 */
	okResyncMs: number;
	/** Gives up on a connection attempt that neither connects nor fails. */
	connectTimeoutMs: number;
	/** How often the heartbeat checks the clock. */
	tickMs: number;
	/** How long a command's `id` stays routable to its error callback. */
	errRouteTtlMs: number;
	requestTimeoutMs: number;
};

/** PROTOCOL.md's numbers: backoff 250 ms doubling to 2 s, ping every 2 s, stale after 6 s, `ok` within 1.5 s. */
export const DEFAULT_TIMING: ClientTiming = {
	backoffMinMs: 250,
	backoffMaxMs: 2000,
	pingIntervalMs: 2000,
	staleMs: 6000,
	okWindowMs: 1500,
	okResyncMs: 500,
	connectTimeoutMs: 5000,
	tickMs: 250,
	errRouteTtlMs: 5000,
	requestTimeoutMs: 5000,
};

/** The delay before reconnect attempt number `attempt` (0-based): 250, 500, 1000, 2000, 2000, … */
export function backoffDelay(attempt: number, timing: Pick<ClientTiming, "backoffMinMs" | "backoffMaxMs"> = DEFAULT_TIMING): number {
	return Math.min(timing.backoffMaxMs, timing.backoffMinMs * 2 ** Math.min(Math.max(0, attempt), 30));
}

/** A failed request: `code` is Lightroom's err code, or one of offline, mismatch, timeout, disconnected, invalid. */
export class LrError extends Error {
	readonly code: string;
	readonly evt: ErrEvt | undefined;

	constructor(code: string, message: string, evt?: ErrEvt) {
		super(message);
		this.name = "LrError";
		this.code = code;
		this.evt = evt;
	}
}

export type ClientEvents = {
	/** The connection state changed. */
	state: [state: ConnState, prev: ConnState];
	/** Every valid event from Lightroom, in order. */
	event: [evt: LrEvent];
	/** Lightroom's plugin instance changed (a reload or relaunch), or the first instance was seen. Fires before that hello's `event`. */
	inst: [inst: string, prev: string | null];
	/** Both sockets connected. */
	connect: [];
	/** The pair was torn down. */
	disconnect: [reason: string];
};

export type SendOptions = {
	/** Called if Lightroom answers this command with `err`. Gives the command an `id` so the error can find its way back. */
	onErr?: (err: ErrEvt) => void;
};

/** What the value model and the actions need from the client; tests substitute a fake. */
export interface LrLink {
	readonly state: ConnState;
	send(cmd: Command, opts?: SendOptions): boolean;
	request(cmd: RequestInput, opts?: { timeoutMs?: number }): Promise<LrEvent>;
	on<K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void): () => void;
}

export type ClientOptions = {
	host?: string;
	cmdPort?: number;
	evtPort?: number;
	/** `hello.client`. */
	client?: string;
	/** `hello.ver`: this plugin's version. */
	ver: string;
	/** The params to `watch`: every param in the banks. */
	watch?: readonly string[];
	timing?: Partial<ClientTiming>;
	log?: Log;
};

export type ClientStats = {
	connects: number;
	disconnects: number;
	linesSent: number;
	oks: number;
	/** `ok`s with no line waiting for them. */
	extraOks: number;
	/** Lines a pong showed Lightroom had taken whose `ok` never came (see okResyncMs). */
	lostOks: number;
	events: number;
	/** Lines that weren't JSON, or that turned up on the command socket. */
	badLines: number;
	invalidEvents: number;
	/** Well-formed events of a type v1 doesn't define. */
	ignoredEvents: number;
	okLatencyMs: { last: number; avg: number; max: number };
	pingRttMs: number | null;
	staleReconnects: number;
	busyEpisodes: number;
};

type PendingRequest = {
	reply: string;
	resolve: (evt: LrEvent) => void;
	reject: (err: LrError) => void;
	timer: NodeJS.Timeout;
};

const clip = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Every interval here is measured on the monotonic clock: a wall-clock step, such as a time sync after the
 * Mac wakes, must not look like a stale event socket or a busy Lightroom.
 */
const monotonic = (): number => performance.now();

/** A line on the command socket still waiting for its `ok`: its number on this connection and when it went out. */
type SentLine = { seq: number; at: number };

/**
 * The deck's side of PROTOCOL.md's transport: a command socket and an event socket to Lightroom on
 * 127.0.0.1, kept up as a pair, with backoff, `ok` draining, a heartbeat that tells a stale event socket
 * from a busy Lightroom, the hello handshake, the version check, and `watch` on every new session.
 */
export class LrClient implements LrLink {
	readonly stats: ClientStats = {
		connects: 0,
		disconnects: 0,
		linesSent: 0,
		oks: 0,
		extraOks: 0,
		lostOks: 0,
		events: 0,
		badLines: 0,
		invalidEvents: 0,
		ignoredEvents: 0,
		okLatencyMs: { last: 0, avg: 0, max: 0 },
		pingRttMs: null,
		staleReconnects: 0,
		busyEpisodes: 0,
	};

	readonly #host: string;
	readonly #cmdPort: number;
	readonly #evtPort: number;
	readonly #client: string;
	readonly #ver: string;
	readonly #timing: ClientTiming;
	readonly #log: Log;
	readonly #events: Emitter<ClientEvents>;
	#watch: string[];

	#running = false;
	/** Bumped on every teardown, so callbacks from old sockets are ignored. */
	#gen = 0;
	#cmd: net.Socket | null = null;
	#evt: net.Socket | null = null;
	#cmdUp = false;
	#evtUp = false;
	#connectTimer: NodeJS.Timeout | null = null;
	#reconnectTimer: NodeJS.Timeout | null = null;
	#tickTimer: NodeJS.Timeout | null = null;
	#attempt = 0;
	/** Set while attempts keep failing, so an outage is logged once rather than every 2 s. */
	#failing = false;
	#state: ConnState = "offline";
	#hello: HelloEvt | null = null;
	#inst: string | null = null;
	#watchSent = false;
	#lastEventAt = 0;
	#busy = false;
	#busyEndedAt = 0;
	/** The lines still waiting for their `ok`, oldest first. */
	#okQueue: SentLine[] = [];
	/** Lines written on this connection; the newest line's `seq`. */
	#lineSeq = 0;
	/** The newest ping a pong has answered, waiting for okResyncMs before the `ok`s it vouches for are settled; 0 when none. */
	#resyncSeq = 0;
	#resyncAt = 0;
	#lastPingAt = 0;
	#nextId = 1;
	readonly #requests = new Map<number, PendingRequest>();
	readonly #errRoutes = new Map<number, { onErr: (err: ErrEvt) => void; expires: number }>();
	/** Pings waiting for their pong: when each went out, and its line number. */
	readonly #pings = new Map<number, SentLine>();

	constructor(opts: ClientOptions) {
		this.#host = opts.host ?? "127.0.0.1";
		this.#cmdPort = opts.cmdPort ?? DEFAULT_CMD_PORT;
		this.#evtPort = opts.evtPort ?? DEFAULT_EVT_PORT;
		this.#client = opts.client ?? "deck";
		this.#ver = opts.ver;
		this.#timing = { ...DEFAULT_TIMING, ...opts.timing };
		this.#log = opts.log ?? nullLog;
		this.#events = new Emitter<ClientEvents>(this.#log);
		this.#watch = [...new Set(opts.watch ?? [])];
	}

	get state(): ConnState {
		return this.#state;
	}

	/** The current connection's hello, if Lightroom has sent one. */
	get hello(): HelloEvt | null {
		return this.#hello;
	}

	/** The last plugin instance seen; it survives reconnects. */
	get inst(): string | null {
		return this.#inst;
	}

	get connected(): boolean {
		return this.#cmdUp && this.#evtUp;
	}

	on<K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void): () => void {
		return this.#events.on(event, listener);
	}

	/** Connects, and keeps reconnecting until {@link stop}. */
	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#log.info(`connecting to Lightroom on ${this.#host}, commands ${this.#cmdPort}, events ${this.#evtPort}`);
		this.#connect();
	}

	stop(): void {
		if (!this.#running) return;
		this.#running = false;
		this.#clearReconnect();
		const wasUp = this.connected;
		this.#teardown();
		this.#updateState();
		if (wasUp) this.#events.emit("disconnect", "stopped");
	}

	/** Drops both sockets and reconnects at once, resetting the backoff: after the Mac wakes up, for example. */
	reconnectNow(reason: string): void {
		if (!this.#running) return;
		this.#log.info(`reconnecting to Lightroom: ${reason}`);
		this.#clearReconnect();
		const wasUp = this.connected;
		this.#teardown();
		this.#attempt = 0;
		this.#updateState();
		if (wasUp) this.#events.emit("disconnect", reason);
		if (this.#running) this.#connect();
	}

	/** Replaces the watched params, and sends `watch` now if a session is up. */
	setWatch(params: readonly string[]): void {
		this.#watch = [...new Set(params)];
		if (this.#hello?.v === PROTOCOL_VERSION && this.connected) this.#sendWatch();
	}

	/**
	 * Sends a command without waiting for a reply. Returns false when it can't go out: no session, a version
	 * mismatch (only hello and ping go out then), or a command that fails validation.
	 */
	send(cmd: Command, opts?: SendOptions): boolean {
		if (!this.#canSend(cmd.t)) return false;
		if (!opts?.onErr) return this.#write(cmd);
		const id = this.#allocId();
		this.#errRoutes.set(id, { onErr: opts.onErr, expires: monotonic() + this.#timing.errRouteTtlMs });
		const ok = this.#write({ ...cmd, id } as Command);
		if (!ok) this.#errRoutes.delete(id);
		return ok;
	}

	/** Sends a command that has a reply (ping, presets, preset, reload) and resolves with the reply, or rejects with an {@link LrError}. */
	request(input: RequestInput, opts?: { timeoutMs?: number }): Promise<LrEvent> {
		const reply = REPLY_TYPE[input.t];
		if (!this.#canSend(input.t)) {
			const code = this.#state === "mismatch" ? "mismatch" : "offline";
			return Promise.reject(new LrError(code, `can't send ${input.t}: Lightroom is ${this.#state}`));
		}
		const id = this.#allocId();
		const cmd = { ...input, id } as RequestCommand;
		const timeoutMs = opts?.timeoutMs ?? this.#timing.requestTimeoutMs;
		return new Promise<LrEvent>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.#requests.delete(id)) reject(new LrError("timeout", `no ${reply} for ${input.t} ${id} within ${timeoutMs} ms`));
			}, timeoutMs);
			this.#requests.set(id, { reply, resolve, reject, timer });
			if (!this.#write(cmd)) {
				clearTimeout(timer);
				this.#requests.delete(id);
				reject(new LrError("invalid", `couldn't send ${input.t}`));
			}
		});
	}

	// ---- connection ----

	#connect(): void {
		this.#clearReconnect();
		const gen = ++this.#gen;
		this.#cmdUp = false;
		this.#evtUp = false;
		const evt = net.createConnection({ host: this.#host, port: this.#evtPort });
		const cmd = net.createConnection({ host: this.#host, port: this.#cmdPort });
		this.#evt = evt;
		this.#cmd = cmd;
		const evtLines = new LineSplitter();
		const cmdLines = new LineSplitter();
		for (const [side, sock] of [
			["evt", evt],
			["cmd", cmd],
		] as const) {
			let lastError: string | null = null;
			sock.setNoDelay(true);
			sock.on("connect", () => {
				if (gen !== this.#gen) return;
				if (side === "evt") this.#evtUp = true;
				else this.#cmdUp = true;
				this.#maybeUp(gen);
			});
			// Both sockets are always read: the command socket's `ok`s must never fill its buffer.
			sock.on("data", (chunk: Buffer) => {
				if (gen !== this.#gen) return;
				if (side === "evt") this.#onEventLines(gen, evtLines.push(chunk));
				else this.#onCommandLines(cmdLines.push(chunk));
			});
			sock.on("error", (err: NodeJS.ErrnoException) => {
				lastError = err.code ?? err.message;
			});
			sock.on("close", () => this.#lost(gen, side, lastError ?? "closed"));
		}
		this.#connectTimer = setTimeout(() => {
			if (gen === this.#gen && !this.connected) this.#lost(gen, "connect", `timed out after ${this.#timing.connectTimeoutMs} ms`);
		}, this.#timing.connectTimeoutMs);
	}

	#maybeUp(gen: number): void {
		if (!this.#cmdUp || !this.#evtUp) return;
		if (this.#connectTimer) clearTimeout(this.#connectTimer);
		this.#connectTimer = null;
		const now = monotonic();
		this.#lastEventAt = now;
		this.#lastPingAt = now;
		this.#busy = false;
		this.#busyEndedAt = 0;
		this.#okQueue = [];
		this.#lineSeq = 0;
		this.#resyncSeq = 0;
		this.#hello = null;
		this.#watchSent = false;
		this.stats.connects += 1;
		if (this.#failing) this.#log.info("reached Lightroom again");
		this.#failing = false;
		this.#log.info("both sockets connected; saying hello");
		this.#events.emit("connect");
		if (gen !== this.#gen) return;
		this.#write({ t: "hello", v: PROTOCOL_VERSION, client: this.#client, ver: this.#ver });
		this.#tickTimer = setInterval(() => this.#tick(gen), this.#timing.tickMs);
		this.#updateState();
	}

	/** The pair rule: one socket closed, errored or failed to connect, so both go, and both reconnect. */
	#lost(gen: number, side: string, reason: string): void {
		if (gen !== this.#gen) return;
		const wasUp = this.connected;
		this.#teardown();
		if (wasUp) {
			this.stats.disconnects += 1;
			this.#log.info(`lost Lightroom (${side}: ${reason}); closing both sockets and reconnecting`);
		} else if (!this.#failing) {
			this.#failing = true;
			this.#log.info(`can't reach Lightroom (${side}: ${reason}); retrying, backing off to ${this.#timing.backoffMaxMs} ms`);
		} else {
			this.#log.trace(`still can't reach Lightroom (${side}: ${reason})`);
		}
		this.#updateState();
		if (wasUp) this.#events.emit("disconnect", `${side}: ${reason}`);
		if (this.#running && this.#reconnectTimer === null && gen + 1 === this.#gen) this.#scheduleReconnect();
	}

	#teardown(): void {
		this.#gen += 1;
		for (const sock of [this.#cmd, this.#evt]) sock?.destroy();
		this.#cmd = null;
		this.#evt = null;
		this.#cmdUp = false;
		this.#evtUp = false;
		if (this.#connectTimer) clearTimeout(this.#connectTimer);
		if (this.#tickTimer) clearInterval(this.#tickTimer);
		this.#connectTimer = null;
		this.#tickTimer = null;
		this.#okQueue = [];
		this.#resyncSeq = 0;
		this.#hello = null;
		this.#busy = false;
		const requests = [...this.#requests.values()];
		this.#requests.clear();
		for (const req of requests) {
			clearTimeout(req.timer);
			req.reject(new LrError("disconnected", "the connection to Lightroom closed"));
		}
		this.#errRoutes.clear();
		this.#pings.clear();
	}

	#scheduleReconnect(): void {
		const delay = backoffDelay(this.#attempt, this.#timing);
		this.#attempt += 1;
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = null;
			if (this.#running) this.#connect();
		}, delay);
	}

	#clearReconnect(): void {
		if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = null;
	}

	// ---- incoming ----

	#onCommandLines(lines: string[]): void {
		for (const line of lines) {
			const text = line.trim();
			if (text === "ok") this.#onOk();
			else if (text !== "") {
				this.stats.badLines += 1;
				this.#log.warn(`unexpected line on Lightroom's command socket: ${clip(text)}`);
			}
		}
	}

	/** LrSocket's receive mode answers every line with `ok`: match it to the oldest waiting line. */
	#onOk(): void {
		this.stats.oks += 1;
		const sent = this.#okQueue.shift();
		if (sent === undefined) {
			this.stats.extraOks += 1;
			return;
		}
		const now = monotonic();
		const ms = now - sent.at;
		const lat = this.stats.okLatencyMs;
		lat.last = ms;
		lat.avg = lat.avg === 0 ? ms : lat.avg * 0.9 + ms * 0.1;
		lat.max = Math.max(lat.max, ms);
		this.#checkBusy(now);
	}

	#onEventLines(gen: number, lines: string[]): void {
		for (const line of lines) {
			if (gen !== this.#gen) return;
			this.#lastEventAt = monotonic();
			if (line.trim() === "") continue;
			let raw: unknown;
			try {
				raw = JSON.parse(line);
			} catch {
				this.stats.badLines += 1;
				this.#log.warn(`Lightroom sent a line that isn't JSON: ${clip(line)}`);
				continue;
			}
			const parsed = parseEvent(raw);
			if (parsed.kind === "invalid") {
				this.stats.invalidEvents += 1;
				this.#log.warn(`ignoring an invalid event (${parsed.why}): ${clip(line)}`);
				continue;
			}
			if (parsed.kind === "ignored") {
				this.stats.ignoredEvents += 1;
				this.#log.debug(`ignoring ${parsed.why}`);
				continue;
			}
			if (parsed.dropped.length > 0) this.#log.debug(`dropped badly typed fields (${parsed.dropped.join(", ")}) from ${clip(line)}`);
			this.stats.events += 1;
			this.#log.trace(`< ${clip(line)}`);
			this.#handle(gen, parsed.evt);
		}
	}

	#handle(gen: number, evt: LrEvent): void {
		if (evt.t === "hello") {
			this.#onHello(gen, evt);
			return;
		}
		if (evt.t === "pong" && evt.id !== undefined) {
			const ping = this.#pings.get(evt.id);
			if (ping !== undefined) {
				this.#pings.delete(evt.id);
				const now = monotonic();
				this.stats.pingRttMs = now - ping.at;
				// Lightroom took this ping, so it took every line before it too; #resyncOks settles their `ok`s.
				if (ping.seq > this.#resyncSeq) {
					this.#resyncSeq = ping.seq;
					this.#resyncAt = now;
				}
			}
		}
		if (evt.t === "err") this.#logErr(evt);
		this.#route(evt);
		if (gen !== this.#gen) return;
		this.#events.emit("event", evt);
	}

	#onHello(gen: number, evt: HelloEvt): void {
		this.#hello = evt;
		this.#attempt = 0; // a real session: the next outage starts the backoff again
		if (evt.v !== PROTOCOL_VERSION) {
			if (this.#state !== "mismatch") {
				this.#log.warn(`Lightroom's DeckBridge speaks protocol v${evt.v}, this plugin speaks v${PROTOCOL_VERSION}: sending only hello and ping until they match`);
			}
			this.#events.emit("event", evt);
			if (gen === this.#gen) this.#updateState();
			return;
		}
		const prev = this.#inst;
		const changed = evt.inst !== undefined && evt.inst !== prev;
		if (changed && evt.inst !== undefined) {
			this.#inst = evt.inst;
			if (prev !== null) this.#log.info(`Lightroom's DeckBridge instance changed (${prev} → ${evt.inst}): dropping cached values and watching again`);
			this.#events.emit("inst", evt.inst, prev);
			if (gen !== this.#gen) return;
		}
		this.#events.emit("event", evt);
		if (gen !== this.#gen) return;
		this.#updateState();
		if (!this.#watchSent || changed) this.#sendWatch();
	}

	#sendWatch(): void {
		if (this.#watch.length === 0) {
			this.#watchSent = true;
			return;
		}
		if (this.#write({ t: "watch", ps: [...this.#watch] })) this.#watchSent = true;
	}

	/** Hands a reply to the request or error callback waiting for its `id`. */
	#route(evt: LrEvent): void {
		const id = "id" in evt ? evt.id : undefined;
		if (id === undefined) return;
		const req = this.#requests.get(id);
		if (req) {
			if (evt.t === "err") {
				this.#requests.delete(id);
				clearTimeout(req.timer);
				req.reject(new LrError(evt.code, evt.msg ?? evt.code, evt));
			} else if (evt.t === req.reply) {
				this.#requests.delete(id);
				clearTimeout(req.timer);
				req.resolve(evt);
			}
			return;
		}
		if (evt.t === "err") {
			const route = this.#errRoutes.get(id);
			if (route) {
				this.#errRoutes.delete(id);
				try {
					route.onErr(evt);
				} catch (err) {
					this.#log.error(`error callback threw: ${describeError(err)}`);
				}
			}
		}
	}

	#logErr(evt: ErrEvt): void {
		const what = `Lightroom refused ${evt.cmd ?? "a command"}${evt.id !== undefined ? ` (id ${evt.id})` : ""}: ${evt.code}${evt.msg ? ` (${evt.msg})` : ""}`;
		// Refusals that are part of normal use: the guard, and a set that crossed a photo change (stale).
		if (evt.code === "guard" || evt.code === "stale") this.#log.info(what);
		else this.#log.warn(what);
	}

	// ---- outgoing ----

	#canSend(t: CommandType): boolean {
		if (!this.#cmd || !this.connected) return false;
		if (t === "hello" || t === "ping") return true;
		return this.#hello !== null && this.#hello.v === PROTOCOL_VERSION;
	}

	#write(cmd: Command): boolean {
		const problems = validateCommand(cmd);
		if (problems.length > 0) {
			this.#log.error(`not sending an invalid command ${clip(JSON.stringify(cmd))}: ${problems.join("; ")}`);
			return false;
		}
		const sock = this.#cmd;
		if (!sock || sock.destroyed || !this.#cmdUp) return false;
		const line = JSON.stringify(cmd);
		sock.write(`${line}\n`);
		this.#lineSeq += 1;
		this.#okQueue.push({ seq: this.#lineSeq, at: monotonic() });
		if (this.#okQueue.length > 10_000) this.#okQueue.splice(0, this.#okQueue.length - 10_000);
		this.stats.linesSent += 1;
		this.#log.trace(`> ${clip(line)}`);
		return true;
	}

	#allocId(): number {
		const id = this.#nextId;
		this.#nextId = this.#nextId >= 2 ** 31 - 1 ? 1 : this.#nextId + 1;
		return id;
	}

	// ---- heartbeat ----

	#tick(gen: number): void {
		if (gen !== this.#gen) return;
		const now = monotonic();
		for (const [id, route] of this.#errRoutes) if (route.expires <= now) this.#errRoutes.delete(id);
		for (const [id, ping] of this.#pings) if (now - ping.at > 60_000) this.#pings.delete(id);
		if (now - this.#lastPingAt >= this.#timing.pingIntervalMs) {
			this.#lastPingAt = now;
			const id = this.#allocId();
			if (this.#write({ t: "ping", id })) this.#pings.set(id, { seq: this.#lineSeq, at: now });
		}
		this.#resyncOks(now);
		this.#checkBusy(now);
		if (gen !== this.#gen || this.#busy) return;
		// Quiet since the last event, or since Lightroom started taking lines again after being busy.
		const quietMs = now - Math.max(this.#lastEventAt, this.#busyEndedAt);
		if (quietMs >= this.#timing.staleMs) {
			this.stats.staleReconnects += 1;
			this.#log.warn(`no event from Lightroom for ${Math.round(quietMs)} ms although it takes commands: the event socket is stale`);
			this.#lost(gen, "evt", "stale");
		}
	}

	/**
	 * `ok`s are matched to lines by count, so a lost one would leave a line that Lightroom took waiting for
	 * ever, and the busy check would flip to busy whenever traffic paused. A pong settles that: every line up
	 * to its ping was taken, so any of them still waiting okResyncMs after the pong lost its `ok`. The wait
	 * lets a pong that beat its ping's `ok` (another socket) be followed by that `ok`, matched as usual.
	 */
	#resyncOks(now: number): void {
		if (this.#resyncSeq === 0 || now - this.#resyncAt < this.#timing.okResyncMs) return;
		const upTo = this.#resyncSeq;
		this.#resyncSeq = 0;
		let lost = 0;
		while (this.#okQueue.length > 0 && (this.#okQueue[0]?.seq ?? Number.POSITIVE_INFINITY) <= upTo) {
			this.#okQueue.shift();
			lost += 1;
		}
		if (lost === 0) return;
		this.stats.lostOks += lost;
		this.#log.warn(`${lost} line(s) that Lightroom took (a later pong says so) never got their ok; no longer waiting for them`);
	}

	#checkBusy(now: number): void {
		const oldest = this.#okQueue[0];
		const overdue = oldest !== undefined && now - oldest.at >= this.#timing.okWindowMs;
		if (overdue === this.#busy) return;
		this.#busy = overdue;
		if (overdue) {
			this.stats.busyEpisodes += 1;
			this.#log.info(`Lightroom hasn't taken a line for ${Math.round(now - (oldest?.at ?? now))} ms: busy (a menu, dialog or the Plug-in Manager is open?), waiting`);
		} else {
			this.#busyEndedAt = now;
			this.#log.info("Lightroom is taking lines again");
		}
		this.#updateState();
	}

	#updateState(): void {
		let next: ConnState;
		if (!this.connected) next = "offline";
		else if (this.#hello && this.#hello.v !== PROTOCOL_VERSION) next = "mismatch";
		else if (this.#busy) next = "busy";
		else if (this.#hello) next = "online";
		else next = "offline";
		if (next === this.#state) return;
		const prev = this.#state;
		this.#state = next;
		this.#log.info(`Lightroom connection: ${prev} → ${next}`);
		this.#events.emit("state", next, prev);
	}
}
