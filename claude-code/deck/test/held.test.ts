import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type Held, HeldRequests, type Responder } from "../src/bridge/held.js";
import { ALLOW_DECISION, DENY_DECISION } from "../src/protocol/wire.js";
import { RecordingLog } from "./helpers/recording-log.js";

/** A client whose answer the test can read, and which can close. */
class FakeResponder implements Responder {
	open = true;
	sent: { status: number; body: string }[] = [];
	send(status: number, body: string): void {
		if (!this.open) throw new Error("sent to a closed client");
		this.open = false;
		this.sent.push({ status, body });
	}
}

const ALLOW_JSON = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
const DENY_JSON = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from the Stream Deck.","interrupt":true}}}';

function req(tool: string, fields: Partial<Omit<Held, "id">> = {}): Omit<Held, "id"> {
	return { at: 1000, host: "local_a", tool, kind: "tool", summary: tool, fp: "00000000", agent: null, ...fields };
}

describe("held requests", () => {
	test("the answers are PROTOCOL.md's, byte for byte", () => {
		assert.equal(JSON.stringify(ALLOW_DECISION), ALLOW_JSON);
		assert.equal(JSON.stringify(DENY_DECISION), DENY_JSON);
	});

	test("holds requests oldest first, numbered in arrival order", () => {
		const held = new HeldRequests();
		let changes = 0;
		held.onChange(() => changes++);
		const a = held.hold(req("Bash"), new FakeResponder());
		const b = held.hold(req("Write", { host: "local_b" }), new FakeResponder());
		assert.deepEqual([a.id, b.id], [1, 2]);
		assert.equal(held.size, 2);
		assert.equal(changes, 2);
		assert.equal(held.oldest?.tool, "Bash");
		assert.deepEqual(
			held.forHost("local_b").map((h) => h.tool),
			["Write"],
		);
	});

	test("Approve answers the oldest with allow, Deny with deny, and then the next is the oldest", () => {
		const held = new HeldRequests();
		const first = new FakeResponder();
		const second = new FakeResponder();
		const a = held.hold(req("Bash"), first);
		const b = held.hold(req("Edit"), second);
		const result = held.press(a.id, "allow");
		assert.equal(result.ok && result.did, "answered");
		assert.deepEqual(first.sent, [{ status: 200, body: ALLOW_JSON }]);
		assert.deepEqual(second.sent, [], "only the oldest is answered");
		held.press(b.id, "deny");
		assert.deepEqual(second.sent, [{ status: 200, body: DENY_JSON }]);
		assert.equal(held.size, 0);
	});

	test("a press for a request the key no longer shows answers nothing", () => {
		const held = new HeldRequests();
		const r2 = new FakeResponder();
		const a = held.hold(req("A"), new FakeResponder());
		const b = held.hold(req("B"), r2);
		held.close(a.id);
		assert.deepEqual(held.press(a.id, "allow"), { ok: false, why: "changed", held: b });
		assert.equal(held.press(null, "allow").ok, false, "the key showed nothing, but a request arrived before the press");
		assert.deepEqual(r2.sent, []);
		assert.equal(held.press(b.id, "allow").ok, true);
	});

	test("an ask is shown but never answered: the press says jump, and it stays held", () => {
		const held = new HeldRequests();
		const r = new FakeResponder();
		const q = held.hold(req("AskUserQuestion", { kind: "ask" }), r);
		const result = held.press(q.id, "allow");
		assert.deepEqual(result, { ok: true, did: "jump", held: q });
		assert.deepEqual(r.sent, []);
		assert.equal(held.size, 1);
	});

	test("takeAllowed gives a session's last Allow once, with when it went: not a Deny, not with another of its requests held, and not once a newer one has come", () => {
		let wall = 5000;
		const held = new HeldRequests({ wallNow: () => wall });
		assert.equal(held.takeAllowed("local_a"), null);
		const a = held.hold(req("Bash"), new FakeResponder());
		const b = held.hold(req("Write", { host: "local_b" }), new FakeResponder());
		wall = 6000;
		held.press(a.id, "allow");
		assert.equal(held.takeAllowed("local_b"), null, "another session's");
		assert.deepEqual(held.takeAllowed("local_a"), { held: a, at: 6000 });
		assert.equal(held.takeAllowed("local_a"), null, "once");
		// From a dial, as from a key.
		wall = 7000;
		held.answer("local_b", b.id, "allow");
		assert.deepEqual(held.takeAllowed("local_b"), { held: b, at: 7000 });
		// A Deny.
		const c = held.hold(req("Bash"), new FakeResponder());
		held.press(c.id, "deny");
		assert.equal(held.takeAllowed("local_a"), null);
		// Another of the session's requests is still held: it goes on waiting for that one.
		const d = held.hold(req("Bash"), new FakeResponder());
		const e = held.hold(req("Edit"), new FakeResponder());
		held.press(d.id, "allow");
		assert.equal(held.takeAllowed("local_a"), null);
		// A newer request comes after the Allow.
		held.press(e.id, "allow");
		held.hold(req("Read"), new FakeResponder());
		assert.equal(held.takeAllowed("local_a"), null);
	});

	test("a Session Slot dial answers its own session's oldest, Allow or Deny, and only the one its strip showed", () => {
		const held = new HeldRequests();
		const b = new FakeResponder();
		const a1 = new FakeResponder();
		const a2 = new FakeResponder();
		held.hold(req("Bash", { host: "local_b" }), b);
		const first = held.hold(req("Write"), a1);
		const second = held.hold(req("Edit"), a2);
		assert.deepEqual(held.answer("local_a", second.id, "allow"), { ok: false, why: "changed", held: first, detail: `the strip showed #${second.id}, but the session's oldest is #${first.id}` });
		assert.deepEqual(held.answer("local_a", first.id, "deny"), { ok: true, held: first, remaining: 2 });
		assert.deepEqual(held.answer("local_a", second.id, "allow"), { ok: true, held: second, remaining: 1 });
		assert.deepEqual([a1.sent, a2.sent, b.sent], [[{ status: 200, body: DENY_JSON }], [{ status: 200, body: ALLOW_JSON }], []], "the oldest across sessions, B's, isn't touched");
		assert.equal(held.answer("local_c", null, "allow").ok, false, "nothing held for that session");
	});

	test("a dial never answers an ask (Phase 9): Allow and Deny are refused, nothing is sent, and it stays held until released", () => {
		const held = new HeldRequests();
		const r = new FakeResponder();
		for (const tool of ["AskUserQuestion", "ExitPlanMode"]) {
			const ask = held.hold(req(tool, { kind: "ask" }), r);
			for (const decision of ["allow", "deny"] as const) {
				const result = held.answer("local_a", ask.id, decision);
				assert.deepEqual(result.ok ? null : [result.why, result.held], ["ask", ask], `${tool} ${decision}`);
			}
			assert.deepEqual([r.sent, held.size], [[], 1], tool);
			held.release(ask.id, "the tool's end (rule 1)");
			assert.deepEqual(r.sent, [{ status: 200, body: "{}" }], tool);
			r.open = true;
			r.sent = [];
		}
	});

	test("nothing but PROTOCOL.md's three bodies ever leaves: Allow, Deny and {}, whatever answers or releases a request", () => {
		const held = new HeldRequests();
		const responders: FakeResponder[] = [];
		const hold = (tool: string, fields: Partial<Omit<Held, "id">> = {}): Held => {
			const r = new FakeResponder();
			responders.push(r);
			return held.hold(req(tool, fields), r);
		};
		// Every way a request can go: the keys, a dial, the release rules and a client that went, on a tool and on an ask.
		for (const decision of ["allow", "deny"] as const) {
			held.press(hold("Bash").id, decision);
			held.answer("local_a", hold("Bash").id, decision);
			const ask = hold("AskUserQuestion", { kind: "ask" });
			held.press(ask.id, decision);
			held.answer("local_a", ask.id, decision);
			held.release(ask.id, "rule 1");
			const plan = hold("ExitPlanMode", { kind: "ask" });
			held.answer("local_a", plan.id, decision);
			held.close(plan.id);
		}
		held.release(hold("Bash").id, "rule 3");
		const bodies = responders.flatMap((r) => r.sent.map((sent) => sent.body));
		assert.deepEqual(new Set(bodies), new Set([ALLOW_JSON, DENY_JSON, "{}"]), "each of the three, and nothing else");
		assert.equal(bodies.length, 7, "one answer per request answered or released; none for the plans, which closed");
		assert.equal(held.size, 0);
	});

	test("an oldest whose client already went is removed, nothing is sent, and the press doesn't fall through", () => {
		const held = new HeldRequests();
		const gone = new FakeResponder();
		const next = new FakeResponder();
		const a = held.hold(req("A"), gone);
		held.hold(req("B"), next);
		gone.open = false;
		const result = held.press(a.id, "allow");
		assert.deepEqual(result.ok === false && result.why, "gone");
		assert.deepEqual(next.sent, []);
		assert.equal(held.size, 1);
	});

	test("release answers no decision; close removes without an answer", () => {
		const log = new RecordingLog();
		const held = new HeldRequests({ log });
		const r1 = new FakeResponder();
		const r2 = new FakeResponder();
		const a = held.hold(req("A"), r1);
		const b = held.hold(req("B"), r2);
		assert.equal(held.release(a.id, "rule 1")?.id, a.id);
		assert.deepEqual(r1.sent, [{ status: 200, body: "{}" }]);
		r2.open = false;
		assert.equal(held.close(b.id)?.id, b.id);
		assert.equal(held.release(b.id, "again"), null, "a request that's gone can't be released");
		assert.equal(held.size, 0);
		assert.ok(log.at("info").some((l) => /RELEASED #1 "A": rule 1; 1 held/.test(l)), log.at("info").join("\n"));
	});

	test("nothing held: a press does nothing", () => {
		assert.deepEqual(new HeldRequests().press(null, "allow"), { ok: false, why: "empty", held: null });
	});

	test("the log names each held request's session", () => {
		const log = new RecordingLog();
		const held = new HeldRequests({ log });
		held.hold(req("Bash", { host: "local_x", summary: "ls" }), new FakeResponder());
		assert.deepEqual(log.at("info"), ['info HELD #1 tool "Bash" "ls" fp 00000000 from local_x; 1 held']);
	});
});
