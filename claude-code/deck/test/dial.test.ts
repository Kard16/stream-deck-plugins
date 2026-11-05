import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import type { PollReply } from "../src/bridge/commands.js";
import { modelName } from "../src/model/format.js";
import { SessionModel } from "../src/model/sessions.js";
import { CHOICE_MS, ModeDials } from "../src/mode/dials.js";
import { modeStrip } from "../src/mode/strip.js";
import type { RegistrySession } from "../src/registry/registry.js";
import { COALESCE_MS, SessionsDials } from "../src/sessions/dials.js";
import { sessionsStrip, STRIP_COLORS } from "../src/sessions/strip.js";
import type { Feedback } from "../src/util/painter.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { deckRoot } from "./helpers/paths.js";
import { RecordingLog } from "./helpers/recording-log.js";

class FakeReply implements PollReply {
	open = true;
	sent: string[] = [];
	send(_status: number, body: string): void {
		this.open = false;
		this.sent.push(body);
	}
	onClose(): void {}
}

function session(key: string, fields: Partial<RegistrySession> = {}): RegistrySession {
	return { key, name: `Session ${key}`, status: "idle", cwd: `/Users/me/p${key}`, hostSessionId: `local_${key}`, sessionId: `uuid-${key}`, statusUpdatedAt: 1, startedAt: Number(key), ...fields };
}

const list = (...keys: string[]): RegistrySession[] => keys.map((k) => session(k));

function setup(sessions: RegistrySession[] = list("1", "2", "3", "4")) {
	const clock = new FakeClock();
	const log = new RecordingLog();
	const model = new SessionModel({ clock, log, wallNow: () => 5000 });
	model.setRegistry(sessions);
	model.setBridgeState("listening");
	const jumps: string[] = [];
	const dials = new SessionsDials(model, { clock, log, open: (h) => jumps.push(h) });
	const sent: Feedback[] = [];
	let alerts = 0;
	dials.add("d1", { setFeedback: (p) => sent.push(p), showAlert: () => alerts++ });
	return { clock, log, model, dials, sent, jumps, alerts: () => alerts };
}

const shown = (dials: SessionsDials): unknown => {
	const p = dials.painted("d1") as Record<string, { value: unknown }> | null;
	return p && { name: p.name?.value, status: p.status?.value, pos: p.pos?.value };
};

describe("Sessions dial", () => {
	test("shows one session in the layout's own keys: title, status, context, model and effort, position", () => {
		const { clock, model, dials, sent } = setup([session("1", { name: "Fix the build", status: "busy" }), session("2")]);
		model.hello({ v: 1, sid: "uuid-1", host: "local_1", inst: "i", model: "claude-haiku-5-5", effort: "low" });
		model.events({ host: "local_1", inst: "i", seq: 1, events: [{ t: "tool.start", tool: "Read", use: "u", summary: "notes.md", fp: "1" }, { t: "measure", context: { percent: 12 } }] });
		clock.advance(200);
		const p = dials.painted("d1") as Record<string, { value: unknown }>;
		assert.deepEqual(
			Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.value])),
			{ name: "Fix the build", mark: "", status: "working: notes.md", ctx: "12%", meta: "Haiku 5.5 · low", pos: "1/2", bar: 12 },
		);
		assert.deepEqual(Object.keys(sent[0] ?? {}).sort(), ["bar", "ctx", "mark", "meta", "name", "pos", "status"], "never title or icon");
	});

	test("ticks within 40 ms are coalesced into one move, one session per tick, and only changed keys are sent", () => {
		const { clock, dials, sent } = setup();
		clock.advance(500); // well after the first paint, so the rate limit doesn't delay this one
		const before = sent.length;
		dials.rotate("d1", 1, false);
		clock.advance(10);
		dials.rotate("d1", 1, false);
		clock.advance(10);
		assert.equal(sent.length, before, "nothing moves inside the window");
		clock.advance(COALESCE_MS);
		assert.deepEqual(shown(dials), { name: "Session 3", status: "idle", pos: "3/4" });
		assert.equal(sent.length, before + 1, "one strip update for the whole burst");
		assert.deepEqual(Object.keys(sent.at(-1) ?? {}).sort(), ["name", "pos"]);
	});

	test("stops at either end, and repaints at most 10 times a second", () => {
		const { clock, dials, sent } = setup(list("1", "2", "3", "4", "5", "6", "7", "8", "9"));
		dials.rotate("d1", -3, false);
		clock.advance(100);
		assert.equal(dials.selected("d1")?.key, "local_1");
		const before = sent.length;
		for (let i = 0; i < 10; i++) {
			dials.rotate("d1", 1, false);
			clock.advance(COALESCE_MS + 1);
		}
		clock.advance(1000);
		const paints = sent.length - before;
		assert.ok(paints >= 4 && paints <= 6, `${paints} paints for 10 moves over about 0.4 s`);
		dials.rotate("d1", 10, false);
		clock.advance(100);
		assert.deepEqual(shown(dials), { name: "Session 9", status: "idle", pos: "9/9" });
	});

	test("stays on its session when the list changes, or on the same place when that session ends", () => {
		const { clock, model, dials } = setup();
		dials.rotate("d1", 2, false);
		clock.advance(100);
		assert.equal(dials.selected("d1")?.key, "local_3");
		model.setRegistry(list("0", "1", "2", "3", "4"));
		clock.advance(200);
		assert.equal(dials.selected("d1")?.key, "local_3");
		assert.deepEqual(shown(dials), { name: "Session 3", status: "idle", pos: "4/5" });
		model.setRegistry(list("0", "1", "2", "4"));
		clock.advance(200);
		assert.equal(dials.selected("d1")?.key, "local_4");
		model.setRegistry([]);
		clock.advance(200);
		assert.deepEqual(shown(dials), { name: "No sessions", status: "", pos: "0/0" });
	});

	test("press and tap jump and make the session the target, marked on the strip; long-touch only logs", () => {
		const { clock, model, dials, log, jumps } = setup();
		dials.rotate("d1", 1, false);
		clock.advance(100);
		dials.down("d1");
		dials.up("d1");
		assert.deepEqual(jumps, ["local_2"]);
		assert.equal(model.target()?.key, "local_2");
		clock.advance(200);
		assert.equal((dials.painted("d1") as Record<string, { value: unknown }>).mark?.value, "●");
		dials.tap("d1", false);
		dials.tap("d1", true);
		assert.deepEqual(jumps, ["local_2", "local_2"]);
		const info = log.at("info");
		assert.equal(info.filter((l) => l.startsWith("info jump local_2 via press")).length, 1, info.join("\n"));
		assert.ok(info.some((l) => l.startsWith("info long-touch local_2")));
	});

	test("a press that turned the dial, or that started before the plugin saw it, doesn't jump", () => {
		const { dials, jumps } = setup();
		dials.up("d1"); // no down seen
		dials.down("d1");
		dials.rotate("d1", 1, true);
		dials.up("d1");
		assert.deepEqual(jumps, []);
	});

	test("jump with no sessions, or no app id, alerts", () => {
		const { model, dials, alerts, jumps } = setup([session("1", { hostSessionId: null })]);
		dials.tap("d1", false);
		assert.equal(alerts(), 1);
		model.setRegistry([]);
		dials.tap("d1", false);
		assert.equal(alerts(), 2);
		assert.deepEqual(jumps, []);
	});

	test("strip details: no context hides the bar; a full context turns it orange; names and models", () => {
		const view = { key: "local_1", host: "local_1", pid: "1", title: "T", status: "idle" as const, doing: null, context: null, model: null, effort: null, mode: null, plugin: false, listed: true, running: true, need: null, since: null, seen: null, tokens: null, window: null, cost: null, summary: null, needs: null, project: null, startedAt: null, archived: false };
		assert.deepEqual(sessionsStrip(view, 0, 1, false).bar, { value: 0, opacity: 0, bar_fill_c: STRIP_COLORS.fill });
		assert.equal(sessionsStrip({ ...view, context: 91.6 }, 0, 1, true).bar.bar_fill_c, STRIP_COLORS.full);
		assert.equal(sessionsStrip({ ...view, context: 91.6 }, 0, 1, true).ctx.value, "92%");
		assert.equal(sessionsStrip(view, 0, 1, false).meta.value, "— · —");
		assert.equal(modelName("claude-opus-4-7[1m]"), "Opus 4.7 1M");
		assert.equal(modelName("claude-sonnet-4-20250514"), "Sonnet 4");
		assert.equal(modelName("sonnet"), "Sonnet");
		assert.equal(modelName("gpt-x"), "gpt-x");
	});
});

describe("Mode dial", () => {
	function modeSetup() {
		const clock = new FakeClock();
		const log = new RecordingLog();
		const model = new SessionModel({ clock, log, wallNow: () => 5000 });
		model.setRegistry([session("1"), session("2")]);
		model.setBridgeState("listening");
		model.hello({ v: 1, sid: "uuid-1", host: "local_1", inst: "i", model: "claude-haiku-5-5", mode: "default", effort: "low" });
		const poll = new FakeReply();
		model.next(new URLSearchParams({ host: "local_1", inst: "i" }), poll);
		model.pick("local_1");
		const dials = new ModeDials(model, { clock, log });
		let alerts = 0;
		const sent: Feedback[] = [];
		dials.add("m", { setFeedback: (p) => sent.push(p), showAlert: () => alerts++ });
		const strip = (): Record<string, unknown> => Object.fromEntries(Object.entries(dials.painted("m") ?? {}).map(([k, v]) => [k, (v as { value: unknown }).value]));
		return { clock, model, dials, poll, sent, strip, alerts: () => alerts };
	}

	test("shows the target's title, mode, model and effort, in the layout's own keys", () => {
		const { clock, sent, strip } = modeSetup();
		clock.advance(200);
		assert.deepEqual(strip(), { target: "Session 1", mode: "Manual", meta: "Haiku 5.5 · low" });
		assert.deepEqual(Object.keys(sent[0] ?? {}).sort(), ["meta", "mode", "target"], "never title or icon");
	});

	test("turning chooses a mode, one per tick, stopping at the ends; a press applies it to the target", () => {
		const { clock, model, dials, poll, strip } = modeSetup();
		dials.rotate("m", 1, false);
		clock.advance(COALESCE_MS + 100);
		assert.equal(strip().mode, "→ Accept edits");
		dials.rotate("m", 5, false);
		clock.advance(COALESCE_MS + 100);
		assert.equal(dials.shown("m"), "auto");
		dials.rotate("m", -1, false);
		clock.advance(COALESCE_MS + 100);
		dials.down("m");
		dials.up("m");
		assert.deepEqual(JSON.parse(poll.sent[0] ?? "null"), { cmds: [{ id: "c1", t: "mode", mode: "plan" }] });
		clock.advance(200);
		assert.equal(strip().mode, "Plan…");
		model.result({ host: "local_1", inst: "i", id: "c1", state: "done" });
		model.events({ host: "local_1", inst: "i", seq: 1, events: [{ t: "settings", mode: "plan" }] });
		clock.advance(200);
		assert.equal(strip().mode, "Plan");
	});

	test("an unapplied choice goes back to the target's mode after a while, or on long-touch", () => {
		const { clock, dials, strip } = modeSetup();
		dials.rotate("m", 2, false);
		clock.advance(COALESCE_MS + 100);
		assert.equal(strip().mode, "→ Plan");
		clock.advance(CHOICE_MS);
		assert.equal(strip().mode, "Manual");
		dials.rotate("m", 1, false);
		clock.advance(COALESCE_MS + 100);
		dials.tap("m", true);
		clock.advance(200);
		assert.equal(strip().mode, "Manual");
	});

	test("a refused change alerts; a choice doesn't carry over to another target", () => {
		const { clock, model, dials, strip, alerts } = modeSetup();
		dials.rotate("m", 3, false);
		clock.advance(COALESCE_MS + 100);
		dials.tap("m", false);
		model.result({ host: "local_1", inst: "i", id: "c1", state: "refused", error: "no" });
		assert.equal(alerts(), 1);
		dials.rotate("m", 1, false);
		clock.advance(COALESCE_MS + 100);
		model.pick("local_2");
		clock.advance(200);
		assert.deepEqual(strip(), { target: "Session 2", mode: "—", meta: "— · —" });
		dials.tap("m", false);
		assert.equal(alerts(), 1, "no choice for this target, so the tap applies nothing");
		assert.equal(model.commands.get("c2"), null);
	});

	test("a press or tap without a turn does nothing, though the strip shows the target's mode: no command, no alert", () => {
		const { clock, model, dials, poll, strip, alerts } = modeSetup();
		clock.advance(200);
		assert.equal(strip().mode, "Manual");
		const pressAndTap = (): void => {
			dials.down("m");
			dials.up("m");
			dials.tap("m", false);
		};
		pressAndTap();
		assert.deepEqual([poll.sent, alerts(), model.commands.get("c1")], [[], 0, null], "before any turn");
		// After a choice goes back, on its own or on long-touch.
		dials.rotate("m", 2, false);
		clock.advance(COALESCE_MS + 100);
		clock.advance(CHOICE_MS);
		pressAndTap();
		dials.rotate("m", 1, false);
		clock.advance(COALESCE_MS + 100);
		dials.tap("m", true);
		pressAndTap();
		assert.deepEqual([poll.sent, alerts(), model.commands.get("c1")], [[], 0, null], "after the choice went back");
		// After a change is applied: its press sends one command, and the presses after it none.
		dials.rotate("m", 1, false);
		clock.advance(COALESCE_MS + 100);
		dials.tap("m", false);
		assert.deepEqual(JSON.parse(poll.sent[0] ?? "null"), { cmds: [{ id: "c1", t: "mode", mode: "acceptEdits" }] });
		model.result({ host: "local_1", inst: "i", id: "c1", state: "done" });
		model.events({ host: "local_1", inst: "i", seq: 1, events: [{ t: "settings", mode: "acceptEdits" }] });
		clock.advance(200);
		assert.equal(strip().mode, "Accept edits");
		pressAndTap();
		assert.deepEqual([alerts(), model.commands.get("c2")], [0, null], "after the change was applied");
	});
});

describe("strip layouts (com.karimdhanji.claude.sdPlugin/layouts)", () => {
	const layoutKeys = (file: string): string[] => {
		const layout = JSON.parse(readFileSync(path.join(deckRoot(), "com.karimdhanji.claude.sdPlugin", "layouts", file), "utf8")) as { items: { key: string }[] };
		return layout.items.map((item) => item.key).sort();
	};

	// streamdeck validate doesn't catch a strip key missing from its layout, or live data in the app's own keys.
	test("each strip fills exactly its layout's keys, none of them the app's own title or icon", () => {
		const view = { key: "local_1", host: "local_1", pid: "1", title: "T", status: "idle" as const, doing: null, context: 50, model: null, effort: null, mode: "plan", plugin: true, listed: true, running: true, need: null, since: null, seen: null, tokens: null, window: null, cost: null, summary: null, needs: null, project: null, startedAt: null, archived: false };
		const cases: [string, string[]][] = [
			["sessions.json", Object.keys(sessionsStrip(view, 0, 1, true))],
			["sessions.json", Object.keys(sessionsStrip(null, 0, 0, false))],
			["mode.json", Object.keys(modeStrip({ target: view, choice: "auto", applying: false, online: true }))],
			["mode.json", Object.keys(modeStrip({ target: null, choice: null, applying: false, online: false }))],
		];
		for (const [file, keys] of cases) {
			assert.deepEqual([...keys].sort(), layoutKeys(file), file);
			assert.ok(!keys.includes("title") && !keys.includes("icon"), `${file}: never title or icon`);
		}
	});
});
