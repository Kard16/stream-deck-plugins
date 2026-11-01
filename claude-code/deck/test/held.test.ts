import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ALLOW_DECISION, describeBody, HeldQueue, type Responder } from "../src/bridge/held.js";

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

describe("held-request queue", () => {
	test("holds requests oldest first, with their tool_name and session_id", () => {
		const queue = new HeldQueue({ now: () => 1000 });
		let changes = 0;
		queue.onChange(() => changes++);
		const a = queue.hold({ tool_name: "Bash", session_id: "s1", tool_input: { command: "ls" } }, new FakeResponder());
		const b = queue.hold({ tool_name: "Write" }, new FakeResponder());
		const c = queue.hold([1, 2], new FakeResponder());
		assert.equal(queue.size, 3);
		assert.equal(changes, 3);
		assert.deepEqual(a, { id: 1, at: 1000, toolName: "Bash", sessionId: "s1" });
		assert.deepEqual(b, { id: 2, at: 1000, toolName: "Write", sessionId: null });
		assert.deepEqual(c, { id: 3, at: 1000, toolName: null, sessionId: null }, "any JSON is held; only an object has a tool_name");
		assert.equal(queue.oldest?.id, 1);
	});

	test("answers the oldest with allow, then the next is the oldest", () => {
		const queue = new HeldQueue();
		const first = new FakeResponder();
		const second = new FakeResponder();
		queue.hold({ tool_name: "Bash" }, first);
		queue.hold({ tool_name: "Edit" }, second);

		const result = queue.answerOldest();
		assert.equal(result.ok, true);
		assert.deepEqual(first.sent, [{ status: 200, body: ALLOW_JSON }]);
		assert.equal(JSON.stringify(ALLOW_DECISION), ALLOW_JSON);
		assert.deepEqual(second.sent, [], "only the oldest is answered");
		assert.equal(queue.size, 1);
		assert.equal(queue.oldest?.toolName, "Edit");
		if (result.ok) assert.equal(result.remaining, 1);
	});

	test("a client that closes first is removed from the count, and isn't answered", () => {
		const queue = new HeldQueue();
		const r1 = new FakeResponder();
		const r2 = new FakeResponder();
		const r3 = new FakeResponder();
		queue.hold({ tool_name: "A" }, r1);
		const b = queue.hold({ tool_name: "B" }, r2);
		queue.hold({ tool_name: "C" }, r3);

		r2.open = false;
		assert.equal(queue.close(b.id), true);
		assert.equal(queue.size, 2);
		assert.deepEqual(
			queue.list().map((r) => r.toolName),
			["A", "C"],
		);
		assert.equal(queue.close(b.id), false, "closing twice changes nothing");

		queue.answerOldest();
		queue.answerOldest();
		assert.equal(queue.size, 0);
		assert.deepEqual(r2.sent, []);
		assert.equal(r1.sent.length, 1);
		assert.equal(r3.sent.length, 1);
	});

	test("a press for a request the key no longer shows answers nothing", () => {
		const queue = new HeldQueue();
		const r1 = new FakeResponder();
		const r2 = new FakeResponder();
		const a = queue.hold({ tool_name: "A" }, r1);
		const b = queue.hold({ tool_name: "B" }, r2);
		// The key showed A; A's client went away; B is now the oldest.
		queue.close(a.id);
		const result = queue.answerOldest(a.id);
		assert.deepEqual(result, { ok: false, why: "changed", req: b });
		assert.deepEqual(r2.sent, []);
		assert.equal(queue.size, 1);
		// The key showed nothing, but a request arrived before the press.
		assert.equal(queue.answerOldest(null).ok, false);
		// The key showed B.
		assert.equal(queue.answerOldest(b.id).ok, true);
		assert.equal(r2.sent.length, 1);
	});

	test("an oldest whose client is already gone is removed, and nothing is sent", () => {
		const queue = new HeldQueue();
		const gone = new FakeResponder();
		const next = new FakeResponder();
		queue.hold({ tool_name: "A" }, gone);
		queue.hold({ tool_name: "B" }, next);
		gone.open = false; // closed, but the close hasn't reached the queue yet
		const result = queue.answerOldest();
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.why, "gone");
		assert.deepEqual(next.sent, [], "the press doesn't fall through to the next request");
		assert.equal(queue.size, 1);
	});

	test("nothing held: nothing answered", () => {
		assert.deepEqual(new HeldQueue().answerOldest(), { ok: false, why: "empty", req: null });
	});

	test("describeBody reads only string tool_name and session_id from an object", () => {
		assert.deepEqual(describeBody({ tool_name: "Bash", session_id: "x" }), { toolName: "Bash", sessionId: "x" });
		assert.deepEqual(describeBody({ tool_name: 7, session_id: "" }), { toolName: null, sessionId: null });
		assert.deepEqual(describeBody(null), { toolName: null, sessionId: null });
		assert.deepEqual(describeBody("Bash"), { toolName: null, sessionId: null });
	});
});
