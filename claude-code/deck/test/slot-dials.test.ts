import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PollReply } from "../src/bridge/commands.js";
import { DecisionKeys, SETTLE_MS } from "../src/keys/decision.js";
import { SessionModel } from "../src/model/sessions.js";
import { ALLOW_DECISION, DENY_DECISION } from "../src/protocol/wire.js";
import type { RegistrySession } from "../src/registry/registry.js";
import { COALESCE_MS, GONE_MS, PICK_SETTLE_MS, type SlotDialsOptions, SlotDials, type SlotScreen } from "../src/slots/dials.js";
import { dialSlotId } from "../src/slots/ids.js";
import { Slots } from "../src/slots/slots.js";
import { MemorySlotStore } from "../src/slots/store.js";
import { PAINT_INTERVAL_MS } from "../src/util/painter.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { RecordingLog } from "./helpers/recording-log.js";

class FakeReply implements PollReply {
	open = true;
	sent: unknown[] = [];
	send(_status: number, body: string): void {
		this.open = false;
		this.sent.push(JSON.parse(body));
	}
	onClose(): void {}
}

const A = "local_a";
const B = "local_b";
const DEV = "dev1";
const SLOT0 = dialSlotId(DEV, 2, 0);
const SLOT1 = dialSlotId(DEV, 2, 1);

function reg(pid: number, host: string, fields: Partial<RegistrySession> = {}): RegistrySession {
	return { key: String(pid), name: `Session ${host.slice(6)}`, status: "busy", cwd: `/p/${pid}`, hostSessionId: host, sessionId: `sid-${pid}`, statusUpdatedAt: 1000, startedAt: pid, ...fields };
}

const COLOR = { question: "Red or blue?", header: "Color", options: [{ label: "Red", description: "Warm" }, { label: "Blue", description: "Cool" }], multiSelect: false };

/**
 * A on the first dial's slot and B on the second's, both shown, with the 1 s rule and the gone guard as given. The
 * slots' repaint tick runs on a clock of its own that stands still, so no tick comes between a test's steps (slots.test.ts
 * tests the tick).
 */
function setup(opts: Partial<SlotDialsOptions> = {}, registry: RegistrySession[] = [reg(1, A), reg(2, B)]) {
	const clock = new FakeClock();
	let wall = 50_000;
	const log = new RecordingLog();
	const model = new SessionModel({ clock, log, wallNow: () => wall });
	model.setRegistry(registry);
	model.setBridgeState("listening");
	const slots = new Slots(model, { store: new MemorySlotStore(new Map([[SLOT0, A], [SLOT1, B]])), clock: new FakeClock(), fillDelayMs: 0 });
	const renders: { screen: SlotScreen; now: number }[] = [];
	const events: string[] = [];
	const alerts: string[] = [];
	const jumps: string[] = [];
	const dials = new SlotDials(slots, model, {
		render: (screen, now) => {
			renders.push({ screen, now });
			const what = "request" in screen ? `#${screen.request}` : screen.kind === "pages" ? `page ${screen.page}` : "";
			return { layout: `layouts/slot-${screen.kind}.json`, feedback: { what: { value: what }, pick: { value: "pick" in screen ? screen.pick : null } } };
		},
		clock,
		wallNow: () => wall,
		log,
		paintIntervalMs: 0,
		open: (h) => jumps.push(h),
		...opts,
	});
	const surface = (id: string) => ({
		setLayout: (layout: string) => events.push(`${id} layout ${layout}`),
		setFeedback: (payload: Record<string, unknown>) => events.push(`${id} feedback ${Object.keys(payload).sort().join(",")}`),
		showAlert: () => alerts.push(id),
	});
	dials.add("d0", SLOT0, surface("d0"));
	dials.add("d1", SLOT1, surface("d1"));
	const permission = (host: string, tool: string, input: unknown): FakeReply => {
		const reply = new FakeReply();
		model.permission({ session_id: host === A ? "sid-1" : "sid-2", tool_name: tool, tool_input: input }, host, reply);
		return reply;
	};
	const press = (id = "d0"): void => {
		dials.down(id);
		dials.up(id);
	};
	const turn = (n = 1, id = "d0"): SlotScreen => {
		dials.rotate(id, n, false);
		const s = dials.screen(id);
		assert.ok(s);
		return s;
	};
	const screen = (id = "d0"): SlotScreen => {
		const s = dials.screen(id);
		assert.ok(s);
		return s;
	};
	/** Long enough after a turn for its repaint, and for the chip to be in sight PICK_SETTLE_MS after it. */
	const seePick = (): void => clock.advance(COALESCE_MS + PICK_SETTLE_MS);
	/** What the strip last painted in the test render's `pick` key: the chip. */
	const paintedPick = (id = "d0"): unknown => (dials.painted(id)?.pick as { value?: unknown } | undefined)?.value;
	return { clock, model, slots, dials, log, renders, events, alerts, jumps, permission, press, turn, screen, seePick, paintedPick, surface, at: (t: number) => (wall = t) };
}

/** The pages while no other loop is in a turn: Now, Context, Setup. */
const PAGES = 3;

const pickOf = (s: SlotScreen): number | null => ("pick" in s ? s.pick : null);

describe("a Session Slot dial with nothing to answer: the pages", () => {
	test("turning moves a page, wrapping both ways; a long touch goes back to the first; a press or tap jumps and makes it the target", () => {
		const { model, dials, jumps, turn, press, screen } = setup();
		assert.deepEqual([screen().kind, screen().kind === "pages" && screen().slot], ["pages", SLOT0]);
		const pages = (): number[] => {
			const s = screen();
			return s.kind === "pages" ? [s.page, s.pages] : [];
		};
		assert.deepEqual(pages(), [0, PAGES]);
		turn();
		turn();
		assert.deepEqual(pages(), [2, 3]);
		turn();
		assert.deepEqual(pages(), [0, 3], "wraps");
		turn(-1);
		assert.deepEqual(pages(), [2, 3], "and back");
		turn(2);
		assert.deepEqual(pages(), [1, 3], "one step per tick");
		dials.tap("d0", true);
		assert.deepEqual(pages(), [0, 3]);
		press();
		dials.tap("d0", false);
		assert.deepEqual(jumps, [A, A]);
		assert.equal(model.picked, A);
	});

	test("an empty slot: nothing to page or jump to, and a press alerts", () => {
		const { slots, dials, alerts, jumps, surface } = setup();
		const empty = dialSlotId(DEV, 2, 3);
		dials.add("d3", empty, surface("d3"));
		assert.equal(slots.host(empty), null, "no session left to fill it");
		assert.deepEqual(dials.screen("d3"), { kind: "empty", slot: empty });
		dials.rotate("d3", 1, false);
		dials.tap("d3", true);
		dials.down("d3");
		dials.up("d3");
		dials.tap("d3", false);
		assert.deepEqual([alerts, jumps], [["d3", "d3"], []]);
	});

	test("a press that turned while held is no press", () => {
		const { dials, jumps } = setup();
		dials.down("d0");
		dials.rotate("d0", 1, true);
		dials.up("d0");
		assert.deepEqual(jumps, []);
	});
});

describe("the Agents pages on a Session Slot dial (agents-and-wake.md, B2)", () => {
	test("while other loops are in a turn their pages come after Now and turning goes through them; the page stays put while they come and go, and when the one shown goes, the strip goes to Now", () => {
		const { model, turn, screen } = setup();
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia" });
		let seq = 0;
		/** `running` workflow agents in a turn, all listed: two a page. */
		const running = (n: number): void => {
			const agents = Array.from({ length: n }, (_, i) => ({ kind: "workflow", desc: `agent ${i + 1}`, doing: "" }));
			assert.equal(model.events({ host: A, inst: "ia", seq: ++seq, events: [{ t: "threads", at: 1, running: n, agents, runs: [] }] }).status, 204);
		};
		const pages = (): number[] => {
			const s = screen();
			return s.kind === "pages" ? [s.page, s.pages] : [];
		};
		turn();
		assert.deepEqual(pages(), [1, PAGES], "Context");
		running(3);
		assert.deepEqual(pages(), [3, 5], "still Context, now after two Agents pages");
		turn(2);
		assert.deepEqual(pages(), [0, 5], "Setup, then round to Now");
		turn();
		assert.deepEqual(pages(), [1, 5], "the first Agents page");
		turn();
		assert.deepEqual(pages(), [2, 5], "the second");
		turn(-3);
		assert.deepEqual(pages(), [4, 5], "back through Now to Setup");
		turn(3);
		// One finishes: the second Agents page goes while it shows.
		running(2);
		assert.deepEqual(pages(), [0, 4], "Now");
		running(5);
		assert.deepEqual(pages(), [0, 6], "it stays on Now as more come");
		turn();
		assert.deepEqual(pages(), [1, 6]);
		running(0);
		assert.deepEqual(pages(), [0, PAGES], "all done while one showed: Now");
	});
});

describe("an approval on its session's dial", () => {
	test("nothing picked until a turn: the first clockwise picks Allow, counter-clockwise Deny; then one, stopping at either end; a long touch clears", () => {
		const { dials, permission, turn, screen } = setup();
		permission(A, "Bash", { command: "npm test" });
		const s = screen();
		assert.equal(s.kind, "approval");
		assert.deepEqual(s.kind === "approval" ? [s.tool, s.summary, s.choices.map((c) => c.label), s.pick] : [], ["Bash", "npm test", ["Allow", "Deny"], null]);
		assert.equal(pickOf(turn()), 0);
		assert.equal(pickOf(turn()), 1);
		assert.equal(pickOf(turn()), 1, "stops at Deny: no wrapping round to Allow");
		assert.equal(pickOf(turn(5)), 1);
		assert.equal(pickOf(turn(-1)), 0);
		assert.equal(pickOf(turn(-3)), 0, "and at Allow");
		dials.tap("d0", true);
		assert.equal(pickOf(screen()), null);
		assert.equal(pickOf(turn(-1)), 1, "the first turn counter-clockwise picks the last");
	});

	test("a press with nothing picked jumps; with a pick, once in sight 1 s, it sends the keys' Allow or Deny", () => {
		const { clock, jumps, alerts, permission, turn, press, screen, seePick } = setup();
		const reply = permission(A, "Bash", { command: "npm test" });
		press();
		assert.deepEqual([jumps, reply.sent], [[A], []]);
		turn();
		clock.advance(SETTLE_MS - 1);
		press();
		assert.deepEqual([alerts, reply.sent], [["d0"], []], "under 1 s: an alert, nothing sent");
		clock.advance(SETTLE_MS);
		press();
		assert.deepEqual(reply.sent, [ALLOW_DECISION]);
		assert.equal(screen().kind, "pages", "answered: the screen starts over");
		const second = permission(A, "Bash", { command: "rm -rf build" });
		clock.advance(SETTLE_MS);
		turn(-1);
		seePick();
		press();
		assert.deepEqual(second.sent, [DENY_DECISION]);
	});

	test("the 1 s counts from the request's first paint on the strip, or the strip's last alert or answer if later", () => {
		const { clock, alerts, permission, turn, press } = setup();
		const reply = permission(A, "Bash", { command: "ls" });
		clock.advance(500);
		press();
		assert.deepEqual(alerts, [], "nothing picked: a jump, not an alert");
		turn();
		clock.advance(400);
		press();
		assert.deepEqual(alerts, ["d0"], "the pick in sight long enough, but the request only 900 ms");
		clock.advance(SETTLE_MS - 1);
		press();
		assert.deepEqual(alerts, ["d0", "d0"], "from the alert, 999 ms");
		clock.advance(SETTLE_MS);
		press();
		assert.deepEqual(reply.sent, [ALLOW_DECISION]);
	});

	test("the dial answers its own session's oldest request, not the oldest across sessions", () => {
		const { clock, permission, turn, press, screen, seePick } = setup();
		const b = permission(B, "Bash", { command: "npm test" });
		clock.advance(10);
		const a = permission(A, "Write", { file_path: "/x/s9.txt" });
		assert.equal(screen("d0").kind === "approval" && screen("d0").kind, "approval");
		assert.equal(screen("d0").kind === "approval" ? (screen("d0") as { summary: string }).summary : "", "s9.txt");
		clock.advance(SETTLE_MS);
		turn();
		seePick();
		press();
		assert.deepEqual([a.sent, b.sent], [[ALLOW_DECISION], []]);
	});

	test("only the request the strip showed: one the strip hasn't painted yet gets an alert, and nothing, though the same chip was picked on both", () => {
		// A render whose since changes with the wall clock each second, as the real strip's does, so a repaint 2 s on
		// sends and starts the painter's 100 ms.
		const { clock, model, dials, permission, turn, press, screen, alerts, at } = setup({
			paintIntervalMs: 100,
			goneMs: 0,
			render: (s, now) => ({ layout: `layouts/slot-${s.kind}.json`, feedback: { what: { value: "request" in s ? `#${s.request}` : s.kind }, pick: { value: "pick" in s ? s.pick : null }, since: { value: Math.floor(now / 1000) } } }),
		});
		const first = permission(A, "Bash", { command: "one" });
		turn();
		const second = permission(A, "Bash", { command: "two" });
		clock.advance(2 * SETTLE_MS);
		// A change at 2 s repaints the since, as the slots' tick would; Allow on the first has been in sight since its
		// paint at 100 ms.
		at(52_000);
		model.setRecords(new Map());
		// The first is answered elsewhere now, so the strip's paint of the second waits out those 100 ms.
		const key = new DecisionKeys(model, "allow", { clock, paintIntervalMs: 0, settleMs: 0 });
		key.add("k", { setImage: () => {}, showOk: () => {}, showAlert: () => {} });
		key.press("k");
		assert.deepEqual(first.sent, [ALLOW_DECISION]);
		const firstId = dials.lastShown("d0");
		assert.equal(screen().kind === "approval" && (screen() as { request: number }).request !== firstId, true, "the screen is the second's");
		turn();
		press();
		assert.deepEqual([alerts, second.sent], [["d0"], []], "the strip still showed the first, with Allow picked as now: nothing sent");
		clock.advance(100 + SETTLE_MS);
		press();
		assert.deepEqual(second.sent, [ALLOW_DECISION]);
		key.remove("k");
	});

	test("a request answered elsewhere first: the screen starts over at once, and a press within GONE_MS alerts and sends nothing", () => {
		assert.deepEqual([GONE_MS, SETTLE_MS], [1000, 1000]);
		const { clock, model, permission, turn, press, screen, alerts, jumps } = setup();
		const reply = permission(A, "Bash", { command: "ls" });
		clock.advance(SETTLE_MS);
		turn();
		const key = new DecisionKeys(model, "deny", { clock, paintIntervalMs: 0, settleMs: 0 });
		key.add("k", { setImage: () => {}, showOk: () => {}, showAlert: () => {} });
		key.press("k");
		assert.deepEqual(reply.sent, [DENY_DECISION]);
		assert.equal(screen().kind, "pages");
		clock.advance(GONE_MS - 1);
		press();
		assert.deepEqual([alerts, jumps], [["d0"], []]);
		clock.advance(1);
		press();
		assert.deepEqual(jumps, [A], "after GONE_MS, the pages' press jumps");
		key.remove("k");
	});

	test("a request answered elsewhere makes the press alert only while nothing newer is on the strip: once the strip paints the session's next request, a press acts on it, under the 1 s rule and PICK_SETTLE_MS (dial-next)", () => {
		// Every length real, GONE_MS included. A send waits 1 s from p2's first paint, which comes after p1 left, so no send
		// can fall within GONE_MS of that; a press with nothing picked jumps at once, so it can, and it shows the guard gone
		// once the strip paints p2. (Where the 1 s rule is off, as in the fixture runner, whose clock never moves, a send
		// can too: dial-next.jsonl.)
		assert.ok(PAINT_INTERVAL_MS < GONE_MS);
		const { clock, model, dials, permission, press, turn, screen, alerts, jumps } = setup({ paintIntervalMs: PAINT_INTERVAL_MS });
		// p1, a question, is held and painted on A's strip: Answer in app.
		const p1 = permission(A, "AskUserQuestion", { questions: [COLOR] });
		const p1Id = model.held.oldestFor(A)?.id ?? -1;
		clock.advance(PAINT_INTERVAL_MS);
		assert.equal(dials.lastShown("d0"), p1Id, "p1 on the strip");
		// The user answers it in the app, and its tool.end releases it: the strip's pages are painted at once.
		clock.advance(400);
		const leftAt = clock.now();
		assert.ok(model.held.release(p1Id, "tool.end"));
		assert.deepEqual([p1.sent, screen().kind], [[{}], "pages"]);
		press();
		assert.deepEqual([alerts, jumps], [["d0"], []], "nothing newer on the strip: the pages' press alerts rather than jumping");
		// p2, a Bash for the same session, is held; its paint waits out the paint interval from the pages'.
		clock.advance(50);
		const p2 = permission(A, "Bash", { command: "npm test" });
		const p2Id = model.held.oldestFor(A)?.id ?? -1;
		assert.ok(p2Id > p1Id);
		assert.equal(screen().kind, "approval");
		press();
		assert.deepEqual([alerts, jumps, p2.sent], [["d0", "d0"], [], []], "before p2 is painted: an alert, where a press with nothing picked would jump");
		clock.advance(leftAt + PAINT_INTERVAL_MS - 1 - clock.now());
		assert.equal(dials.lastShown("d0"), p1Id, "p2 not painted yet");
		clock.advance(1);
		const firstPaint = clock.now();
		assert.equal(dials.lastShown("d0"), p2Id, "p2 painted");
		// Within GONE_MS of p1 leaving, a press with nothing picked jumps: the guard has done its part.
		assert.ok(clock.now() - leftAt < GONE_MS, `${clock.now() - leftAt} ms after p1 left`);
		press();
		assert.deepEqual([alerts.length, jumps, p2.sent], [2, [A], []], "a jump, no alert");
		// Sending waits out the 1 s from p2's first paint: Allow has been in sight long enough, p2 only 999 ms.
		turn();
		clock.advance(firstPaint + SETTLE_MS - 1 - clock.now());
		press();
		assert.deepEqual([alerts.length, p2.sent], [3, []], "999 ms after p2's first paint: an alert, nothing sent");
		clock.advance(SETTLE_MS);
		press();
		assert.deepEqual(p2.sent, [ALLOW_DECISION]);
		assert.deepEqual([alerts.length, jumps], [3, [A]]);
	});

	test("the dial's own answer isn't a request gone unanswered, and a request the strip never painted sets nothing", () => {
		const { clock, dials, permission, turn, press, jumps, alerts, model } = setup({ paintIntervalMs: 100 });
		permission(A, "Bash", { command: "ls" });
		turn();
		// The pages were painted at 0, so the request's first paint, its pick with it, waits for 100 ms, and the 1 s
		// counts from there.
		clock.advance(SETTLE_MS);
		press();
		assert.deepEqual(alerts, ["d0"], "in sight for 900 ms");
		alerts.length = 0;
		clock.advance(SETTLE_MS);
		press();
		press();
		assert.deepEqual([alerts, jumps], [[], [A]], "sent, then a press on the pages jumps at once");
		// Held and released within the 100 ms the painter waits after a paint: never in sight.
		clock.advance(1000);
		assert.equal(model.held.size, 0);
		turn();
		clock.advance(COALESCE_MS);
		permission(A, "Write", { file_path: "/x" });
		assert.equal(dials.lastShown("d0") === model.held.oldestFor(A)?.id, false, "not painted yet");
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 999_999_999_999 }), reg(2, B)]);
		assert.equal(model.held.size, 0, "released by rule 3");
		clock.advance(150);
		press();
		assert.deepEqual([alerts, jumps], [[], [A, A]]);
	});
});

describe("a question or a plan on its session's dial: Answer in app (Phase 9)", () => {
	test("a question reads Answer in app with its summary; turns and a long touch change nothing, and a press or tap jumps and answers nothing", () => {
		const { clock, model, dials, permission, turn, press, screen, jumps, alerts } = setup();
		const reply = permission(A, "AskUserQuestion", { questions: [COLOR] });
		const id = model.held.oldestFor(A)?.id;
		const want = { kind: "inApp", slot: SLOT0, session: model.slotView(A), request: id, tool: "AskUserQuestion", summary: "Red or blue?" };
		assert.deepEqual(screen(), want);
		press();
		assert.deepEqual([jumps, reply.sent], [[A], []], "at once: a jump needs no wait");
		// However the dial turns, and however long the strip has shown it, a press only jumps.
		turn();
		turn(-3);
		dials.tap("d0", true);
		clock.advance(2 * SETTLE_MS);
		assert.deepEqual(screen(), want);
		press();
		dials.tap("d0", false);
		assert.deepEqual([jumps, reply.sent, alerts], [[A, A, A], [], []]);
		assert.equal(model.held.oldestFor(A)?.id, id, "still held, until the app's answer releases it");
	});

	test("a plan reads the same, Plan ready, whatever its tool_input, one over Phase 7's 64 KiB included; a press jumps and answers nothing", () => {
		const { clock, permission, turn, press, screen, jumps } = setup();
		const reply = permission(B, "ExitPlanMode", { plan: `# Tidy the deck\n${"x".repeat(64 * 1024)}`, planFilePath: "/p.md" });
		const s = screen("d1");
		assert.deepEqual(s.kind === "inApp" ? [s.kind, s.tool, s.summary] : [s.kind], ["inApp", "ExitPlanMode", "Plan ready"]);
		turn(1, "d1");
		clock.advance(2 * SETTLE_MS);
		press("d1");
		assert.deepEqual([jumps, reply.sent], [[B], []]);
	});
});

describe("a press acts only on the choice the strip shows (PICK_SETTLE_MS)", () => {
	test("a tick just before a push: the strip hasn't shown the new chip, so the push alerts and sends nothing; once it has, for PICK_SETTLE_MS, it sends that one", () => {
		const { clock, alerts, permission, turn, press, paintedPick } = setup();
		const reply = permission(A, "Bash", { command: "rm -rf build" });
		turn(-1);
		clock.advance(2 * SETTLE_MS);
		assert.equal(paintedPick(), 1, "Deny, in sight for 2 s");
		turn(-1);
		press();
		assert.deepEqual([alerts, reply.sent], [["d0"], []], "the strip still showed Deny");
		clock.advance(COALESCE_MS);
		assert.equal(paintedPick(), 0, "Allow, painted now");
		press();
		assert.deepEqual([alerts, reply.sent], [["d0", "d0"], []], "Allow painted just now, and within 1 s of the alert");
		clock.advance(SETTLE_MS);
		press();
		assert.deepEqual(reply.sent, [ALLOW_DECISION]);
	});

	test(`the chip must have been in sight ${PICK_SETTLE_MS} ms since its paint`, () => {
		assert.ok(PICK_SETTLE_MS >= 300 && PICK_SETTLE_MS < SETTLE_MS, String(PICK_SETTLE_MS));
		for (const [wait, want] of [
			[PICK_SETTLE_MS - 1, []],
			[PICK_SETTLE_MS, [ALLOW_DECISION]],
		] as const) {
			const { clock, alerts, permission, turn, press } = setup();
			const reply = permission(A, "Bash", { command: "ls" });
			clock.advance(SETTLE_MS);
			turn();
			clock.advance(COALESCE_MS + wait);
			press();
			assert.deepEqual([reply.sent, alerts.length], [want, want.length === 0 ? 1 : 0], String(wait));
		}
	});

	test("the chips stop at either end, so a stray tick past Deny or Allow leaves the chip the strip shows, and a push sends it", () => {
		for (const [first, stray, want] of [
			[-1, 1, DENY_DECISION],
			[1, -1, ALLOW_DECISION],
		] as const) {
			const { clock, alerts, permission, turn, press } = setup();
			const reply = permission(A, "Bash", { command: "ls" });
			const before = pickOf(turn(first));
			clock.advance(2 * SETTLE_MS);
			assert.equal(pickOf(turn(stray)), before, `${first}: the tick past the end changes nothing`);
			press();
			assert.deepEqual([reply.sent, alerts], [[want], []], String(first));
		}
	});

	test("an approval with nothing picked: one stray tick and a push at once neither allows it nor jumps", () => {
		const { clock, alerts, jumps, permission, turn, press } = setup();
		const reply = permission(A, "Bash", { command: "rm -rf build" });
		clock.advance(2 * SETTLE_MS);
		assert.equal(pickOf(turn()), 0, "Allow, at once");
		press();
		assert.deepEqual([reply.sent, jumps, alerts], [[], [], ["d0"]]);
	});
});

describe("nothing sends without a press", () => {
	test("a pick waits however long, and so does a question: no timeout, no default", () => {
		const { clock, permission, turn, at, alerts, jumps } = setup();
		const tool = permission(A, "Bash", { command: "ls" });
		turn();
		const question = permission(B, "AskUserQuestion", { questions: [COLOR] });
		turn(1, "d1");
		turn(1, "d1");
		for (let minute = 1; minute <= 30; minute++) {
			at(50_000 + minute * 60_000);
			clock.advance(60_000);
		}
		assert.deepEqual([tool.sent, question.sent, alerts, jumps], [[], [], [], []]);
	});
});

describe("starting over, painting, and the strip's layouts", () => {
	test("the screen starts over when the oldest held request changes, or the slot's session does", () => {
		const { clock, model, slots, permission, turn, screen } = setup();
		permission(A, "Bash", { command: "one" });
		permission(A, "Bash", { command: "two" });
		permission(A, "AskUserQuestion", { questions: [COLOR] });
		turn();
		assert.equal(pickOf(screen()), 0);
		const key = new DecisionKeys(model, "allow", { clock, paintIntervalMs: 0, settleMs: 0 });
		key.add("k", { setImage: () => {}, showOk: () => {}, showAlert: () => {} });
		key.press("k");
		assert.deepEqual([screen().kind, pickOf(screen())], ["approval", null], "the next approval, with nothing picked");
		turn();
		key.press("k");
		assert.equal(screen().kind, "inApp", "the next request, the question");
		key.remove("k");
		turn();
		model.setRecords(new Map([[B, { host: B, title: null, model: null, effort: null, permissionMode: null, lastFocusedAt: 99_999, turnCategory: null, isArchived: false, lastActivityAt: null, cwd: null, summary: null, needs: null }]]));
		slots.takeOnScreen(SLOT0);
		const s = screen();
		assert.deepEqual([s.kind, s.kind === "pages" ? s.session.host : null, s.kind === "pages" ? s.page : null], ["pages", B, 0], "another session: from the first page");
	});

	test("a new session on the slot starts the screen over: a chip picked for another session's request never carries over to its own", () => {
		const { clock, model, slots, permission, turn, press, screen, jumps, alerts } = setup();
		const a = permission(A, "Bash", { command: "ls" });
		const b = permission(B, "Bash", { command: "rm -rf build" });
		const aId = model.held.oldestFor(A)?.id;
		const bId = model.held.oldestFor(B)?.id;
		turn();
		turn(-1, "d1");
		clock.advance(2 * SETTLE_MS);
		assert.deepEqual([pickOf(screen("d0")), pickOf(screen("d1"))], [0, 1], "Allow on A's, Deny on B's, both in sight");
		// What a long press does: B onto the first dial's slot, which swaps A onto the second's.
		assert.equal(slots.place(SLOT0, B).ok, true);
		assert.deepEqual([slots.host(SLOT0), slots.host(SLOT1)], [B, A]);
		const s0 = screen("d0");
		const s1 = screen("d1");
		assert.deepEqual([s0.kind, "request" in s0 && s0.request, pickOf(s0)], ["approval", bId, null], "B's approval, nothing picked");
		assert.deepEqual([s1.kind, "request" in s1 && s1.request, pickOf(s1)], ["approval", aId, null], "A's approval, nothing picked");
		clock.advance(2 * SETTLE_MS);
		press("d0");
		press("d1");
		assert.deepEqual([a.sent, b.sent, alerts], [[], [], []], "nothing sent");
		assert.deepEqual(jumps, [B, A], "with nothing picked, each press jumps");
	});

	test("ticks apply at once, one step each; their repaint waits COALESCE_MS and comes once", () => {
		const { clock, events, turn, screen } = setup();
		const before = events.filter((e) => e.startsWith("d0 feedback")).length;
		turn();
		turn();
		turn(-1);
		assert.deepEqual(screen().kind === "pages" ? screen() : null, { kind: "pages", slot: SLOT0, session: (screen() as { session: unknown }).session, page: 1, pages: PAGES });
		assert.equal(events.filter((e) => e.startsWith("d0 feedback")).length, before, "not painted yet");
		clock.advance(COALESCE_MS);
		assert.equal(events.filter((e) => e.startsWith("d0 feedback")).length, before + 1);
	});

	test("a new screen kind switches the layout before its feedback, which then fills every key", () => {
		const { permission, events } = setup();
		assert.deepEqual(events.slice(0, 2), ["d0 layout layouts/slot-pages.json", "d0 feedback pick,what"]);
		events.length = 0;
		permission(A, "Bash", { command: "ls" });
		assert.deepEqual(events, ["d0 layout layouts/slot-approval.json", "d0 feedback pick,what"]);
	});

	test("a strip that throws when drawn is logged at error, and nothing escapes add or a change; the next repaint draws it", () => {
		let fail = true;
		const { model, dials, log, permission } = setup({
			render: (screen) => {
				if (fail) throw new Error("bad strip");
				return { layout: `layouts/slot-${screen.kind}.json`, feedback: { what: { value: screen.kind } } };
			},
		});
		permission(B, "Bash", { command: "ls" });
		assert.deepEqual(dials.painted("d0"), {});
		assert.ok(log.at("error").length >= 3, log.at("error").join("\n"));
		assert.ok(log.at("error").every((l) => l.includes("screen threw: Error: bad strip")));
		fail = false;
		model.setRecords(new Map());
		assert.deepEqual([dials.painted("d0"), dials.painted("d1")], [{ what: { value: "pages" } }, { what: { value: "approval" } }]);
	});

	test("lastShown keeps the last request its strip painted after the screen moves on", () => {
		const { clock, model, dials, permission } = setup();
		assert.equal(dials.lastShown("d0"), null);
		permission(A, "Bash", { command: "ls" });
		const id = model.held.oldestFor(A)?.id ?? -1;
		assert.equal(dials.lastShown("d0"), id);
		const key = new DecisionKeys(model, "allow", { clock, paintIntervalMs: 0, settleMs: 0 });
		key.add("k", { setImage: () => {}, showOk: () => {}, showAlert: () => {} });
		key.press("k");
		key.remove("k");
		assert.equal(dials.screen("d0")?.kind, "pages");
		assert.equal(dials.lastShown("d0"), id);
	});
});
