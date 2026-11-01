import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RegistrySession } from "../src/registry/registry.js";
import { COALESCE_MS, SessionsDials } from "../src/sessions/dials.js";
import { displayName, sessionsStrip, STRIP_COLORS } from "../src/sessions/strip.js";
import type { Feedback } from "../src/util/painter.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { RecordingLog } from "./helpers/recording-log.js";

function session(key: string, fields: Partial<RegistrySession> = {}): RegistrySession {
	return {
		key,
		name: `Session ${key}`,
		status: "idle",
		cwd: `/Users/me/p${key}`,
		hostSessionId: `local_${key}`,
		sessionId: `uuid-${key}`,
		statusUpdatedAt: 1,
		startedAt: Number(key),
		...fields,
	};
}

const list = (...keys: string[]): RegistrySession[] => keys.map((k) => session(k));

function setup(sessions: RegistrySession[] = list("1", "2", "3", "4")) {
	const clock = new FakeClock();
	const log = new RecordingLog();
	const dials = new SessionsDials({ clock, log });
	const sent: Feedback[] = [];
	let alerts = 0;
	dials.setSessions(sessions);
	dials.add("d1", { setFeedback: (p) => sent.push(p), showAlert: () => alerts++ });
	return { clock, log, dials, sent, alerts: () => alerts };
}

const shown = (dials: SessionsDials): unknown => {
	const p = dials.painted("d1") as Record<string, { value: string }> | null;
	return p && { name: p.name?.value, status: p.status?.value, pos: p.pos?.value };
};

describe("Sessions dial", () => {
	test("shows one session: its title, its raw status and its position, in the layout's own keys", () => {
		const { dials, sent } = setup([session("1", { name: "Fix the build", status: "busy" }), session("2")]);
		assert.deepEqual(shown(dials), { name: "Fix the build", status: "busy", pos: "1/2" });
		assert.deepEqual(Object.keys(sent[0] ?? {}).sort(), ["name", "pos", "status"], "never title or icon");
	});

	test("ticks within 40 ms are coalesced into one move, one session per tick", () => {
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
		assert.deepEqual(Object.keys(sent.at(-1) ?? {}).sort(), ["name", "pos"], "only changed keys are sent");
	});

	test("stops at either end", () => {
		const { clock, dials } = setup();
		dials.rotate("d1", -3, false);
		clock.advance(100);
		assert.equal(dials.selected("d1")?.key, "1");
		dials.rotate("d1", 10, false);
		clock.advance(100);
		assert.equal(dials.selected("d1")?.key, "4");
	});

	test("repaints at most 10 times a second", () => {
		const { clock, dials, sent } = setup(list("1", "2", "3", "4", "5", "6", "7", "8", "9"));
		const before = sent.length;
		for (let i = 0; i < 10; i++) {
			dials.rotate("d1", 1, false);
			clock.advance(COALESCE_MS + 1);
		}
		clock.advance(1000);
		const paints = sent.length - before;
		assert.ok(paints >= 4 && paints <= 6, `${paints} paints for 10 moves over about 0.4 s`);
		assert.deepEqual(shown(dials), { name: "Session 9", status: "idle", pos: "9/9" });
	});

	test("stays on its session when the list changes, or on the same place when that session ends", () => {
		const { clock, dials } = setup();
		dials.rotate("d1", 2, false);
		clock.advance(100);
		assert.equal(dials.selected("d1")?.key, "3");
		dials.setSessions(list("0", "1", "2", "3", "4"));
		clock.advance(200);
		assert.equal(dials.selected("d1")?.key, "3");
		assert.deepEqual(shown(dials), { name: "Session 3", status: "idle", pos: "4/5" });
		dials.setSessions(list("0", "1", "2", "4"));
		clock.advance(200);
		assert.equal(dials.selected("d1")?.key, "4");
		dials.setSessions(list("0"));
		clock.advance(200);
		assert.equal(dials.selected("d1")?.key, "0");
		dials.setSessions([]);
		clock.advance(200);
		assert.deepEqual(shown(dials), { name: "No sessions", status: "", pos: "0/0" });
	});

	test("follows a session by its hostSessionId, so a new pid for the same session keeps the selection", () => {
		const { clock, dials } = setup([session("10", { hostSessionId: "local_a" }), session("20", { hostSessionId: "local_b" })]);
		dials.rotate("d1", 1, false);
		clock.advance(100);
		assert.equal(dials.selected("d1")?.hostSessionId, "local_b");
		// The app restarted local_b's process: a new registry file, started later, listed first by a newer one.
		dials.setSessions([session("5", { hostSessionId: "local_c", startedAt: 1 }), session("10", { hostSessionId: "local_a" }), session("30", { hostSessionId: "local_b" })]);
		assert.equal(dials.selected("d1")?.key, "30");
	});

	test("follows status and name changes from the registry", () => {
		const { clock, dials } = setup([session("1", { status: "busy" })]);
		dials.setSessions([session("1", { status: "idle", name: "Renamed" })]);
		clock.advance(200);
		assert.deepEqual(shown(dials), { name: "Renamed", status: "idle", pos: "1/1" });
		dials.setSessions([session("1", { status: "waiting" })]);
		clock.advance(200);
		assert.deepEqual(shown(dials), { name: "Session 1", status: "waiting", pos: "1/1" }, "any status shows as it is");
	});

	test("press and tap log `jump <hostSessionId>`; long-touch logs; nothing else happens", () => {
		const { clock, dials, log } = setup();
		dials.rotate("d1", 1, false);
		clock.advance(100);
		dials.down("d1");
		dials.up("d1");
		dials.tap("d1", false);
		dials.tap("d1", true);
		const info = log.at("info");
		assert.equal(info.filter((l) => l.startsWith("info jump local_2 via press")).length, 1, info.join("\n"));
		assert.equal(info.filter((l) => l.startsWith("info jump local_2 via tap")).length, 1);
		assert.ok(info.some((l) => l.startsWith("info long-touch local_2")));
	});

	test("a press that turned the dial, or that started before the plugin saw it, doesn't jump", () => {
		const { dials, log } = setup();
		dials.up("d1"); // no down seen
		dials.down("d1");
		dials.rotate("d1", 1, true);
		dials.up("d1");
		assert.ok(!log.at("info").some((l) => l.includes("jump")));
	});

	test("jump with no sessions, or no hostSessionId, alerts", () => {
		const { dials, log, alerts } = setup([session("1", { hostSessionId: null })]);
		dials.tap("d1", false);
		assert.equal(alerts(), 1);
		assert.ok(log.at("info").some((l) => /jump via tap: pid 1 .* has no hostSessionId/.test(l)));
		dials.setSessions([]);
		dials.tap("d1", false);
		assert.equal(alerts(), 2);
	});

	test("names fall back to the folder, then the pid; long ones are cut; missing status reads unknown", () => {
		assert.equal(displayName(session("7", { name: null })), "p7");
		assert.equal(displayName(session("7", { name: "  ", cwd: null })), "Session 7");
		assert.equal(displayName(session("7", { name: "x".repeat(500) })).length, 121);
		assert.deepEqual(sessionsStrip([session("7", { status: null })], 0).status, { value: "unknown", color: STRIP_COLORS.none });
	});
});
