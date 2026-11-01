import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, describe, test } from "node:test";

import { allowedHosts, BRIDGE_HOST, BRIDGE_PORT } from "../src/bridge/config.js";
import { HeldQueue } from "../src/bridge/held.js";
import { BridgeServer } from "../src/bridge/server.js";
import { type Outcome, send, sleep, waitFor } from "./helpers/http.js";
import { RecordingLog } from "./helpers/recording-log.js";

const ALLOW_JSON = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
const TOKEN = randomBytes(32).toString("hex");
const BODY = JSON.stringify({ session_id: "sess-1", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });

function status(outcome: Outcome): number | string {
	return "status" in outcome ? outcome.status : outcome.error;
}

describe("bridge server (ephemeral ports on 127.0.0.1)", () => {
	let server: BridgeServer | null = null;
	afterEach(async () => {
		await server?.stop();
		server = null;
	});

	async function start(opts: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {}) {
		const queue = new HeldQueue();
		const log = new RecordingLog();
		server = new BridgeServer({ port: 0, token: TOKEN, queue, log, ...opts });
		const port = await server.listen();
		return { queue, log, port, server };
	}

	test("the plugin's address is 127.0.0.1:47601, and only that Host is allowed", () => {
		assert.equal(BRIDGE_HOST, "127.0.0.1");
		assert.equal(BRIDGE_PORT, 47601);
		assert.deepEqual(allowedHosts(BRIDGE_PORT), ["127.0.0.1:47601", "localhost:47601"]);
	});

	test("holds POST /permission with the token, and a key press answers it with allow", async () => {
		const { queue, log, port } = await start();
		const { outcome } = send(port, { token: TOKEN, body: BODY });
		await waitFor(() => queue.size === 1, "the request to be held");
		assert.deepEqual(queue.oldest && { tool: queue.oldest.toolName, session: queue.oldest.sessionId }, { tool: "Bash", session: "sess-1" });
		assert.ok(log.at("info").some((l) => /^info HELD #1 Bash session "sess-1"; 1 held$/.test(l)), log.at("info").join("\n"));

		// Still held a while later: nothing answers on its own.
		await sleep(150);
		assert.equal(queue.size, 1);

		assert.equal(queue.answerOldest().ok, true);
		const reply = await outcome;
		assert.ok("status" in reply);
		assert.equal(reply.status, 200);
		assert.equal(reply.body, ALLOW_JSON);
		assert.equal(reply.headers["content-type"], "application/json");
		assert.equal(queue.size, 0);
	});

	test("localhost:<port> is allowed as well", async () => {
		const { queue, port } = await start();
		const { outcome } = send(port, { token: TOKEN, host: `localhost:${port}` });
		await waitFor(() => queue.size === 1, "the request to be held");
		queue.answerOldest();
		assert.equal(status(await outcome), 200);
	});

	test("no token, a wrong token or another scheme gets 401, and nothing is held", async () => {
		const { queue, log, port } = await start();
		assert.equal(status(await send(port, {}).outcome), 401);
		assert.equal(status(await send(port, { token: "0".repeat(64) }).outcome), 401);
		assert.equal(status(await send(port, { token: TOKEN.slice(0, -1) }).outcome), 401);
		assert.equal(status(await send(port, { authorization: `Basic ${TOKEN}` }).outcome), 401);
		const missing = await send(port, { method: "GET", path: "/anything" }).outcome;
		assert.equal(status(missing), 401, "unauthenticated requests learn nothing about routes");
		if ("headers" in missing) assert.match(String(missing.headers["www-authenticate"]), /^Bearer/);
		assert.equal(queue.size, 0);
		const lines = log.at("info");
		assert.ok(lines.some((l) => /REQ 401 POST "\/permission": no token/.test(l)));
		assert.ok(lines.some((l) => /REQ 401 POST "\/permission": wrong token/.test(l)));
	});

	test("a Host other than 127.0.0.1:<port> or localhost:<port> gets 403, before the token is checked", async () => {
		const { queue, log, port } = await start();
		assert.equal(status(await send(port, { token: TOKEN, host: "evil.example" }).outcome), 403);
		assert.equal(status(await send(port, { token: TOKEN, host: `evil.example:${port}` }).outcome), 403);
		assert.equal(status(await send(port, { token: TOKEN, host: "127.0.0.1:1" }).outcome), 403);
		assert.equal(status(await send(port, { token: TOKEN, host: "127.0.0.1" }).outcome), 403);
		assert.equal(status(await send(port, { host: "evil.example" }).outcome), 403, "no token: still 403");
		assert.equal(queue.size, 0);
		assert.ok(log.at("info").some((l) => /REQ 403 POST "\/permission": Host "evil.example" isn't/.test(l)));
	});

	test("other routes, methods and bodies: 404, 405, 400 and 413", async () => {
		const { queue, port } = await start({ maxBodyBytes: 1024 });
		assert.equal(status(await send(port, { token: TOKEN, path: "/other" }).outcome), 404);
		const get = await send(port, { token: TOKEN, method: "GET" }).outcome;
		assert.equal(status(get), 405);
		if ("headers" in get) assert.equal(get.headers.allow, "POST");
		assert.equal(status(await send(port, { token: TOKEN, body: "not json" }).outcome), 400);
		assert.equal(status(await send(port, { token: TOKEN, body: "" }).outcome), 400);
		const big = await send(port, { token: TOKEN, body: JSON.stringify({ tool_name: "Write", content: "x".repeat(4096) }) }).outcome;
		assert.ok(status(big) === 413 || status(big) === "ECONNRESET" || status(big) === "EPIPE", `got ${status(big)}`);
		assert.equal(queue.size, 0);
	});

	test("a client that gives up is removed from the count, and the log says so", async () => {
		const { queue, log, port } = await start();
		const first = send(port, { token: TOKEN, body: BODY });
		const second = send(port, { token: TOKEN, body: JSON.stringify({ tool_name: "Edit" }) });
		await waitFor(() => queue.size === 2, "both requests to be held");

		first.req.destroy(); // like `curl -m 2` timing out
		await waitFor(() => queue.size === 1, "the closed request to be removed");
		assert.equal(queue.oldest?.toolName, "Edit");
		assert.ok(log.at("info").some((l) => /^info CLOSED #1 Bash: the client closed first; removed; 1 held$/.test(l)), log.at("info").join("\n"));

		assert.equal(queue.answerOldest().ok, true);
		assert.equal(status(await second.outcome), 200);
		assert.ok("error" in (await first.outcome), "the closed client got no answer");
	});

	test("a held request outlives the server's header and request timeouts", async () => {
		const { queue, port } = await start({ http: { headersTimeout: 100, requestTimeout: 200, connectionsCheckingInterval: 20 } });
		const { outcome } = send(port, { token: TOKEN, body: BODY });
		await waitFor(() => queue.size === 1, "the request to be held");
		await sleep(700);
		assert.equal(queue.size, 1, "still held");
		queue.answerOldest();
		assert.equal(status(await outcome), 200);
	});

	test("stopping drops held requests: the client sees the connection go, never a decision", async () => {
		const { queue, port, server: bridge } = await start();
		const { outcome } = send(port, { token: TOKEN, body: BODY });
		await waitFor(() => queue.size === 1, "the request to be held");
		await bridge.stop();
		const result = await outcome;
		assert.ok("error" in result, `expected a dropped connection, got ${JSON.stringify(result)}`);
	});

	test("the token never reaches the log, whole or cut, even where a client puts it", async () => {
		const { log, port, queue } = await start();
		await send(port, { path: `/x/${TOKEN}` }).outcome;
		await send(port, { token: TOKEN, path: `/y/${"z".repeat(40)}${TOKEN}` }).outcome;
		await send(port, { token: "wrong" }).outcome;
		await send(port, { token: TOKEN, host: `${"h".repeat(70)}${TOKEN}` }).outcome;
		const held = send(port, { token: TOKEN, body: JSON.stringify({ tool_name: `${"t".repeat(90)}${TOKEN}`, session_id: TOKEN }) });
		await waitFor(() => queue.size === 1, "the request to be held");
		queue.answerOldest();
		await held.outcome;
		assert.ok(log.lines.length >= 5);
		// No run of 16 of the token's characters anywhere.
		for (const line of log.lines) {
			for (let i = 0; i + 16 <= TOKEN.length; i++) assert.ok(!line.message.includes(TOKEN.slice(i, i + 16)), line.message);
		}
		assert.ok(log.lines.some((l) => l.message.includes("/x/<token>")));
	});

	test("a busy port: listen rejects; start logs, retries after 1 s, and listens once the port is free", async () => {
		const { port, server: first } = await start();
		const other = new BridgeServer({ port, token: TOKEN, queue: new HeldQueue() });
		await assert.rejects(other.listen(), /EADDRINUSE/);

		const log = new RecordingLog();
		const states: string[] = [];
		const retrying = new BridgeServer({ port, token: TOKEN, queue: new HeldQueue(), log });
		retrying.onState((s) => states.push(s));
		retrying.start();
		await waitFor(() => retrying.state === "retrying", "a retry to be scheduled");
		assert.ok(log.at("error").some((l) => l.includes(`can't listen on 127.0.0.1:${port} (EADDRINUSE); retrying in 1 s`)));
		await first.stop();
		await waitFor(() => retrying.state === "listening", "the retry to listen", 3000);
		assert.deepEqual(states, ["starting", "retrying", "starting", "listening"]);
		assert.ok(log.at("info").some((l) => l === `info listening on 127.0.0.1:${port}`));
		await retrying.stop();
		await other.stop();
	});
});
