import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { describeError, type Log, nullLog, quote, redacting, scrub } from "../util/log.js";
import { allowedHosts, BRIDGE_HOST, MAX_BODY_BYTES, PERMISSION_PATH } from "./config.js";
import type { HeldQueue, Responder } from "./held.js";
import { checkBearer } from "./token.js";

export type BridgeState = "starting" | "listening" | "retrying" | "stopped";

export type BridgeOptions = {
	/** BRIDGE_PORT in the plugin; 0 (any free port) in tests. */
	port: number;
	host?: string;
	token: string;
	queue: HeldQueue;
	log?: Log;
	maxBodyBytes?: number;
	/** Node's server options, for tests that shorten its timeouts. */
	http?: http.ServerOptions;
};

/** Listen retries back off from 1 s to 30 s: the port may be busy, and macOS 26 can refuse loopback for a while after boot. */
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];

/**
 * The bridge: HTTP on 127.0.0.1. Every request must name an allowed Host (else 403) and carry
 * `Authorization: Bearer <token>` (else 401). `POST /permission` with a JSON body is held in the queue until a
 * key press answers it, or until its client goes away. The token is never logged, nor is any header that
 * might hold it.
 */
export class BridgeServer {
	readonly #opts: Required<Omit<BridgeOptions, "http">> & { http: http.ServerOptions };
	readonly #listeners = new Set<(state: BridgeState) => void>();
	#server: http.Server | null = null;
	#state: BridgeState = "stopped";
	#port: number | null = null;
	#retry = 0;
	#retryTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(opts: BridgeOptions) {
		this.#opts = {
			port: opts.port,
			host: opts.host ?? BRIDGE_HOST,
			token: opts.token,
			queue: opts.queue,
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

	/** Stops listening and drops every connection, held ones included, without an answer. Tests use this. */
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
				// Bodies arrive at once from a local hook. These bound only receiving a request; a request that has
				// arrived and is held isn't subject to them (test/server.test.ts checks that).
				headersTimeout: 10_000,
				requestTimeout: 30_000,
				...this.#opts.http,
			},
			(req, res) => this.#handle(req, res),
		);
		return server;
	}

	/**
	 * Text from a client, made fit for the log: the token replaced before anything is cut short (a cut token
	 * would no longer match), then quoted and cut.
	 */
	#show(text: string | null | undefined, max = 60): string {
		return quote(text === null || text === undefined ? text : scrub(text, this.#opts.token), max);
	}

	#handle(req: IncomingMessage, res: ServerResponse): void {
		const { log, token } = this.#opts;
		// Node's parser only lets through methods it knows, so the method is safe to log as it is.
		const method = req.method ?? "?";
		const target = (req.url ?? "").split("?")[0] ?? "";
		const what = `${method} ${this.#show(target)}`;
		const reject = (status: number, why: string, headers: Record<string, string> = {}): void => {
			log.info(`REQ ${status} ${what}: ${why}`);
			reply(res, status, { error: http.STATUS_CODES[status] ?? "error" }, headers);
			// Drop the rest of any body without reading it.
			req.resume();
		};

		const host = req.headers.host;
		const port = this.#port ?? this.#opts.port;
		if (host === undefined || !allowedHosts(port).includes(host.toLowerCase())) {
			reject(403, `Host ${this.#show(host)} isn't 127.0.0.1:${port} or localhost:${port}`);
			return;
		}
		const auth = checkBearer(req.headers.authorization, token);
		if (auth !== "ok") {
			reject(401, auth === "missing" ? "no token" : "wrong token", { "www-authenticate": 'Bearer realm="streamdeck"' });
			return;
		}
		if (target !== PERMISSION_PATH) {
			reject(404, "no such route");
			return;
		}
		if (method !== "POST") {
			reject(405, "only POST", { allow: "POST" });
			return;
		}

		readBody(req, this.#opts.maxBodyBytes).then(
			(text) => {
				let body: unknown;
				try {
					// Only tool_name and session_id are kept from the body, and only for the key and the log; with
					// the token taken out first, nothing cut from it later can carry part of the token.
					body = JSON.parse(scrub(text, token));
				} catch {
					reject(400, `the body isn't JSON (${Buffer.byteLength(text)} bytes)`);
					return;
				}
				this.#hold(req, res, body);
			},
			(err: unknown) => {
				if (err instanceof TooLarge) reject(413, `the body is over ${this.#opts.maxBodyBytes} bytes`);
				else log.info(`REQ ${what}: the client went away while sending its body (${describeError(err).split("\n")[0]})`);
			},
		);
	}

	#hold(req: IncomingMessage, res: ServerResponse, body: unknown): void {
		const { log, queue } = this.#opts;
		let answered = false;
		const responder: Responder = {
			get open() {
				return !answered && !res.writableEnded && !res.destroyed && !req.socket.destroyed;
			},
			send(status, text) {
				answered = true;
				res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
				res.end(text);
			},
		};
		const held = queue.hold(body, responder);
		const label = `#${held.id} ${held.toolName === null ? "(no tool_name)" : this.#show(held.toolName).slice(1, -1)}`;
		log.info(`HELD ${label} session ${this.#show(held.sessionId)}; ${queue.size} held`);

		const onClose = (): void => {
			if (answered) return;
			if (queue.close(held.id)) log.info(`CLOSED ${label}: the client closed first; removed; ${queue.size} held`);
		};
		res.once("close", onClose);
		// The client may already be gone, before the listener was in place.
		if (req.socket.destroyed) onClose();
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
	const text = JSON.stringify(body);
	res.writeHead(status, { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(text) });
	res.end(text);
}
