import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import type { PollReply } from "../src/bridge/commands.js";
import { SLOTS_FILE } from "../src/bridge/config.js";
import { SessionModel } from "../src/model/sessions.js";
import type { AppRecord } from "../src/records/records.js";
import type { RegistrySession } from "../src/registry/registry.js";
import { compareSlots, dialSlotId, parseSlotId, slotId } from "../src/slots/ids.js";
import { HOLD_MS, type SlotKeyLook, SlotKeys } from "../src/slots/keys.js";
import { type OthersLook, OthersKeys, othersLook } from "../src/slots/others.js";
import { FILL_DELAY_MS, Slots } from "../src/slots/slots.js";
import { MemorySlotStore, nodeSlotFs, parseSlots, SlotFile, type SlotFs, slotsText } from "../src/slots/store.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { RecordingLog } from "./helpers/recording-log.js";

/** Lets the front check's promises settle. */
const settle = async (): Promise<void> => {
	for (let i = 0; i < 6; i++) await Promise.resolve();
};

class FakeReply implements PollReply {
	open = true;
	send(): void {
		this.open = false;
	}
	onClose(): void {}
}

const A = "local_a";
const B = "local_b";
const C = "local_c";
const D = "local_d";
const E = "local_e";
const DEV = "dev1";
/** The bottom row of a Stream Deck + (2 rows of 4), left to right, and a top-row slot. */
const BOTTOM = [0, 1, 2, 3].map((col) => slotId(DEV, 1, col));
const TOP = slotId(DEV, 0, 0);

function reg(pid: number, host: string, fields: Partial<RegistrySession> = {}): RegistrySession {
	return { key: String(pid), name: `Session ${host.slice(6)}`, status: "idle", cwd: `/p/${pid}`, hostSessionId: host, sessionId: `sid-${pid}`, statusUpdatedAt: 1000, startedAt: pid, ...fields };
}

function record(host: string, fields: Partial<AppRecord> = {}): AppRecord {
	return { host, title: null, model: null, effort: null, permissionMode: null, lastFocusedAt: null, turnCategory: null, isArchived: false, lastActivityAt: null, cwd: null, summary: null, needs: null, ...fields };
}

function setup(registry: RegistrySession[], saved: Map<string, string> = new Map()) {
	let wall = 10_000;
	const log = new RecordingLog();
	const model = new SessionModel({ clock: new FakeClock(), log, wallNow: () => wall });
	model.setRegistry(registry);
	const store = new MemorySlotStore(saved);
	const slotClock = new FakeClock();
	const slots = new Slots(model, { store, log, clock: slotClock });
	const permission = (host: string, tool = "Bash"): void => {
		const pid = registry.find((r) => r.hostSessionId === host)?.key ?? "?";
		model.permission({ session_id: `sid-${pid}`, tool_name: tool, tool_input: { command: "ls" } }, host, new FakeReply());
	};
	/** The slots appear as a page's do, one willAppear at a time, then fill together. */
	const show = (...ids: string[]): void => {
		for (const id of ids) slots.appear(id, `who-${id}`);
		slotClock.advance(FILL_DELAY_MS);
	};
	return { model, slots, store, log, permission, show, slotClock, at: (t: number) => (wall = t) };
}

describe("slot ids (session-keys.md, Slots)", () => {
	test("<device>:<row>:<col>; a dial joins the bottom row's key in its column", () => {
		assert.equal(slotId("D1", 1, 2), "D1:1:2");
		assert.equal(dialSlotId("D1", 2, 3), "D1:1:3", "row 1 on a Stream Deck +");
		assert.equal(dialSlotId("D1", 4, 0), "D1:3:0");
		assert.deepEqual(parseSlotId("D1:1:2"), { device: "D1", row: 1, col: 2 });
		assert.deepEqual(parseSlotId("a:b:1:2"), { device: "a:b", row: 1, col: 2 }, "a device id may hold colons");
		for (const bad of ["", "D1", "D1:1", ":1:2", "D1:-1:2", "D1:1:x", "D1:1:2:", "D1\n:1:2", "D1:1234:0"]) assert.equal(parseSlotId(bad), null, JSON.stringify(bad));
	});

	test("slots fill bottom row first, left to right", () => {
		const shuffled = [slotId(DEV, 0, 1), slotId(DEV, 1, 3), slotId(DEV, 0, 0), slotId(DEV, 1, 0), slotId(DEV, 1, 2), slotId(DEV, 1, 1)];
		assert.deepEqual([...shuffled].sort(compareSlots), [...BOTTOM, slotId(DEV, 0, 0), slotId(DEV, 0, 1)]);
	});
});

describe("the saved slots (run/slots.json)", () => {
	const top = mkdtempSync(path.join(os.tmpdir(), "claude-deck-slots-"));
	after(() => rmSync(top, { recursive: true, force: true }));

	test("written whole as {v: 1, slots: {id: {host}}}, through a temp file renamed into place, 0600 in a 0700 folder", () => {
		const run = path.join(mkdtempSync(path.join(top, "case-")), "run");
		const renames: [string, string][] = [];
		const fs: SlotFs = { ...nodeSlotFs, rename: (from, to) => (renames.push([from, to]), nodeSlotFs.rename(from, to)) };
		const file = new SlotFile(run, { fs });
		file.save(new Map([[BOTTOM[1] ?? "", B], [BOTTOM[0] ?? "", A]]));
		assert.equal(file.file, path.join(run, SLOTS_FILE));
		assert.deepEqual(JSON.parse(readFileSync(file.file, "utf8")), { v: 1, slots: { [BOTTOM[0] ?? ""]: { host: A }, [BOTTOM[1] ?? ""]: { host: B } } });
		assert.equal(renames.length, 1);
		assert.equal(renames[0]?.[1], file.file);
		assert.notEqual(renames[0]?.[0], file.file, "written beside it first");
		assert.deepEqual(readdirSync(run), [SLOTS_FILE], "no temp file left");
		assert.equal(statSync(file.file).mode & 0o777, 0o600);
		assert.equal(statSync(run).mode & 0o777, 0o700);
		assert.deepEqual([...file.load()], [[BOTTOM[0], A], [BOTTOM[1], B]]);
	});

	test("no file is no slots, quietly; a bad file is no slots and one warn line", () => {
		const dir = mkdtempSync(path.join(top, "case-"));
		const log = new RecordingLog();
		const file = new SlotFile(dir, { log });
		assert.equal(file.load().size, 0);
		assert.equal(log.lines.length, 0);
		const bad = [
			"{",
			"[]",
			'{"v": 2, "slots": {}}',
			'{"v": 1}',
			'{"v": 1, "slots": []}',
			`{"v": 1, "slots": {"nope": {"host": "${A}"}}}`,
			`{"v": 1, "slots": {"${BOTTOM[0]}": {"host": "not-an-id"}}}`,
			`{"v": 1, "slots": {"${BOTTOM[0]}": "${A}"}}`,
			`{"v": 1, "slots": {"${BOTTOM[0]}": {"host": "${A}"}, "${BOTTOM[1]}": {"host": "${A}"}}}`,
		];
		for (const text of bad) {
			writeFileSync(path.join(dir, SLOTS_FILE), text);
			const before: number = log.lines.length;
			assert.equal(file.load().size, 0, text);
			assert.equal(log.lines.length - before, 1, text);
			assert.equal(log.lines.at(-1)?.level, "warn");
		}
		// A good file with fields it doesn't know.
		writeFileSync(path.join(dir, SLOTS_FILE), `{"v": 1, "note": "x", "slots": {"${BOTTOM[0]}": {"host": "${A}", "title": "kept out"}}}`);
		assert.deepEqual([...file.load()], [[BOTTOM[0], A]]);
	});

	test("a save that fails is warned of once, and the slots carry on; the temp file goes", () => {
		const dir = mkdtempSync(path.join(top, "case-"));
		const log = new RecordingLog();
		let fail = true;
		const fs: SlotFs = { ...nodeSlotFs, rename: (from, to) => (fail ? (() => { throw Object.assign(new Error("nope"), { code: "EIO" }); })() : nodeSlotFs.rename(from, to)) };
		const file = new SlotFile(dir, { fs, log });
		file.save(new Map([[BOTTOM[0] ?? "", A]]));
		file.save(new Map([[BOTTOM[0] ?? "", B]]));
		assert.equal(log.at("warn").length, 1);
		assert.deepEqual(readdirSync(dir), []);
		fail = false;
		file.save(new Map([[BOTTOM[0] ?? "", C]]));
		assert.deepEqual([...file.load()], [[BOTTOM[0], C]]);
		assert.ok(log.at("info").some((l) => l.includes("saved again")));
	});

	test("each save writes the temp file, flushes it to the disk, then renames it into place", () => {
		const dir = mkdtempSync(path.join(top, "case-"));
		const calls: string[] = [];
		const name = (file: string): string => path.relative(dir, file) || ".";
		const fs: SlotFs = {
			...nodeSlotFs,
			mkdir: (d, mode) => (calls.push(`mkdir ${name(d)}`), nodeSlotFs.mkdir(d, mode)),
			writeFile: (file, text, mode) => (calls.push(`write ${name(file)}`), nodeSlotFs.writeFile(file, text, mode)),
			sync: (file) => (calls.push(`sync ${name(file)}`), nodeSlotFs.sync(file)),
			rename: (from, to) => (calls.push(`rename ${name(from)} ${name(to)}`), nodeSlotFs.rename(from, to)),
		};
		new SlotFile(dir, { fs }).save(new Map([[BOTTOM[0] ?? "", A]]));
		const tmp = `.${SLOTS_FILE}.${process.pid}.tmp`;
		assert.deepEqual(calls, [`mkdir .`, `write ${tmp}`, `sync ${tmp}`, `rename ${tmp} ${SLOTS_FILE}`]);
	});

	test("a temp file an earlier run left behind is removed at load; nothing else is", () => {
		const dir = mkdtempSync(path.join(top, "case-"));
		const log = new RecordingLog();
		const stale = `.${SLOTS_FILE}.999999999.tmp`;
		for (const f of [stale, `.${SLOTS_FILE}.tmp`, `${SLOTS_FILE}.1.tmp`, "token"]) writeFileSync(path.join(dir, f), "x");
		writeFileSync(path.join(dir, SLOTS_FILE), slotsText(new Map([[BOTTOM[0] ?? "", A]])));
		assert.deepEqual([...new SlotFile(dir, { log }).load()], [[BOTTOM[0], A]]);
		assert.deepEqual(readdirSync(dir).sort(), [`.${SLOTS_FILE}.tmp`, SLOTS_FILE, `${SLOTS_FILE}.1.tmp`, "token"].sort());
		assert.ok(log.at("info").some((l) => l.includes(`removed ${stale}`)), log.at("info").join("\n"));
		assert.equal(new SlotFile(path.join(dir, "not-there"), { log }).load().size, 0, "no folder: nothing to sweep, and no slots");
	});

	test("the text is the parser's", () => {
		const slots = new Map([[BOTTOM[2] ?? "", C], [TOP, A]]);
		const parsed = parseSlots(slotsText(slots));
		assert.ok(parsed.ok);
		assert.deepEqual(parsed.ok ? [...parsed.slots].sort() : [], [...slots].sort());
	});
});

describe("the slots (session-keys.md, Slots)", () => {
	test("only showing slots fill, bottom row first, left to right, and the newest session first", () => {
		const { slots, show } = setup([reg(1, A), reg(2, B), reg(3, C)]);
		assert.equal(slots.host(BOTTOM[0] ?? ""), null, "nothing shows yet");
		show(BOTTOM[2] ?? "", BOTTOM[0] ?? "");
		assert.deepEqual(slots.entries(), [[BOTTOM[0], C], [BOTTOM[2], B]]);
		show(TOP);
		assert.equal(slots.host(TOP), A);
		show(BOTTOM[1] ?? "");
		assert.equal(slots.host(BOTTOM[1] ?? ""), null, "no session left off the slots");
	});

	test("slots that appear one at a time fill together, FILL_DELAY_MS after the first, or at once on a change to the model", () => {
		const { model, slots, slotClock } = setup([reg(1, A), reg(2, B), reg(3, C)]);
		slots.appear(BOTTOM[3] ?? "", "k3");
		slotClock.advance(FILL_DELAY_MS - 1);
		slots.appear(BOTTOM[0] ?? "", "k0");
		assert.equal(slots.host(BOTTOM[3] ?? ""), null, "not yet");
		slotClock.advance(1);
		assert.deepEqual(slots.entries(), [[BOTTOM[0], C], [BOTTOM[3], B]], "in slot order, not the order they appeared");
		slots.appear(BOTTOM[1] ?? "", "k1");
		model.setRegistry([reg(1, A), reg(2, B), reg(3, C, { status: "busy" })]);
		assert.equal(slots.host(BOTTOM[1] ?? ""), A, "a change to the model fills at once");
		assert.equal(slotClock.pendingTimers, 0, "and the timer goes");
		// A slot that appears with its session already there doesn't wait.
		slots.disappear(BOTTOM[1] ?? "", "k1");
		slots.appear(BOTTOM[1] ?? "", "k1");
		assert.equal(slotClock.pendingTimers, 0);
		slots.dispose();
	});

	test("a session that needs you comes first, the one waiting longest", () => {
		const { slots, show, permission, at } = setup([reg(1, A), reg(2, B), reg(3, C), reg(4, D, { status: "waiting", statusUpdatedAt: 900 })]);
		at(5000);
		permission(B);
		at(6000);
		permission(A, "AskUserQuestion");
		show(...BOTTOM);
		assert.deepEqual(
			slots.entries().map(([, h]) => h),
			[D, B, A, C],
			"D waits since 900, B since 5000, A since 6000; then the newest",
		);
	});

	test("a session on a slot, showing or not, isn't taken again; an archived one isn't taken at all", () => {
		const { model, slots, show } = setup([reg(1, A), reg(2, B), reg(3, C)], new Map([[TOP, C]]));
		model.setRecords(new Map([[B, record(B, { isArchived: true })]]));
		show(...BOTTOM);
		assert.deepEqual(slots.entries(), [[BOTTOM[0], A], [TOP, C]], "C stays on the hidden top slot; B is archived");
	});

	test("stay put: a slot keeps its session while it isn't running, and lets it go once archived", () => {
		const { model, slots, show } = setup([reg(1, A), reg(2, B)]);
		show(BOTTOM[0] ?? "");
		assert.equal(slots.host(BOTTOM[0] ?? ""), B);
		model.setRecords(new Map([[B, record(B)]]));
		model.setRegistry([reg(1, A)]);
		assert.equal(slots.host(BOTTOM[0] ?? ""), B, "not running, but its record is there");
		assert.equal(model.slotView(B)?.running, false);
		model.setRegistry([reg(1, A), reg(2, B)]);
		assert.equal(slots.host(BOTTOM[0] ?? ""), B, "a newer session doesn't push it off");
		model.setRecords(new Map([[B, record(B, { isArchived: true })]]));
		assert.equal(slots.host(BOTTOM[0] ?? ""), A, "archived: the slot lets it go and fills again");
	});

	test("stay put: no record file and not listed lets it go, but only once both are known", () => {
		const { model, slots, show } = setup([reg(1, A)], new Map([[BOTTOM[0] ?? "", B]]));
		show(BOTTOM[0] ?? "");
		assert.equal(slots.host(BOTTOM[0] ?? ""), B, "no records scan yet");
		model.setRecords(new Map(), new Set([A]));
		assert.equal(slots.host(BOTTOM[0] ?? ""), B, "the scan didn't look for B");
		model.setRecords(new Map(), new Set([B]));
		assert.equal(slots.host(BOTTOM[0] ?? ""), A, "no file and not listed: it goes, and A fills the slot");
		// Before the registry's first reading, a missing record isn't enough.
		const fresh = new SessionModel();
		const kept = new Slots(fresh, { store: new MemorySlotStore(new Map([[TOP, C]])) });
		fresh.setRecords(new Map(), new Set([C]));
		assert.equal(kept.host(TOP), C);
		fresh.setRegistry([]);
		assert.equal(kept.host(TOP), null);
	});

	test("the slotted sessions' records are kept, and every change is saved", () => {
		const { model, slots, store, show } = setup([reg(1, A), reg(2, B)]);
		assert.deepEqual(model.hosts(), [A, B]);
		show(BOTTOM[0] ?? "");
		assert.deepEqual([...store.saved], [[BOTTOM[0], B]]);
		model.setRegistry([reg(1, A)]);
		assert.deepEqual(model.hosts(), [A, B], "B's record is still read");
		const saves = store.saves;
		slots.place(BOTTOM[0] ?? "", A);
		assert.equal(store.saves, saves + 1);
		assert.deepEqual([...store.saved], [[BOTTOM[0], A]]);
	});

	test("loaded at start; a key and a dial on one slot share it, and it shows while either does", () => {
		const { slots } = setup([reg(1, A), reg(2, B)], new Map([[BOTTOM[3] ?? "", A]]));
		assert.equal(slots.host(BOTTOM[3] ?? ""), A);
		slots.appear(BOTTOM[3] ?? "", "key");
		slots.appear(BOTTOM[3] ?? "", "dial");
		slots.disappear(BOTTOM[3] ?? "", "key");
		assert.equal(slots.showing(BOTTOM[3] ?? ""), true);
		slots.disappear(BOTTOM[3] ?? "", "dial");
		assert.equal(slots.showing(BOTTOM[3] ?? ""), false);
		assert.equal(slots.host(BOTTOM[3] ?? ""), A, "keeps its session while hidden");
		slots.appear("not a slot", "x");
		assert.equal(slots.showing("not a slot"), false);
	});

	test("long press: the slot takes the session on screen, swapping with the slot it was on", () => {
		const { model, slots, show } = setup([reg(1, A), reg(2, B), reg(3, C)]);
		show(BOTTOM[0] ?? "", BOTTOM[1] ?? "");
		assert.deepEqual(slots.entries(), [[BOTTOM[0], C], [BOTTOM[1], B]]);
		assert.deepEqual(slots.takeOnScreen(BOTTOM[0] ?? ""), { ok: false, why: "no session is known to be on screen in the app" });
		model.setRecords(new Map([[B, record(B, { lastFocusedAt: 9000 })]]));
		assert.deepEqual(slots.takeOnScreen(BOTTOM[0] ?? ""), { ok: true, host: B, from: BOTTOM[1], replaced: null });
		assert.deepEqual(slots.entries(), [[BOTTOM[0], B], [BOTTOM[1], C]], "swapped");
		model.setRecords(new Map([[A, record(A, { lastFocusedAt: 9500 })]]));
		assert.deepEqual(slots.takeOnScreen(BOTTOM[1] ?? ""), { ok: true, host: A, from: null, replaced: C });
		assert.deepEqual(slots.entries(), [[BOTTOM[0], B], [BOTTOM[1], A]], "C is off the slots now");
		assert.deepEqual(slots.takeOnScreen(BOTTOM[1] ?? ""), { ok: true, host: A, from: null, replaced: null }, "already there");
	});

	test("a long press with an archived session last on screen alerts and changes nothing, rather than showing OK and letting it go", () => {
		const { model, slots, show, log } = setup([reg(1, A), reg(2, B), reg(3, C)]);
		model.setRecords(new Map([[A, record(A, { isArchived: true })]]));
		show(BOTTOM[0] ?? "", BOTTOM[1] ?? "");
		assert.deepEqual(slots.entries(), [[BOTTOM[0], C], [BOTTOM[1], B]]);
		model.setRecords(new Map([[A, record(A, { isArchived: true, lastFocusedAt: 9000 })]]));
		assert.equal(model.onScreen()?.host, A);
		assert.deepEqual(slots.takeOnScreen(BOTTOM[0] ?? ""), { ok: false, why: "the session on screen in the app is archived" });
		assert.deepEqual(slots.entries(), [[BOTTOM[0], C], [BOTTOM[1], B]], "nothing changed");
		assert.ok(log.at("info").some((l) => l.includes("is archived: nothing changes")), log.at("info").join("\n"));
	});

	test("a long press swaps with a hidden slot too, which keeps the session it gets", () => {
		const { model, slots, show } = setup([reg(1, A), reg(2, B)], new Map([[TOP, B]]));
		show(BOTTOM[0] ?? "");
		assert.deepEqual(slots.entries(), [[BOTTOM[0], A], [TOP, B]]);
		model.setRecords(new Map([[B, record(B, { lastFocusedAt: 9000 })]]));
		assert.equal(slots.takeOnScreen(BOTTOM[0] ?? "").ok, true);
		assert.deepEqual(slots.entries(), [[BOTTOM[0], B], [TOP, A]]);
	});

	test("a swap from an empty slot leaves the other empty, and a showing one fills again", () => {
		const { slots, show } = setup([reg(1, A), reg(2, B), reg(3, C)]);
		show(BOTTOM[0] ?? "");
		slots.place(TOP, C);
		assert.deepEqual(slots.entries(), [[BOTTOM[0], B], [TOP, C]]);
		slots.place(BOTTOM[1] ?? "", B);
		assert.deepEqual(slots.entries(), [[BOTTOM[0], A], [BOTTOM[1], B], [TOP, C]], "B moved; its slot, showing, took A");
		assert.equal(slots.place("nope", A).ok, false);
		assert.equal(slots.place(TOP, "nope").ok, false);
	});

	test("one listener call per change, after the slots have caught up with the model", () => {
		const { model, slots, show } = setup([reg(1, A)]);
		show(BOTTOM[0] ?? "");
		const seen: (string | null)[] = [];
		slots.onChange(() => seen.push(slots.host(BOTTOM[0] ?? "")));
		model.setRecords(new Map([[A, record(A, { isArchived: true })]]));
		assert.deepEqual(seen, [null]);
	});
});

describe("Session Slot keys (src/slots/keys.ts)", () => {
	function keys(registry: RegistrySession[] = [reg(1, A), reg(2, B)]) {
		const s = setup(registry);
		const clock = new FakeClock();
		const jumps: string[] = [];
		const looks: SlotKeyLook[] = [];
		const k = new SlotKeys(s.slots, s.model, { art: (look) => (looks.push(look), `${look.slot} ${look.session?.host ?? "none"}`), clock, wallNow: () => 42, paintIntervalMs: 0, open: (h) => jumps.push(h) });
		const feedback: string[] = [];
		const surface = (id: string) => ({ setImage: () => {}, showOk: () => feedback.push(`${id}:ok`), showAlert: () => feedback.push(`${id}:alert`) });
		/** A key appears on its slot, which then fills as a page's slots do. */
		const addKey = (id: string, slot: string | null): void => {
			k.add(id, slot, surface(id));
			s.slotClock.advance(FILL_DELAY_MS);
		};
		return { ...s, k, clock, jumps, looks, feedback, surface, addKey };
	}

	test("a key shows its slot's session, and showing makes its slot fill", () => {
		const { k, addKey, looks } = keys();
		addKey("k0", BOTTOM[0] ?? "");
		assert.equal(k.painted("k0"), `${BOTTOM[0]} ${B}`);
		assert.deepEqual([looks.at(-1)?.session?.host, looks.at(-1)?.now], [B, 42]);
	});

	test("a press jumps to the session, makes it the target, and counts its turn's end as seen; an empty slot alerts", () => {
		const { model, k, addKey, jumps, feedback, at } = keys([reg(1, A)]);
		addKey("k0", BOTTOM[0] ?? "");
		addKey("k1", BOTTOM[1] ?? "");
		// Idle, and active since it was last on screen: unseen.
		model.setRecords(new Map([[A, record(A, { lastActivityAt: 9000, lastFocusedAt: 8000 })]]));
		assert.equal(model.slotView(A)?.seen, false);
		at(9500);
		k.down("k0");
		k.up("k0");
		assert.deepEqual(jumps, [A]);
		assert.equal(model.picked, A);
		assert.equal(model.slotView(A)?.seen, true);
		k.down("k1");
		k.up("k1");
		assert.deepEqual(feedback, ["k1:alert"]);
		assert.deepEqual(jumps, [A]);
	});

	test("held 500 ms: the slot takes the session on screen, shows OK, and the key-up after does nothing", () => {
		assert.equal(HOLD_MS, 500);
		const { model, slots, k, clock, addKey, jumps, feedback } = keys();
		addKey("k0", BOTTOM[0] ?? "");
		addKey("k1", BOTTOM[1] ?? "");
		model.setRecords(new Map([[B, record(B, { lastFocusedAt: 9000 })]]));
		assert.deepEqual(slots.entries(), [[BOTTOM[0], B], [BOTTOM[1], A]]);
		model.setRecords(new Map([[A, record(A, { lastFocusedAt: 9000 })]]));
		k.down("k0");
		clock.advance(HOLD_MS - 1);
		assert.deepEqual(feedback, []);
		clock.advance(1);
		assert.deepEqual(feedback, ["k0:ok"]);
		assert.deepEqual(slots.entries(), [[BOTTOM[0], A], [BOTTOM[1], B]]);
		k.up("k0");
		assert.deepEqual(jumps, [], "the key-up after a hold does nothing");
		assert.equal(k.painted("k0"), `${BOTTOM[0]} ${A}`);
		assert.equal(k.painted("k1"), `${BOTTOM[1]} ${B}`);
	});

	test("a hold with no session known to be on screen alerts; a release before 500 ms is a press", () => {
		const { k, clock, addKey, jumps, feedback } = keys();
		addKey("k0", BOTTOM[0] ?? "");
		k.down("k0");
		clock.advance(HOLD_MS);
		assert.deepEqual(feedback, ["k0:alert"]);
		k.up("k0");
		k.down("k0");
		clock.advance(HOLD_MS - 10);
		k.up("k0");
		assert.deepEqual(jumps, [B]);
		clock.advance(1000);
		assert.deepEqual(feedback, ["k0:alert"], "no hold fires after the release");
	});

	test("a press acts only on the session the key showed: one put on the slot since the key's last paint alerts", () => {
		const s = setup([reg(1, A), reg(2, B)]);
		const clock = new FakeClock();
		const jumps: string[] = [];
		const feedback: string[] = [];
		const k = new SlotKeys(s.slots, s.model, { art: (look) => `${look.session?.host ?? "none"}`, clock, paintIntervalMs: 100, open: (h) => jumps.push(h) });
		k.add("k0", BOTTOM[0] ?? "", { setImage: () => {}, showOk: () => feedback.push("ok"), showAlert: () => feedback.push("alert") });
		assert.equal(k.painted("k0"), "none");
		// The slot fills with B, and the key's repaint waits out its 100 ms.
		s.slotClock.advance(FILL_DELAY_MS);
		assert.deepEqual([s.slots.host(BOTTOM[0] ?? ""), k.painted("k0")], [B, "none"]);
		k.down("k0");
		k.up("k0");
		assert.deepEqual([jumps, feedback], [[], ["alert"]], "the key showed no session");
		clock.advance(100);
		k.down("k0");
		k.up("k0");
		assert.deepEqual(jumps, [B]);
		// A swap puts A there, within 100 ms of the key's last paint: again the repaint waits.
		s.slots.place(BOTTOM[0] ?? "", A);
		k.down("k0");
		k.up("k0");
		assert.deepEqual([jumps, feedback], [[B], ["alert", "alert"]], "the key still showed B");
		clock.advance(100);
		k.down("k0");
		k.up("k0");
		assert.deepEqual(jumps, [B, A]);
		k.remove("k0");
	});

	test("a face that throws when drawn is logged at error, and the key carries on: nothing escapes add, a change or a tick, and a press before its first paint alerts", () => {
		const s = setup([reg(1, A)]);
		const clock = new FakeClock();
		const log = new RecordingLog();
		const jumps: string[] = [];
		const feedback: string[] = [];
		let fail = true;
		const art = (look: SlotKeyLook): string => {
			if (fail) throw new Error("bad art");
			return `${look.session?.host ?? "none"}`;
		};
		const k = new SlotKeys(s.slots, s.model, { art, clock, log, paintIntervalMs: 0, open: (h) => jumps.push(h) });
		k.add("k0", BOTTOM[0] ?? "", { setImage: () => {}, showOk: () => {}, showAlert: () => feedback.push("alert") });
		s.slotClock.advance(FILL_DELAY_MS);
		clock.advance(3000);
		assert.equal(k.painted("k0"), null);
		assert.ok(log.at("error").length >= 3, log.at("error").join("\n"));
		assert.ok(log.at("error").every((l) => l.includes("drawing its face threw: Error: bad art")));
		k.down("k0");
		k.up("k0");
		assert.deepEqual([jumps, feedback], [[], ["alert"]], "nothing shown yet: no jump");
		fail = false;
		clock.advance(1000);
		assert.equal(k.painted("k0"), A);
		k.down("k0");
		k.up("k0");
		assert.deepEqual(jumps, [A]);
		k.remove("k0");
	});

	test("while a slot key or an Others key shows, the model's front-app check may run; with none, it never asks", async () => {
		let asks = 0;
		let wall = 10_000;
		const clock = new FakeClock();
		const model = new SessionModel({
			clock,
			wallNow: () => wall,
			front: async () => {
				asks++;
				return false;
			},
		});
		model.setRegistry([reg(1, A)]);
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "i" });
		// A on screen in the app, then its turn ends there: unseen while on screen, which is what the check is for.
		model.events({ sid: null, host: A, inst: "i", seq: 1, events: [{ t: "attach", surface: "desktop", at: 1 }] });
		wall = 20_000;
		model.events({ sid: null, host: A, inst: "i", seq: 2, events: [{ t: "turn.start", turn: "t", at: 1 }, { t: "turn.end", turn: "t", reason: "answer", at: 1 }] });
		model.setRegistry([reg(1, A, { statusUpdatedAt: 20_001 })]);
		assert.equal(model.session(A)?.seen, false);
		clock.advance(5000);
		await settle();
		assert.equal(asks, 0, "nothing on the deck shows seen");
		const slots = new Slots(model, { store: new MemorySlotStore(), clock, fillDelayMs: 0 });
		const surface = { setImage: () => {}, showOk: () => {}, showAlert: () => {} };
		const k = new SlotKeys(slots, model, { art: () => "", clock, paintIntervalMs: 0, tickMs: 0 });
		k.add("m", null, surface);
		await settle();
		assert.equal(asks, 0, "a slot key in a multi-action shows nothing");
		k.add("k0", BOTTOM[0] ?? "", surface);
		await settle();
		assert.equal(asks, 1, "a slot key does");
		k.remove("k0");
		clock.advance(5000);
		await settle();
		assert.equal(asks, 1, "gone: the check stops");
		const others = new OthersKeys(slots, model, { art: () => "", clock, paintIntervalMs: 0, tickMs: 0 });
		others.add("o", surface);
		await settle();
		assert.equal(asks, 2, "an Others key does too");
		others.remove("o");
		k.remove("m");
		clock.advance(5000);
		await settle();
		assert.equal(asks, 2);
		model.dispose();
	});

	test("in a multi-action a slot key has no place: it does nothing, and holds no slot", () => {
		const { slots, k, clock, addKey, jumps, feedback } = keys();
		addKey("m", null);
		k.down("m");
		clock.advance(HOLD_MS);
		k.up("m");
		assert.deepEqual([jumps, feedback, slots.entries()], [[], [], []]);
	});

	test("it repaints once a second for since, while it has keys, and stops with the last", () => {
		const { k, clock, addKey, looks } = keys();
		addKey("k0", BOTTOM[0] ?? "");
		const before = looks.length;
		clock.advance(3000);
		assert.equal(looks.length - before, 3);
		k.remove("k0");
		clock.advance(3000);
		assert.equal(looks.length - before, 3);
		assert.equal(clock.pendingTimers, 0);
	});
});

describe("Others (src/slots/others.ts)", () => {
	test("counts the running sessions on no slot: those that need you, the longest waiting, the unseen, and the rest", () => {
		const { model, slots, show, permission, at } = setup([reg(1, A), reg(2, B, { status: "waiting", statusUpdatedAt: 3000 }), reg(3, C), reg(4, D), reg(5, E)]);
		show(BOTTOM[0] ?? "");
		assert.equal(slots.host(BOTTOM[0] ?? ""), B, "B needs you, so it fills first");
		at(4000);
		permission(C);
		at(2000);
		permission(D, "ExitPlanMode");
		model.setRecords(new Map([[A, record(A, { lastActivityAt: 5000, lastFocusedAt: 1000 })], [E, record(E, { isArchived: true })]]));
		const look = othersLook(model.sessions(), slots.slotted(), 99);
		assert.deepEqual({ needing: look.needing, oldest: look.oldest?.host, unseen: look.unseen, running: look.running, others: look.others, now: look.now }, { needing: 2, oldest: D, unseen: 1, running: 3, others: 0, now: 99 });
	});

	test("a press jumps to the one waiting longest and makes it the target; with none, it alerts", () => {
		const { model, slots, show, permission, at } = setup([reg(1, A), reg(2, B), reg(3, C)]);
		const jumps: string[] = [];
		const looks: OthersLook[] = [];
		const others = new OthersKeys(slots, model, { art: (look) => (looks.push(look), `${look.needing}`), clock: new FakeClock(), paintIntervalMs: 0, open: (h) => jumps.push(h) });
		const feedback: string[] = [];
		others.add("o", { setImage: () => {}, showOk: () => feedback.push("ok"), showAlert: () => feedback.push("alert") });
		others.press("o");
		assert.deepEqual(feedback, ["alert"]);
		show(BOTTOM[0] ?? "");
		at(7000);
		permission(C);
		at(6000);
		permission(A);
		assert.equal(others.painted("o"), "1", "C is on the slot; A needs you");
		others.press("o");
		assert.deepEqual(jumps, [A]);
		assert.equal(model.picked, A);
		others.remove("o");
	});

	test("a press acts only on the session the key showed as waiting longest: another one now, or none shown yet, alerts", () => {
		const { model, slots, permission, at } = setup([reg(1, A), reg(2, B)]);
		const clock = new FakeClock();
		const jumps: string[] = [];
		const feedback: string[] = [];
		const others = new OthersKeys(slots, model, { art: (look) => `${look.oldest?.host ?? "none"}`, clock, paintIntervalMs: 100, open: (h) => jumps.push(h) });
		others.add("o", { setImage: () => {}, showOk: () => {}, showAlert: () => feedback.push("alert") });
		at(6000);
		permission(B);
		assert.equal(others.painted("o"), "none", "the repaint waits out the 100 ms");
		others.press("o");
		assert.deepEqual([jumps, feedback], [[], ["alert"]], "the key showed none needing you");
		clock.advance(100);
		// A has waited longer, from before B: it's the one now, but within 100 ms of its last paint the key still
		// shows B.
		at(5000);
		permission(A);
		others.press("o");
		assert.deepEqual([jumps, feedback], [[], ["alert", "alert"]], "the key still showed B");
		clock.advance(100);
		assert.equal(others.painted("o"), A);
		others.press("o");
		assert.deepEqual(jumps, [A]);
		others.remove("o");
	});

	test("a face that throws when drawn is logged at error, and nothing escapes add, a change or a tick", () => {
		const { model, slots, permission } = setup([reg(1, A)]);
		const clock = new FakeClock();
		const log = new RecordingLog();
		const feedback: string[] = [];
		const others = new OthersKeys(slots, model, {
			art: () => {
				throw new Error("bad art");
			},
			clock,
			log,
			paintIntervalMs: 0,
		});
		others.add("o", { setImage: () => {}, showOk: () => {}, showAlert: () => feedback.push("alert") });
		permission(A);
		clock.advance(2000);
		assert.ok(log.at("error").length >= 3, log.at("error").join("\n"));
		assert.ok(log.at("error").every((l) => l.includes("Others: drawing its face threw: Error: bad art")));
		others.press("o");
		assert.deepEqual(feedback, ["alert"], "nothing shown yet: no jump");
		others.remove("o");
	});
});

describe("the slot file's place", () => {
	test("slots.json sits in the run folder beside the token, which git ignores", () => {
		const deckRun = path.join("com.karimdhanji.claude.sdPlugin", "run");
		assert.equal(new SlotFile(deckRun).file, path.join(deckRun, "slots.json"));
		assert.equal(existsSync(path.join(os.tmpdir(), "never-made", SLOTS_FILE)), false);
	});
});
