import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { isObj, type Obj, ROUTES } from "../protocol/wire.js";
import { type Clock, realClock } from "../util/clock.js";
import { describeError, type Log, nullLog, quote, redacting, Scrubber } from "../util/log.js";
import { QuietLog } from "../util/quiet-log.js";
import type { PollReply } from "./commands.js";
import { allowedHosts, BRIDGE_HOST, MAX_BODY_BYTES } from "./config.js";
import { checkBearer } from "./token.js";

export type BridgeState = "starting" | "listening" | "retrying" | "stopped";

/**
 * A route's answer: a status, and a JSON body unless the status is 204. `logged`: the route has logged a refusal
 * itself, quietly (a 409 hello, say), so the bridge's own line for it goes at debug.
 */
export type RouteAnswer = { status: number; body?: unknown; logged?: boolean };

/**
 * What the bridge does with each route, once the Host, the token, the method and the body have passed.
 * The deck's session model implements it (src/model/sessions.ts). `permission` and `next` may hold their
 * request; the others answer at once. `permission`, `pretool` and `hello` may first read the registry once more
 * (PROTOCOL.md, Desktop sessions only), and then return a promise that settles once they have answered or held
 * the request.
 */
export interface BridgeRoutes {
	/**
	 * `POST /v1/permission`: the hook's input, and the `X-Deck-Host` header as sent. `inputScrubbed`: the token scrub
	 * changed something inside the body's `tool_input` (scrubJson), so that input as it came is gone, and an `ask`
	 * request is display-only (PROTOCOL.md, Held requests).
	 */
	permission(body: unknown, deckHost: string | undefined, reply: PollReply, inputScrubbed: boolean): void | Promise<void>;
	/** `POST /v1/pretool`: the mode hook's input, and the `X-Deck-Host` header as sent. Answered, never held. */
	pretool(body: unknown, deckHost: string | undefined, reply: PollReply): void | Promise<void>;
	hello(body: Obj): RouteAnswer | Promise<RouteAnswer>;
	events(body: Obj): RouteAnswer;
	/** `GET /v1/next`: held, or answered at once, with 409 `hello first` for a session no instance has said hello for. */
	next(query: URLSearchParams, reply: PollReply): void;
	result(body: Obj): RouteAnswer;
}

export type BridgeOptions = {
	/** BRIDGE_PORT in the plugin; 0 (any free port) in tests. */
	port: number;
	host?: string;
	token: string;
	routes: BridgeRoutes;
	log?: Log;
	maxBodyBytes?: number;
	/** Node's server options, for tests that shorten its timeouts. */
	http?: http.ServerOptions;
	/** Times the quiet logging of refused requests; a fake one in tests. */
	clock?: Clock;
};

/** Listen retries back off from 1 s to 30 s: the port may be busy, and macOS 26 can refuse loopback for a while after boot. */
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];

/** The status Node answers each of its own errors with (its `socketOnError`); any other is 400. */
const CLIENT_ERRORS: Record<string, number> = { HPE_HEADER_OVERFLOW: 431, HPE_CHUNK_EXTENSIONS_OVERFLOW: 413, ERR_HTTP_REQUEST_TIMEOUT: 408 };

const METHODS: Record<string, "GET" | "POST"> = {
	[ROUTES.permission]: "POST",
	[ROUTES.pretool]: "POST",
	[ROUTES.hello]: "POST",
	[ROUTES.events]: "POST",
	[ROUTES.next]: "GET",
	[ROUTES.result]: "POST",
};

/**
 * The bridge: HTTP/1.1 on 127.0.0.1 (PROTOCOL.md, Transport). In order: a Host other than 127.0.0.1:<port> or
 * localhost:<port> gets 403; a missing or wrong bearer token 401; an unknown route 404; a wrong method 405; a
 * body over the limit 413; a body that isn't JSON 400. Error answers are `{"error": "<reason>"}`. No CORS
 * headers. The token is never logged, nor is any header that might hold it. A 403 or 401 is logged quietly,
 * since a client with a stale token keeps trying: the first per route and reason at info, then at most one
 * info line in 10 minutes, with the count since, and the rest at debug.
 */
export class BridgeServer {
	readonly #opts: Required<Omit<BridgeOptions, "http" | "clock">> & { http: http.ServerOptions };
	/** Takes the token out of what clients send, and out of the log. */
	readonly #scrubber: Scrubber;
	/** The 403s and 401s, keyed by route and reason. */
	readonly #refusals: QuietLog;
	readonly #listeners = new Set<(state: BridgeState) => void>();
	#server: http.Server | null = null;
	#state: BridgeState = "stopped";
	#port: number | null = null;
	#retry = 0;
	#retryTimer: ReturnType<typeof setTimeout> | null = null;
	#routed = 0;

	constructor(opts: BridgeOptions) {
		this.#scrubber = new Scrubber(opts.token);
		this.#opts = {
			port: opts.port,
			host: opts.host ?? BRIDGE_HOST,
			token: opts.token,
			routes: opts.routes,
			// Belt and braces: the token can't reach the log even if a client puts it in a path.
			log: redacting(opts.log ?? nullLog, this.#scrubber),
			maxBodyBytes: opts.maxBodyBytes ?? MAX_BODY_BYTES,
			http: opts.http ?? {},
		};
		this.#refusals = new QuietLog(this.#opts.log, { clock: opts.clock ?? realClock });
	}

	get state(): BridgeState {
		return this.#state;
	}

	/** The port it listens on, once listening. */
	get port(): number | null {
		return this.#port;
	}

	/**
	 * How many requests a route has taken so far: answered, or held for an answer later, after any second reading
	 * of the registry it made first. The fixture runner waits on it to keep requests in order.
	 */
	get routed(): number {
		return this.#routed;
	}

	onState(listener: (state: BridgeState) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Listens once; rejects if that fails. Tests use this. */
	listen(): Promise<number> {
		this.#setState("starting");
		return new Promise((resolve, reject) => {
			const server = this.#makeServer();
			const onError = (err: Error): void => {
				server.close();
				reject(err);
			};
			server.once("error", onError);
			server.listen(this.#opts.port, this.#opts.host, () => {
				server.off("error", onError);
				server.on("error", (err) => this.#opts.log.error(`server error: ${describeError(err)}`));
				const address = server.address();
				this.#port = typeof address === "object" && address ? address.port : this.#opts.port;
				this.#server = server;
				this.#retry = 0;
				this.#setState("listening");
				resolve(this.#port);
			});
		});
	}

	/** Listens, retrying with backoff until it can. The plugin uses this. */
	start(): void {
		if (this.#state === "listening" || this.#state === "starting" || this.#retryTimer !== null) return;
		const { host, port, log } = this.#opts;
		this.listen().then(
			(bound) => log.info(`listening on ${host}:${bound}`),
			(err: unknown) => {
				const code = (err as NodeJS.ErrnoException).code ?? describeError(err);
				const wait = RETRY_MS[Math.min(this.#retry, RETRY_MS.length - 1)] ?? 30_000;
				this.#retry++;
				log.error(`can't listen on ${host}:${port} (${code}); retrying in ${wait / 1000} s`);
				this.#setState("retrying");
				this.#retryTimer = setTimeout(() => {
					this.#retryTimer = null;
					this.start();
				}, wait);
			},
		);
	}

	/** Stops listening and drops every connection, held ones included, without an answer. */
	async stop(): Promise<void> {
		if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
		this.#retryTimer = null;
		const server = this.#server;
		this.#server = null;
		this.#port = null;
		this.#setState("stopped");
		if (!server) return;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
	}

	#setState(state: BridgeState): void {
		if (state === this.#state) return;
		this.#state = state;
		for (const listener of [...this.#listeners]) listener(state);
	}

	#makeServer(): http.Server {
		const server = http.createServer(
			{
				// Bodies arrive at once from a local client. These bound only receiving a request; a request that has
				// arrived and is held isn't subject to them (test/server.test.ts checks that).
				headersTimeout: 10_000,
				requestTimeout: 30_000,
				...this.#opts.http,
			},
			(req, res) => this.#handle(req, res),
		);
		server.on("clientError", (err: NodeJS.ErrnoException, socket: Socket) => this.#clientError(err, socket));
		return server;
	}

	/**
	 * A request Node takes no further: one it can't parse, with headers over its limit, or too slow to arrive. Node's
	 * own answer has no body; this one carries `{"error"}` like every other. As Node's does, it goes only where it
	 * can't cut into another answer, here a connection with nothing written to it yet, and the connection is dropped.
	 * A client that has gone (ECONNRESET) gets nothing.
	 */
	#clientError(err: NodeJS.ErrnoException, socket: Socket): void {
		if (err.code !== "ECONNRESET" && socket.writable && socket.bytesWritten === 0) {
			const status = CLIENT_ERRORS[err.code ?? ""] ?? 400;
			this.#opts.log.info(`REQ ${status}: Node couldn't take the request (${err.code ?? "no code"})`);
			const text = JSON.stringify({ error: http.STATUS_CODES[status] ?? "error" });
			socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ""}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`);
		}
		socket.destroy();
	}

	/**
	 * Text from a client, made fit for the log: the token taken out before anything is cut short (a cut might
	 * leave too little of it to recognise), then quoted and cut.
	 */
	#show(value: string | null | undefined, max = 60): string {
		return quote(value === null || value === undefined ? value : this.#scrubber.scrub(value), max);
	}

	#handle(req: IncomingMessage, res: ServerResponse): void {
		const { log, token, routes } = this.#opts;
		// Node's parser only lets through methods it knows, so the method is safe to log as it is.
		const method = req.method ?? "?";
		const url = req.url ?? "";
		const q = url.indexOf("?");
		const target = q < 0 ? url : url.slice(0, q);
		const queryString = q < 0 ? "" : url.slice(q + 1);
		const what = `${method} ${this.#show(target)}`;
		const allowed = methodFor(target);
		/** `quiet`: the reason's name, when the client is apt to repeat it; the line is then logged quietly. */
		const refuse = (status: number, why: string, headers: Record<string, string> = {}, quiet?: string): void => {
			const line = `REQ ${status} ${what}: ${why}`;
			// Keyed by route and reason. Every path that isn't a route shares one key, so no client can make many.
			if (quiet === undefined) log.info(line);
			else this.#refusals.note(`${allowed === undefined ? "another path" : target} ${quiet}`, line);
			// The reason stays in the log: the answer names only the status, never echoing what the client sent.
			reply(res, status, { error: http.STATUS_CODES[status] ?? "error" }, headers);
			// Drop the rest of any body without reading it.
			req.resume();
		};

		const host = req.headers.host;
		const port = this.#port ?? this.#opts.port;
		if (host === undefined || !allowedHosts(port).includes(host.toLowerCase())) {
			refuse(403, `Host ${this.#show(host)} isn't 127.0.0.1:${port} or localhost:${port}`, {}, "bad Host");
			return;
		}
		const auth = checkBearer(req.headers.authorization, token);
		if (auth !== "ok") {
			const why = auth === "missing" ? "no token" : "wrong token";
			refuse(401, why, { "www-authenticate": 'Bearer realm="streamdeck"' }, why);
			return;
		}
		if (allowed === undefined) {
			refuse(404, "no such route");
			return;
		}
		if (method !== allowed) {
			refuse(405, `only ${allowed}`, { allow: allowed });
			return;
		}

		if (target === ROUTES.next) {
			req.resume();
			// The token is taken out of the query as it is out of bodies, once decoded, so nothing cut from it later
			// (the mod's inst in a log line, say) can carry part of it.
			const query = new URLSearchParams();
			for (const [name, value] of new URLSearchParams(queryString)) query.append(this.#scrubber.scrub(name), this.#scrubber.scrub(value));
			this.#guard(what, res, () => routes.next(query, this.#heldReply(req, res)));
			return;
		}

		readBody(req, this.#opts.maxBodyBytes).then(
			(text) => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(text);
				} catch {
					refuse(400, `the body isn't JSON (${Buffer.byteLength(text)} bytes)`);
					return;
				}
				const hook = target === ROUTES.permission || target === ROUTES.pretool;
				// A hook's body is Claude Code's, and its route answers whatever it is; the mod's are objects.
				if (!hook && !isObj(parsed)) {
					refuse(400, "the body isn't a JSON object");
					return;
				}
				this.#guard(what, res, () => {
					// With the token taken out of every string first, nothing cut from the body later (a tool's summary
					// on a key, a line in the log) can carry part of it. It's taken out after parsing, since a run of the
					// token's digits in the raw text could be part of a number. It can't fail on a body that parsed,
					// however long its strings or deep its nesting, so a valid body never gets 400 for it; were it to
					// throw all the same, the guard answers 500 and the bridge carries on. A PermissionRequest whose
					// tool_input it changed goes to the route flagged: that input can't go back as it came.
					const { body, inputScrubbed } = scrubJson(parsed, this.#scrubber);
					if (hook) {
						const header = req.headers["x-deck-host"];
						const deckHost = typeof header === "string" ? header : undefined;
						const held = this.#heldReply(req, res);
						return target === ROUTES.permission ? routes.permission(body, deckHost, held, inputScrubbed) : routes.pretool(body, deckHost, held);
					}
					const obj = body as Obj;
					const answer = target === ROUTES.hello ? routes.hello(obj) : target === ROUTES.events ? routes.events(obj) : routes.result(obj);
					if (answer instanceof Promise) return answer.then((a) => this.#answer(what, res, a));
					this.#answer(what, res, answer);
				});
			},
			(err: unknown) => {
				if (err instanceof TooLarge) refuse(413, `the body is over ${this.#opts.maxBodyBytes} bytes`);
				else log.info(`REQ ${what}: the client went away while sending its body (${describeError(err).split("\n")[0]})`);
			},
		);
	}

	/** Sends a route's answer, with a log line: at info for an error, unless the route has logged it already. */
	#answer(what: string, res: ServerResponse, answer: RouteAnswer): void {
		const line = `REQ ${answer.status} ${what}`;
		if (answer.status < 400) this.#opts.log.debug(line);
		else if (answer.logged) this.#opts.log.debug(`${line}: ${JSON.stringify(answer.body ?? null)}`);
		else this.#opts.log.info(`${line}: ${JSON.stringify(answer.body ?? null)}`);
		reply(res, answer.status, answer.body, {});
	}

	/**
	 * Runs a route, with the scrubbing of its body, and counts the request as routed once the route has answered or
	 * held it, which may come after a promise. Whatever throws there, or rejects, gets a 500 for its client and a
	 * log line, and the bridge carries on.
	 */
	#guard(what: string, res: ServerResponse, run: () => void | Promise<void>): void {
		const failed = (err: unknown): void => {
			this.#opts.log.error(`${what} failed: ${describeError(err)}`);
			reply(res, 500, { error: "internal error" }, {});
		};
		let taking: void | Promise<void>;
		try {
			taking = run();
		} catch (err) {
			failed(err);
			this.#routed++;
			return;
		}
		if (!(taking instanceof Promise)) {
			this.#routed++;
			return;
		}
		taking.then(
			() => {
				this.#routed++;
			},
			(err: unknown) => {
				failed(err);
				this.#routed++;
			},
		);
	}

	/** The answer handle for a request a route may hold. */
	#heldReply(req: IncomingMessage, res: ServerResponse): PollReply {
		let answered = false;
		const onClose: (() => void)[] = [];
		const closed = (): void => {
			if (answered) return;
			answered = true;
			for (const fn of onClose.splice(0)) fn();
		};
		res.once("close", closed);
		return {
			get open() {
				return !answered && !res.writableEnded && !res.destroyed && !req.socket.destroyed;
			},
			send(status, text) {
				if (answered) return;
				answered = true;
				onClose.length = 0;
				if (res.destroyed || res.headersSent) return;
				res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
				res.end(text);
			},
			onClose(fn) {
				if (answered) return;
				onClose.push(fn);
				// The client may already be gone, before the listener was in place.
				if (req.socket.destroyed) closed();
			},
		};
	}
}

class TooLarge extends Error {}

/** The method a route takes; undefined for a path that isn't one, such as "__proto__". */
function methodFor(target: string): "GET" | "POST" | undefined {
	return Object.hasOwn(METHODS, target) ? METHODS[target] : undefined;
}

/**
 * A parsed body with the token taken out of every string in it, names included (see Scrubber), and whether that
 * changed anything inside the body's own `tool_input`, the input itself included when it's a string: a value or a
 * name at any depth (`inputScrubbed`). A change anywhere else, a transcript path say, doesn't count. The body is
 * changed in place, since nothing else holds it, and walked from a list of the objects and arrays still to visit
 * rather than by recursion, so no depth of nesting can overflow the stack.
 */
function scrubJson(body: unknown, scrubber: Scrubber): { body: unknown; inputScrubbed: boolean } {
	if (typeof body === "string") return { body: scrubber.scrub(body), inputScrubbed: false };
	let inputScrubbed = false;
	// Beside each object or array still to visit, whether it's the body's tool_input or inside it.
	const todo: unknown[] = [body];
	const inInput: boolean[] = [false];
	while (todo.length > 0) {
		const value = todo.pop();
		const inside = inInput.pop() === true;
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length; i++) {
				const v: unknown = value[i];
				if (typeof v === "string") {
					const s = scrubber.scrub(v);
					if (inside && s !== v) inputScrubbed = true;
					value[i] = s;
				} else if (typeof v === "object" && v !== null) {
					todo.push(v);
					inInput.push(inside);
				}
			}
		} else if (isObj(value)) {
			let renamed = false;
			for (const k of Object.keys(value)) {
				const v = value[k];
				const input = inside || (value === body && k === "tool_input");
				if (typeof v === "string") {
					const s = scrubber.scrub(v);
					if (input && s !== v) inputScrubbed = true;
					value[k] = s;
				} else if (typeof v === "object" && v !== null) {
					todo.push(v);
					inInput.push(input);
				}
				if (scrubber.scrub(k) !== k) {
					renamed = true;
					if (inside) inputScrubbed = true;
				}
			}
			if (!renamed) continue;
			// The names go back in their order, each defined as JSON.parse defines it, so a "__proto__" among them
			// stays an ordinary key; of two names that scrub alike, the later value wins, in the earlier's place.
			const entries = Object.entries(value);
			for (const [k] of entries) delete value[k];
			for (const [k, v] of entries) Object.defineProperty(value, scrubber.scrub(k), { value: v, writable: true, enumerable: true, configurable: true });
		}
	}
	return { body, inputScrubbed };
}

/** Reads a request body as UTF-8, failing with TooLarge past `max` bytes, or with the error if the client aborts. */
function readBody(req: IncomingMessage, max: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let done = false;
		const finish = (fn: () => void): void => {
			if (done) return;
			done = true;
			fn();
		};
		req.on("data", (chunk: Buffer) => {
			if (done) return;
			size += chunk.length;
			if (size > max) {
				finish(() => reject(new TooLarge()));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => finish(() => resolve(Buffer.concat(chunks).toString("utf8"))));
		req.on("error", (err) => finish(() => reject(err)));
		req.on("aborted", () => finish(() => reject(new Error("aborted"))));
		req.on("close", () => finish(() => reject(new Error("closed before the body ended"))));
	});
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
	if (res.headersSent || res.destroyed) return;
	if (status === 204 || body === undefined) {
		res.writeHead(status, headers);
		res.end();
		return;
	}
	const text = JSON.stringify(body);
	res.writeHead(status, { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(text) });
	res.end(text);
}
