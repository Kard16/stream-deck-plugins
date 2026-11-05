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
	return { at: 1000, host: "local_a", tool, kind: "tool", summary: tool, fp: "00000000", ask: null, ...fields };
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
