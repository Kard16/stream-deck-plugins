import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import type { PollReply } from "../src/bridge/commands.js";
import { fits } from "../src/keys/art.js";
import { agentPages, agentsHead, MAX_AGENT_PAGES } from "../src/model/format.js";
import { SessionModel, type SessionView, type SideView } from "../src/model/sessions.js";
import type { ThreadAgent, ThreadRun } from "../src/protocol/wire.js";
import type { RegistrySession } from "../src/registry/registry.js";
import { APPROVAL_CHOICES, COALESCE_MS, SlotDials, type SlotScreen } from "../src/slots/dials.js";
import { dialSlotId } from "../src/slots/ids.js";
import { Slots } from "../src/slots/slots.js";
import { MemorySlotStore } from "../src/slots/store.js";
import { DOT_EM, dotsSize, NEWER_MARK, nowLine, pageDots, SLOT_LAYOUTS, SLOT_STRIP_COLORS, SLOT_TEXT, type SlotScreenKind, slotStrip } from "../src/slots/strip.js";
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
	test("one layout per screen kind, each file there, and no stray layout: the Sessions dial's and the question's and plan's went in Phase 9", () => {
		assert.deepEqual(KINDS.sort(), ["approval", "empty", "inApp", "pages"]);
		assert.equal(new Set(Object.values(SLOT_LAYOUTS)).size, KINDS.length);
		// Dotfiles aside: Finder may leave a .DS_Store, which git ignores.
		const files = readdirSync(LAYOUT_DIR).filter((f) => !f.startsWith("."));
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

/** A workflow run as a `threads` event lists it: `review`, 5 of 9 ended, unless the test says otherwise. */
function run(fields: Partial<ThreadRun> = {}): ThreadRun {
	return { run: "wf_1", name: "review", started: 9, finished: 5, failed: 0, open: 3, ...fields };
}

/** `n` workflow agents, `agent 1`…, each on a Grep. */
function agents(n: number): ThreadAgent[] {
	return Array.from({ length: n }, (_, i) => ({ kind: "workflow", desc: `agent ${i + 1}`, doing: `Grep: pattern ${i + 1}` }));
}

/** Sessions with other loops in a turn: a workflow's three, ten with only eight listed, and one subagent. */
const AGENT_SESSIONS = [
	[
		"workflow",
		view({
			title: "Review the diff",
			status: "background",
			since: NOW - 4 * 60_000,
			context: 62,
			threads: {
				running: 3,
				agents: [
					{ kind: "workflow", desc: "logs", doing: "Grep: Device" },
					{ kind: "workflow", desc: "hardware", doing: "" },
					{ kind: "other", desc: "", doing: "WebSearch: U2725QE firmware update for the hub" },
				],
				runs: [run()],
			},
		}),
	],
	["ten", view({ title: "Many agents", status: "background", threads: { running: 10, agents: agents(8), runs: [] } })],
	["subagent", view({ title: "One subagent", status: "working", doing: "notes.md", threads: { running: 1, agents: [{ kind: "subagent", desc: "Explore the tests", doing: "" }], runs: [] } })],
] as const;

function screens(): [string, SlotScreen][] {
	const working = view({ title: "Stream Deck plugins revision for the session keys", status: "working", doing: "npm test --workspace=claude-code/deck", since: NOW - 4 * 60_000, context: 62.4, tokens: 620_000, window: 1_000_000, cost: 1.239, model: "claude-opus-5-5", effort: "max", mode: "acceptEdits", project: "stream-deck-plugins", summary: "Built the slot strip and its layouts, then ran the deck's tests; all 470 passed after one fix to the painter." });
	const done = view({ status: "done", seen: false, since: NOW - 3 * 60_000, summary: "Wrote the README" });
	const blank = view({ status: "idle", since: null, context: null, model: null, effort: null, mode: null });
	const input = view({ status: "needs-you", need: "input", since: NOW - 30_000, needs: "Pick which branch to keep before it carries on with the merge", summary: "Merged two branches" });
	const off = view({ running: false, listed: false, title: "Yesterday's session", model: "claude-haiku-5-5", effort: "low", mode: "default", project: "notes" });
	const high = view({ status: "working", context: 91 });
	const question = view({ status: "needs-you", need: "question", since: NOW - 4 * 60_000 });
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
	// While other loops are in a turn, their Agents pages come after Now (agents-and-wake.md, B2).
	for (const [name, s] of AGENT_SESSIONS) {
		const pages = 3 + agentPages(s.threads).length;
		for (let page = 0; page < pages; page++) out.push([`pages ${name} ${page}`, { kind: "pages", slot: SLOT, session: s, page, pages }]);
	}
	for (const pick of [null, 0, 1]) out.push([`approval pick ${pick}`, { kind: "approval", slot: SLOT, session: approve, request: 1, tool: "Bash", summary: "rm -rf build && npm run build && npm test -- --test-name-pattern=slot", choices: APPROVAL_CHOICES, pick }]);
	out.push(["approval mcp", { kind: "approval", slot: SLOT, session: approve, request: 1, tool: "mcp__ccd_session_mgmt__set_session_permission_mode", summary: "set session permission mode", choices: APPROVAL_CHOICES, pick: null }]);
	out.push(["in app, question", { kind: "inApp", slot: SLOT, session: question, request: 5, tool: "AskUserQuestion", summary: "Which colour should the test use for th…" }]);
	out.push(["in app, short question", { kind: "inApp", slot: SLOT, session: question, request: 6, tool: "AskUserQuestion", summary: "Red or blue?" }]);
	out.push(["in app, plan", { kind: "inApp", slot: SLOT, session: plan, request: 7, tool: "ExitPlanMode", summary: "Plan ready" }]);
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
		assert.deepEqual(strings(now, "name", "dots", "line1"), ["Stream Deck p…", "●○○", "Working: npm test --w…"]);
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
		assert.deepEqual(strings(off, "name", "line1", "line2"), ["Yesterday's s…", "Not running", "Press to open it"]);
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

	test("the page dots fit their item at any count of pages, measured as the app's font draws ● and ○ (SF at weight 700, about 0.95 em each, with its tracking): smaller type than the layout's only when six or five would overflow it", () => {
		const item = layoutOf("pages").items.find((i) => i.key === "dots");
		const [width, size] = SLOT_TEXT.pages.dots;
		assert.deepEqual([width, size, item?.font?.weight], [item?.rect[2], item?.font?.size, 700]);
		assert.ok(DOT_EM >= 0.972, "at least SF's ○ at weight 700, the widest of the Mac's fonts, with SF's tracking");
		const most = 3 + MAX_AGENT_PAGES;
		for (let pages = 1; pages <= most; pages++) {
			const px = dotsSize(pages);
			assert.ok(pages * DOT_EM * px <= width, `${pages} dots at ${px} px take ${(pages * DOT_EM * px).toFixed(1)} px of ${width}`);
			assert.ok(px >= 8 && px <= size, `${pages} dots at ${px} px`);
		}
		assert.deepEqual(Array.from({ length: most }, (_, i) => dotsSize(i + 1)), [12, 12, 12, 12, 10, 8]);
		// The strip sends that size with the dots, and the layout's weight.
		const s = view({ status: "background", threads: { running: 10, agents: agents(8), runs: [] } });
		for (const [pages, px] of [[6, 8], [3, 12]] as const) {
			const dots = slotStrip({ kind: "pages", slot: SLOT, session: s, page: 0, pages }, NOW).feedback.dots;
			assert.deepEqual(dots, { value: pageDots(0, pages), font: { size: px, weight: 700 } }, `${pages} pages`);
		}
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

	test("the Now line while other loops are in a turn: Background or Working with the run in a turn or how many agents, as the key; working's tool only without them (agents-and-wake.md, B2)", () => {
		const line = (fields: Partial<SessionView>) => nowLine(view({ since: NOW - 4 * 60_000, ...fields }), NOW);
		const loops = (running: number, runs: ThreadRun[] = []) => ({ running, agents: [], runs });
		assert.deepEqual(line({ status: "background", threads: loops(3, [run()]) }), { value: "Background: review 5/9", color: "#4A9EFF" });
		assert.equal(line({ status: "background", threads: loops(3) }).value, "Background: 3 agents");
		assert.equal(line({ status: "background", threads: loops(1) }).value, "Background: 1 agent");
		assert.deepEqual(line({ status: "working", threads: loops(2, [run()]), doing: "npm test" }), { value: "Working: review 5/9", color: "#4A9EFF" });
		assert.equal(line({ status: "working", threads: loops(2), doing: "npm test" }).value, "Working: 2 agents");
		assert.equal(line({ status: "working", threads: loops(0, [run({ open: 0 })]), doing: "npm test" }).value, "Working: npm test");
		assert.equal(line({ status: "background" }).value, "Background for 4m", "no picture to say why");
		// A long run name is cut to the line, its counts whole.
		assert.equal(line({ status: "background", threads: loops(3, [run({ name: "agents-and-wake-review" })]) }).value, "Background: agent… 5/9");
	});

	test("the Agents pages: after Now while other loops are in a turn, the run in a turn or how many in the accent colour, then two agents a page; the last of up to three ends +n more; Context and Setup follow; the dots count every page", () => {
		const all = new Map(screens());
		const strip = (name: string) => slotStrip(all.get(name) as SlotScreen, NOW).feedback;
		const first = strip("pages workflow 1");
		assert.deepEqual(strings(first, "dots", "line1", "line2", "line3"), ["○●○○○", "review · 5/9 done", "● logs: Grep: Device", "● hardware"]);
		assert.equal((first.line1 as { color: string }).color, SLOT_STRIP_COLORS.accent);
		assert.equal((first.line2 as { color: string }).color, SLOT_STRIP_COLORS.caption, "the second line's colour goes on every page");
		assert.deepEqual(first.bar, { value: 0, opacity: 0 });
		// No description: the kind; the doing cut to the line.
		assert.deepEqual(strings(strip("pages workflow 2"), "dots", "line1", "line2", "line3"), ["○○●○○", "review · 5/9 done", "● other: WebSearch: U27…", ""]);
		assert.deepEqual(strings(strip("pages workflow 3"), "dots", "line1"), ["○○○●○", "Context 62%"]);
		assert.deepEqual(strings(strip("pages workflow 4"), "dots"), ["○○○○●"]);
		assert.deepEqual(strings(strip("pages workflow 0"), "dots", "line1"), ["●○○○○", "Background: review 5/9"]);
		// Ten running, eight listed: three pages, the last line counting the five that don't fit.
		assert.equal(agentPages(AGENT_SESSIONS[1][1].threads).length, 3);
		assert.deepEqual(strings(strip("pages ten 1"), "dots", "line1", "line2", "line3"), ["○●○○○○", "10 agents running", "● agent 1: Grep: patter…", "● agent 2: Grep: patter…"]);
		assert.deepEqual(strings(strip("pages ten 3"), "dots", "line2", "line3"), ["○○○●○○", "● agent 5: Grep: patter…", "+5 more"]);
		assert.deepEqual(strings(strip("pages ten 4"), "line1"), ["Context —"]);
		assert.deepEqual(strings(strip("pages subagent 1"), "dots", "line1", "line2", "line3"), ["○●○○", "1 agent running", "● Explore the tests", ""]);
		assert.deepEqual(strings(strip("pages subagent 0"), "line1"), ["Working: 1 agent"]);
		// A long run name is cut, its counts whole.
		const long = view({ status: "background", threads: { running: 2, agents: agents(2), runs: [run({ name: "agents-and-wake-review" })] } });
		assert.equal(value(slotStrip({ kind: "pages", slot: SLOT, session: long, page: 1, pages: 4 }, NOW).feedback, "line1"), "agents-and… · 5/9 done");
	});

	test("a session's unfinished threads (PROTOCOL.md's 2026-11-08 amendment): Background: 2 threads on Now, then an Agents page listing each, what it waits on before its title; after its own agents; dials count the pages", () => {
		const thread = (i: number, fields: Partial<SideView> = {}): SideView => ({ key: `local_t${i}`, title: `Thread ${i}`, status: "working", need: null, startedAt: i, ...fields });
		const lighting = [thread(1, { title: "Doc 40 T1: the lamp behind the film" }), thread(2, { title: "Doc 40 T2: the safelight", status: "approval", need: "approval" })];
		const s = view({ status: "background", since: NOW - 240_000, sideSessions: lighting });
		assert.deepEqual(nowLine(s, NOW), { value: "Background: 2 threads", color: "#4A9EFF" });
		assert.deepEqual(agentPages(null, lighting), [["● Doc 40 T1: the lamp behind the film", "● Approve? Doc 40 T2: the safelight"]]);
		const page = slotStrip({ kind: "pages", slot: SLOT, session: s, page: 1, pages: 4 }, NOW).feedback;
		assert.deepEqual(strings(page, "dots", "line1", "line2", "line3"), ["○●○○", "2 threads", "● Doc 40 T1: the lamp b…", "● Approve? Doc 40 T2: t…"]);
		assert.equal((page.line1 as { color: string }).color, SLOT_STRIP_COLORS.accent);
		assert.deepEqual(strings(slotStrip({ kind: "pages", slot: SLOT, session: s, page: 2, pages: 4 }, NOW).feedback, "line1"), ["Context —"]);
		// The first line with its own agents too, which the pages list first; a needs-you thread; +n more past three pages.
		assert.deepEqual(agentsHead(null, lighting), { text: "2 threads", keep: 0 });
		assert.deepEqual(agentsHead({ running: 1, agents: [], runs: [] }, [thread(1)]), { text: "1 agent, 1 thread", keep: 0 });
		assert.deepEqual(agentsHead({ running: 0, agents: [], runs: [] }, [thread(1)]), { text: "1 thread", keep: 0 });
		assert.deepEqual(agentsHead({ running: 3, agents: [], runs: [run()] }, [thread(1)]), { text: "review · 5/9 done", keep: 11 }, "a run in a turn first");
		assert.deepEqual(agentPages({ running: 1, agents: agents(1), runs: [] }, [thread(1, { status: "needs-you", need: "input" })]), [["● agent 1: Grep: pattern 1", "● Needs you Thread 1"]]);
		const many = agentPages({ running: 4, agents: agents(4), runs: [] }, [thread(1), thread(2), thread(3)]);
		assert.equal(many.length, MAX_AGENT_PAGES);
		assert.deepEqual(many[2], ["● Thread 1", "+2 more"]);
		assert.deepEqual(agentPages({ running: 0, agents: [], runs: [] }, []), []);
	});

	test("which agents the pages list (format.ts's agentPages): two a page, up to three pages, +n more for those running beyond what fits or what the snapshot lists; none while none is in a turn", () => {
		const of = (running: number, listed: number) => agentPages({ running, agents: agents(listed), runs: [] }).map((p) => p.map((l) => l.replace(/: Grep: pattern \d+$/, "")));
		assert.deepEqual(of(0, 2), [], "none in a turn");
		assert.deepEqual(of(1, 1), [["● agent 1"]]);
		assert.deepEqual(of(6, 6), [["● agent 1", "● agent 2"], ["● agent 3", "● agent 4"], ["● agent 5", "● agent 6"]]);
		assert.deepEqual(of(7, 7), [["● agent 1", "● agent 2"], ["● agent 3", "● agent 4"], ["● agent 5", "+2 more"]]);
		assert.deepEqual(of(4, 3), [["● agent 1", "● agent 2"], ["● agent 3", "+1 more"]], "running counts one the snapshot didn't list");
		assert.deepEqual(of(2, 0), [["+2 more"]]);
		assert.equal(agentPages(null).length, 0);
		// The first line (agents-and-wake.md, B2): `<name> · <finished>/<started> done`, or with the failures in place of
		// `done`; the counts are kept whole, and the name is cut.
		assert.deepEqual(agentsHead({ running: 3, agents: [], runs: [run()] }), { text: "review · 5/9 done", keep: 11 });
		assert.deepEqual(agentsHead({ running: 1, agents: [], runs: [run({ failed: 1 })] }), { text: "review · 5/9, 1 failed", keep: 16 });
		assert.deepEqual(agentsHead({ running: 1, agents: [], runs: [run({ name: "agents-and-wake-review", started: 12, finished: 10, failed: 2 })] }), { text: "agents-and-wake-review · 10/12, 2 failed", keep: 18 });
		assert.deepEqual(agentsHead({ running: 2, agents: [], runs: [run({ open: 0 })] }), { text: "2 agents running", keep: 0 }, "no run in a turn");
		assert.deepEqual(agentsHead({ running: 1, agents: [], runs: [] }), { text: "1 agent running", keep: 0 });
		// On the strip's line, of about 22 characters: a failure fits whole, and a long name is cut, never the counts.
		const head = (r: ThreadRun) => value(slotStrip({ kind: "pages", slot: SLOT, session: view({ status: "background", threads: { running: 1, agents: agents(1), runs: [r] } }), page: 1, pages: 4 }, NOW).feedback, "line1");
		assert.equal(head(run({ failed: 1 })), "review · 5/9, 1 failed");
		assert.equal(head(run({ name: "agents-and-wake-review", started: 12, finished: 10, failed: 2 })), "age… · 10/12, 2 failed");
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

	test("Answer in app: the key's Question or Plan, the summary on up to two lines, and the chip; an empty slot says how to fill it", () => {
		const all = new Map(screens());
		const strip = (name: string) => slotStrip(all.get(name) as SlotScreen, NOW).feedback;
		const chip = { value: "Answer in app", color: "#FFFFFF", background: SLOT_STRIP_COLORS.inApp };
		const question = strip("in app, question");
		// A summary is at most 40 characters (PROTOCOL.md, Fingerprints and summaries), so two lines hold it.
		assert.deepEqual(strings(question, "head", "since", "line1", "line2"), ["Question", "4m", "Which colour should the", "test use for th…"]);
		assert.deepEqual(question.chip, chip);
		assert.deepEqual(strings(strip("in app, short question"), "head", "line1", "line2"), ["Question", "Red or blue?", ""]);
		const plan = strip("in app, plan");
		assert.deepEqual(strings(plan, "head", "since", "line1", "line2"), ["Plan", "1m", "Plan ready", ""]);
		assert.deepEqual(plan.chip, chip);
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

	test("a question: Answer in app's layout before its keys; a turn changes nothing, a press jumps, and the since ticks alone", () => {
		const { clock, dials, calls, sent, jumps, press, ask, alerts, at } = liveDial();
		clock.advance(1000);
		calls.length = 0;
		ask({ questions: [{ question: "Red or blue?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }] });
		const inApp = layoutOf("inApp").items.map((i) => i.key).sort().join(",");
		assert.deepEqual(calls, ["layout layouts/slot-inapp.json", `feedback ${inApp}`]);
		const shown = () => {
			const p = dials.painted("d") as Record<string, { value: unknown }>;
			return [p.head?.value, p.line1?.value, p.chip?.value];
		};
		assert.deepEqual(shown(), ["Question", "Red or blue?", "Answer in app"]);
		calls.length = 0;
		dials.rotate("d", 1, false);
		clock.advance(1000);
		assert.deepEqual(calls, [], "a turn changes nothing on the strip");
		press();
		assert.deepEqual([jumps, alerts()], [["local_a"], 0]);
		// A minute on, only the since changes.
		clock.advance(1000);
		sent.length = 0;
		at(160_000);
		clock.advance(1000);
		assert.deepEqual(sent.map((p) => Object.keys(p)), [["since"]]);
	});
});
