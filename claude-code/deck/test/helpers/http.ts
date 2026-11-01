import http from "node:http";

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
	body?: string;
};

/** One request to the bridge on 127.0.0.1, on its own connection. `outcome` settles with the reply or the error. */
export function send(port: number, opts: RequestOptions = {}): { req: http.ClientRequest; outcome: Promise<Outcome> } {
	const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}`, "content-type": "application/json" };
	if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
	if (opts.authorization !== undefined) headers.authorization = opts.authorization;
	const req = http.request({ host: "127.0.0.1", port, method: opts.method ?? "POST", path: opts.path ?? "/permission", headers, agent: false });
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
	req.end(opts.body ?? "{}");
	return { req, outcome };
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
