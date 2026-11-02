import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { isObj, type Obj, ROUTES } from "../protocol/wire.js";
import { describeError, type Log, nullLog, quote, redacting, scrub } from "../util/log.js";
import type { PollReply } from "./commands.js";
import { allowedHosts, BRIDGE_HOST, MAX_BODY_BYTES } from "./config.js";
import { checkBearer } from "./token.js";

export type BridgeState = "starting" | "listening" | "retrying" | "stopped";

/** A route's answer: a status, and a JSON body unless the status is 204. */
export type RouteAnswer = { status: number; body?: unknown };

/**
 * What the bridge does with each route, once the Host, the token, the method and the body have passed.
 * The deck's session model implements it (src/model/sessions.ts). `permission` and `next` may hold their
 * request; the others answer at once.
 */
export interface BridgeRoutes {
	/** `POST /v1/permission`: the hook's input, and the `X-Deck-Host` header as sent. */
	permission(body: unknown, deckHost: string | undefined, reply: PollReply): void;
	hello(body: Obj): RouteAnswer;
	events(body: Obj): RouteAnswer;
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
};

/** Listen retries back off from 1 s to 30 s: the port may be busy, and macOS 26 can refuse loopback for a while after boot. */
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];

const METHODS: Record<string, "GET" | "POST"> = {
	[ROUTES.permission]: "POST",
	[ROUTES.hello]: "POST",
	[ROUTES.events]: "POST",
	[ROUTES.next]: "GET",
	[ROUTES.result]: "POST",
};

/**
 * The bridge: HTTP/1.1 on 127.0.0.1 (PROTOCOL.md, Transport). In order: a Host other than 127.0.0.1:<port> or
 * localhost:<port> gets 403; a missing or wrong bearer token 401; an unknown route 404; a wrong method 405; a
 * body over the limit 413; a body that isn't JSON 400. Error answers are `{"error": "<reason>"}`. No CORS
 * headers. The token is never logged, nor is any header that might hold it.
 */
export class BridgeServer {
	readonly #opts: Required<Omit<BridgeOptions, "http">> & { http: http.ServerOptions };
	readonly #listeners = new Set<(state: BridgeState) => void>();
	#server: http.Server | null = null;
	#state: BridgeState = "stopped";
	#port: number | null = null;
	#retry = 0;
	#retryTimer: ReturnType<typeof setTimeout> | null = null;
	#routed = 0;

	constructor(opts: BridgeOptions) {
		this.#opts = {
			port: opts.port,
			host: opts.host ?? BRIDGE_HOST,
			token: opts.token,
			routes: opts.routes,
			// Belt and braces: the token can't reach the log even if a client puts it in a path.
			log: redacting(opts.log ?? nullLog, opts.token),
			maxBodyBytes: opts.maxBodyBytes ?? MAX_BODY_BYTES,
			http: opts.http ?? {},
		};
	}

	get state(): BridgeState {
		return this.#state;
	}

	/** The port it listens on, once listening. */
	get port(): number | null {
		return this.#port;
	}

	/** How many requests reached a route so far. The fixture runner waits on it to keep requests in order. */
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
		return http.createServer(
			{
				// Bodies arrive at once from a local client. These bound only receiving a request; a request that has
				// arrived and is held isn't subject to them (test/server.test.ts checks that).
				headersTimeout: 10_000,
				requestTimeout: 30_000,
				...this.#opts.http,
			},
			(req, res) => this.#handle(req, res),
		);
	}

	/**
	 * Text from a client, made fit for the log: the token replaced before anything is cut short (a cut token
	 * would no longer match), then quoted and cut.
	 */
	#show(value: string | null | undefined, max = 60): string {
		return quote(value === null || value === undefined ? value : scrub(value, this.#opts.token), max);
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
		const refuse = (status: number, why: string, headers: Record<string, string> = {}): void => {
			log.info(`REQ ${status} ${what}: ${why}`);
			// The reason stays in the log: the answer names only the status, never echoing what the client sent.
			reply(res, status, { error: http.STATUS_CODES[status] ?? "error" }, headers);
			// Drop the rest of any body without reading it.
			req.resume();
		};

		const host = req.headers.host;
		const port = this.#port ?? this.#opts.port;
		if (host === undefined || !allowedHosts(port).includes(host.toLowerCase())) {
			refuse(403, `Host ${this.#show(host)} isn't 127.0.0.1:${port} or localhost:${port}`);
			return;
		}
		const auth = checkBearer(req.headers.authorization, token);
		if (auth !== "ok") {
			refuse(401, auth === "missing" ? "no token" : "wrong token", { "www-authenticate": 'Bearer realm="streamdeck"' });
			return;
		}
		const allowed = METHODS[target];
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
			this.#routed++;
			this.#guard(what, res, () => routes.next(new URLSearchParams(queryString), this.#heldReply(req, res)));
			return;
		}

		readBody(req, this.#opts.maxBodyBytes).then(
			(text) => {
				let body: unknown;
				try {
					// With the token taken out first, nothing cut from the body later (a tool's summary on a key, a line
					// in the log) can carry part of it.
					body = JSON.parse(scrub(text, token));
				} catch {
					refuse(400, `the body isn't JSON (${Buffer.byteLength(text)} bytes)`);
					return;
				}
				if (target === ROUTES.permission) {
					const deckHost = req.headers["x-deck-host"];
					this.#routed++;
					this.#guard(what, res, () => routes.permission(body, typeof deckHost === "string" ? deckHost : undefined, this.#heldReply(req, res)));
					return;
				}
				if (!isObj(body)) {
					refuse(400, "the body isn't a JSON object");
					return;
				}
				const obj = body;
				this.#routed++;
				this.#guard(what, res, () => {
					const answer = target === ROUTES.hello ? routes.hello(obj) : target === ROUTES.events ? routes.events(obj) : routes.result(obj);
					if (answer.status >= 400) log.info(`REQ ${answer.status} ${what}: ${JSON.stringify(answer.body ?? null)}`);
					else log.debug(`REQ ${answer.status} ${what}`);
					reply(res, answer.status, answer.body, {});
				});
			},
			(err: unknown) => {
				if (err instanceof TooLarge) refuse(413, `the body is over ${this.#opts.maxBodyBytes} bytes`);
				else log.info(`REQ ${what}: the client went away while sending its body (${describeError(err).split("\n")[0]})`);
			},
		);
	}

	/** Runs a route; a route that throws gets a 500 for its client and a log line, and the bridge carries on. */
	#guard(what: string, res: ServerResponse, run: () => void): void {
		try {
			run();
		} catch (err) {
			this.#opts.log.error(`${what} failed: ${describeError(err)}`);
			reply(res, 500, { error: "internal error" }, {});
		}
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
