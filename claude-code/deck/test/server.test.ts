import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, describe, test } from "node:test";

import { allowedHosts, BRIDGE_HOST, BRIDGE_PORT, MAX_BODY_BYTES } from "../src/bridge/config.js";
import { type BridgeRoutes, BridgeServer } from "../src/bridge/server.js";
import { SessionModel } from "../src/model/sessions.js";
import { fingerprint } from "../src/protocol/fingerprint.js";
import { SCRUB_RUN, Scrubber } from "../src/util/log.js";
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
		// In the long poll's query, as the mod's inst, which the log names, cut to 40 characters, when it's new:
		// the token itself; after 30 characters, so the cut ends in its start; and percent-encoded.
		const poll = (inst: string) => send(port, { token: TOKEN, method: "GET", path: `/v1/next?sid=${MOD.sid}&host=${HOST}&inst=${inst}&wait=0` }).outcome;
		assert.equal(status(await poll(TOKEN)), 200);
		await poll(`${"q".repeat(30)}${TOKEN}`);
		await poll(`p${[...TOKEN].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("")}`);
		// Part of the token on its own, as if a client had cut it.
		await poll(`${"r".repeat(30)}${TOKEN.slice(0, 20)}`);
		await send(port, { token: TOKEN, path: `/w/${TOKEN.slice(20, 40)}` }).outcome;
		const held = send(port, { token: TOKEN, body: JSON.stringify({ tool_name: `${"t".repeat(90)}${TOKEN}`, session_id: TOKEN, tool_input: { command: TOKEN } }) });
		await waitFor(() => model.held.size === 1, "the request to be held");
		assert.ok(!model.held.oldest?.summary.includes(TOKEN.slice(0, SCRUB_RUN)), "nor a key");
		model.held.press(1, "allow");
		await held.outcome;
		assert.ok(log.lines.length >= 5);
		// No run of SCRUB_RUN of the token's characters anywhere.
		for (const line of log.lines) {
			for (let i = 0; i + SCRUB_RUN <= TOKEN.length; i++) assert.ok(!line.message.includes(TOKEN.slice(i, i + SCRUB_RUN)), line.message);
		}
		assert.ok(log.lines.some((l) => l.message.includes("/x/<token>")));
		// The query was scrubbed before anything read it: the inst arrived whole as <token>, not cut and then redacted.
		assert.ok(log.lines.some((l) => l.message.includes('RESTART local_test-server: mod instance "<token>" replaces "i1"')), log.at("info").join("\n"));
		assert.ok(log.lines.some((l) => l.message.includes(`mod instance "${"q".repeat(30)}<token>"`)));
		assert.ok(log.lines.some((l) => l.message.includes('mod instance "p<token>"')));
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
		const { outcome } = send(port, { token: TOKEN, body: `{"tool_name":"Custom","tool_input":{"k${TOKEN.slice(0, SCRUB_RUN)}":1,"__proto__":"p${TOKEN}","z":${nest(`x${TOKEN}`)},"${TOKEN}":2}}` });
		await waitFor(() => model.held.size === 1, "the request to be held");
		// As JSON.parse makes it, "__proto__" is an own key here too, so the fingerprint counts it.
		const expected: unknown = JSON.parse(`{"k<token>":1,"__proto__":"p<token>","z":${nest("x<token>")},"<token>":2}`);
		assert.equal(model.held.oldest?.fp, fingerprint("Custom", expected));
		model.held.press(1, "allow");
		assert.equal(status(await outcome), 200);
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
