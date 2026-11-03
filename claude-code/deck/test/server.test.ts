import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, describe, test } from "node:test";

import { allowedHosts, BRIDGE_HOST, BRIDGE_PORT, MAX_BODY_BYTES } from "../src/bridge/config.js";
import { type BridgeRoutes, BridgeServer } from "../src/bridge/server.js";
import { SessionModel } from "../src/model/sessions.js";
import { fingerprint } from "../src/protocol/fingerprint.js";
import type { RegistrySession } from "../src/registry/registry.js";
import { SCRUB_RUN, Scrubber } from "../src/util/log.js";
import { QUIET_MS } from "../src/util/quiet-log.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { type Outcome, type RequestOptions, send, sendRaw, sleep, waitFor, within } from "./helpers/http.js";
import { RecordingLog } from "./helpers/recording-log.js";

const ALLOW_JSON = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
const PRETOOL_ALLOW_JSON = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"The mode change pressed on the Stream Deck."}}';
const TOKEN = randomBytes(32).toString("hex");
const HOST = "local_test-server";
const BODY = JSON.stringify({ session_id: "sess-1", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
const MOD = { sid: "sess-1", host: HOST, inst: "i1" };
/** The header a hook sends with its session's host. */
const HOOK = { "x-deck-host": HOST };
/** The session the tests' requests come from, as the registry lists it: the hooks' requests count only from it. */
const LISTED: RegistrySession = { key: "101", name: "Server test", status: "busy", cwd: "/x", hostSessionId: HOST, sessionId: MOD.sid, statusUpdatedAt: 1, startedAt: 1 };
/** The mode hook's input for the deck's own change to `mode`. */
const modeCheck = (mode: string, sid = MOD.sid): string =>
	JSON.stringify({ session_id: sid, hook_event_name: "PreToolUse", tool_name: "mcp__ccd_session_mgmt__set_session_permission_mode", tool_input: { session_id: "self", mode }, tool_use_id: "toolu_plugin_0001" });

function status(outcome: Outcome): number | string {
	return "status" in outcome ? outcome.status : outcome.error;
}

function json(outcome: Outcome): unknown {
	return "status" in outcome && outcome.body !== "" ? JSON.parse(outcome.body) : null;
}

/**
 * The answer to a request the bridge answers at once, or `{error: "pending"}` if none has come within 2 s: an answer
 * that never comes fails the test there and then, rather than holding it up to npm test's deadline for each test.
 */
function atOnce(port: number, opts: RequestOptions): Promise<Outcome> {
	return within(send(port, opts).outcome, 2000);
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
		model.setRegistry([LISTED]);
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
		const { outcome } = send(port, { token: TOKEN, host: `localhost:${port}`, body: BODY, headers: HOOK });
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

	test("a hello whose v is nested 20,000 deep is refused as another version, not with 500", async () => {
		const { log, port } = await start();
		const depth = 20_000;
		for (const v of [`${"[".repeat(depth)}1${"]".repeat(depth)}`, `${'{"v":'.repeat(depth)}1${"}".repeat(depth)}`]) {
			const answer = await send(port, { token: TOKEN, path: "/v1/hello", body: `{"v":${v},"sid":"sess-1","host":"${HOST}","inst":"i1","model":"m"}` }).outcome;
			assert.equal(status(answer), 200);
			assert.deepEqual(json(answer), { v: 1, ok: false, error: "version" });
		}
		assert.equal(log.at("error").length, 0, log.at("error").join("\n"));
		assert.deepEqual(log.at("warn"), [`warn HELLO from ${HOST} speaks version an array; the deck speaks 1`, `warn HELLO from ${HOST} speaks version an object; the deck speaks 1`]);
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
		assert.equal(status(await send(port, { token: TOKEN, path: "/v1/hello", body: JSON.stringify({ v: 1, ...MOD, model: "m" }) }).outcome), 200);
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
		const first = send(port, { token: TOKEN, body: BODY, headers: HOOK });
		await waitFor(() => model.held.size === 1, "the first request to be held");
		const second = send(port, { token: TOKEN, body: JSON.stringify({ session_id: MOD.sid, tool_name: "Edit", tool_input: { file_path: "/a/b.txt" } }), headers: HOOK });
		await waitFor(() => model.held.size === 2, "both requests to be held");

		first.req.destroy(); // like the hook's timeout
		await waitFor(() => model.held.size === 1, "the closed request to be removed");
		assert.equal(model.held.oldest?.tool, "Edit");
		assert.ok(log.at("info").some((l) => /^info CLOSED #1: the client closed first; 1 held$/.test(l)), log.at("info").join("\n"));

		assert.equal(model.held.press(2, "allow").ok, true);
		assert.equal(status(await second.outcome), 200);
		assert.ok("error" in (await first.outcome), "the closed client got no answer");
	});

	test("a request Node takes no further still gets {\"error\"}: one it can't parse, headers over its limit, one too slow to arrive", async () => {
		const { model, log, port } = await start({ http: { headersTimeout: 100, requestTimeout: 200, connectionsCheckingInterval: 20 } });
		const head = `Host: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\n`;
		const garbled = await sendRaw(port, `POST /v1/permission HTTP/1.1\r\n${head}Content-Length: twelve\r\n\r\n`);
		assert.deepEqual([status(garbled), json(garbled)], [400, { error: "Bad Request" }]);
		const big = await sendRaw(port, `POST /v1/permission HTTP/1.1\r\n${head}X-Pad: ${"p".repeat(17_000)}\r\nContent-Length: 2\r\n\r\n{}`);
		assert.deepEqual([status(big), json(big)], [431, { error: "Request Header Fields Too Large" }]);
		// The route has it, but its body never ends.
		const slow = await sendRaw(port, `POST /v1/permission HTTP/1.1\r\n${head}Content-Length: 100\r\n\r\n{"tool_name":`);
		assert.deepEqual([status(slow), json(slow)], [408, { error: "Request Timeout" }]);
		if ("headers" in slow) assert.deepEqual([slow.headers["content-type"], slow.headers.connection], ["application/json", "close"]);
		assert.equal(model.held.size, 0);
		assert.deepEqual(
			log.at("info").filter((l) => l.startsWith("info REQ 4")),
			["info REQ 400: Node couldn't take the request (HPE_INVALID_CONTENT_LENGTH)", "info REQ 431: Node couldn't take the request (HPE_HEADER_OVERFLOW)", "info REQ 408: Node couldn't take the request (ERR_HTTP_REQUEST_TIMEOUT)"],
		);
		// The bridge carries on.
		assert.equal(status(await send(port, { token: TOKEN, path: "/v1/hello", body: JSON.stringify({ v: 1, ...MOD, model: "m" }) }).outcome), 200);
	});

	test("a held request outlives the server's header and request timeouts", async () => {
		const { model, port } = await start({ http: { headersTimeout: 100, requestTimeout: 200, connectionsCheckingInterval: 20 } });
		const { outcome } = send(port, { token: TOKEN, body: BODY, headers: HOOK });
		await waitFor(() => model.held.size === 1, "the request to be held");
		await sleep(700);
		assert.equal(model.held.size, 1, "still held");
		model.held.press(1, "allow");
		assert.equal(status(await outcome), 200);
	});

	test("stopping drops held requests: the client sees the connection go, never a decision", async () => {
		const { model, port, server: bridge } = await start();
		const { outcome } = send(port, { token: TOKEN, body: BODY, headers: HOOK });
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
			pretool: () => Promise.reject(new Error("bang")),
			hello: () => ({ status: 200, body: { v: 1, ok: true } }),
			events: () => ({ status: 204 }),
			next: () => {},
			result: () => ({ status: 204 }),
		};
		const bridge = new BridgeServer({ port: 0, token: TOKEN, routes, log });
		server = bridge;
		const port = await bridge.listen();
		assert.equal(status(await send(port, { token: TOKEN, body: BODY }).outcome), 500);
		const rejected = await send(port, { token: TOKEN, path: "/v1/pretool", body: BODY }).outcome;
		assert.deepEqual([status(rejected), json(rejected)], [500, { error: "internal error" }], "a route's promise that rejects");
		assert.equal(status(await send(port, { token: TOKEN, path: "/v1/hello", body: "{}" }).outcome), 200);
		assert.ok(log.at("error").some((l) => l.includes("boom")));
		assert.ok(log.at("error").some((l) => l.includes("bang")));
		assert.equal(bridge.routed, 3, "each counts as routed once it's answered");
	});

	test("the token never reaches the log, whole or cut, even where a client puts it", async () => {
		const { log, port, model } = await start();
		await send(port, { path: `/x/${TOKEN}` }).outcome;
		await send(port, { token: TOKEN, path: `/y/${"z".repeat(40)}${TOKEN}` }).outcome;
		await send(port, { token: "wrong" }).outcome;
		await send(port, { token: TOKEN, host: `${"h".repeat(70)}${TOKEN}` }).outcome;
		await send(port, { token: TOKEN, path: "/v1/hello", body: JSON.stringify({ v: 1, ...MOD, plugin: TOKEN, cc: `${"c".repeat(30)}${TOKEN}` }) }).outcome;
		// In the long poll's query, as the mod's inst, which the log names, cut to 40 characters, when it's new:
		// the token itself; after 30 characters, so the cut ends in its start; and percent-encoded.
		const poll = (inst: string) => send(port, { token: TOKEN, method: "GET", path: `/v1/next?sid=${MOD.sid}&host=${HOST}&inst=${inst}&wait=0` }).outcome;
		assert.equal(status(await poll(TOKEN)), 200);
		await poll(`${"q".repeat(30)}${TOKEN}`);
		await poll(`p${[...TOKEN].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("")}`);
		// Part of the token on its own, as if a client had cut it.
		await poll(`${"r".repeat(30)}${TOKEN.slice(0, 20)}`);
		await send(port, { token: TOKEN, path: `/w/${TOKEN.slice(20, 40)}` }).outcome;
		// As a hook's session_id, which the log names when the registry doesn't confirm it. Answered at once, or the
		// test fails rather than waits on a request held by mistake.
		const unconfirmed = await within(send(port, { token: TOKEN, body: JSON.stringify({ tool_name: "Bash", session_id: TOKEN, tool_input: { command: "ls" } }), headers: HOOK }).outcome, 2000);
		assert.deepEqual([status(unconfirmed), json(unconfirmed)], [200, {}]);
		// In a held request's tool and input, which the log and a key show.
		const held = send(port, { token: TOKEN, body: JSON.stringify({ tool_name: `${"t".repeat(90)}${TOKEN}`, session_id: MOD.sid, tool_input: { command: TOKEN } }), headers: HOOK });
		await waitFor(() => model.held.size === 1, "the request to be held");
		assert.ok(!model.held.oldest?.summary.includes(TOKEN.slice(0, SCRUB_RUN)), "nor a key");
		model.held.press(1, "allow");
		await held.outcome;
		// And as a new instance's inst in a hello, which the log names as it replaces the current one.
		await send(port, { token: TOKEN, path: "/v1/hello", body: JSON.stringify({ v: 1, ...MOD, inst: `${"s".repeat(30)}${TOKEN}` }) }).outcome;
		assert.ok(log.lines.length >= 5);
		// No run of SCRUB_RUN of the token's characters anywhere.
		for (const line of log.lines) {
			for (let i = 0; i + SCRUB_RUN <= TOKEN.length; i++) assert.ok(!line.message.includes(TOKEN.slice(i, i + SCRUB_RUN)), line.message);
		}
		assert.ok(log.lines.some((l) => l.message.includes("/x/<token>")));
		// The query was scrubbed before anything read it: the inst arrived whole as <token>, not cut and then redacted.
		assert.ok(log.lines.some((l) => l.message.includes('POLL local_test-server from mod instance "<token>", not the current one')), log.at("debug").join("\n"));
		assert.ok(log.lines.some((l) => l.message.includes(`mod instance "${"q".repeat(30)}<token>"`)));
		assert.ok(log.lines.some((l) => l.message.includes('mod instance "p<token>"')));
		assert.ok(log.lines.some((l) => l.message.includes('sid "<token>"')), "the hook's session_id");
		assert.ok(log.lines.some((l) => l.message.includes(`RESTART local_test-server: mod instance "${"s".repeat(30)}<token>" replaces "i1"`)), log.at("info").join("\n"));
	});

	test("the token is taken out of a body's strings, not its numbers: a number holding a run of its digits still parses", async () => {
		const token = "0123456789abcdef".repeat(4);
		const { port } = await start({ token });
		const body = JSON.stringify({ ...MOD, seq: 1, events: [{ t: "turn.start", turn: "/x/1234567890", at: 1234567890123 }] });
		assert.equal(status(await send(port, { token, path: "/v1/events", body }).outcome), 204);
	});

	test("a Scrubber takes out the token, and any run of SCRUB_RUN or more of its characters", () => {
		const scrub = (text: string, secret: string): string => new Scrubber(secret).scrub(text);
		assert.equal(scrub(`/x/${TOKEN}/y`, TOKEN), "/x/<token>/y");
		assert.equal(scrub(`z${TOKEN.slice(0, SCRUB_RUN)}`, TOKEN), "z<token>", "a cut that ends in its start");
		assert.equal(scrub(`${TOKEN.slice(-SCRUB_RUN)}z`, TOKEN), "<token>z", "a summary that keeps only its end");
		assert.equal(scrub(`q${TOKEN.slice(10, 40)}q${TOKEN}q`, TOKEN), "q<token>q<token>q");
		assert.equal(scrub(`${TOKEN.slice(0, 20)}${TOKEN.slice(30, 50)}`, TOKEN), "<token>", "touching runs become one");
		assert.equal(scrub(`z${TOKEN.slice(0, SCRUB_RUN - 1)}z`, TOKEN), `z${TOKEN.slice(0, SCRUB_RUN - 1)}z`, "fewer characters stay");
		assert.equal(scrub("fixture-token, then fixture-to…", "fixture-token"), "<token>, then <token>…");
		const odd = "a]b^c-d\\e[f";
		assert.equal(scrub(`<${odd}> <${odd.slice(1, 9)}>`, odd), "<<token>> <<token>>", "characters a regular expression treats specially");
		assert.equal(scrub("tok, tok", "tok"), "<token>, <token>", "a secret shorter than SCRUB_RUN goes only whole");
		assert.equal(scrub(TOKEN, ""), TOKEN);
		// The run rule holds anywhere in a string far longer than a backtracking regular expression could take.
		const token = "0123456789abcdef".repeat(4);
		const half = "fedcba9876543210".repeat(187_500);
		const long = new Scrubber(token).scrub(`${half}${token.slice(3, 3 + SCRUB_RUN)}${half}${token.slice(5, 4 + SCRUB_RUN)}`);
		assert.equal(long.length, 2 * half.length + "<token>".length + SCRUB_RUN - 1);
		assert.ok(long === `${half}<token>${half}${token.slice(5, 4 + SCRUB_RUN)}`, "8 characters in a row go, 7 stay");
	});

	test("a body with one 6M-character hex string is held, with the token's runs taken out of it", async () => {
		// Every character is one of the token's, and none of its windows of SCRUB_RUN are in the token but the one
		// put in the middle, which must still go.
		const token = "0123456789abcdef".repeat(4);
		const half = "fedcba9876543210".repeat(187_500);
		const input = { file_path: "/x/big.txt", content: `${half}${token.slice(3, 3 + SCRUB_RUN)}${half}` };
		const { model, port } = await start({ token });
		const { outcome } = send(port, { token, body: JSON.stringify({ session_id: "sess-1", tool_name: "Write", tool_input: input }), headers: { "x-deck-host": HOST } });
		await waitFor(() => model.held.size === 1, "the request to be held", 10_000);
		assert.equal(model.held.oldest?.fp, fingerprint("Write", { ...input, content: `${half}<token>${half}` }));
		model.held.press(1, "allow");
		const reply = await outcome;
		assert.ok("status" in reply, JSON.stringify(reply));
		assert.equal(reply.body, ALLOW_JSON);
	});

	test("a body of 1.6M short strings doesn't hold up the bridge: the token's scrubber is built once, not per string", async () => {
		const { port } = await start();
		const body = JSON.stringify({ ...MOD, seq: 1, events: [], pad: Array.from({ length: 1_600_000 }, (_, i) => `s${i % 10}`) });
		assert.ok(Buffer.byteLength(body) <= MAX_BODY_BYTES);
		const started = performance.now();
		assert.equal(status(await send(port, { token: TOKEN, path: "/v1/events", body }).outcome), 204);
		// Built per string, the scrubber took 2.7 s here on this Mac; built once, the whole request takes about 50 ms.
		const ms = performance.now() - started;
		assert.ok(ms < 1000, `${Math.round(ms)} ms`);
	});

	test("20,000 levels of nesting don't crash a route: a PermissionRequest that deep is held without an fp", async () => {
		const { model, port, log } = await start();
		const depth = 20_000;
		const deep = `${"[".repeat(depth)}"${TOKEN}"${"]".repeat(depth)}`;
		const held = send(port, { token: TOKEN, body: `{"session_id":"sess-1","tool_name":"Custom","tool_input":{"a":${deep}}}`, headers: { "x-deck-host": HOST } });
		await waitFor(() => model.held.size === 1, "the request to be held");
		assert.deepEqual(model.held.oldest && { tool: model.held.oldest.tool, fp: model.held.oldest.fp, host: model.held.oldest.host }, { tool: "Custom", fp: null, host: HOST });
		assert.ok(log.at("info").some((l) => /^info HELD #1 tool "Custom" "Custom" fp none from local_test-server; 1 held$/.test(l)), log.at("info").join("\n"));
		// The mod's routes take a body that deep too.
		const events = await send(port, { token: TOKEN, path: "/v1/events", body: `{"sid":"sess-1","host":"${HOST}","inst":"i1","seq":1,"events":[{"t":"turn.start","turn":"t1","at":1}],"x":${deep}}` }).outcome;
		assert.equal(status(events), 204);
		model.held.press(1, "deny");
		assert.equal(status(await held.outcome), 200);
		assert.equal(log.at("error").length, 0, log.at("error").join("\n"));
	});

	test("the token is taken out of strings at any depth, and out of names, where a __proto__ stays a plain key", async () => {
		const { model, port } = await start();
		const nest = (inner: string): string => {
			let s = JSON.stringify(inner);
			for (let i = 0; i < 1000; i++) s = i % 2 === 0 ? `[${s}]` : `{"n":${s}}`;
			return s;
		};
		const { outcome } = send(port, { token: TOKEN, body: `{"session_id":"${MOD.sid}","tool_name":"Custom","tool_input":{"k${TOKEN.slice(0, SCRUB_RUN)}":1,"__proto__":"p${TOKEN}","z":${nest(`x${TOKEN}`)},"${TOKEN}":2}}`, headers: HOOK });
		await waitFor(() => model.held.size === 1, "the request to be held");
		// As JSON.parse makes it, "__proto__" is an own key here too, so the fingerprint counts it.
		const expected: unknown = JSON.parse(`{"k<token>":1,"__proto__":"p<token>","z":${nest("x<token>")},"<token>":2}`);
		assert.equal(model.held.oldest?.fp, fingerprint("Custom", expected));
		model.held.press(1, "allow");
		assert.equal(status(await outcome), 200);
	});

	test("POST /v1/pretool is answered at once: the allow for the deck's own mode change in flight, once, and {} for anything else", async () => {
		const { model, log, port } = await start();
		// Never held: a check not answered within 2 s fails the test rather than holding it up.
		const check = (body: string, headers: Record<string, string> = HOOK) => within(send(port, { token: TOKEN, path: "/v1/pretool", body, headers }).outcome, 2000);
		const none = await check(modeCheck("plan"));
		assert.deepEqual([status(none), "body" in none && none.body], [200, "{}"], "nothing in flight");
		// The mod says hello and takes the deck's mode command.
		assert.equal(status(await send(port, { token: TOKEN, path: "/v1/hello", body: JSON.stringify({ v: 1, ...MOD, model: "m" }) }).outcome), 200);
		const cmd = model.commands.queue(HOST, { t: "mode", mode: "plan" });
		const taken = await send(port, { token: TOKEN, method: "GET", path: `/v1/next?sid=${MOD.sid}&host=${HOST}&inst=${MOD.inst}&wait=0` }).outcome;
		assert.deepEqual(json(taken), { cmds: [{ id: cmd.id, t: "mode", mode: "plan" }] });
		// Another mode, a process the registry doesn't confirm, or no host: no decision, and the allow stays unused.
		for (const [body, headers] of [
			[modeCheck("auto"), HOOK],
			[modeCheck("plan", "sess-child"), HOOK],
			[modeCheck("plan"), {}],
		] as const) {
			const answer = await check(body, headers);
			assert.deepEqual([status(answer), "body" in answer && answer.body], [200, "{}"], `${body} ${JSON.stringify(headers)}`);
		}
		const allowed = await check(modeCheck("plan"));
		assert.ok("status" in allowed);
		assert.deepEqual([allowed.status, allowed.body, allowed.headers["content-type"]], [200, PRETOOL_ALLOW_JSON, "application/json"]);
		const again = await check(modeCheck("plan"));
		assert.deepEqual([status(again), "body" in again && again.body], [200, "{}"], "only the first check per command");
		// Never held: nothing waits on the deck.
		assert.equal(model.held.size, 0);
		assert.ok(log.at("info").some((l) => l === `info ALLOWED the mode check for the change to "plan" for ${HOST}: the deck's own command ${cmd.id}`), log.at("info").join("\n"));
		assert.ok(log.at("debug").some((l) => l === `debug PRETOOL ${HOST}: no decision: no mode command in flight for "plan" that hasn't had its check allowed`), log.at("debug").join("\n"));
		assert.ok(!log.at("info").some((l) => l.includes("PRETOOL")), "no decision is logged at debug");
	});

	test("POST /v1/pretool has the Host and token checks of every route, and the transport's errors", async () => {
		const { port } = await start();
		const body = modeCheck("plan");
		assert.equal(status(await send(port, { token: TOKEN, host: "evil.example", path: "/v1/pretool", body, headers: HOOK }).outcome), 403);
		assert.equal(status(await send(port, { path: "/v1/pretool", body, headers: HOOK }).outcome), 401);
		assert.equal(status(await send(port, { token: "0".repeat(64), path: "/v1/pretool", body, headers: HOOK }).outcome), 401);
		const get = await send(port, { token: TOKEN, method: "GET", path: "/v1/pretool" }).outcome;
		assert.equal(status(get), 405);
		if ("headers" in get) assert.equal(get.headers.allow, "POST");
		const garbled = await send(port, { token: TOKEN, path: "/v1/pretool", body: "not json", headers: HOOK }).outcome;
		assert.deepEqual([status(garbled), json(garbled)], [400, { error: "Bad Request" }]);
		// JSON that isn't a PreToolUse's input is still answered with no decision: a 2xx is one of the two bodies.
		for (const odd of ["[1,2]", '"x"', "{}", '{"tool_name":7}']) {
			const answer = await within(send(port, { token: TOKEN, path: "/v1/pretool", body: odd, headers: HOOK }).outcome, 2000);
			assert.deepEqual([status(answer), "body" in answer && answer.body], [200, "{}"], odd);
		}
	});

	test("a client refused again and again is logged quietly: the first per route and reason at info, then one line in 10 minutes with the count since, the rest at debug", async () => {
		const clock = new FakeClock();
		const { log, port } = await start({ clock });
		const lines = (level: "info" | "debug", text: string): string[] => log.lines.filter((l) => l.level === level && l.message.includes(text)).map((l) => l.message);
		const stale = (path = "/v1/hello") => send(port, { token: "0".repeat(64), path, body: "{}" }).outcome;
		// A stale token, 211 times: once made 211 info lines.
		for (let i = 0; i < 211; i++) assert.equal(status(await stale()), 401);
		assert.deepEqual(lines("info", "wrong token"), ['REQ 401 POST "/v1/hello": wrong token']);
		assert.equal(lines("debug", "wrong token").length, 210);
		// Each route and each reason has its own first line at info.
		await stale("/v1/events");
		await send(port, { path: "/v1/hello", body: "{}" }).outcome;
		await send(port, { token: TOKEN, host: "evil.example", path: "/v1/hello", body: "{}" }).outcome;
		await send(port, { token: TOKEN, host: "evil.example", path: "/v1/hello", body: "{}" }).outcome;
		// Every path that isn't a route counts as one, so a client can't make the keys many.
		await send(port, { path: "/x" }).outcome;
		await send(port, { path: "/y" }).outcome;
		await send(port, { path: "/__proto__" }).outcome;
		assert.deepEqual(lines("info", "REQ 40"), [
			'REQ 401 POST "/v1/hello": wrong token',
			'REQ 401 POST "/v1/events": wrong token',
			'REQ 401 POST "/v1/hello": no token',
			'REQ 403 POST "/v1/hello": Host "evil.example" isn\'t 127.0.0.1:' + port + " or localhost:" + port,
			'REQ 401 POST "/x": no token',
		]);
		// Within 10 minutes of its last info line, at debug; from then, one line at info, with the count since.
		clock.advance(QUIET_MS - 1);
		await stale();
		assert.equal(lines("info", "wrong token").length, 2, "one for each route so far");
		clock.advance(1);
		await stale();
		await stale();
		assert.deepEqual(lines("info", 'POST "/v1/hello": wrong token'), [
			'REQ 401 POST "/v1/hello": wrong token',
			'REQ 401 POST "/v1/hello": wrong token; 211 more like it, at debug, in the 10 min since the last at info',
		]);
		assert.equal(lines("debug", 'POST "/v1/hello": wrong token').length, 212);
		// What isn't a refusal a client repeats is logged as before.
		await send(port, { token: TOKEN, method: "GET", path: "/v1/nope" }).outcome;
		await send(port, { token: TOKEN, method: "GET", path: "/v1/nope" }).outcome;
		assert.equal(lines("info", "no such route").length, 2);
	});

	test("a deck restarted while a mod had no request open: the new deck answers its polls at once with 409 hello first, says so at info once, and holds its poll after its hello", async () => {
		const { port, server: first, model: old } = await start();
		const hello = JSON.stringify({ v: 1, ...MOD, cwd: "/x", plugin: "0.2.0", cc: "2.1.309" });
		assert.equal(status(await atOnce(port, { token: TOKEN, path: "/v1/hello", body: hello })), 200);
		assert.equal(old.session(HOST)?.plugin, true);
		// The mod waits out its second between polls, nothing open, so nothing of its fails as the deck restarts.
		await first.stop();
		old.dispose();
		const log = new RecordingLog();
		const restarted = new SessionModel({ log });
		model = restarted;
		restarted.setRegistry([LISTED]);
		const again = new BridgeServer({ port, token: TOKEN, routes: restarted, log });
		server = again;
		assert.equal(await again.listen(), port);
		const poll = () => atOnce(port, { token: TOKEN, method: "GET", path: `/v1/next?sid=${MOD.sid}&host=${HOST}&inst=${MOD.inst}&wait=20` });
		for (let i = 0; i < 3; i++) {
			const answer = await poll();
			assert.deepEqual([status(answer), json(answer)], [409, { error: "hello first" }], "answered at once, each time");
			if ("headers" in answer) assert.equal(answer.headers["content-type"], "application/json");
		}
		const events = JSON.stringify({ ...MOD, seq: 7, events: [{ t: "measure", context: { percent: 12, window: 200000 }, at: 1 }] });
		assert.equal(status(await atOnce(port, { token: TOKEN, path: "/v1/events", body: events })), 204);
		assert.deepEqual([restarted.session(HOST)?.plugin, restarted.session(HOST)?.context], [false, 12]);
		assert.deepEqual(
			log.at("info").filter((l) => l.includes("HELLO FIRST") || l.includes("NO HELLO")),
			[`info HELLO FIRST ${HOST}: mod instance "i1" polls, but no instance has said hello to this deck for the session, so the deck answers 409 to ask for one`],
			log.at("debug").join("\n"),
		);
		// The mod's quiet hello, about 100 ms later: current again, its poll held.
		assert.equal(status(await atOnce(port, { token: TOKEN, path: "/v1/hello", body: hello })), 200);
		const held = send(port, { token: TOKEN, method: "GET", path: `/v1/next?sid=${MOD.sid}&host=${HOST}&inst=${MOD.inst}&wait=20` }).outcome;
		assert.deepEqual(await within(held, 200), { error: "pending" });
		assert.equal(restarted.session(HOST)?.plugin, true);
	});

	test("two live mods for one host after a deck restart, through the bridge, with the limit shortened to 300 ms: the predecessor's hello lands last, and once it has gone the limit without a poll, the live mod's next poll gets 409, its hello makes it current, and its held poll takes the next command", async () => {
		const log = new RecordingLog();
		const restarted = new SessionModel({ log, inFlightMs: 300 });
		model = restarted;
		restarted.setRegistry([LISTED]);
		server = new BridgeServer({ port: 0, token: TOKEN, routes: restarted, log });
		const port = await server.listen();
		const hello = (inst: string) => atOnce(port, { token: TOKEN, path: "/v1/hello", body: JSON.stringify({ v: 1, sid: MOD.sid, host: HOST, inst, cwd: "/x", plugin: "0.3.0", cc: "2.1.309" }) });
		const poll = (inst: string) => send(port, { token: TOKEN, method: "GET", path: `/v1/next?sid=${MOD.sid}&host=${HOST}&inst=${inst}&wait=20` }).outcome;
		// Each mod's next poll asks for a hello, and each says one. The predecessor's lands last, and replaces the live one's.
		for (const inst of ["inew", "iold"]) {
			const answer = await within(poll(inst), 2000);
			assert.deepEqual([status(answer), json(answer)], [409, { error: "hello first" }], inst);
		}
		assert.equal(status(await hello("inew")), 200);
		assert.equal(status(await hello("iold")), 200);
		const started = Date.now();
		// iold polls no more. inew polls every 20 ms or so, a stray's poll answered at once with none, until one asks
		// for a hello.
		let strays = 0;
		for (;;) {
			const answer = await within(poll("inew"), 2000);
			if (status(answer) === 409) break;
			assert.deepEqual([status(answer), json(answer)], [200, { cmds: [] }]);
			strays++;
			assert.ok(Date.now() - started < 3000, "never asked for a hello");
			await sleep(20);
		}
		const after = Date.now() - started;
		assert.ok(after >= 250 && strays > 0, `asked for a hello ${after} ms after iold's, after ${strays} stray polls`);
		assert.ok(log.at("info").includes(`info UNPOLLED ${HOST}: mod instance "iold" has had no poll open for 0.3 s, so it's no longer the current one, and the deck forgets which instances said hello; the mod's next poll gets 409 to ask for one`), log.at("info").join("\n"));
		// inew's hello makes it current; its next poll is held, and takes the next command.
		assert.equal(status(await hello("inew")), 200);
		const held = poll("inew");
		await waitFor(() => restarted.commands.polling(HOST), "inew's poll to be held");
		const queued = restarted.queue(HOST, { t: "prompt", text: "hi" });
		assert.ok(queued.ok, JSON.stringify(queued));
		assert.deepEqual(json(await within(held, 2000)), { cmds: [{ id: queued.cmd.id, t: "prompt", text: "hi" }] });
		assert.equal(queued.cmd.inst, "inew");
	});

	test("a 409 through the bridge is logged at info once, then at debug: a refused hello's, its REQ lines included, and a poll's that asks for a hello", async () => {
		const { log, port } = await start();
		// A claude started inside the session, with the session's host and its own session id.
		const child = JSON.stringify({ v: 1, sid: "sess-child", host: HOST, inst: "ichild", model: "m", plugin: "0.2.0", cc: "2.1.309" });
		for (let i = 0; i < 5; i++) {
			const answer = await atOnce(port, { token: TOKEN, path: "/v1/hello", body: child });
			assert.deepEqual([status(answer), json(answer)], [409, { error: "not this session" }]);
		}
		// The session's own mod polls a deck it hasn't said hello to.
		for (let i = 0; i < 5; i++) {
			const answer = await atOnce(port, { token: TOKEN, method: "GET", path: `/v1/next?sid=${MOD.sid}&host=${HOST}&inst=${MOD.inst}&wait=20` });
			assert.deepEqual([status(answer), json(answer)], [409, { error: "hello first" }]);
		}
		assert.deepEqual(log.at("info").filter((l) => l.includes("409")), [
			`info HELLO refused with 409 for ${HOST} inst "ichild" sid "sess-child": the registry lists that host under another session id`,
			`info HELLO FIRST ${HOST}: mod instance "i1" polls, but no instance has said hello to this deck for the session, so the deck answers 409 to ask for one`,
		]);
		const debug = (text: string): number => log.lines.filter((l) => l.level === "debug" && l.message.includes(text)).length;
		assert.deepEqual(
			[debug('REQ 409 POST "/v1/hello": {"error":"not this session"}'), debug("HELLO refused with 409"), debug(`HELLO FIRST ${HOST}`)],
			[5, 4, 4],
			"the bridge's own line for each refused hello, and the rest of the route's",
		);
	});

	test("a refusal's quiet key doesn't grow with what the client sends: many bad Hosts, one line at info; many wrong tokens, one", async () => {
		const { log, port } = await start();
		for (let i = 0; i < 20; i++) {
			assert.equal(status(await atOnce(port, { token: TOKEN, host: `rebind-${i}.example:${port}`, path: "/v1/hello", body: "{}" })), 403);
			assert.equal(status(await atOnce(port, { token: randomBytes(32).toString("hex"), path: "/v1/hello", body: "{}" })), 401);
		}
		assert.deepEqual(log.at("info").filter((l) => l.startsWith("info REQ 4")), [
			`info REQ 403 POST "/v1/hello": Host "rebind-0.example:${port}" isn't 127.0.0.1:${port} or localhost:${port}`,
			'info REQ 401 POST "/v1/hello": wrong token',
		]);
		assert.deepEqual(
			[log.lines.filter((l) => l.level === "debug" && l.message.startsWith("REQ 403")).length, log.lines.filter((l) => l.level === "debug" && l.message.startsWith("REQ 401")).length],
			[19, 19],
		);
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
