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

	test("results from another session or mod instance, with no instance, or for a command not yet delivered, are ignored", () => {
		const { queue } = setup();
		const queued = queue.queue("local_b", { t: "prompt", text: "not delivered" });
		assert.equal(queue.result("local_b", "ib", queued.id, "done", null, null), false);
		const cmd = queue.queue("local_a", { t: "prompt", text: "hi" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		assert.equal(queue.result("local_b", "ib", cmd.id, "done", null, null), false);
		assert.equal(queue.result("local_a", "ia-2", cmd.id, "done", null, null), false);
		assert.equal(queue.result("local_a", null, cmd.id, "waiting", null, null), false, "a result with no inst");
		assert.equal(queue.result("local_a", null, cmd.id, "done", null, null), false, "a final one with no inst");
		assert.equal(queue.result("local_a", "ia", cmd.id, "sideways", null, null), false);
		assert.equal(cmd.state, "delivered");
		assert.equal(queue.result("local_a", "ia", cmd.id, "done", null, null), true, "from the instance it went to");
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

	test("a waiting prompt whose mod keeps polling is still waiting ten minutes on, until its final result", () => {
		const { queue, clock } = setup();
		const cmd = queue.queue("local_a", { t: "prompt", text: "hi" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		// The mod polls again as soon as a poll answers, and takes the prompt.
		let poll = new FakePoll();
		queue.poll("local_a", "ia", 20, poll);
		assert.equal(queue.result("local_a", "ia", cmd.id, "waiting", null, null), true);
		// The session's turn runs on for ten minutes. Each poll answers with none after its 20 s, and the mod
		// polls again at once. Then the engine submits the prompt.
		for (let i = 0; i < 30; i++) {
			clock.advance(20_000);
			assert.deepEqual(poll.answers, [{ cmds: [] }]);
			poll = new FakePoll();
			queue.poll("local_a", "ia", 20, poll);
		}
		assert.equal(cmd.state, "waiting");
		assert.equal(queue.result("local_a", "ia", cmd.id, "done", null, null), true);
		assert.deepEqual([cmd.state, cmd.error], ["done", null]);
	});

	test("a waiting prompt fails with 'no result' once its session has gone 60 s without an open poll", () => {
		const { queue, clock } = setup();
		const cmd = queue.queue("local_a", { t: "prompt", text: "hi" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		const held = new FakePoll();
		queue.poll("local_a", "ia", 20, held);
		assert.equal(queue.result("local_a", "ia", cmd.id, "waiting", null, null), true);
		// The poll's client goes away 5 s in, and the mod doesn't poll again for 50 s: within the limit.
		clock.advance(5000);
		held.close();
		clock.advance(50_000);
		assert.equal(cmd.state, "waiting");
		// It polls once more; that poll answers with none after its 20 s, and no other follows.
		const last = new FakePoll();
		queue.poll("local_a", "ia", 20, last);
		clock.advance(20_000);
		assert.deepEqual(last.answers, [{ cmds: [] }]);
		clock.advance(IN_FLIGHT_MS - 1);
		assert.equal(cmd.state, "waiting");
		clock.advance(1);
		assert.deepEqual([cmd.state, cmd.error], ["failed", "no result"]);
		assert.equal(queue.result("local_a", "ia", cmd.id, "done", null, null), false, "a late result is ignored");
		assert.equal(clock.pendingTimers, 0);
	});

	test("a mode command keeps its 60 s, even after a waiting result, and while its mod keeps polling", () => {
		const { queue, clock } = setup();
		const cmd = queue.queue("local_a", { t: "mode", mode: "plan" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		queue.poll("local_a", "ia", 20, new FakePoll());
		assert.equal(queue.result("local_a", "ia", cmd.id, "waiting", null, null), true);
		// The mod polls on, each poll after the last answers, and still the change fails 60 s after delivery.
		for (let i = 0; i < 2; i++) {
			clock.advance(20_000);
			queue.poll("local_a", "ia", 20, new FakePoll());
		}
		clock.advance(20_000 - 1);
		assert.equal(cmd.state, "waiting");
		clock.advance(1);
		assert.deepEqual([cmd.state, cmd.error], ["failed", "no result"]);
		assert.equal(queue.inFlightMode("local_a", "plan", "pretool"), null, "so the bridge no longer allows that change");
		assert.equal(queue.inFlightMode("local_a", "plan", "permission"), null);
	});

	test("a mode command in flight is found once per hook, for its session and mode; each hook's allow is counted apart", () => {
		const { queue } = setup();
		const cmd = queue.queue("local_a", { t: "mode", mode: "acceptEdits" });
		for (const hook of ["pretool", "permission"] as const) assert.equal(queue.inFlightMode("local_a", "acceptEdits", hook), null, `queued isn't in flight (${hook})`);
		queue.poll("local_a", "ia", 20, new FakePoll());
		for (const hook of ["pretool", "permission"] as const) {
			assert.equal(queue.inFlightMode("local_b", "acceptEdits", hook), null);
			assert.equal(queue.inFlightMode("local_a", "plan", hook), null);
			assert.equal(queue.inFlightMode("local_a", "acceptEdits", hook), cmd);
		}
		cmd.allowed.pretool = true;
		assert.equal(queue.inFlightMode("local_a", "acceptEdits", "pretool"), null, "one mode check's allow per command");
		assert.equal(queue.inFlightMode("local_a", "acceptEdits", "permission"), cmd, "the PermissionRequest still has its own");
		cmd.allowed.permission = true;
		assert.equal(queue.inFlightMode("local_a", "acceptEdits", "permission"), null, "one PermissionRequest's allow per command");
		// And the other way round, for a second command.
		const next = queue.queue("local_a", { t: "mode", mode: "plan" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		next.allowed.permission = true;
		assert.equal(queue.inFlightMode("local_a", "plan", "pretool"), next);
		assert.equal(queue.result("local_a", "ia", next.id, "done", null, ""), true);
		assert.equal(queue.inFlightMode("local_a", "plan", "pretool"), null, "a finished command isn't in flight");
	});

	test("a mod restart fails the in-flight commands and keeps the queued ones; a session's end fails both", () => {
		const { queue } = setup();
		const flying = queue.queue("local_a", { t: "prompt", text: "one" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		const queued = queue.queue("local_a", { t: "prompt", text: "two" });
		queue.restarted("local_a", "ib", "the mod restarted");
		assert.deepEqual([flying.state, flying.error], ["failed", "the mod restarted"]);
		assert.equal(queued.state, "queued");
		queue.failHost("local_a", "the session ended");
		assert.deepEqual([queued.state, queued.error], ["failed", "the session ended"]);
	});

	test("a mod restart answers the old instance's open poll with none, so a command queued after waits for the new one", () => {
		const { queue } = setup();
		const old = new FakePoll();
		queue.poll("local_a", "ia", 20, old);
		const other = new FakePoll();
		queue.poll("local_b", "ib", 20, other);
		queue.restarted("local_a", "ia-2", "the mod restarted");
		assert.deepEqual(old.answers, [{ cmds: [] }]);
		assert.equal(queue.polling("local_a"), false);
		assert.deepEqual(other.answers, [], "another session's poll stays open");
		const cmd = queue.queue("local_a", { t: "prompt", text: "hi" });
		assert.equal(cmd.state, "queued");
		const fresh = new FakePoll();
		queue.poll("local_a", "ia-2", 20, fresh);
		assert.deepEqual(fresh.answers, [{ cmds: [{ id: cmd.id, t: "prompt", text: "hi" }] }]);
		assert.deepEqual([cmd.state, cmd.inst], ["delivered", "ia-2"]);
	});

	test("a queued command that no poll takes within 60 s fails with 'not delivered'", () => {
		const { queue, clock } = setup();
		const cmd = queue.queue("local_a", { t: "prompt", text: "hi" });
		clock.advance(IN_FLIGHT_MS - 1);
		assert.equal(cmd.state, "queued");
		clock.advance(1);
		assert.deepEqual([cmd.state, cmd.error], ["failed", "not delivered"]);
		const late = new FakePoll();
		queue.poll("local_a", "ia", 20, late);
		clock.advance(20_000);
		assert.deepEqual(late.answers, [{ cmds: [] }], "a later poll doesn't get it");
		assert.equal(clock.pendingTimers, 0);
	});

	test("a command taken just in time gets its 60 s for a result from delivery, not from when it was queued", () => {
		const { queue, clock } = setup();
		const cmd = queue.queue("local_a", { t: "mode", mode: "plan" });
		clock.advance(IN_FLIGHT_MS - 1);
		queue.poll("local_a", "ia", 20, new FakePoll());
		assert.equal(cmd.state, "delivered");
		clock.advance(IN_FLIGHT_MS - 1);
		assert.equal(cmd.state, "delivered");
		clock.advance(1);
		assert.deepEqual([cmd.state, cmd.error], ["failed", "no result"]);
		assert.equal(clock.pendingTimers, 0);
	});

	test("a poll answered at once counts as the mod being alive: a waiting prompt outlives 60 s of such polls", () => {
		const { queue, clock } = setup();
		const cmd = queue.queue("local_a", { t: "prompt", text: "hi" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		assert.equal(queue.result("local_a", "ia", cmd.id, "waiting", null, null), true);
		// The mod's polls come every 50 s and are answered at once (wait 0), so no poll is ever open, yet the
		// session never goes 60 s without one.
		for (let i = 0; i < 6; i++) {
			clock.advance(50_000);
			const now = new FakePoll();
			queue.poll("local_a", "ia", 0, now);
			assert.deepEqual(now.answers, [{ cmds: [] }]);
		}
		assert.equal(cmd.state, "waiting");
		// Then they stop: 60 s after the last, the prompt fails.
		clock.advance(IN_FLIGHT_MS - 1);
		assert.equal(cmd.state, "waiting");
		clock.advance(1);
		assert.deepEqual([cmd.state, cmd.error], ["failed", "no result"]);
	});

	test("a waiting prompt still ends when the mod restarts or the session ends", () => {
		const { queue } = setup();
		const restarted = queue.queue("local_a", { t: "prompt", text: "one" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		queue.result("local_a", "ia", restarted.id, "waiting", null, null);
		queue.restarted("local_a", "ia-2", "the mod restarted");
		assert.deepEqual([restarted.state, restarted.error], ["failed", "the mod restarted"]);
		const ended = queue.queue("local_a", { t: "prompt", text: "two" });
		queue.poll("local_a", "ia-2", 20, new FakePoll());
		queue.result("local_a", "ia-2", ended.id, "waiting", null, null);
		queue.failHost("local_a", "the session ended");
		assert.deepEqual([ended.state, ended.error], ["failed", "the session ended"]);
	});

	test("a session's end answers its open poll with none, and fails every command it has", () => {
		const { queue, clock } = setup();
		const waiting = queue.queue("local_a", { t: "prompt", text: "one" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		queue.result("local_a", "ia", waiting.id, "waiting", null, null);
		const open = new FakePoll();
		queue.poll("local_a", "ia", 20, open);
		const other = new FakePoll();
		queue.poll("local_b", "ib", 20, other);
		queue.failHost("local_a", "the session ended");
		assert.deepEqual(open.answers, [{ cmds: [] }]);
		assert.equal(queue.polling("local_a"), false);
		assert.deepEqual([waiting.state, waiting.error], ["failed", "the session ended"]);
		assert.deepEqual(other.answers, [], "another session's poll stays open");
		clock.advance(20_000);
		assert.deepEqual(open.answers, [{ cmds: [] }], "answered once");
	});

	test("a turn's end answers the session's open poll with none at once, and the queue holds the next for the wait it's given", () => {
		const { queue, clock } = setup();
		// No poll open: none yet, or its client went away. Nothing to answer.
		assert.equal(queue.turnEnded("local_a"), false);
		const gone = new FakePoll();
		queue.poll("local_a", "ia", 20, gone);
		gone.close();
		assert.equal(queue.turnEnded("local_a"), false);
		assert.deepEqual(gone.answers, []);
		const open = new FakePoll();
		queue.poll("local_a", "ia", 20, open);
		const other = new FakePoll();
		queue.poll("local_b", "ib", 20, other);
		clock.advance(5000);
		assert.equal(queue.turnEnded("local_a"), true);
		assert.deepEqual(open.answers, [{ cmds: [] }]);
		assert.equal(queue.polling("local_a"), false);
		assert.deepEqual(other.answers, [], "another session's poll stays open");
		assert.equal(queue.turnEnded("local_a"), false, "answered already");
		// The mod polls again: that poll is held as usual, and a command queued later answers it.
		const next = new FakePoll();
		queue.poll("local_a", "ia", 20, next);
		clock.advance(15_000);
		assert.deepEqual(next.answers, []);
		const cmd = queue.queue("local_a", { t: "prompt", text: "hi" });
		assert.deepEqual(next.answers, [{ cmds: [{ id: cmd.id, t: "prompt", text: "hi" }] }]);
		assert.deepEqual(open.answers, [{ cmds: [] }], "answered once");
	});

	test("a poll answered at a turn's end starts a waiting prompt's 60 s without a poll, as any poll's end does", () => {
		const { queue, clock } = setup();
		// A prompt pressed while the session was busy waits for the turn's end (S3).
		const cmd = queue.queue("local_a", { t: "prompt", text: "hi" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		assert.equal(queue.result("local_a", "ia", cmd.id, "waiting", null, null), true);
		queue.poll("local_a", "ia", 20, new FakePoll());
		clock.advance(5000);
		assert.equal(queue.turnEnded("local_a"), true);
		// The mod never polls again.
		clock.advance(IN_FLIGHT_MS - 1);
		assert.equal(cmd.state, "waiting");
		clock.advance(1);
		assert.deepEqual([cmd.state, cmd.error], ["failed", "no result"]);
	});

	test("a turn's end whose poll's client went before its close arrived answers nothing, and says so", () => {
		const { queue } = setup();
		const dying = new FakePoll();
		queue.poll("local_a", "ia", 20, dying);
		dying.open = false;
		assert.equal(queue.turnEnded("local_a"), false);
		assert.deepEqual(dying.answers, []);
	});

	test("dispose stops every timer", () => {
		const { queue, clock } = setup();
		queue.queue("local_a", { t: "prompt", text: "hi" });
		queue.poll("local_a", "ia", 20, new FakePoll());
		queue.poll("local_b", "ib", 20, new FakePoll());
		const waiting = queue.queue("local_c", { t: "prompt", text: "waits" });
		queue.poll("local_c", "ic", 20, new FakePoll());
		queue.result("local_c", "ic", waiting.id, "waiting", null, null);
		assert.ok(clock.pendingTimers > 0);
		queue.dispose();
		assert.equal(clock.pendingTimers, 0);
	});
});
