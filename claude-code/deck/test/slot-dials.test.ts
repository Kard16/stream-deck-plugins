import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PollReply } from "../src/bridge/commands.js";
import { DecisionKeys, SETTLE_MS } from "../src/keys/decision.js";
import { SessionModel } from "../src/model/sessions.js";
import { KEEP_INPUT_BYTES } from "../src/protocol/ask.js";
import { ALLOW_DECISION, answerDecision, approvePlanDecision, DENY_DECISION } from "../src/protocol/wire.js";
import type { RegistrySession } from "../src/registry/registry.js";
import { COALESCE_MS } from "../src/sessions/dials.js";
import { GONE_MS, PAGES, PICK_SETTLE_MS, PLAN_CHOICES, type SlotDialsOptions, SlotDials, type SlotScreen } from "../src/slots/dials.js";
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
const FRUIT = { question: "Which fruits?", header: "Fruit", options: [{ label: "Apple", description: "Red or green" }, { label: "Pear, ripe", description: "Soft" }, { label: "Plum", description: "Purple" }], multiSelect: true };
const SIZE = { question: "Which size?", header: "Size", options: [{ label: "Small", description: "A little one" }, { label: "Large", description: "A big one" }], multiSelect: false };

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
			return { layout: `layouts/slot-${screen.kind}.json`, feedback: { what: { value: what }, pick: { value: "pick" in screen ? screen.pick : "cursor" in screen ? screen.cursor : null } } };
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
	/** Long enough after a turn for its repaint, and for the choice to be in sight PICK_SETTLE_MS after it. */
	const seePick = (): void => clock.advance(COALESCE_MS + PICK_SETTLE_MS);
	/** What the strip last painted in the test render's `pick` key: the chip or the cursor. */
	const paintedPick = (id = "d0"): unknown => (dials.painted(id)?.pick as { value?: unknown } | undefined)?.value;
	return { clock, model, slots, dials, log, renders, events, alerts, jumps, permission, press, turn, screen, seePick, paintedPick, surface, at: (t: number) => (wall = t) };
}

const pickOf = (s: SlotScreen): number | null => ("pick" in s ? s.pick : null);
const cursorOf = (s: SlotScreen): number | null => (s.kind === "question" ? s.cursor : null);

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
		// can fall within GONE_MS of that; a pick that moves on waits only for PICK_SETTLE_MS, so it can, and it shows the
		// guard gone once the strip paints p2. (Where the 1 s rule is off, as in the fixture runner, whose clock never
		// moves, a send can too: dial-next.jsonl.)
		assert.ok(PAINT_INTERVAL_MS + PICK_SETTLE_MS < GONE_MS);
		const { clock, model, dials, permission, press, turn, screen, alerts, jumps } = setup({ paintIntervalMs: PAINT_INTERVAL_MS });
		// p1, a question, is held and painted on A's strip.
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
		// p2, a form of two questions for the same session, is held; its paint waits out the paint interval from the pages'.
		clock.advance(50);
		const input = { questions: [COLOR, SIZE] };
		const p2 = permission(A, "AskUserQuestion", input);
		const p2Id = model.held.oldestFor(A)?.id ?? -1;
		assert.ok(p2Id > p1Id);
		assert.equal(screen().kind, "question");
		press();
		assert.deepEqual([alerts, jumps, p2.sent], [["d0", "d0"], [], []], "before p2 is painted: an alert, where a press before any turn would jump");
		turn();
		clock.advance(leftAt + PAINT_INTERVAL_MS - 1 - clock.now());
		assert.equal(dials.lastShown("d0"), p1Id, "p2 not painted yet");
		clock.advance(1);
		const firstPaint = clock.now();
		assert.equal(dials.lastShown("d0"), p2Id, "p2 painted, the cursor on Red");
		// Red in sight PICK_SETTLE_MS, within GONE_MS of p1 leaving: the press picks it and moves on.
		clock.advance(PICK_SETTLE_MS);
		assert.ok(clock.now() - leftAt < GONE_MS, `${clock.now() - leftAt} ms after p1 left`);
		press();
		const second = screen();
		assert.deepEqual([second.kind === "question" ? [second.index, second.question] : second.kind, alerts.length], [[1, "Which size?"], 2], "on to question 2, no alert");
		// Sending waits out the 1 s from p2's first paint: Small has been in sight long enough, p2 only 999 ms.
		turn();
		clock.advance(firstPaint + SETTLE_MS - 1 - clock.now());
		press();
		assert.deepEqual([alerts.length, p2.sent], [3, []], "999 ms after p2's first paint: an alert, nothing sent");
		clock.advance(SETTLE_MS);
		press();
		assert.deepEqual(p2.sent, [JSON.parse(JSON.stringify(answerDecision(input, { "Red or blue?": "Red", "Which size?": "Small" })))]);
		assert.deepEqual([alerts.length, jumps], [3, []]);
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

describe("a question on its session's dial", () => {
	test("single-select: the cursor runs over the options, then Other…; a press picks, and after the last question it sends the Answer", () => {
		const { clock, permission, turn, press, screen, jumps } = setup();
		const input = { questions: [COLOR] };
		const reply = permission(A, "AskUserQuestion", input);
		const s = screen();
		assert.equal(s.kind, "question");
		assert.deepEqual(
			s.kind === "question" ? { index: s.index, count: s.count, header: s.header, question: s.question, multi: s.multi, cursor: s.cursor, items: s.items } : null,
			{
				index: 0,
				count: 1,
				header: "Color",
				question: "Red or blue?",
				multi: false,
				cursor: null,
				items: [
					{ t: "option", label: "Red", description: "Warm", ticked: false },
					{ t: "option", label: "Blue", description: "Cool", ticked: false },
					{ t: "other" },
				],
			},
		);
		press();
		assert.deepEqual([jumps, reply.sent], [[A], []], "a press before any turn jumps");
		assert.equal(cursorOf(turn(-1)), 2, "counter-clockwise first: the last place, Other…");
		assert.equal(cursorOf(turn()), 0, "wraps");
		assert.equal(cursorOf(turn()), 1);
		clock.advance(SETTLE_MS);
		press();
		assert.deepEqual(reply.sent, [JSON.parse(JSON.stringify(answerDecision(input, { "Red or blue?": "Blue" })))]);
		assert.equal(screen().kind, "pages");
	});

	test("Other… jumps, typing goes in the app, and nothing is sent", () => {
		const { clock, permission, turn, press, jumps, seePick } = setup();
		const reply = permission(A, "AskUserQuestion", { questions: [COLOR] });
		clock.advance(SETTLE_MS);
		turn(3);
		seePick();
		press();
		assert.deepEqual([jumps, reply.sent], [[A], []]);
	});

	test("multi-select: a press ticks or unticks; Next needs a tick; the last question's list ends with Send; a long touch goes back, or clears the first's picks", () => {
		const { clock, dials, alerts, permission, turn, press, screen, seePick } = setup();
		const input = { questions: [FRUIT, SIZE] };
		const reply = permission(A, "AskUserQuestion", input);
		clock.advance(SETTLE_MS);
		const q = (): Extract<SlotScreen, { kind: "question" }> => {
			const s = screen();
			assert.equal(s.kind, "question");
			return s as Extract<SlotScreen, { kind: "question" }>;
		};
		assert.deepEqual(q().items.at(-1), { t: "next", send: false, ready: false });
		turn(-1);
		seePick();
		press();
		assert.deepEqual([alerts, q().index], [["d0"], 0], "Next with no tick");
		clock.advance(SETTLE_MS);
		turn();
		seePick();
		press();
		turn();
		seePick();
		press();
		assert.deepEqual(q().picked, ["Apple", "Pear, ripe"]);
		press();
		assert.deepEqual(q().picked, ["Apple"], "unticked: the place the strip shows hasn't changed, so a second press needs no wait");
		turn();
		seePick();
		press();
		assert.deepEqual(q().picked, ["Apple", "Plum"]);
		assert.deepEqual(q().items.at(-1), { t: "next", send: false, ready: true });
		turn();
		turn();
		seePick();
		press();
		assert.deepEqual([q().index, q().question, q().cursor], [1, "Which size?", null], "Next");
		press();
		assert.deepEqual(alerts, ["d0", "d0"], "nothing under the cursor after turns: an alert, not a jump");
		dials.tap("d0", true);
		assert.deepEqual([q().index, q().picked], [0, ["Apple", "Plum"]], "back a question, the picks kept");
		dials.tap("d0", true);
		assert.deepEqual([q().index, q().picked, q().cursor], [0, [], null], "on the first, its picks cleared");
		turn();
		seePick();
		press();
		turn();
		seePick();
		press();
		turn(3);
		seePick();
		press();
		turn(2);
		clock.advance(SETTLE_MS);
		press();
		assert.deepEqual(reply.sent, [JSON.parse(JSON.stringify(answerDecision(input, { "Which fruits?": 'Apple, "Pear, ripe"', "Which size?": "Large" })))]);
	});

	test("on a multi-select last question, Send needs a tick and sends", () => {
		const { clock, alerts, permission, turn, press, screen, seePick } = setup();
		const input = { questions: [FRUIT] };
		const reply = permission(A, "AskUserQuestion", input);
		clock.advance(SETTLE_MS);
		const last = turn(-1);
		assert.deepEqual(last.kind === "question" ? last.items[last.cursor ?? 0] : null, { t: "next", send: true, ready: false });
		seePick();
		press();
		assert.deepEqual([alerts, reply.sent], [["d0"], []]);
		clock.advance(SETTLE_MS);
		turn(-2);
		seePick();
		press();
		turn(2);
		seePick();
		press();
		assert.deepEqual(reply.sent, [JSON.parse(JSON.stringify(answerDecision(input, { "Which fruits?": "Plum" })))]);
		assert.equal(screen().kind, "pages");
	});

	test("a question the dial can't answer, or a form too big, shows Answer in app; a press jumps, and turns do nothing", () => {
		const { clock, dials, permission, press, screen, jumps } = setup();
		const reply = permission(A, "AskUserQuestion", { questions: [{ question: "Free text?", options: [] }] });
		assert.deepEqual(
			(({ kind, why }) => ({ kind, why }))(screen() as Extract<SlotScreen, { kind: "inApp" }>),
			{ kind: "inApp", why: "unreadable" },
		);
		dials.rotate("d0", 3, false);
		dials.tap("d0", true);
		clock.advance(SETTLE_MS);
		press();
		assert.deepEqual([jumps, reply.sent], [[A], []]);
		const big = permission(B, "ExitPlanMode", { plan: "x".repeat(KEEP_INPUT_BYTES) });
		assert.equal((screen("d1") as Extract<SlotScreen, { kind: "inApp" }>).why, "too big");
		press("d1");
		assert.deepEqual([jumps, big.sent], [[A, B], []]);
	});

	test("a question or a plan whose tool_input the token scrub changed shows Answer in app: turns do nothing, and a press jumps and sends nothing", () => {
		const { clock, model, dials, press, screen, jumps } = setup();
		const flagged = (host: string, tool: string, input: unknown): FakeReply => {
			const reply = new FakeReply();
			model.permission({ session_id: host === A ? "sid-1" : "sid-2", tool_name: tool, tool_input: input }, host, reply, true);
			return reply;
		};
		const question = flagged(A, "AskUserQuestion", { questions: [COLOR] });
		const plan = flagged(B, "ExitPlanMode", { plan: "# Tidy the deck\n", planFilePath: "/p.md" });
		for (const id of ["d0", "d1"]) {
			const s = screen(id);
			assert.deepEqual(s.kind === "inApp" ? [s.kind, s.why] : [s.kind], ["inApp", "scrubbed"], id);
		}
		dials.rotate("d0", 2, false);
		dials.rotate("d1", -1, false);
		clock.advance(SETTLE_MS);
		press();
		press("d1");
		assert.deepEqual([jumps, question.sent, plan.sent], [[A, B], [], []]);
	});
});

describe("a plan on its session's dial", () => {
	test("Plan ready, its first line, and the chips Approve · Auto, Approve · Accept edits, Approve · Manual and Reject, in that order", () => {
		const { clock, jumps, permission, turn, press, screen, seePick } = setup();
		const input = { plan: "# Tidy the deck\n\n1. Do it.\n", planFilePath: "/Users/me/.claude/plans/tidy-otter.md" };
		const reply = permission(A, "ExitPlanMode", input);
		const s = screen();
		assert.deepEqual(s.kind === "plan" ? [s.firstLine, s.choices.map((c) => c.label), s.pick] : null, ["Tidy the deck", ["Approve · Auto", "Approve · Accept edits", "Approve · Manual", "Reject"], null]);
		assert.deepEqual(
			PLAN_CHOICES.map((c) => (c.t === "approve" ? c.mode : c.t)),
			["auto", "acceptEdits", "default", "reject"],
		);
		press();
		assert.deepEqual([jumps, reply.sent], [[A], []], "nothing picked: a jump, where the whole plan is");
		clock.advance(SETTLE_MS);
		turn(2);
		seePick();
		press();
		assert.deepEqual(reply.sent, [JSON.parse(JSON.stringify(approvePlanDecision(input, "acceptEdits")))]);
	});

	test("each Approve sends its mode; Reject sends the keys' Deny; a plan without a file approves its {} as it came", () => {
		for (const [ticks, want] of [
			[1, approvePlanDecision({}, "auto")],
			[3, approvePlanDecision({}, "default")],
			[-1, DENY_DECISION],
		] as const) {
			const { clock, permission, turn, press, seePick } = setup();
			const reply = permission(A, "ExitPlanMode", {});
			clock.advance(SETTLE_MS);
			turn(ticks);
			seePick();
			press();
			assert.deepEqual(reply.sent, [JSON.parse(JSON.stringify(want))], String(ticks));
		}
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

	test("the chips stop at either end, so a stray tick past Deny, Reject or Allow leaves the chip the strip shows, and a push sends it", () => {
		for (const [tool, input, first, stray, want] of [
			["Bash", { command: "ls" }, -1, 1, DENY_DECISION],
			["ExitPlanMode", {}, -1, 1, DENY_DECISION],
			["Bash", { command: "ls" }, 1, -1, ALLOW_DECISION],
			["ExitPlanMode", {}, 1, -1, approvePlanDecision({}, "auto")],
		] as const) {
			const { clock, alerts, permission, turn, press } = setup();
			const reply = permission(A, tool, input);
			const before = pickOf(turn(first));
			clock.advance(2 * SETTLE_MS);
			assert.equal(pickOf(turn(stray)), before, `${tool}: the tick past the end changes nothing`);
			press();
			assert.deepEqual([reply.sent, alerts], [[JSON.parse(JSON.stringify(want))], []], `${tool} ${first}`);
		}
	});

	test("a plan with nothing picked: one stray tick and a push at once neither approves it nor jumps", () => {
		const { clock, alerts, jumps, permission, turn, press } = setup();
		const reply = permission(A, "ExitPlanMode", { plan: "# Tidy the deck\n" });
		clock.advance(2 * SETTLE_MS);
		assert.equal(pickOf(turn()), 0, "Approve · Auto, at once");
		press();
		assert.deepEqual([reply.sent, jumps, alerts], [[], [], ["d0"]]);
	});

	test("a question: a tick just before a push neither picks nor sends, on a last question or on one the pick would move on from", () => {
		const { clock, alerts, permission, turn, press, screen } = setup();
		const one = permission(A, "AskUserQuestion", { questions: [COLOR] });
		clock.advance(2 * SETTLE_MS);
		assert.equal(cursorOf(turn()), 0, "Red, at once, from nothing under the cursor");
		press();
		assert.deepEqual([one.sent, alerts], [[], ["d0"]], "a single-select last question: nothing sent");
		// B's form of two, on the second dial: the cursor on Red, shown; a tick to Blue and a push at once.
		const two = permission(B, "AskUserQuestion", { questions: [COLOR, SIZE] });
		turn(1, "d1");
		clock.advance(2 * SETTLE_MS);
		assert.equal(cursorOf(turn(1, "d1")), 1);
		press("d1");
		const s = screen("d1");
		assert.deepEqual(s.kind === "question" ? [s.index, s.picked, s.cursor] : null, [0, [], 1], "still question 1, with nothing picked");
		assert.deepEqual([two.sent, alerts], [[], ["d0", "d1"]]);
	});
});

describe("nothing sends without a press", () => {
	test("a pick, a tick or a cursor waits however long: no timeout, no default", () => {
		const { clock, permission, turn, at, alerts, jumps } = setup();
		const tool = permission(A, "Bash", { command: "ls" });
		turn();
		const question = permission(B, "AskUserQuestion", { questions: [FRUIT] });
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
		assert.deepEqual([screen().kind, cursorOf(screen())], ["question", null], "the next request, from its start");
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

	test("a new session on the slot starts a question over too: its question, cursor, picks and turn", () => {
		const { clock, model, slots, permission, turn, press, screen, seePick, jumps, alerts } = setup();
		const a = permission(A, "AskUserQuestion", { questions: [FRUIT, SIZE] });
		const b = permission(B, "AskUserQuestion", { questions: [SIZE] });
		clock.advance(SETTLE_MS);
		// On A's form: Apple ticked, Next, then the cursor on Large in question 2.
		turn();
		seePick();
		press();
		turn(-1);
		seePick();
		press();
		turn(2);
		const before = screen("d0");
		assert.deepEqual(before.kind === "question" ? [before.index, before.cursor] : null, [1, 1]);
		// A long press with B on screen in the app: B onto the first slot, A onto the second.
		model.setRecords(new Map([[B, { host: B, title: null, model: null, effort: null, permissionMode: null, lastFocusedAt: 99_999, turnCategory: null, isArchived: false, lastActivityAt: null, cwd: null, summary: null, needs: null }]]));
		assert.equal(slots.takeOnScreen(SLOT0).ok, true);
		const s0 = screen("d0");
		assert.deepEqual(s0.kind === "question" ? [s0.request, s0.index, s0.cursor, s0.picked] : null, [model.held.oldestFor(B)?.id, 0, null, []], "B's form from its start");
		const s1 = screen("d1");
		assert.deepEqual(s1.kind === "question" ? [s1.request, s1.index, s1.cursor, s1.picked] : null, [model.held.oldestFor(A)?.id, 0, null, []], "and A's, on the other dial, from its start: the picks went too");
		clock.advance(2 * SETTLE_MS);
		press("d0");
		assert.deepEqual([a.sent, b.sent, alerts, jumps], [[], [], [], [B]], "no turn on B's form yet: a press jumps");
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
