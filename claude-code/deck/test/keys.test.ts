import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { IN_FLIGHT_MS, type PollReply } from "../src/bridge/commands.js";
import { decisionKeySvg, modeKeySvg, promptKeySvg, sessionKeySvg, svgDataUrl, wrap } from "../src/keys/art.js";
import { ModeKeys, PromptKeys, REFUSED_SHOW_MS, SENT_SHOW_MS } from "../src/keys/commands.js";
import { DecisionKeys, SETTLE_MS } from "../src/keys/decision.js";
import { SessionKeys, sessionKeyLook } from "../src/keys/session.js";
import { SessionModel } from "../src/model/sessions.js";
import type { RegistrySession } from "../src/registry/registry.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { RecordingLog } from "./helpers/recording-log.js";

class FakeReply implements PollReply {
	open = true;
	sent: string[] = [];
	#onClose: (() => void)[] = [];
	send(_status: number, body: string): void {
		this.open = false;
		this.sent.push(body);
	}
	onClose(fn: () => void): void {
		this.#onClose.push(fn);
	}
	close(): void {
		this.open = false;
		for (const fn of this.#onClose) fn();
	}
}

const A = "local_a";
const B = "local_b";

function reg(pid: number, host: string, fields: Partial<RegistrySession> = {}): RegistrySession {
	return { key: String(pid), name: `Session ${pid}`, status: "busy", cwd: `/p/${pid}`, hostSessionId: host, sessionId: `sid-${pid}`, statusUpdatedAt: 1000, startedAt: pid, ...fields };
}

function setup() {
	const clock = new FakeClock();
	const log = new RecordingLog();
	const model = new SessionModel({ clock, log, wallNow: () => 5000 });
	model.setRegistry([reg(1, A), reg(2, B)]);
	model.setBridgeState("listening");
	const feedback: string[] = [];
	const images = new Map<string, string[]>();
	const surface = (id: string) => ({
		setImage: (svg: string) => images.set(id, [...(images.get(id) ?? []), svg]),
		showOk: () => feedback.push(`${id}:ok`),
		showAlert: () => feedback.push(`${id}:alert`),
	});
	const jumps: string[] = [];
	const permission = (host: string, tool: string, input: unknown): FakeReply => {
		const reply = new FakeReply();
		model.permission({ session_id: "x", tool_name: tool, tool_input: input }, host, reply);
		return reply;
	};
	/** The mod of a session says hello and opens its long poll. */
	const mod = (host: string): FakeReply => {
		model.hello({ v: 1, host, inst: `i-${host}`, model: "claude-haiku-5-5" });
		const poll = new FakeReply();
		model.next(new URLSearchParams({ host, inst: `i-${host}`, wait: "20" }), poll);
		return poll;
	};
	return { clock, log, model, feedback, images, surface, jumps, open: (h: string) => jumps.push(h), permission, mod };
}

describe("Approve and Deny keys", () => {
	test("show the oldest request across sessions: its session, what it's for, and the count", () => {
		const { clock, model, surface, permission, open } = setup();
		const approve = new DecisionKeys(model, "allow", { clock, open });
		approve.add("k", surface("k"));
		assert.match(approve.painted("k")?.svg ?? "", />Approve</);
		permission(B, "Bash", { command: "npm test" });
		clock.advance(200);
		permission(A, "Write", { file_path: "/x/s4.txt" });
		clock.advance(200);
		const svg = approve.painted("k")?.svg ?? "";
		assert.match(svg, />2</);
		assert.match(svg, />Session 2</);
		assert.match(svg, />npm test</);
		assert.equal(approve.painted("k")?.shown, 1);
	});

	test("a press answers only the request the key showed, then the next shows", () => {
		const { clock, model, surface, feedback, permission } = setup();
		const approve = new DecisionKeys(model, "allow", { clock });
		const deny = new DecisionKeys(model, "deny", { clock });
		approve.add("a", surface("a"));
		deny.add("d", surface("d"));
		const first = permission(A, "Bash", { command: "ls" });
		const second = permission(B, "Edit", { file_path: "/x/y.ts" });
		clock.advance(200 + SETTLE_MS);
		approve.press("a");
		assert.deepEqual(JSON.parse(first.sent[0] ?? "null"), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
		assert.match(deny.painted("d")?.svg ?? "", />y\.ts</);
		// Deny now shows the next request, but it got there just now: a press straight away answers nothing.
		deny.press("d");
		assert.deepEqual(second.sent, []);
		clock.advance(SETTLE_MS);
		deny.press("d");
		assert.equal(JSON.parse(second.sent[0] ?? "null").hookSpecificOutput.decision.behavior, "deny");
		assert.deepEqual(feedback, ["a:ok", "d:alert", "d:ok"]);
	});

	for (const decision of ["allow", "deny"] as const) {
		const name = decision === "allow" ? "Approve" : "Deny";
		test(`${name}: an immediate second press answers nothing, though the next request is painted under the first press's OK`, () => {
			const { clock, model, surface, feedback, permission, log } = setup();
			const keys = new DecisionKeys(model, decision, { clock, log });
			keys.add("k", surface("k"));
			const write = permission(A, "Write", { file_path: "/p/1/notes.md" });
			const rm = permission(B, "Bash", { command: "rm -rf ~/Projects/p2" });
			clock.advance(200 + SETTLE_MS);
			keys.press("k");
			assert.equal(JSON.parse(write.sent[0] ?? "null").hookSpecificOutput.decision.behavior, decision);
			assert.equal(keys.painted("k")?.shown, 2, "the next request is on the key at once");
			clock.advance(80);
			keys.press("k");
			assert.deepEqual(rm.sent, [], "never seen, so never answered");
			assert.equal(model.held.size, 1);
			assert.ok(log.at("info").some((l) => l.includes(`${name} press: nothing answered: #2 had been in sight on the key for 80 ms`)));
			// That press's alert covered the key again, so a press soon after it is still too soon, though the
			// request was painted more than SETTLE_MS ago.
			clock.advance(SETTLE_MS - 40);
			keys.press("k");
			assert.deepEqual(rm.sent, []);
			// Left alone that long, it has been seen: now a press answers it.
			clock.advance(SETTLE_MS);
			keys.press("k");
			assert.equal(JSON.parse(rm.sent[0] ?? "null").hookSpecificOutput.decision.behavior, decision);
			assert.deepEqual(feedback, ["k:ok", "k:alert", "k:alert", "k:ok"]);
		});
	}

	test("a request is answered only once it has been on the key for SETTLE_MS; a recount doesn't restart that", () => {
		const { clock, model, surface, feedback, permission } = setup();
		const approve = new DecisionKeys(model, "allow", { clock });
		approve.add("k", surface("k"));
		const ls = permission(A, "Bash", { command: "ls" });
		clock.advance(200);
		approve.press("k");
		assert.deepEqual(ls.sent, []);
		clock.advance(SETTLE_MS - 300);
		// A second request repaints the key with a new count, but it still shows the first.
		permission(B, "Bash", { command: "make" });
		clock.advance(300);
		assert.match(approve.painted("k")?.svg ?? "", />2</);
		approve.press("k");
		assert.equal(JSON.parse(ls.sent[0] ?? "null").hookSpecificOutput.decision.behavior, "allow");
		assert.deepEqual(feedback, ["k:alert", "k:ok"]);
	});

	test("a press after the shown request ended does nothing but alert", () => {
		const { clock, model, surface, feedback, permission, log } = setup();
		const approve = new DecisionKeys(model, "allow", { clock, log });
		approve.add("k", surface("k"));
		const first = permission(A, "Bash", { command: "ls" });
		clock.advance(200 + SETTLE_MS);
		// A second request arrives: the key repaints at once with the count, still showing the first.
		const second = permission(B, "Bash", { command: "rm -rf build" });
		assert.equal(approve.painted("k")?.shown, 1);
		assert.match(approve.painted("k")?.svg ?? "", />2</);
		// The first ends (its client goes) within the painter's 100 ms of that repaint, so the key still shows it
		// when pressed, though the oldest is now the second.
		first.close();
		assert.equal(model.held.oldest?.id, 2);
		assert.equal(approve.painted("k")?.shown, 1);
		approve.press("k");
		assert.deepEqual(second.sent, []);
		assert.deepEqual(feedback, ["k:alert"]);
		assert.ok(log.at("info").some((l) => l.includes("Approve press: nothing answered: the key showed #1, but the oldest is now #2")));
		// The key then shows the second, and once it has been in sight for SETTLE_MS, a press answers it.
		clock.advance(100);
		assert.equal(approve.painted("k")?.shown, 2);
		clock.advance(SETTLE_MS);
		approve.press("k");
		assert.equal(JSON.parse(second.sent[0] ?? "null").hookSpecificOutput.decision.behavior, "allow");
	});

	test("a question or a plan shows 'needs you'; a press jumps to its session and answers nothing", () => {
		const { clock, model, surface, feedback, permission, jumps, open } = setup();
		const deny = new DecisionKeys(model, "deny", { clock, open });
		deny.add("k", surface("k"));
		const ask = permission(B, "AskUserQuestion", { questions: [{ question: "Red or blue?" }] });
		clock.advance(200 + SETTLE_MS);
		assert.match(deny.painted("k")?.svg ?? "", />needs you</);
		deny.press("k");
		assert.deepEqual(jumps, [B]);
		assert.deepEqual(ask.sent, []);
		assert.deepEqual(feedback, []);
		assert.equal(model.held.size, 1);
	});

	test("offline while the bridge isn't listening; nothing held alerts", () => {
		const { clock, model, surface, feedback } = setup();
		const approve = new DecisionKeys(model, "allow", { clock });
		approve.add("k", surface("k"));
		approve.press("k");
		assert.deepEqual(feedback, ["k:alert"]);
		model.setBridgeState("retrying");
		clock.advance(200);
		assert.match(approve.painted("k")?.svg ?? "", /Offline/);
	});

	test("images change only when the look does, at most 10 a second", () => {
		const { clock, model, surface, images, permission } = setup();
		const approve = new DecisionKeys(model, "allow", { clock });
		approve.add("k", surface("k"));
		const before = images.get("k")?.length ?? 0;
		for (let i = 0; i < 20; i++) permission(A, "Bash", { command: `echo ${i}` });
		clock.advance(50);
		assert.ok((images.get("k")?.length ?? 0) - before <= 1);
		clock.advance(1000);
		assert.ok((images.get("k")?.length ?? 0) - before <= 2);
		assert.match(images.get("k")?.at(-1) ?? "", />20</);
	});
});

describe("Saved Prompt keys", () => {
	test("a press queues the text for the target; the key shows waiting, then sent for a few seconds", () => {
		const { clock, model, surface, mod } = setup();
		const poll = mod(A);
		model.pick(A);
		const keys = new PromptKeys(model, { clock });
		keys.add("k", surface("k"), { text: "  Run the tests and report.\n", label: "Tests" });
		assert.deepEqual(keys.look("k"), { label: "Tests", target: "Session 1", state: "idle", online: true });
		keys.press("k");
		assert.deepEqual(JSON.parse(poll.sent[0] ?? "null"), { cmds: [{ id: "c1", t: "prompt", text: "Run the tests and report." }] });
		assert.equal(keys.look("k")?.state, "waiting");
		model.result({ host: A, inst: `i-${A}`, id: "c1", state: "waiting" });
		assert.equal(keys.look("k")?.state, "waiting");
		// The session's turn runs past the 60 s a command gets without a result, while the mod keeps a poll open,
		// polling again each time one answers: the prompt still waits.
		for (let ms = 0; ms <= IN_FLIGHT_MS; ms += 20_000) {
			model.next(new URLSearchParams({ host: A, inst: `i-${A}`, wait: "20" }), new FakeReply());
			clock.advance(20_000);
		}
		assert.equal(keys.look("k")?.state, "waiting");
		model.result({ host: A, inst: `i-${A}`, id: "c1", state: "done" });
		assert.equal(keys.look("k")?.state, "sent");
		clock.advance(SENT_SHOW_MS + 1);
		assert.equal(keys.look("k")?.state, "idle");
	});

	test("refused or failed shows refused, longer", () => {
		const { clock, model, surface, mod, log } = setup();
		mod(A);
		model.pick(A);
		const keys = new PromptKeys(model, { clock, log });
		keys.add("k", surface("k"), { text: "Carry on." });
		keys.press("k");
		model.result({ host: A, inst: `i-${A}`, id: "c1", state: "refused", error: "dropped: the session was stopped" });
		assert.equal(keys.look("k")?.state, "refused");
		clock.advance(SENT_SHOW_MS + 1);
		assert.equal(keys.look("k")?.state, "refused");
		clock.advance(REFUSED_SHOW_MS);
		assert.equal(keys.look("k")?.state, "idle");
		assert.ok(log.at("info").some((l) => l.includes('c1: refused: "dropped: the session was stopped"')));
	});

	test("while the key's last prompt is queued, delivered or waiting, a press alerts and sends nothing: a double press sends once", () => {
		const { clock, model, surface, feedback, log } = setup();
		model.hello({ v: 1, host: A, inst: `i-${A}`, model: "claude-haiku-5-5" });
		model.pick(A);
		const keys = new PromptKeys(model, { clock, log });
		keys.add("k", surface("k"), { text: "Carry on." });
		keys.press("k");
		keys.press("k");
		assert.deepEqual(
			model.commands.list().map((c) => [c.id, c.state]),
			[["c1", "queued"]],
		);
		assert.deepEqual(feedback, ["k:alert"]);
		assert.ok(log.at("info").some((l) => l.includes("Saved Prompt: nothing sent: c1 is still queued")));
		model.next(new URLSearchParams({ host: A, inst: `i-${A}`, wait: "20" }), new FakeReply());
		keys.press("k");
		model.result({ host: A, inst: `i-${A}`, id: "c1", state: "waiting" });
		keys.press("k");
		assert.deepEqual(feedback, ["k:alert", "k:alert", "k:alert"], "delivered, then waiting");
		assert.equal(model.commands.list().length, 1);
		// Once it's final, a press sends again, while the key still shows the last outcome.
		model.result({ host: A, inst: `i-${A}`, id: "c1", state: "done" });
		assert.equal(keys.look("k")?.state, "sent");
		keys.press("k");
		assert.deepEqual(
			model.commands.list().map((c) => [c.id, c.state]),
			[
				["c1", "done"],
				["c2", "queued"],
			],
		);
		assert.equal(feedback.length, 3);
	});

	test("no text, no target, an ended target, or a session without the plugin: the press alerts and nothing is queued", () => {
		const { clock, model, surface, feedback, mod } = setup();
		const keys = new PromptKeys(model, { clock });
		keys.add("k", surface("k"), {});
		keys.press("k");
		keys.press("k", { text: "hi" });
		model.pick(B);
		keys.press("k");
		mod(A);
		model.pick(A);
		model.setRegistry([reg(2, B)]);
		keys.press("k");
		assert.deepEqual(feedback, ["k:alert", "k:alert", "k:alert", "k:alert"]);
		assert.equal(model.commands.list().length, 0);
		assert.equal(keys.look("k")?.target, "Session 1 (ended)");
	});
});

describe("Mode keys", () => {
	test("show the mode, blue while it's the target's; a press changes the target's mode, and ok when done", () => {
		const { clock, model, surface, feedback, mod } = setup();
		const poll = mod(A);
		model.pick(A);
		const keys = new ModeKeys(model, { clock });
		keys.add("plan", surface("plan"), { mode: "plan" });
		keys.add("manual", surface("manual"), { mode: "default" });
		model.events({ host: A, inst: `i-${A}`, seq: 1, events: [{ t: "settings", mode: "default" }] });
		assert.deepEqual(keys.look("manual"), { mode: "Manual", active: true, pending: false, target: "Session 1", online: true });
		assert.equal(keys.look("plan")?.active, false);
		keys.press("plan");
		assert.deepEqual(JSON.parse(poll.sent[0] ?? "null"), { cmds: [{ id: "c1", t: "mode", mode: "plan" }] });
		assert.equal(keys.look("plan")?.pending, true);
		model.result({ host: A, inst: `i-${A}`, id: "c1", state: "done" });
		model.events({ host: A, inst: `i-${A}`, seq: 2, events: [{ t: "settings", mode: "plan" }] });
		assert.deepEqual([keys.look("plan")?.active, keys.look("plan")?.pending], [true, false]);
		assert.deepEqual(feedback, ["plan:ok"]);
	});

	test("a refused change alerts; a key without a mode alerts", () => {
		const { clock, model, surface, feedback, mod } = setup();
		mod(A);
		model.pick(A);
		const keys = new ModeKeys(model, { clock });
		keys.add("k", surface("k"), {});
		keys.press("k");
		keys.press("k", { mode: "bypassPermissions" });
		keys.press("k", { mode: "auto" });
		model.result({ host: A, inst: `i-${A}`, id: "c1", state: "refused", error: "the app refused" });
		assert.deepEqual(feedback, ["k:alert", "k:alert", "k:alert"]);
	});
});

describe("Session key", () => {
	test("shows the target's title and status; a press jumps to it", () => {
		const { clock, model, surface, feedback, jumps, open } = setup();
		const keys = new SessionKeys(model, { clock, open });
		keys.add("k", surface("k"));
		keys.press("k");
		assert.deepEqual(feedback, ["k:alert"], "no target yet");
		model.pick(B);
		clock.advance(200);
		assert.match(keys.painted("k") ?? "", />Session 2</);
		assert.match(keys.painted("k") ?? "", />working</);
		keys.press("k");
		assert.deepEqual(jumps, [B]);
		model.setRegistry([reg(1, A)]);
		keys.press("k");
		assert.deepEqual(feedback, ["k:alert", "k:alert"], "an ended target alerts");
		assert.deepEqual(sessionKeyLook(model.target()), { title: "Session 2", status: "ended", statusColor: "#6A707A" });
	});
});

describe("key art", () => {
	test("text is escaped, cut and wrapped", () => {
		assert.match(decisionKeySvg({ decision: "allow", online: true, count: 150, oldest: { title: "<b>&", summary: "x", ask: false } }), />99\+</);
		assert.match(decisionKeySvg({ decision: "allow", online: true, count: 1, oldest: { title: "<b>&", summary: "x", ask: false } }), /&lt;b&gt;&amp;/);
		assert.match(decisionKeySvg({ decision: "deny", online: false, count: 0, oldest: null }), /Offline/);
		assert.match(promptKeySvg({ label: null, target: null, state: "idle", online: true }), /Set text/);
		assert.match(modeKeySvg({ mode: "Accept edits", active: true, pending: true, target: "S", online: true }), /Setting…/);
		assert.match(sessionKeySvg({ title: "A very long session title that needs wrapping", status: "done", statusColor: "#fff" }), /…/);
		assert.deepEqual(wrap("Run the tests and report.", 11, 3), ["Run the", "tests and", "report."]);
		assert.deepEqual(wrap("one two three four five six seven", 9, 2), ["one two", "three fo…"]);
		assert.deepEqual(wrap("supercalifragilistic", 11, 2), ["supercalif…"]);
		assert.match(svgDataUrl("<svg/>"), /^data:image\/svg\+xml;base64,/);
	});
});
