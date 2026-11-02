import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CommandQueue, IN_FLIGHT_MS, type PollReply } from "../src/bridge/commands.js";
import { FakeClock } from "./helpers/fake-clock.js";

/** A long poll whose answer the test reads, and which the test can close. */
class FakePoll implements PollReply {
	open = true;
	answers: unknown[] = [];
	#onClose: (() => void)[] = [];
	send(status: number, body: string): void {
		assert.equal(status, 200);
		this.open = false;
		this.answers.push(JSON.parse(body));
	}
	onClose(fn: () => void): void {
		this.#onClose.push(fn);
	}
	close(): void {
		this.open = false;
		for (const fn of this.#onClose) fn();
	}
}

function setup() {
	const clock = new FakeClock();
	const queue = new CommandQueue({ clock });
	return { clock, queue };
}

describe("command queue and long poll", () => {
	test("a poll with commands queued answers at once, oldest first, and they're in flight", () => {
		const { queue } = setup();
		const c1 = queue.queue("local_a", { t: "prompt", text: "one" });
		const c2 = queue.queue("local_a", { t: "mode", mode: "plan" });
		queue.queue("local_b", { t: "prompt", text: "other session" });
		const poll = new FakePoll();
		queue.poll("local_a", "ia", 20, poll);
		assert.deepEqual(poll.answers, [
			{
				cmds: [
					{ id: c1.id, t: "prompt", text: "one" },
					{ id: c2.id, t: "mode", mode: "plan" },
				],
			},
		]);
		assert.deepEqual([c1.state, c2.state], ["delivered", "delivered"]);
		assert.equal(queue.get(c1.id)?.inst, "ia");
		assert.match(c1.id, /^c\d+$/);
	});

	test("an empty poll is held until a command is queued, which answers it at once", () => {
		const { queue, clock } = setup();
		const poll = new FakePoll();
		queue.poll("local_a", "ia", 20, poll);
		clock.advance(5000);
		assert.deepEqual(poll.answers, []);
		assert.equal(queue.polling("local_a"), true);
		const cmd = queue.queue("local_a", { t: "prompt", text: "go" });
		assert.deepEqual(poll.answers, [{ cmds: [{ id: cmd.id, t: "prompt", text: "go" }] }]);
		assert.equal(queue.polling("local_a"), false);
	});

	test("a held poll answers no commands when its wait is up; wait 0 answers at once", () => {
		const { queue, clock } = setup();
		const poll = new FakePoll();
		queue.poll("local_a", "ia", 3, poll);
		clock.advance(2999);
		assert.deepEqual(poll.answers, []);
		clock.advance(1);
		assert.deepEqual(poll.answers, [{ cmds: [] }]);
		const now = new FakePoll();
		queue.poll("local_a", "ia", 0, now);
		assert.deepEqual(now.answers, [{ cmds: [] }]);
	});

	test("one open poll per session: a new one answers the older with none", () => {
		const { queue } = setup();
		const older = new FakePoll();
		const newer = new FakePoll();
		queue.poll("local_a", "ia", 20, older);
		queue.poll("local_a", "ia", 20, newer);
		assert.deepEqual(older.answers, [{ cmds: [] }]);
		assert.deepEqual(newer.answers, []);
		const other = new FakePoll();
		queue.poll("local_b", "ib", 20, other);
		assert.deepEqual(newer.answers, [], "another session's poll doesn't touch it");
	});

	test("a poll whose client went away gets nothing, and the command stays queued for the next", () => {
		const { queue } = setup();
		const gone = new FakePoll();
		queue.poll("local_a", "ia", 20, gone);
		gone.close();
		const cmd = queue.queue("local_a", { t: "prompt", text: "hi" });
		assert.equal(cmd.state, "queued");
		const next = new FakePoll();
		queue.poll("local_a", "ia", 20, next);
		assert.equal(cmd.state, "delivered");
	});

	test("results: waiting, then a final state; later results and unknown ids are ignored", () => {
		const { queue } = setup();
		const cmd = queue.queue("local_a", { t: "prompt", text: "hi" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		assert.equal(queue.result("local_a", "ia", cmd.id, "waiting", null, null), true);
		assert.equal(cmd.state, "waiting");
		assert.equal(queue.result("local_a", "ia", cmd.id, "refused", "dropped: stopped", null), true);
		assert.deepEqual([cmd.state, cmd.error], ["refused", "dropped: stopped"]);
		assert.equal(queue.result("local_a", "ia", cmd.id, "done", null, null), false, "a finished command");
		assert.equal(queue.result("local_a", "ia", "c999", "done", null, null), false, "an unknown one");
	});

	test("results from another session or mod instance, or for a command not yet delivered, are ignored", () => {
		const { queue } = setup();
		const queued = queue.queue("local_b", { t: "prompt", text: "not delivered" });
		assert.equal(queue.result("local_b", "ib", queued.id, "done", null, null), false);
		const cmd = queue.queue("local_a", { t: "prompt", text: "hi" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		assert.equal(queue.result("local_b", "ib", cmd.id, "done", null, null), false);
		assert.equal(queue.result("local_a", "ia-2", cmd.id, "done", null, null), false);
		assert.equal(queue.result("local_a", "ia", cmd.id, "sideways", null, null), false);
		assert.equal(cmd.state, "delivered");
	});

	test("a delivered command with no result fails after 60 s, with 'no result'", () => {
		const { queue, clock } = setup();
		const cmd = queue.queue("local_a", { t: "prompt", text: "hi" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		clock.advance(IN_FLIGHT_MS - 1);
		assert.equal(cmd.state, "delivered");
		clock.advance(1);
		assert.deepEqual([cmd.state, cmd.error], ["failed", "no result"]);
		assert.equal(queue.result("local_a", "ia", cmd.id, "done", null, null), false, "a late result is ignored");
	});

	test("a prompt the mod is waiting with stays in flight past 60 s, until its final result", () => {
		const { queue, clock } = setup();
		const cmd = queue.queue("local_a", { t: "prompt", text: "hi" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		clock.advance(IN_FLIGHT_MS - 1000);
		assert.equal(queue.result("local_a", "ia", cmd.id, "waiting", null, null), true);
		assert.equal(clock.pendingTimers, 0, "no clock runs on a waiting prompt");
		// The session's turn runs on for ten minutes; the engine then submits the prompt.
		clock.advance(10 * 60_000);
		assert.equal(cmd.state, "waiting");
		assert.equal(queue.result("local_a", "ia", cmd.id, "done", null, null), true);
		assert.deepEqual([cmd.state, cmd.error], ["done", null]);
	});

	test("a mode command keeps its 60 s, even if a waiting result comes for it", () => {
		const { queue, clock } = setup();
		const cmd = queue.queue("local_a", { t: "mode", mode: "plan" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		assert.equal(queue.result("local_a", "ia", cmd.id, "waiting", null, null), true);
		clock.advance(IN_FLIGHT_MS);
		assert.deepEqual([cmd.state, cmd.error], ["failed", "no result"]);
		assert.equal(queue.inFlightMode("local_a", "plan"), null, "so the bridge no longer allows that change");
	});

	test("a mode command in flight is found once, for its session and mode", () => {
		const { queue } = setup();
		const cmd = queue.queue("local_a", { t: "mode", mode: "acceptEdits" });
		assert.equal(queue.inFlightMode("local_a", "acceptEdits"), null, "queued isn't in flight");
		queue.poll("local_a", "ia", 20, new FakePoll());
		assert.equal(queue.inFlightMode("local_b", "acceptEdits"), null);
		assert.equal(queue.inFlightMode("local_a", "plan"), null);
		assert.equal(queue.inFlightMode("local_a", "acceptEdits"), cmd);
		cmd.allowed = true;
		assert.equal(queue.inFlightMode("local_a", "acceptEdits"), null, "one allow per command");
	});

	test("a mod restart fails the in-flight commands and keeps the queued ones; a session's end fails both", () => {
		const { queue } = setup();
		const flying = queue.queue("local_a", { t: "prompt", text: "one" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		const queued = queue.queue("local_a", { t: "prompt", text: "two" });
		queue.forgetInFlight("local_a", "the mod restarted");
		assert.deepEqual([flying.state, flying.error], ["failed", "the mod restarted"]);
		assert.equal(queued.state, "queued");
		queue.failHost("local_a", "the session ended");
		assert.deepEqual([queued.state, queued.error], ["failed", "the session ended"]);
	});

	test("a waiting prompt still ends when the mod restarts or the session ends", () => {
		const { queue } = setup();
		const restarted = queue.queue("local_a", { t: "prompt", text: "one" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		queue.result("local_a", "ia", restarted.id, "waiting", null, null);
		queue.forgetInFlight("local_a", "the mod restarted");
		assert.deepEqual([restarted.state, restarted.error], ["failed", "the mod restarted"]);
		const ended = queue.queue("local_a", { t: "prompt", text: "two" });
		queue.poll("local_a", "ia-2", 20, new FakePoll());
		queue.result("local_a", "ia-2", ended.id, "waiting", null, null);
		queue.failHost("local_a", "the session ended");
		assert.deepEqual([ended.state, ended.error], ["failed", "the session ended"]);
	});

	test("dispose stops every timer", () => {
		const { queue, clock } = setup();
		queue.queue("local_a", { t: "prompt", text: "hi" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		queue.poll("local_b", "ib", 20, new FakePoll());
		assert.ok(clock.pendingTimers > 0);
		queue.dispose();
		assert.equal(clock.pendingTimers, 0);
	});
});
