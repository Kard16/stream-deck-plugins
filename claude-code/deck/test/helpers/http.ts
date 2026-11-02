import http from "node:http";
import net from "node:net";

export type Reply = { status: number; body: string; headers: http.IncomingHttpHeaders };
export type Outcome = Reply | { error: string };

export type RequestOptions = {
	method?: string;
	path?: string;
	/** The Host header; defaults to 127.0.0.1:<port>. */
	host?: string;
	/** Sent as `Authorization: Bearer <token>`; omit for no header. */
	token?: string;
	authorization?: string;
	/** More headers, by lower-case name. */
	headers?: Record<string, string>;
	/** The body as sent; none for a GET unless given. */
	body?: string;
};

/** One request to the bridge on 127.0.0.1, on its own connection. `outcome` settles with the reply or the error. */
export function send(port: number, opts: RequestOptions = {}): { req: http.ClientRequest; outcome: Promise<Outcome> } {
	const method = opts.method ?? "POST";
	const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}`, "content-type": "application/json", ...opts.headers };
	if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
	if (opts.authorization !== undefined) headers.authorization = opts.authorization;
	const req = http.request({ host: "127.0.0.1", port, method, path: opts.path ?? "/v1/permission", headers, agent: false });
	const outcome = new Promise<Outcome>((resolve) => {
		req.on("response", (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
			res.on("error", (err) => resolve({ error: (err as NodeJS.ErrnoException).code ?? err.message }));
		});
		req.on("error", (err) => resolve({ error: (err as NodeJS.ErrnoException).code ?? err.message }));
	});
	req.end(opts.body ?? (method === "GET" ? undefined : "{}"));
	return { req, outcome };
}

/** A request with full control of its headers: `null` leaves a header out. For the fixture runner. */
export function request(port: number, method: string, path: string, headers: Record<string, string>, body: string | undefined): { req: http.ClientRequest; outcome: Promise<Outcome> } {
	const req = http.request({ host: "127.0.0.1", port, method, path, headers, agent: false });
	const outcome = new Promise<Outcome>((resolve) => {
		req.on("response", (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => (text += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }));
			res.on("error", (err) => resolve({ error: (err as NodeJS.ErrnoException).code ?? err.message }));
		});
		req.on("error", (err) => resolve({ error: (err as NodeJS.ErrnoException).code ?? err.message }));
	});
	req.end(body);
	return { req, outcome };
}

/**
 * `text` written as it is to a new connection, for requests Node's own client won't send. Settles with the answer
 * read back by the time the bridge closes the connection, or an error when nothing like one came.
 */
export function sendRaw(port: number, text: string): Promise<Outcome> {
	return new Promise((resolve) => {
		const socket = net.connect(port, "127.0.0.1");
		let got = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => (got += chunk));
		// A reset after the answer leaves what came before it.
		socket.on("error", () => undefined);
		// A bridge that never answers fails the test instead of hanging it.
		socket.setTimeout(5000, () => socket.destroy());
		socket.on("close", () => {
			const status = /^HTTP\/1\.1 (\d{3}) /.exec(got);
			const end = got.indexOf("\r\n\r\n");
			if (!status || end < 0) {
				resolve({ error: got === "" ? "closed without an answer" : `not an answer: ${JSON.stringify(got.slice(0, 80))}` });
				return;
			}
			const headers: http.IncomingHttpHeaders = {};
			for (const line of got.slice(0, end).split("\r\n").slice(1)) {
				const colon = line.indexOf(":");
				headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
			}
			resolve({ status: Number(status[1]), body: got.slice(end + 4), headers });
		});
		socket.write(text);
	});
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `check` is true. Fails with `what` after `timeoutMs`. */
export async function waitFor(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await sleep(5);
	}
}

/** Settles with the outcome, or with `{error: "pending"}` when it hasn't settled within `ms`. */
export function within(outcome: Promise<Outcome>, ms: number): Promise<Outcome> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<Outcome>((resolve) => {
		timer = setTimeout(() => resolve({ error: "pending" }), ms);
	});
	return Promise.race([outcome, late]).finally(() => clearTimeout(timer));
}
