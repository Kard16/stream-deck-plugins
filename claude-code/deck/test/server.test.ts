import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, describe, test } from "node:test";

import { allowedHosts, BRIDGE_HOST, BRIDGE_PORT } from "../src/bridge/config.js";
import { type BridgeRoutes, BridgeServer } from "../src/bridge/server.js";
import { SessionModel } from "../src/model/sessions.js";
import { type Outcome, send, sleep, waitFor, within } from "./helpers/http.js";
import { RecordingLog } from "./helpers/recording-log.js";

const ALLOW_JSON = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
const TOKEN = randomBytes(32).toString("hex");
const HOST = "local_test-server";
const BODY = JSON.stringify({ session_id: "sess-1", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
const MOD = { sid: "sess-1", host: HOST, inst: "i1" };

function status(outcome: Outcome): number | string {
	return "status" in outcome ? outcome.status : outcome.error;
}

function json(outcome: Outcome): unknown {
	return "status" in outcome && outcome.body !== "" ? JSON.parse(outcome.body) : null;
}

describe("bridge server (ephemeral ports on 127.0.0.1)", () => {
	let server: BridgeServer | null = null;
	let model: SessionModel | null = null;
	afterEach(async () => {
		await server?.stop();
		model?.dispose();
		server = null;
		model = null;
	});

	async function start(opts: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {}) {
		const log = new RecordingLog();
		model = new SessionModel({ log });
		server = new BridgeServer({ port: 0, token: TOKEN, routes: model, log, ...opts });
		const port = await server.listen();
		return { model, log, port, server };
	}

	test("the plugin's address is 127.0.0.1:47600, and only that Host is allowed", () => {
		assert.equal(BRIDGE_HOST, "127.0.0.1");
		assert.equal(BRIDGE_PORT, 47600);
		assert.deepEqual(allowedHosts(BRIDGE_PORT), ["127.0.0.1:47600", "localhost:47600"]);
	});

	test("holds POST /v1/permission with the token, and a key press answers it with allow", async () => {
		const { model, log, port } = await start();
		const { outcome } = send(port, { token: TOKEN, body: BODY, headers: { "x-deck-host": HOST } });
		await waitFor(() => model.held.size === 1, "the request to be held");
		assert.deepEqual(model.held.oldest && { tool: model.held.oldest.tool, host: model.held.oldest.host, summary: model.held.oldest.summary }, { tool: "Bash", host: HOST, summary: "ls" });
		assert.ok(log.at("info").some((l) => /^info HELD #1 tool "Bash" "ls" fp [0-9a-f]{8} from local_test-server; 1 held$/.test(l)), log.at("info").join("\n"));

		// Still held a while later: nothing answers on its own.
		await sleep(150);
		assert.equal(model.held.size, 1);

		assert.equal(model.held.press(1, "allow").ok, true);
		const reply = await outcome;
		assert.ok("status" in reply);
		assert.equal(reply.status, 200);
		assert.equal(reply.body, ALLOW_JSON);
		assert.equal(reply.headers["content-type"], "application/json");
		assert.equal(reply.headers["access-control-allow-origin"], undefined, "no CORS headers");
	});

	test("localhost:<port> is allowed as well", async () => {
		const { model, port } = await start();
		const { outcome } = send(port, { token: TOKEN, host: `localhost:${port}`, body: BODY });
		await waitFor(() => model.held.size === 1, "the request to be held");
		model.held.press(1, "deny");
		assert.equal(status(await outcome), 200);
	});

	test("no token, a wrong token or another scheme gets 401 with WWW-Authenticate, and nothing is held", async () => {
		const { model, log, port } = await start();
		assert.equal(status(await send(port, { body: BODY }).outcome), 401);
		assert.equal(status(await send(port, { token: "0".repeat(64), body: BODY }).outcome), 401);
		assert.equal(status(await send(port, { token: TOKEN.slice(0, -1), body: BODY }).outcome), 401);
		assert.equal(status(await send(port, { authorization: `Basic ${TOKEN}`, body: BODY }).outcome), 401);
		const missing = await send(port, { method: "GET", path: "/anything" }).outcome;
		assert.equal(status(missing), 401, "unauthenticated requests learn nothing about routes");
		if ("headers" in missing) assert.equal(missing.headers["www-authenticate"], 'Bearer realm="streamdeck"');
		assert.deepEqual(json(missing), { error: "Unauthorized" });
		assert.equal(model.held.size, 0);
		const lines = log.at("info");
		assert.ok(lines.some((l) => /REQ 401 POST "\/v1\/permission": no token/.test(l)));
		assert.ok(lines.some((l) => /REQ 401 POST "\/v1\/permission": wrong token/.test(l)));
	});

	test("a Host other than 127.0.0.1:<port> or localhost:<port> gets 403, before the token is checked", async () => {
		const { model, log, port } = await start();
		assert.equal(status(await send(port, { token: TOKEN, host: "evil.example", body: BODY }).outcome), 403);
		assert.equal(status(await send(port, { token: TOKEN, host: `evil.example:${port}`, body: BODY }).outcome), 403);
		assert.equal(status(await send(port, { token: TOKEN, host: "127.0.0.1:1", body: BODY }).outcome), 403);
		assert.equal(status(await send(port, { token: TOKEN, host: "127.0.0.1", body: BODY }).outcome), 403);
		assert.equal(status(await send(port, { host: "evil.example", body: BODY }).outcome), 403, "no token: still 403");
		assert.equal(model.held.size, 0);
		assert.ok(log.at("info").some((l) => /REQ 403 POST "\/v1\/permission": Host "evil.example" isn't/.test(l)));
	});

	test("unknown routes 404, wrong methods 405 with Allow, bad bodies 400, big ones 413", async () => {
		const { model, port } = await start({ maxBodyBytes: 1024 });
		assert.equal(status(await send(port, { token: TOKEN, path: "/permission" }).outcome), 404, "the spike's route is gone");
		assert.equal(status(await send(port, { token: TOKEN, path: "/v1/nope", method: "GET" }).outcome), 404);
		const get = await send(port, { token: TOKEN, method: "GET", path: "/v1/permission" }).outcome;
		assert.equal(status(get), 405);
		if ("headers" in get) assert.equal(get.headers.allow, "POST");
		const post = await send(port, { token: TOKEN, path: "/v1/next" }).outcome;
		assert.equal(status(post), 405);
		if ("headers" in post) assert.equal(post.headers.allow, "GET");
		assert.equal(status(await send(port, { token: TOKEN, body: "not json" }).outcome), 400);
		assert.equal(status(await send(port, { token: TOKEN, body: "" }).outcome), 400);
		assert.equal(status(await send(port, { token: TOKEN, body: "[1,2]", path: "/v1/events" }).outcome), 400, "mod bodies are objects");
		assert.equal(status(await send(port, { token: TOKEN, body: '{"tool_input":{}}' }).outcome), 400, "a PermissionRequest names its tool");
		const big = await send(port, { token: TOKEN, body: JSON.stringify({ tool_name: "Write", content: "x".repeat(4096) }) }).outcome;
		assert.ok(status(big) === 413 || status(big) === "ECONNRESET" || status(big) === "EPIPE", `got ${status(big)}`);
		assert.equal(model.held.size, 0);
	});

	test("hello answers its version; another version is refused with ok false", async () => {
		const { port } = await start();
		const ok = await send(port, { token: TOKEN, path: "/v1/hello", body: JSON.stringify({ v: 1, ...MOD, cwd: "/x", model: "claude-haiku-5-5", plugin: "0.1.0", cc: "2.1.309" }) }).outcome;
		assert.equal(status(ok), 200);
		assert.deepEqual(json(ok), { v: 1, ok: true });
		const other = await send(port, { token: TOKEN, path: "/v1/hello", body: JSON.stringify({ v: 2, ...MOD }) }).outcome;
		assert.equal(status(other), 200);
		assert.deepEqual(json(other), { v: 1, ok: false, error: "version" });
	});

	test("events and results answer 204 with no body; a session the bridge can't place gets 400", async () => {
		const { port } = await start();
		const events = await send(port, { token: TOKEN, path: "/v1/events", body: JSON.stringify({ ...MOD, seq: 1, events: [{ t: "turn.start", turn: "t1", at: 1 }] }) }).outcome;
		assert.equal(status(events), 204);
		assert.ok("body" in events && events.body === "");
		assert.equal(status(await send(port, { token: TOKEN, path: "/v1/result", body: JSON.stringify({ ...MOD, id: "c9", state: "done" }) }).outcome), 204);
		const nowhere = await send(port, { token: TOKEN, path: "/v1/events", body: JSON.stringify({ sid: "unknown", inst: "x", seq: 1, events: [] }) }).outcome;
		assert.equal(status(nowhere), 400);
	});

	test("GET /v1/next is held until a command is queued, then answers it", async () => {
		const { model, port } = await start();
		const poll = send(port, { token: TOKEN, method: "GET", path: `/v1/next?sid=${MOD.sid}&host=${HOST}&inst=${MOD.inst}&wait=20` });
		await waitFor(() => model.commands.polling(HOST), "the poll to be held");
		assert.equal(status(await within(poll.outcome, 100)), "pending");
		const cmd = model.commands.queue(HOST, { t: "prompt", text: "hello" });
		const answer = await poll.outcome;
		assert.equal(status(answer), 200);
		assert.deepEqual(json(answer), { cmds: [{ id: cmd.id, t: "prompt", text: "hello" }] });
		const now = await send(port, { token: TOKEN, method: "GET", path: `/v1/next?sid=${MOD.sid}&host=${HOST}&inst=${MOD.inst}&wait=0` }).outcome;
		assert.deepEqual(json(now), { cmds: [] });
	});

	test("a client that gives up is removed from the held requests, and the log says so", async () => {
		const { model, log, port } = await start();
		const first = send(port, { token: TOKEN, body: BODY });
		const second = send(port, { token: TOKEN, body: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/a/b.txt" } }) });
		await waitFor(() => model.held.size === 2, "both requests to be held");

		first.req.destroy(); // like the hook's timeout
		await waitFor(() => model.held.size === 1, "the closed request to be removed");
		assert.equal(model.held.oldest?.tool, "Edit");
		assert.ok(log.at("info").some((l) => /^info CLOSED #1: the client closed first; 1 held$/.test(l)), log.at("info").join("\n"));

		assert.equal(model.held.press(2, "allow").ok, true);
		assert.equal(status(await second.outcome), 200);
		assert.ok("error" in (await first.outcome), "the closed client got no answer");
	});

	test("a held request outlives the server's header and request timeouts", async () => {
		const { model, port } = await start({ http: { headersTimeout: 100, requestTimeout: 200, connectionsCheckingInterval: 20 } });
		const { outcome } = send(port, { token: TOKEN, body: BODY });
		await waitFor(() => model.held.size === 1, "the request to be held");
		await sleep(700);
		assert.equal(model.held.size, 1, "still held");
		model.held.press(1, "allow");
		assert.equal(status(await outcome), 200);
	});

	test("stopping drops held requests: the client sees the connection go, never a decision", async () => {
		const { model, port, server: bridge } = await start();
		const { outcome } = send(port, { token: TOKEN, body: BODY });
		await waitFor(() => model.held.size === 1, "the request to be held");
		await bridge.stop();
		const result = await outcome;
		assert.ok("error" in result, `expected a dropped connection, got ${JSON.stringify(result)}`);
	});

	test("a route that throws gets 500 and the bridge carries on", async () => {
		const log = new RecordingLog();
		const routes: BridgeRoutes = {
			permission: () => {
				throw new Error("boom");
			},
			hello: () => ({ status: 200, body: { v: 1, ok: true } }),
			events: () => ({ status: 204 }),
			next: () => {},
			result: () => ({ status: 204 }),
		};
		server = new BridgeServer({ port: 0, token: TOKEN, routes, log });
		const port = await server.listen();
		assert.equal(status(await send(port, { token: TOKEN, body: BODY }).outcome), 500);
		assert.equal(status(await send(port, { token: TOKEN, path: "/v1/hello", body: "{}" }).outcome), 200);
		assert.ok(log.at("error").some((l) => l.includes("boom")));
	});

	test("the token never reaches the log, whole or cut, even where a client puts it", async () => {
		const { log, port, model } = await start();
		await send(port, { path: `/x/${TOKEN}` }).outcome;
		await send(port, { token: TOKEN, path: `/y/${"z".repeat(40)}${TOKEN}` }).outcome;
		await send(port, { token: "wrong" }).outcome;
		await send(port, { token: TOKEN, host: `${"h".repeat(70)}${TOKEN}` }).outcome;
		await send(port, { token: TOKEN, path: "/v1/hello", body: JSON.stringify({ v: 1, ...MOD, plugin: TOKEN, cc: `${"c".repeat(30)}${TOKEN}` }) }).outcome;
		const held = send(port, { token: TOKEN, body: JSON.stringify({ tool_name: `${"t".repeat(90)}${TOKEN}`, session_id: TOKEN, tool_input: { command: TOKEN } }) });
		await waitFor(() => model.held.size === 1, "the request to be held");
		assert.ok(!model.held.oldest?.summary.includes(TOKEN.slice(0, 16)), "nor a key");
		model.held.press(1, "allow");
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
		const other = new BridgeServer({ port, token: TOKEN, routes: new SessionModel() });
		await assert.rejects(other.listen(), /EADDRINUSE/);

		const log = new RecordingLog();
		const states: string[] = [];
		const retrying = new BridgeServer({ port, token: TOKEN, routes: new SessionModel(), log });
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
