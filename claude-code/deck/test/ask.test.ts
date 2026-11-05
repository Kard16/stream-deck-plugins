import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type DialAnswer, type Held, HeldRequests, type Responder } from "../src/bridge/held.js";
import { askAnswers, heldAsk, joinLabels, jsonBytes, KEEP_INPUT_BYTES, parseAskForm, planFirstLine } from "../src/protocol/ask.js";
import { ALLOW_DECISION, answerDecision, approvePlanDecision, DENY_DECISION } from "../src/protocol/wire.js";
import { RecordingLog } from "./helpers/recording-log.js";

class FakeResponder implements Responder {
	open = true;
	sent: { status: number; body: string }[] = [];
	send(status: number, body: string): void {
		if (!this.open) throw new Error("sent to a closed client");
		this.open = false;
		this.sent.push({ status, body });
	}
}

const COLOR = { question: "Red or blue?", header: "Color", options: [{ label: "Red", description: "Warm" }, { label: "Blue", description: "Cool" }], multiSelect: false };
const FRUIT = { question: "Which fruits?", header: "Fruit", options: [{ label: "Apple", description: "Red or green" }, { label: "Pear, ripe", description: "Soft" }, { label: "Plum", description: "Purple" }], multiSelect: true };
const SIZE = { question: "Which size?", header: "Size", options: [{ label: "Small" }, { label: "Large" }] };

describe("AskUserQuestion forms (src/protocol/ask.ts)", () => {
	test("reads the form as tool_input carries it, with header, descriptions and multiSelect optional", () => {
		const form = parseAskForm({ questions: [COLOR, SIZE] });
		assert.deepEqual(form, {
			questions: [
				{ question: "Red or blue?", header: "Color", options: [{ label: "Red", description: "Warm" }, { label: "Blue", description: "Cool" }], multiSelect: false },
				{ question: "Which size?", header: "Size", options: [{ label: "Small", description: null }, { label: "Large", description: null }], multiSelect: false },
			],
		});
		assert.equal(parseAskForm({ questions: [{ question: "Q", options: [{ label: "A" }] }] })?.questions[0]?.header, null);
		assert.equal(parseAskForm({ questions: [FRUIT] })?.questions[0]?.multiSelect, true);
	});

	test("a form the deck can't read is none: it stays display-only", () => {
		const q = (fields: Record<string, unknown>) => ({ questions: [{ ...COLOR, ...fields }] });
		const unreadable: unknown[] = [
			null,
			"questions",
			[],
			{},
			{ questions: {} },
			{ questions: [] },
			{ questions: ["Red or blue?"] },
			q({ question: "" }),
			q({ question: 7 }),
			{ questions: [COLOR, COLOR] },
			q({ header: 3 }),
			q({ header: null }),
			q({ multiSelect: "yes" }),
			q({ options: [] }),
			q({ options: undefined }),
			q({ options: "Red, Blue" }),
			q({ options: ["Red"] }),
			q({ options: [{ label: "" }] }),
			q({ options: [{ label: 1 }] }),
			q({ options: [{ label: "Red" }, { label: "Red" }] }),
			q({ options: [{ label: "Red", description: 2 }] }),
		];
		for (const input of unreadable) assert.equal(parseAskForm(input), null, JSON.stringify(input));
	});

	test("a multi-select answer joins the labels with \", \", writing one that holds \", \" or a double quote as a JSON string", () => {
		assert.equal(joinLabels(["Apple", "Plum"]), "Apple, Plum", "T5's plain join");
		assert.equal(joinLabels(["Apple", "Pear, ripe"]), 'Apple, "Pear, ripe"', "a label that holds a comma and a space");
		assert.equal(joinLabels(['Say "hi"', "Plum"]), '"Say \\"hi\\"", Plum', "a label that holds a double quote");
		assert.equal(joinLabels(["a,b", "c"]), "a,b, c", "a comma without a space isn't quoted");
		assert.equal(joinLabels(["Pear, ripe"]), '"Pear, ripe"', "even alone");
		assert.equal(joinLabels([]), "");
	});

	test("answers from picks: a single-select label as it is, a multi-select one in the order of the options, joined", () => {
		const form = parseAskForm({ questions: [FRUIT, SIZE, { ...COLOR, question: 'A "quoted", one?', options: [{ label: "Pear, ripe" }, { label: "x" }] }] });
		assert.ok(form);
		const result = askAnswers(form, { "Which fruits?": ["Pear, ripe", "Apple"], "Which size?": ["Large"], 'A "quoted", one?': ["Pear, ripe"] });
		assert.deepEqual(result, { ok: true, answers: { "Which fruits?": 'Apple, "Pear, ripe"', "Which size?": "Large", 'A "quoted", one?': "Pear, ripe" } });
	});

	test("every question answered, every label its question's, one for single-select, one or more for multi-select, nothing else: or nothing", () => {
		const form = parseAskForm({ questions: [FRUIT, SIZE] });
		assert.ok(form);
		const bad: [Record<string, string[]>, RegExp][] = [
			[{ "Which fruits?": ["Apple"] }, /"Which size\?" isn't answered/],
			[{ "Which fruits?": [], "Which size?": ["Large"] }, /"Which fruits\?" isn't answered/],
			[{ "Which fruits?": ["Apple"], "Which size?": ["Huge"] }, /"Huge" isn't one of the options/],
			[{ "Which fruits?": ["Apple"], "Which size?": ["Small", "Large"] }, /takes one answer, and has 2/],
			[{ "Which fruits?": ["Apple", "Apple"], "Which size?": ["Large"] }, /picked twice/],
			[{ "Which fruits?": ["Apple"], "Which size?": ["Large"], "Other?": ["x"] }, /isn't one of the form's questions/],
		];
		for (const [picks, why] of bad) {
			const result = askAnswers(form, picks);
			assert.equal(result.ok, false, JSON.stringify(picks));
			assert.match(result.ok ? "" : result.why, why, JSON.stringify(picks));
		}
		// A picks object whose question names an Object.prototype key doesn't answer anything.
		assert.equal(askAnswers(form, JSON.parse('{"__proto__": ["Large"], "Which fruits?": ["Apple"]}') as Record<string, string[]>).ok, false);
	});

	test("a plan's first heading or line, without its # marks; none without a plan", () => {
		assert.equal(planFirstLine({ plan: "# Plan\n\n1. Create s10.txt containing: ten.\n", planFilePath: "/p.md" }), "Plan");
		assert.equal(planFirstLine({ plan: "\n\n  ## Tidy the deck  \nmore" }), "Tidy the deck");
		assert.equal(planFirstLine({ plan: "Step one\r\nStep two" }), "Step one");
		assert.equal(planFirstLine({ plan: "#\n\n# \nReal line" }), "Real line");
		assert.equal(planFirstLine({}), null);
		assert.equal(planFirstLine({ plan: 3 }), null);
		assert.equal(planFirstLine({ plan: "  \n " }), null);
		assert.equal(planFirstLine("plan"), null);
	});

	test("a held ask keeps its tool_input up to 64 KiB of JSON (UTF-8 bytes), and is display-only over that", () => {
		assert.equal(KEEP_INPUT_BYTES, 65_536);
		/** An ExitPlanMode input whose JSON is exactly `bytes` long, with a two-byte character in it. */
		const planOf = (bytes: number) => {
			const base = JSON.stringify({ plan: "é" });
			return { plan: `é${"x".repeat(bytes - Buffer.byteLength(base))}` };
		};
		const at = planOf(KEEP_INPUT_BYTES);
		assert.equal(jsonBytes(at), KEEP_INPUT_BYTES);
		assert.equal(heldAsk("ExitPlanMode", at).t, "plan");
		const over = planOf(KEEP_INPUT_BYTES + 1);
		assert.equal(jsonBytes(over), KEEP_INPUT_BYTES + 1);
		assert.deepEqual(heldAsk("ExitPlanMode", over), { t: "inApp", why: "too big" });
		// Counted in UTF-8 bytes, not characters: 32 768 two-byte characters are 64 KiB and more.
		const wide = { plan: "é".repeat(KEEP_INPUT_BYTES / 2) };
		assert.ok(JSON.stringify(wide).length < KEEP_INPUT_BYTES);
		assert.deepEqual(heldAsk("ExitPlanMode", wide), { t: "inApp", why: "too big" });
		// The same for a question: one over the limit isn't read.
		const bigQuestion = { questions: [{ ...COLOR, header: "x".repeat(KEEP_INPUT_BYTES) }] };
		assert.deepEqual(heldAsk("AskUserQuestion", bigQuestion), { t: "inApp", why: "too big" });
	});

	test("a held ask whose tool_input the token scrub changed is display-only, ahead of every other reason", () => {
		for (const [tool, input] of [
			["AskUserQuestion", { questions: [COLOR] }],
			["ExitPlanMode", { plan: "# Plan", planFilePath: "/p.md" }],
			["ExitPlanMode", {}],
			["ExitPlanMode", { plan: "x".repeat(KEEP_INPUT_BYTES) }],
			["AskUserQuestion", { questions: [] }],
		] as const) {
			assert.deepEqual(heldAsk(tool, input, { scrubbed: true }), { t: "inApp", why: "scrubbed" }, JSON.stringify(input).slice(0, 60));
		}
		assert.equal(heldAsk("AskUserQuestion", { questions: [COLOR] }, { scrubbed: false }).t, "question");
		assert.equal(heldAsk("ExitPlanMode", {}, {}).t, "plan");
	});

	test("a held ask: a form it reads, a plan whose input is an object, or display-only; the input is kept as it came", () => {
		const input = { questions: [COLOR], extra: { kept: true } };
		const question = heldAsk("AskUserQuestion", input);
		assert.equal(question.t, "question");
		assert.equal(question.t === "question" && question.input, input, "the same object, not a copy");
		assert.deepEqual(heldAsk("AskUserQuestion", { questions: [] }), { t: "inApp", why: "unreadable" });
		assert.deepEqual(heldAsk("ExitPlanMode", {}), { t: "plan", input: {}, firstLine: null });
		assert.deepEqual(heldAsk("ExitPlanMode", ["plan"]), { t: "inApp", why: "unreadable" });
		assert.deepEqual(heldAsk("ExitPlanMode", null), { t: "inApp", why: "unreadable" });
		// Too deep to write out: display-only, not a throw.
		let deep: unknown = {};
		for (let i = 0; i < 100_000; i++) deep = { d: deep };
		assert.deepEqual(heldAsk("ExitPlanMode", deep), { t: "inApp", why: "too big" });
	});
});

describe("the Answer and the Approve plan (PROTOCOL.md, Permission requests)", () => {
	test("are PROTOCOL.md's bodies, byte for byte, with the input echoed as it came and never changed", () => {
		const input = { questions: [COLOR], z: 1, a: [2] };
		const frozen = JSON.stringify(input);
		assert.equal(
			JSON.stringify(answerDecision(input, { "Red or blue?": "Blue" })),
			'{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"questions":[{"question":"Red or blue?","header":"Color","options":[{"label":"Red","description":"Warm"},{"label":"Blue","description":"Cool"}],"multiSelect":false}],"z":1,"a":[2],"answers":{"Red or blue?":"Blue"}}}}}',
		);
		assert.equal(JSON.stringify(input), frozen, "tool_input isn't changed");
		const plan = { plan: "# Plan\n", planFilePath: "/Users/me/.claude/plans/tidy-otter.md" };
		assert.equal(
			JSON.stringify(approvePlanDecision(plan, "acceptEdits")),
			'{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"plan":"# Plan\\n","planFilePath":"/Users/me/.claude/plans/tidy-otter.md"},"updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}}',
		);
		assert.equal(JSON.stringify(approvePlanDecision({}, "default")), '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{},"updatedPermissions":[{"type":"setMode","mode":"default","destination":"session"}]}}}');
	});

	test("an Answer's answers keep a question named __proto__ as an ordinary key", () => {
		const body = JSON.stringify(answerDecision({ questions: [] }, JSON.parse('{"__proto__":"x"}') as Record<string, string>));
		assert.match(body, /"answers":\{"__proto__":"x"\}/);
	});
});

describe("a Session Slot dial's answers (HeldRequests' answer)", () => {
	const A = "local_a";
	const B = "local_b";
	function hold(held: HeldRequests, host: string, tool: string, input: unknown, fields: Partial<Omit<Held, "id">> = {}) {
		const responder = new FakeResponder();
		const kind = tool === "AskUserQuestion" || tool === "ExitPlanMode" ? "ask" : "tool";
		const h = held.hold({ at: 1000, host, tool, kind, summary: tool, fp: null, ask: kind === "ask" ? heldAsk(tool, input) : null, ...fields }, responder);
		return { h, responder };
	}
	const body = (r: FakeResponder): unknown => JSON.parse(r.sent[0]?.body ?? "null");

	test("acts on its own session's oldest request, of any kind, not the oldest across sessions", () => {
		const held = new HeldRequests();
		const b = hold(held, B, "Bash", { command: "npm test" });
		const a1 = hold(held, A, "Write", { file_path: "/x" });
		const a2 = hold(held, A, "Edit", { file_path: "/y" });
		assert.equal(held.oldestFor(A)?.id, a1.h.id);
		assert.equal(held.oldest?.id, b.h.id);
		const result = held.answer(A, a1.h.id, { t: "allow" });
		assert.equal(result.ok, true);
		assert.deepEqual(body(a1.responder), ALLOW_DECISION);
		assert.deepEqual([b.responder.sent, a2.responder.sent], [[], []]);
		assert.equal(held.oldestFor(A)?.id, a2.h.id);
		held.answer(A, a2.h.id, { t: "deny" });
		assert.deepEqual(body(a2.responder), DENY_DECISION);
	});

	test("only the request the strip showed: another, none, or one that has gone sends nothing", () => {
		const held = new HeldRequests();
		const a1 = hold(held, A, "Write", {});
		const a2 = hold(held, A, "Edit", {});
		assert.equal(held.answer(A, a2.h.id, { t: "allow" }).ok, false, "the strip showed the newer one");
		assert.deepEqual(held.answer(A, null, { t: "allow" }), { ok: false, why: "changed", held: a1.h, detail: `the strip showed no request, but the session's oldest is #${a1.h.id}` });
		assert.equal(held.answer(B, a1.h.id, { t: "allow" }).ok, false, "another session's dial");
		const empty = held.answer(B, null, { t: "allow" });
		assert.equal(!empty.ok && empty.why, "empty");
		a1.responder.open = false;
		const gone = held.answer(A, a1.h.id, { t: "allow" });
		assert.equal(!gone.ok && gone.why, "gone");
		assert.equal(held.oldestFor(A)?.id, a2.h.id, "the closed one is removed");
		assert.deepEqual([a1.responder.sent, a2.responder.sent], [[], []]);
	});

	test("the first answer wins: a key's answer leaves the dial's press with nothing, and the other way round", () => {
		const held = new HeldRequests();
		const a = hold(held, A, "Bash", {});
		assert.equal(held.press(a.h.id, "allow").ok, true);
		const late = held.answer(A, a.h.id, { t: "deny" });
		assert.equal(!late.ok && late.why, "empty");
		const b = hold(held, A, "Bash", {});
		assert.equal(held.answer(A, b.h.id, { t: "deny" }).ok, true);
		const key = held.press(b.h.id, "allow");
		assert.equal(!key.ok && key.why, "empty");
		assert.deepEqual(body(b.responder), DENY_DECISION);
		assert.equal(b.responder.sent.length, 1);
	});

	test("a question takes its answers, checked, as an Answer; a plan takes a mode or Deny; a tool takes Allow or Deny", () => {
		const held = new HeldRequests({ log: new RecordingLog() });
		const input = { questions: [FRUIT, SIZE] };
		const q = hold(held, A, "AskUserQuestion", input);
		for (const wrong of [{ t: "allow" }, { t: "deny" }, { t: "plan", mode: "auto" }, { t: "answers", picks: { "Which fruits?": ["Apple"] } }] as DialAnswer[]) {
			const result = held.answer(A, q.h.id, wrong);
			assert.equal(!result.ok && result.why, "invalid", JSON.stringify(wrong));
		}
		assert.deepEqual(q.responder.sent, [], "nothing sent for an answer that doesn't fit");
		assert.equal(held.answer(A, q.h.id, { t: "answers", picks: { "Which fruits?": ["Plum", "Pear, ripe"], "Which size?": ["Small"] } }).ok, true);
		assert.deepEqual(body(q.responder), JSON.parse(JSON.stringify(answerDecision(input, { "Which fruits?": '"Pear, ripe", Plum', "Which size?": "Small" }))));

		const planInput = { plan: "# Plan", planFilePath: "/p.md" };
		const p = hold(held, A, "ExitPlanMode", planInput);
		for (const wrong of [{ t: "allow" }, { t: "answers", picks: {} }] as DialAnswer[]) assert.equal(held.answer(A, p.h.id, wrong).ok, false, JSON.stringify(wrong));
		assert.equal(held.answer(A, p.h.id, { t: "plan", mode: "auto" }).ok, true);
		assert.deepEqual(body(p.responder), JSON.parse(JSON.stringify(approvePlanDecision(planInput, "auto"))));
		const r = hold(held, A, "ExitPlanMode", {});
		assert.equal(held.answer(A, r.h.id, { t: "deny" }).ok, true);
		assert.deepEqual(body(r.responder), DENY_DECISION);

		const t = hold(held, A, "Bash", {});
		for (const wrong of [{ t: "plan", mode: "auto" }, { t: "answers", picks: {} }] as DialAnswer[]) assert.equal(held.answer(A, t.h.id, wrong).ok, false, JSON.stringify(wrong));
		assert.deepEqual(t.responder.sent, []);
	});

	test("a display-only ask takes nothing from a dial; the keys still jump for it", () => {
		const held = new HeldRequests();
		const big = hold(held, A, "ExitPlanMode", { plan: "x".repeat(KEEP_INPUT_BYTES) });
		assert.deepEqual(big.h.ask, { t: "inApp", why: "too big" });
		for (const answer of [{ t: "plan", mode: "auto" }, { t: "deny" }] as DialAnswer[]) {
			const result = held.answer(A, big.h.id, answer);
			assert.equal(!result.ok && result.why, "invalid");
		}
		assert.deepEqual(big.responder.sent, []);
		const key = held.press(big.h.id, "allow");
		assert.equal(key.ok && key.did, "jump");
		const unreadable = new HeldRequests();
		const q = hold(unreadable, A, "AskUserQuestion", { questions: "?" });
		assert.equal(unreadable.answer(A, q.h.id, { t: "answers", picks: {} }).ok, false);
	});

	test("an answer that sends is logged with what it sent; a refused one changes nothing", () => {
		const log = new RecordingLog();
		const held = new HeldRequests({ log });
		const a = hold(held, A, "ExitPlanMode", {});
		let changes = 0;
		held.onChange(() => changes++);
		held.answer(A, a.h.id, { t: "allow" });
		assert.equal(changes, 0);
		held.answer(A, a.h.id, { t: "plan", mode: "acceptEdits" });
		assert.equal(changes, 1);
		assert.ok(log.at("info").some((l) => /ANSWER #1 "ExitPlanMode": plan approved into acceptEdits, from its session's dial; 0 held/.test(l)), log.at("info").join("\n"));
	});
});
