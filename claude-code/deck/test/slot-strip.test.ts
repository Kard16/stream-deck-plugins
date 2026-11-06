import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import type { PollReply } from "../src/bridge/commands.js";
import { fits } from "../src/keys/art.js";
import { SessionModel, type SessionView } from "../src/model/sessions.js";
import type { RegistrySession } from "../src/registry/registry.js";
import { COALESCE_MS } from "../src/sessions/dials.js";
import { APPROVAL_CHOICES, PLAN_CHOICES, type QuestionItem, SlotDials, type SlotScreen } from "../src/slots/dials.js";
import { dialSlotId } from "../src/slots/ids.js";
import { Slots } from "../src/slots/slots.js";
import { MemorySlotStore } from "../src/slots/store.js";
import { NEWER_MARK, nowLine, pageDots, SLOT_LAYOUTS, SLOT_STRIP_COLORS, SLOT_TEXT, type SlotScreenKind, slotStrip } from "../src/slots/strip.js";
import type { Feedback } from "../src/util/painter.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { deckRoot } from "./helpers/paths.js";
import { view } from "./helpers/views.js";

type Item = {
	key: string;
	type: string;
	rect: [number, number, number, number];
	zOrder?: number;
	font?: { size: number; weight: number };
	[k: string]: unknown;
};
type Layout = { $schema?: string; id: string; items: Item[] };

const LAYOUT_DIR = path.join(deckRoot(), "com.karimdhanji.claude.sdPlugin", "layouts");
const KINDS = Object.keys(SLOT_LAYOUTS) as SlotScreenKind[];

function layoutOf(kind: SlotScreenKind): Layout {
	return JSON.parse(readFileSync(path.join(deckRoot(), "com.karimdhanji.claude.sdPlugin", SLOT_LAYOUTS[kind]), "utf8")) as Layout;
}

/** The properties the layout schema (@elgato/schemas layout.json) allows on each item type we use. */
const ALLOWED: Record<string, readonly string[]> = {
	text: ["key", "type", "rect", "value", "alignment", "color", "font", "text-overflow", "background", "enabled", "opacity", "zOrder"],
	bar: ["key", "type", "rect", "value", "range", "subtype", "bar_bg_c", "bar_fill_c", "bar_border_c", "border_w", "background", "enabled", "opacity", "zOrder"],
};
const OPACITIES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
const HEX = /^#[0-9A-F]{6}$/i;

/** streamdeck validate's own overlap test (layout-item-bounds): touching edges don't overlap; another zOrder never does. */
function overlap(a: Item, b: Item): boolean {
	if ((a.zOrder ?? 0) !== (b.zOrder ?? 0)) return false;
	const [ax, ay, aw, ah] = a.rect;
	const [bx, by, bw, bh] = b.rect;
	return !(bx + bw <= ax || bx >= ax + aw || by + bh <= ay || by >= ay + ah);
}

describe("the Session Slot strip's layouts (com.karimdhanji.claude.sdPlugin/layouts/slot-*.json)", () => {
	// streamdeck validate checks only the layout the manifest names, so these hold its rules for every one the dial
	// switches to: one item out of the strip, or two at one zOrder overlapping, and the whole layout fails silently.
	test("one layout per screen kind, each file there, and no stray slot layout", () => {
		assert.deepEqual(KINDS.sort(), ["approval", "empty", "inApp", "pages", "plan", "question"]);
		assert.equal(new Set(Object.values(SLOT_LAYOUTS)).size, KINDS.length);
		const files = readdirSync(LAYOUT_DIR).filter((f) => f.startsWith("slot-"));
		assert.deepEqual(files.sort(), Object.values(SLOT_LAYOUTS).map((p) => path.basename(p)).sort());
		const ids = KINDS.map((k) => layoutOf(k).id);
		assert.equal(new Set(ids).size, ids.length, "ids are unique");
		for (const k of KINDS) assert.equal(layoutOf(k).$schema, "https://schemas.elgato.com/streamdeck/plugins/layout.json");
	});

	test("every item inside 200×100, none overlapping another at its zOrder, keys unique and ours, text and bar items only", () => {
		for (const kind of KINDS) {
			const { items } = layoutOf(kind);
			const keys = new Set<string>();
			for (const item of items) {
				const where = `${kind}.${item.key}`;
				assert.ok(item.type === "text" || item.type === "bar", `${where}: text or bar`);
				assert.match(item.key, /^[A-Za-z0-9\-_]+$/, where);
				assert.ok(item.key !== "title" && item.key !== "icon", `${where}: never the app's own title or icon`);
				assert.ok(!keys.has(item.key), `${where}: unique`);
				keys.add(item.key);
				const [x, y, w, h] = item.rect;
				assert.ok(item.rect.length === 4 && item.rect.every((n) => Number.isInteger(n)), `${where}: rect`);
				assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 200 && y + h <= 100, `${where}: inside 200×100 (${item.rect.join(",")})`);
				for (const k of Object.keys(item)) assert.ok(ALLOWED[item.type]?.includes(k), `${where}: ${k} isn't a ${item.type} property`);
				if (item.type === "text") {
					assert.equal(typeof item.value, "string", where);
					assert.ok(item.font && Number.isInteger(item.font.size) && item.font.weight >= 100 && item.font.weight <= 1000, `${where}: font`);
					assert.ok(["left", "center", "right"].includes(String(item.alignment)), `${where}: alignment`);
					if (item["text-overflow"] !== undefined) assert.ok(["clip", "ellipsis", "fade"].includes(String(item["text-overflow"])), where);
					assert.match(String(item.color), HEX, where);
					if (item.background !== undefined) assert.match(String(item.background), HEX, where);
				} else {
					assert.equal(typeof item.value, "number", where);
					assert.deepEqual(item.range, { min: 0, max: 100 }, where);
				}
				if (item.opacity !== undefined) assert.ok(OPACITIES.includes(item.opacity as number), `${where}: opacity`);
			}
			for (let i = 0; i < items.length; i++) {
				for (let j = 0; j < i; j++) {
					const a = items[i] as Item;
					const b = items[j] as Item;
					assert.ok(!overlap(a, b), `${kind}: ${a.key} overlaps ${b.key}`);
				}
			}
		}
	});

	test("the painter measures each text item as its layout file has it: the same keys, font size, and a width inside the rect", () => {
		for (const kind of KINDS) {
			const text = layoutOf(kind).items.filter((i) => i.type === "text");
			const measured = SLOT_TEXT[kind] as Record<string, readonly [number, number]>;
			assert.deepEqual(Object.keys(measured).sort(), text.map((i) => i.key).sort(), kind);
			for (const item of text) {
				const [width, size] = measured[item.key] ?? [0, 0];
				assert.equal(size, item.font?.size, `${kind}.${item.key}: font size`);
				assert.ok(width <= item.rect[2] && width >= item.rect[2] - 12, `${kind}.${item.key}: width ${width} in rect ${item.rect[2]}`);
				// A chip (a text with a background) is measured inside its rect, clear of its edges.
				if (item.background !== undefined) assert.ok(width < item.rect[2], `${kind}.${item.key}: a chip's text stays off its edges`);
			}
		}
	});
});

// ---- screens ----

const NOW = 2_000_000;
const SLOT = "dev:1:0";

function screens(): [string, SlotScreen][] {
	const working = view({ title: "Stream Deck plugins revision for the session keys", status: "working", doing: "npm test --workspace=claude-code/deck", since: NOW - 4 * 60_000, context: 62.4, tokens: 620_000, window: 1_000_000, cost: 1.239, model: "claude-opus-5-5", effort: "max", mode: "acceptEdits", project: "stream-deck-plugins", summary: "Built the slot strip and its layouts, then ran the deck's tests; all 470 passed after one fix to the painter." });
	const done = view({ status: "done", seen: false, since: NOW - 3 * 60_000, summary: "Wrote the README" });
	const blank = view({ status: "idle", since: null, context: null, model: null, effort: null, mode: null });
	const input = view({ status: "needs-you", need: "input", since: NOW - 30_000, needs: "Pick which branch to keep before it carries on with the merge", summary: "Merged two branches" });
	const off = view({ running: false, listed: false, title: "Yesterday's session", model: "claude-haiku-5-5", effort: "low", mode: "default", project: "notes" });
	const high = view({ status: "working", context: 91 });
	const waiting = view({ status: "needs-you", need: "question", since: NOW - 4 * 60_000 });
	const plan = view({ status: "needs-you", need: "plan", since: NOW - 65_000 });
	const approve = view({ status: "approval", need: "approval", since: NOW - 12_000 });
	// The Setup page's Claude Code version (hardening.md, C1): on the checked one, and newer, with modes short and long.
	const onSetup = { model: "claude-opus-5-5", effort: "max", project: "stream-deck-plugins" } as const;
	const checked = view({ ...onSetup, mode: "auto", cc: "2.1.317", ccNewer: false });
	const newer = view({ ...onSetup, mode: "auto", cc: "2.1.318", ccNewer: true });
	const newerEdits = view({ ...onSetup, mode: "acceptEdits", cc: "2.1.318", ccNewer: true });
	const checkedEdits = view({ ...onSetup, mode: "acceptEdits", cc: "2.1.317", ccNewer: false });
	const newerNoMode = view({ ...onSetup, mode: null, cc: "2.1.318", ccNewer: true });
	const newerLongMode = view({ ...onSetup, mode: "someFutureModeWithALongName", cc: "2.1.318", ccNewer: true });
	const options = (picked: string[] = []): QuestionItem[] => [
		{ t: "option", label: "Red", description: "Warm", ticked: picked.includes("Red") },
		{ t: "option", label: "Blue", description: null, ticked: picked.includes("Blue") },
		{ t: "other" },
	];
	const multi = (picked: string[], send: boolean): QuestionItem[] => [
		{ t: "option", label: "Apple", description: "Red or green", ticked: picked.includes("Apple") },
		{ t: "option", label: "Pear, ripe", description: null, ticked: picked.includes("Pear, ripe") },
		{ t: "other" },
		{ t: "next", send, ready: picked.length > 0 },
	];
	const q = (fields: Partial<Extract<SlotScreen, { kind: "question" }>>): SlotScreen => ({
		kind: "question",
		slot: SLOT,
		session: waiting,
		request: 3,
		index: 0,
		count: 1,
		header: "Color",
		question: "Which colour should the test use for the session keys' amber outline on the deck?",
		multi: false,
		items: options(),
		cursor: null,
		picked: [],
		...fields,
	});
	const out: [string, SlotScreen][] = [["empty", { kind: "empty", slot: SLOT }]];
	const sessions = [
		["working", working],
		["done", done],
		["blank", blank],
		["input", input],
		["not running", off],
		["high context", high],
		["checked", checked],
		["newer", newer],
		["newer accept edits", newerEdits],
		["checked accept edits", checkedEdits],
		["newer no mode", newerNoMode],
		["newer long mode", newerLongMode],
	] as const;
	for (const [name, s] of sessions) {
		for (let page = 0; page < 3; page++) out.push([`pages ${name} ${page}`, { kind: "pages", slot: SLOT, session: s, page, pages: 3 }]);
	}
	for (const pick of [null, 0, 1]) out.push([`approval pick ${pick}`, { kind: "approval", slot: SLOT, session: approve, request: 1, tool: "Bash", summary: "rm -rf build && npm run build && npm test -- --test-name-pattern=slot", choices: APPROVAL_CHOICES, pick }]);
	out.push(["approval mcp", { kind: "approval", slot: SLOT, session: approve, request: 1, tool: "mcp__ccd_session_mgmt__set_session_permission_mode", summary: "set session permission mode", choices: APPROVAL_CHOICES, pick: null }]);
	out.push(["question before a turn", q({})]);
	out.push(["question cursor on an option", q({ cursor: 0 })]);
	out.push(["question cursor on an option without a description", q({ cursor: 1 })]);
	out.push(["question cursor on Other…", q({ cursor: 2 })]);
	out.push(["question 2 of 2, before a turn", q({ index: 1, count: 2, header: null, question: "Which size?" })]);
	out.push(["question back on the first, picked", q({ count: 2, picked: ["Blue"], items: options(["Blue"]) })]);
	out.push(["question ticked", q({ multi: true, items: multi(["Apple"], false), cursor: 0, picked: ["Apple"], count: 2 })]);
	out.push(["question unticked", q({ multi: true, items: multi(["Apple"], false), cursor: 1, picked: ["Apple"], count: 2 })]);
	out.push(["question next ready", q({ multi: true, items: multi(["Apple"], false), cursor: 3, picked: ["Apple"], count: 2 })]);
	out.push(["question next not ready", q({ multi: true, items: multi([], false), cursor: 3, count: 2 })]);
	out.push(["question send ready", q({ multi: true, items: multi(["Pear, ripe"], true), cursor: 3, picked: ["Pear, ripe"], index: 1, count: 2 })]);
	out.push(["question send not ready", q({ multi: true, items: multi([], true), cursor: 3, index: 1, count: 2 })]);
	for (const pick of [null, 0, 1, 2, 3]) out.push([`plan pick ${pick}`, { kind: "plan", slot: SLOT, session: plan, request: 4, firstLine: "Add the session keys and dials to the Stream Deck plugin", choices: PLAN_CHOICES, pick }]);
	out.push(["plan without a file", { kind: "plan", slot: SLOT, session: plan, request: 4, firstLine: null, choices: PLAN_CHOICES, pick: null }]);
	out.push(["in app, question unreadable", { kind: "inApp", slot: SLOT, session: waiting, request: 5, tool: "AskUserQuestion", summary: "Which colour should the test use for the session keys?", why: "unreadable" }]);
	out.push(["in app, question too big", { kind: "inApp", slot: SLOT, session: waiting, request: 5, tool: "AskUserQuestion", summary: "Which colour?", why: "too big" }]);
	out.push(["in app, plan too big", { kind: "inApp", slot: SLOT, session: plan, request: 6, tool: "ExitPlanMode", summary: "Plan ready", why: "too big" }]);
	out.push(["in app, question scrubbed", { kind: "inApp", slot: SLOT, session: waiting, request: 7, tool: "AskUserQuestion", summary: "Red or blue?", why: "scrubbed" }]);
	out.push(["in app, plan scrubbed", { kind: "inApp", slot: SLOT, session: plan, request: 8, tool: "ExitPlanMode", summary: "Plan ready", why: "scrubbed" }]);
	return out;
}

const value = (f: Feedback, key: string): unknown => (f[key] as { value?: unknown } | undefined)?.value;
const strings = (f: Feedback, ...keys: string[]): unknown[] => keys.map((k) => value(f, k));

describe("the Session Slot strip's screens (session-keys.md, The strip)", () => {
	test("every screen fills exactly its layout's keys, with text that fits each item and values of the item's type", () => {
		for (const [what, screen] of screens()) {
			const { layout, feedback } = slotStrip(screen, NOW);
			assert.equal(layout, SLOT_LAYOUTS[screen.kind], what);
			const items = layoutOf(screen.kind).items;
			assert.deepEqual(Object.keys(feedback).sort(), items.map((i) => i.key).sort(), `${what}: exactly the layout's keys`);
			for (const item of items) {
				const got = feedback[item.key] as Record<string, unknown>;
				const where = `${what}: ${item.key}`;
				if (item.type === "text") {
					assert.equal(typeof got.value, "string", where);
					const text = got.value as string;
					assert.ok(text.length <= fits(item.font?.size ?? 0, item.rect[2]), `${where}: ${JSON.stringify(text)} is longer than ${fits(item.font?.size ?? 0, item.rect[2])}`);
					assert.ok(!/\s{2}|\n/.test(text) && text === text.trim(), `${where}: one line, its spaces folded`);
					assert.ok(!text.includes(" …"), `${where}: no space before an ellipsis`);
				} else {
					assert.equal(typeof got.value, "number", where);
					assert.ok(OPACITIES.includes(got.opacity as number), `${where}: opacity`);
				}
				for (const k of ["color", "background", "bar_fill_c"]) if (got[k] !== undefined) assert.match(String(got[k]), HEX, `${where}: ${k}`);
				for (const k of Object.keys(got)) assert.ok(ALLOWED[item.type]?.includes(k), `${where}: ${k}`);
			}
		}
	});

	test("the same screen draws the same strip, so the painter sends nothing when nothing changed", () => {
		for (const [what, screen] of screens()) assert.deepEqual(slotStrip(screen, NOW), slotStrip(screen, NOW), what);
	});

	test("the pages: title and dots, then Now, Context and Setup", () => {
		const all = new Map(screens());
		const strip = (name: string) => slotStrip(all.get(name) as SlotScreen, NOW).feedback;
		const now = strip("pages working 0");
		assert.deepEqual(strings(now, "name", "dots", "line1"), ["Stream Deck plu…", "●○○", "Working: npm test --w…"]);
		assert.equal((now.line1 as { color: string }).color, "#4A9EFF");
		// The summary, wrapped by approximate width over two lines, the second cut.
		assert.deepEqual(strings(now, "line2", "line3"), ["Built the slot strip and", "its layouts, then ran t…"]);
		assert.deepEqual(now.bar, { value: 0, opacity: 0 }, "the bar is the Context page's");
		const ctx = strip("pages working 1");
		assert.deepEqual(strings(ctx, "dots", "line1", "line2", "line3"), ["○●○", "Context 62%", "620k of 1M tokens", "Cost $1.24"]);
		assert.deepEqual(ctx.bar, { value: 62, opacity: 1, bar_fill_c: "#4A9EFF" });
		assert.deepEqual(strip("pages high context 1").bar, { value: 91, opacity: 1, bar_fill_c: "#F2994A" });
		const setup = strip("pages working 2");
		assert.deepEqual(strings(setup, "dots", "line1", "line2", "line3"), ["○○●", "Opus 5.5 · max", "Accept edits mode", "stream-deck-plugins"]);
		// What it waits on, and what the app says it needs while it needs input.
		assert.deepEqual(strings(strip("pages input 0"), "line1", "line2", "line3"), ["Needs you for 30s", "Pick which branch to", "keep before it carries…"]);
		assert.deepEqual(strings(strip("pages done 0"), "line1", "line2", "line3"), ["Done 3m ago", "Wrote the README", ""]);
		// Nothing known yet.
		assert.deepEqual(strings(strip("pages blank 0"), "line1", "line2"), ["Idle", ""]);
		assert.deepEqual(strings(strip("pages blank 1"), "line1", "line2", "line3"), ["Context —", "", ""]);
		assert.deepEqual(strip("pages blank 1").bar, { value: 0, opacity: 0 });
		assert.deepEqual(strings(strip("pages blank 2"), "line1", "line2", "line3"), ["Model —", "Mode —", ""]);
		// A session that isn't running: from its record, dimmed, and a press opens it.
		const off = strip("pages not running 0");
		assert.deepEqual(strings(off, "name", "line1", "line2"), ["Yesterday's ses…", "Not running", "Press to open it"]);
		assert.equal((off.name as { color: string }).color, SLOT_STRIP_COLORS.dim);
		assert.deepEqual(strings(strip("pages not running 2"), "line1", "line2", "line3"), ["Haiku 5.5 · low", "Manual mode", "notes"]);
	});

	test("the Setup page: the mode, then the session's Claude Code version, marked and amber when it's newer than the repo was checked against; none without one (hardening.md, C1)", () => {
		const all = new Map(screens());
		const strip = (name: string) => slotStrip(all.get(name) as SlotScreen, NOW).feedback;
		const { caption, needsYou } = SLOT_STRIP_COLORS;
		assert.deepEqual(strip("pages checked 2").line2, { value: "Auto mode · 2.1.317", color: caption });
		assert.deepEqual(strip("pages newer 2").line2, { value: `Auto mode · 2.1.318 ${NEWER_MARK}`, color: needsYou });
		assert.equal(NEWER_MARK, "↑");
		// The version stays whole on a line too long for it: the word "mode" goes first, then the mode's name is cut.
		assert.deepEqual(strip("pages newer accept edits 2").line2, { value: "Accept edits · 2.1.318 ↑", color: needsYou });
		assert.equal(value(strip("pages checked accept edits 2"), "line2"), "Accept edits · 2.1.317");
		assert.equal(value(strip("pages newer long mode 2"), "line2"), "someFutureM… · 2.1.318 ↑");
		assert.equal(value(strip("pages newer no mode 2"), "line2"), "Mode — · 2.1.318 ↑");
		// The rest of the page is as it was.
		assert.deepEqual(strings(strip("pages newer 2"), "line1", "line3"), ["Opus 5.5 · max", "stream-deck-plugins"]);
		// No version from the session's hello: the mode alone, as before.
		assert.deepEqual(strip("pages working 2").line2, { value: "Accept edits mode", color: caption });
		assert.deepEqual(strip("pages blank 2").line2, { value: "Mode —", color: caption });
		assert.deepEqual(strip("pages not running 2").line2, { value: "Manual mode", color: caption });
		// The other pages send the second line's colour too, so the Setup page's amber doesn't stay on the strip after a turn.
		for (const page of [0, 1]) assert.equal((strip(`pages newer ${page}`).line2 as { color?: string }).color, caption, `page ${page}`);
	});

	test("the Now line for each status", () => {
		const line = (fields: Partial<SessionView>) => nowLine(view({ since: NOW - 4 * 60_000, ...fields }), NOW).value;
		assert.equal(line({ status: "working" }), "Working for 4m");
		assert.equal(line({ status: "working", doing: "notes.md" }), "Working: notes.md");
		assert.equal(line({ status: "failed" }), "Failed 4m ago");
		assert.equal(line({ status: "interrupted" }), "Stopped 4m ago");
		assert.equal(line({ status: "idle" }), "Idle for 4m");
		assert.equal(line({ status: "approval", need: "approval" }), "Approval waiting for 4m");
		assert.equal(line({ status: "needs-you", need: "plan", since: null }), "Plan waiting");
		assert.deepEqual([pageDots(0, 3), pageDots(2, 3), pageDots(0, 0)], ["●○○", "○○●", "●"]);
	});

	test("an approval: Allow <tool>?, its summary on two lines, and the chips, neither picked until a turn", () => {
		const all = new Map(screens());
		const strip = (name: string) => slotStrip(all.get(name) as SlotScreen, NOW).feedback;
		const none = strip("approval pick null");
		assert.deepEqual(strings(none, "head", "since", "line1", "line2"), ["Allow Bash?", "12s", "rm -rf build && npm run", "build && npm test -- --…"]);
		const chips = (f: Feedback) => [f.allow, f.deny];
		const idle = { color: SLOT_STRIP_COLORS.chipText, background: SLOT_STRIP_COLORS.chip };
		assert.deepEqual(chips(none), [{ value: "✓ Allow", ...idle }, { value: "✗ Deny", ...idle }]);
		assert.deepEqual(chips(strip("approval pick 0")), [{ value: "✓ Allow", color: "#FFFFFF", background: SLOT_STRIP_COLORS.yes }, { value: "✗ Deny", ...idle }]);
		assert.deepEqual(chips(strip("approval pick 1")), [{ value: "✓ Allow", ...idle }, { value: "✗ Deny", color: "#FFFFFF", background: SLOT_STRIP_COLORS.no }]);
		assert.equal(value(strip("approval mcp"), "head"), "Allow set sessi…");
	});

	test("a question: header and 1 of 2, the question wrapped on two lines, the place under the cursor with its description, and 2/3", () => {
		const all = new Map(screens());
		const strip = (name: string) => slotStrip(all.get(name) as SlotScreen, NOW).feedback;
		const first = strip("question before a turn");
		assert.deepEqual(strings(first, "head", "since", "q1", "q2"), ["Color", "4m", "Which colour should the", "test use for the sessio…"]);
		assert.deepEqual(strings(first, "opt", "pos", "desc"), ["Turn to pick", "", "Or press to answer in app"]);
		assert.deepEqual(strings(strip("question cursor on an option"), "opt", "pos", "desc"), ["Red", "1/3", "Warm"]);
		assert.equal((strip("question cursor on an option").opt as { background: string }).background, SLOT_STRIP_COLORS.cursor);
		assert.deepEqual(strings(strip("question cursor on an option without a description"), "opt", "desc"), ["Blue", "Press to pick"]);
		assert.deepEqual(strings(strip("question cursor on Other…"), "opt", "pos", "desc"), ["Other…", "3/3", "Press to type it in the app"]);
		// Later questions, or back on a picked one, a press with nothing under the cursor doesn't jump: no hint.
		assert.deepEqual(strings(strip("question 2 of 2, before a turn"), "head", "q1", "opt", "desc"), ["Question · 2 of 2", "Which size?", "Turn to pick", ""]);
		assert.deepEqual(strings(strip("question back on the first, picked"), "head", "desc"), ["Color · 1 of 2", ""]);
		// Multi-select: ticks, then Next or Send, which need a tick.
		assert.deepEqual(strings(strip("question ticked"), "opt", "pos", "desc"), ["✓ Apple", "1/4", "Red or green"]);
		assert.deepEqual(strings(strip("question unticked"), "opt", "desc"), ["Pear, ripe", "Press to tick"]);
		assert.deepEqual(strings(strip("question next ready"), "opt", "desc"), ["Next →", "On to question 2 of 2"]);
		assert.deepEqual(strip("question next not ready").opt, { value: "Next", color: SLOT_STRIP_COLORS.dim, background: SLOT_STRIP_COLORS.chip });
		assert.equal(value(strip("question next not ready"), "desc"), "Tick at least one first");
		assert.deepEqual(strip("question send ready").opt, { value: "Send", color: "#FFFFFF", background: SLOT_STRIP_COLORS.yes });
		assert.deepEqual(strings(strip("question send not ready"), "opt", "desc"), ["Send", "Tick at least one first"]);
	});

	test("a plan: Plan ready, its first line, and its choices as chips in PLAN_CHOICES' order, ✓ approving into a mode and ✗ rejecting", () => {
		const all = new Map(screens());
		const strip = (name: string) => slotStrip(all.get(name) as SlotScreen, NOW).feedback;
		const none = strip("plan pick null");
		assert.deepEqual(strings(none, "head", "since", "line1"), ["Plan ready", "1m", "Add the session keys an…"]);
		assert.deepEqual(strings(none, "c0", "c1", "c2", "c3"), ["✓ Auto", "✓ Accept edits", "✓ Manual", "✗ Reject"]);
		const backgrounds = (f: Feedback) => ["c0", "c1", "c2", "c3"].map((k) => (f[k] as { background: string }).background);
		const { chip, yes, no } = SLOT_STRIP_COLORS;
		assert.deepEqual(backgrounds(none), [chip, chip, chip, chip]);
		assert.deepEqual(backgrounds(strip("plan pick 0")), [yes, chip, chip, chip]);
		assert.deepEqual(backgrounds(strip("plan pick 1")), [chip, yes, chip, chip]);
		assert.deepEqual(backgrounds(strip("plan pick 2")), [chip, chip, yes, chip]);
		assert.deepEqual(backgrounds(strip("plan pick 3")), [chip, chip, chip, no]);
		assert.deepEqual(PLAN_CHOICES.map((c) => c.t === "approve" ? c.mode : c.t), ["auto", "acceptEdits", "default", "reject"], "the chips follow these");
		assert.equal(value(strip("plan without a file"), "line1"), "Press to read it in app");
	});

	test("Answer in app: what it is, why the dial can't answer it, and the chip; an empty slot says how to fill it", () => {
		const all = new Map(screens());
		const strip = (name: string) => slotStrip(all.get(name) as SlotScreen, NOW).feedback;
		assert.deepEqual(strings(strip("in app, question unreadable"), "head", "line1", "line2", "chip"), ["Question", "Which colour should the…", "The deck can't read it", "Answer in app"]);
		assert.deepEqual(strip("in app, question unreadable").chip, { value: "Answer in app", color: "#FFFFFF", background: SLOT_STRIP_COLORS.inApp });
		assert.deepEqual(strings(strip("in app, question too big"), "line1", "line2"), ["Which colour?", "Too long for the deck"]);
		assert.deepEqual(strings(strip("in app, plan too big"), "head", "line1", "line2"), ["Plan ready", "Too long for the deck", ""]);
		assert.deepEqual(strings(strip("in app, question scrubbed"), "head", "line1", "line2", "chip"), ["Question", "Red or blue?", "Holds the deck's token", "Answer in app"]);
		assert.deepEqual(strings(strip("in app, plan scrubbed"), "head", "line1", "line2", "chip"), ["Plan ready", "Holds the deck's token", "", "Answer in app"]);
		assert.deepEqual(strings(slotStrip({ kind: "empty", slot: SLOT }, NOW).feedback, "name", "line1", "line2"), ["No session", "Hold the key above", "to add the one on screen"]);
	});
});

// ---- the strip on a live dial ----

class FakeReply implements PollReply {
	open = true;
	send(): void {
		this.open = false;
	}
	onClose(): void {}
}

function reg(pid: number, host: string, fields: Partial<RegistrySession> = {}): RegistrySession {
	return { key: String(pid), name: `Session ${pid}`, status: "busy", cwd: `/p/${pid}`, hostSessionId: host, sessionId: `sid-${pid}`, statusUpdatedAt: 1000, startedAt: pid, ...fields };
}

/** One slot dial drawn with slotStrip on a fake surface that records the calls in order. */
function liveDial() {
	const clock = new FakeClock();
	let wall = 100_000;
	const model = new SessionModel({ clock, wallNow: () => wall });
	model.setRegistry([reg(1, "local_a")]);
	model.setBridgeState("listening");
	const slot = dialSlotId("dev", 2, 0);
	const slots = new Slots(model, { store: new MemorySlotStore(new Map([[slot, "local_a"]])), clock, fillDelayMs: 0 });
	const calls: string[] = [];
	const sent: Feedback[] = [];
	const jumps: string[] = [];
	let alerts = 0;
	const dials = new SlotDials(slots, model, { render: slotStrip, clock, wallNow: () => wall, open: (h) => jumps.push(h) });
	dials.add("d", slot, {
		setLayout: (layout) => calls.push(`layout ${layout}`),
		setFeedback: (payload) => {
			calls.push(`feedback ${Object.keys(payload).sort().join(",")}`);
			sent.push(payload);
		},
		showAlert: () => alerts++,
	});
	const press = (): void => {
		dials.down("d");
		dials.up("d");
	};
	const ask = (input: unknown): void => {
		void model.permission({ session_id: "sid-1", tool_name: "AskUserQuestion", tool_input: input }, "local_a", new FakeReply());
	};
	return { clock, model, dials, calls, sent, jumps, press, ask, alerts: () => alerts, at: (t: number) => (wall = t) };
}

describe("the Session Slot strip on a live dial (SlotDials with slotStrip)", () => {
	test("the layout goes before the feedback that fills every key, and a turn sends only what changed", () => {
		const { clock, dials, calls } = liveDial();
		const pages = layoutOf("pages").items.map((i) => i.key).sort().join(",");
		assert.deepEqual(calls, ["layout layouts/slot-pages.json", `feedback ${pages}`]);
		clock.advance(500);
		calls.length = 0;
		dials.rotate("d", 1, false);
		clock.advance(COALESCE_MS);
		assert.deepEqual(calls, ["feedback dots,line1"], "the Context page: no layout; the title, the empty lines and the hidden bar stay");
	});

	test("at most about 10 updates a second while turning fast", () => {
		const { clock, dials, calls } = liveDial();
		clock.advance(1000);
		calls.length = 0;
		for (let i = 0; i < 50; i++) {
			dials.rotate("d", 1, false);
			clock.advance(20);
		}
		clock.advance(200);
		assert.ok(calls.length <= 11, `${calls.length} strip updates in a second of turning`);
		assert.ok(calls.length >= 5, "it still keeps up");
	});

	test("a question: its layout before its keys; the hint shows exactly while a press jumps; the since ticks alone", () => {
		const { clock, dials, calls, sent, jumps, press, ask, alerts, at } = liveDial();
		clock.advance(1000);
		calls.length = 0;
		ask({
			questions: [
				{ question: "Red or blue?", header: "Color", options: [{ label: "Red", description: "Warm" }, { label: "Blue", description: "Cool" }], multiSelect: false },
				{ question: "Which size?", header: "Size", options: [{ label: "Small" }, { label: "Large" }], multiSelect: false },
			],
		});
		const question = layoutOf("question").items.map((i) => i.key).sort().join(",");
		assert.deepEqual(calls, ["layout layouts/slot-question.json", `feedback ${question}`]);
		const shown = () => {
			const p = dials.painted("d") as Record<string, { value: unknown }>;
			return [p.head?.value, p.opt?.value, p.desc?.value];
		};
		assert.deepEqual(shown(), ["Color · 1 of 2", "Turn to pick", "Or press to answer in app"]);
		// The hint is right: a press now jumps.
		press();
		assert.deepEqual(jumps, ["local_a"]);
		// Pick Red, which moves to the second question: no hint there, and a press with nothing under the cursor alerts.
		dials.rotate("d", 1, false);
		clock.advance(1100);
		press();
		clock.advance(200);
		assert.deepEqual(shown(), ["Size · 2 of 2", "Turn to pick", ""]);
		press();
		assert.deepEqual([jumps.length, alerts()], [1, 1]);
		// Back on the first, picked: still no hint, and still no jump.
		dials.tap("d", true);
		clock.advance(200);
		assert.deepEqual(shown(), ["Color · 1 of 2", "Turn to pick", ""]);
		press();
		assert.deepEqual([jumps.length, alerts()], [1, 2]);
		// A minute on, only the since changes.
		clock.advance(1000);
		sent.length = 0;
		at(160_000);
		clock.advance(1000);
		assert.deepEqual(sent.map((p) => Object.keys(p)), [["since"]]);
	});
});
