import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { HeldQueue, type Responder } from "../src/bridge/held.js";
import { ApproveKeys, approveLook } from "../src/keys/approve.js";
import { approveKeySvg, svgDataUrl } from "../src/keys/art.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { RecordingLog } from "./helpers/recording-log.js";

class FakeResponder implements Responder {
	open = true;
	sent: string[] = [];
	send(_status: number, body: string): void {
		this.open = false;
		this.sent.push(body);
	}
}

function setup() {
	const clock = new FakeClock();
	const log = new RecordingLog();
	const queue = new HeldQueue();
	const keys = new ApproveKeys(queue, { log, clock });
	keys.setBridgeState("listening");
	const images: string[] = [];
	const feedback: string[] = [];
	keys.add("k1", { setImage: (svg) => images.push(svg), showOk: () => feedback.push("ok"), showAlert: () => feedback.push("alert") });
	return { clock, log, queue, keys, images, feedback };
}

describe("Approve key", () => {
	test("shows the count and the oldest request's tool", () => {
		const { clock, queue, keys, images } = setup();
		assert.match(images.at(-1) ?? "", /Approve/);
		queue.hold({ tool_name: "Bash" }, new FakeResponder());
		clock.advance(200);
		queue.hold({ tool_name: "Write" }, new FakeResponder());
		clock.advance(200);
		const svg = keys.painted("k1")?.svg ?? "";
		assert.match(svg, />2</);
		assert.match(svg, />Bash</);
		assert.equal(keys.painted("k1")?.shown, 1);
	});

	test("a press answers the request the key shows, then shows the next", () => {
		const { clock, queue, keys, feedback, log } = setup();
		const first = new FakeResponder();
		const second = new FakeResponder();
		queue.hold({ tool_name: "Bash" }, first);
		queue.hold({ tool_name: "Edit" }, second);
		clock.advance(200);
		keys.press("k1");
		assert.equal(first.sent.length, 1);
		assert.deepEqual(feedback, ["ok"]);
		assert.ok(log.at("info").some((l) => l === "info ANSWER #1 Bash: allow, from a key press; 1 held"));
		clock.advance(200);
		assert.equal(keys.painted("k1")?.shown, 2);
		assert.match(keys.painted("k1")?.svg ?? "", />Edit</);
	});

	test("a press after the shown request ended does nothing but alert", () => {
		const { clock, queue, keys, feedback } = setup();
		const first = new FakeResponder();
		const second = new FakeResponder();
		const a = queue.hold({ tool_name: "Bash" }, first);
		clock.advance(200);
		assert.equal(keys.painted("k1")?.shown, a.id);
		// A's client goes and B arrives in the same instant; the key hasn't repainted yet.
		first.open = false;
		queue.close(a.id);
		queue.hold({ tool_name: "Edit" }, second);
		keys.press("k1");
		assert.deepEqual(second.sent, []);
		assert.deepEqual(feedback, ["alert"]);
	});

	test("a press with nothing held alerts", () => {
		const { keys, feedback } = setup();
		keys.press("k1");
		assert.deepEqual(feedback, ["alert"]);
	});

	test("the image only changes when the look does, at most 10 times a second", () => {
		const { clock, queue, images } = setup();
		const before = images.length;
		for (let i = 0; i < 20; i++) queue.hold({ tool_name: "Bash" }, new FakeResponder());
		clock.advance(50);
		assert.ok(images.length - before <= 1);
		clock.advance(1000);
		assert.ok(images.length - before <= 2);
		assert.match(images.at(-1) ?? "", />20</);
	});

	test("looks: offline, idle, held; long tool names are cut", () => {
		assert.deepEqual(approveLook({ size: 0, oldest: null }, "retrying"), { count: 0, tool: null, online: false });
		assert.match(approveKeySvg({ count: 0, tool: null, online: false }), /Offline/);
		assert.match(approveKeySvg({ count: 0, tool: null, online: true }), /Approve/);
		assert.match(approveKeySvg({ count: 150, tool: "Bash", online: true }), />99\+</);
		assert.match(approveKeySvg({ count: 1, tool: "mcp__plugin_vercel_vercel__deploy", online: true }), /…</);
		assert.match(approveKeySvg({ count: 1, tool: "<b>&", online: true }), /&lt;b&gt;&amp;/);
		assert.match(svgDataUrl("<svg/>"), /^data:image\/svg\+xml;base64,/);
	});
});
