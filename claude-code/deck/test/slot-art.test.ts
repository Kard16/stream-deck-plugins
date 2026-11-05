import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PollReply } from "../src/bridge/commands.js";
import { clip, fits, type OthersFace, othersKeySvg, type SlotFace, slotKeySvg, slotToneBackground, type SlotTone } from "../src/keys/art.js";
import { SessionModel, type SessionView } from "../src/model/sessions.js";
import type { RegistrySession } from "../src/registry/registry.js";
import { heldToolOf, NEED_WORDS, othersArt, othersFace, slotFace, slotKeyArt, toolName } from "../src/slots/art.js";
import { slotId } from "../src/slots/ids.js";
import { SlotKeys } from "../src/slots/keys.js";
import { OthersKeys, othersLook } from "../src/slots/others.js";
import { Slots } from "../src/slots/slots.js";
import { MemorySlotStore } from "../src/slots/store.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { view } from "./helpers/views.js";

const NOW = 1_000_000;
const look = (session: SessionView | null) => ({ slot: "dev:1:0", session, now: NOW });

/** A text element of an SVG: where it sits, how it's anchored, its size, colour and content (XML entities decoded). */
type SvgText = { x: number; y: number; anchor: string; size: number; weight: number; fill: string; text: string };

function texts(svg: string): SvgText[] {
	const out: SvgText[] = [];
	for (const m of svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="(\w+)" font-family="[^"]*" font-size="(\d+)" font-weight="(\d+)" fill="([^"]+)">([^<]*)<\/text>/g)) {
		const decoded = (m[7] ?? "").replace(/&lt;|&gt;|&amp;|&quot;|&apos;/g, (e) => ({ "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" })[e] ?? e);
		out.push({ x: Number(m[1]), y: Number(m[2]), anchor: m[3] ?? "", size: Number(m[4]), weight: Number(m[5]), fill: m[6] ?? "", text: decoded });
	}
	return out;
}

/** The key's background: the first rect, the full 144 square. */
function background(svg: string): string | null {
	return /<rect width="144" height="144" rx="26" fill="([^"]+)"\/>/.exec(svg)?.[1] ?? null;
}

/** The context bar's fill width, of 116; null with no fill drawn; undefined with no bar at all. */
function barFill(svg: string): { width: number; fill: string } | null | undefined {
	const rects = [...svg.matchAll(/<rect x="14" y="126" width="(\d+)" height="5" rx="2.5" fill="([^"]+)"\/>/g)];
	if (rects.length === 0) return undefined;
	const fill = rects[1];
	return fill === undefined ? null : { width: Number(fill[1]), fill: fill[2] ?? "" };
}

/** On a line with a word on the left and a value on the right, the two stay at least 6 units apart, by the measure. */
function assertApart(svg: string, y: number, what: string): void {
	const row = texts(svg).filter((t) => t.y === y);
	const left = row.find((t) => t.anchor === "start");
	const right = row.find((t) => t.anchor === "end");
	if (!left || !right) return;
	const leftEnd = left.x + left.text.length * left.size * 0.54;
	const rightStart = right.x - right.text.length * right.size * 0.54;
	assert.ok(rightStart - leftEnd >= 6, `${what}: ${JSON.stringify(left.text)} runs to ${leftEnd.toFixed(1)}, ${JSON.stringify(right.text)} starts at ${rightStart.toFixed(1)}`);
}

const OUTLINE = '<rect x="3" y="3" width="138" height="138" rx="23" fill="none" stroke="#F2C94C" stroke-width="5"/>';
const AMBER = slotToneBackground("need");

/**
 * Every text sits inside the key, by the measure the art cuts with (fits: about 0.54 em a character): from x 6 to 138,
 * clear of the amber outline's 5 units.
 */
function assertInside(svg: string, what: string): void {
	for (const t of texts(svg)) {
		const w = t.text.length * t.size * 0.54;
		const [left, right] = t.anchor === "start" ? [t.x, t.x + w] : t.anchor === "end" ? [t.x - w, t.x] : [t.x - w / 2, t.x + w / 2];
		assert.ok(left >= 6 && right <= 138, `${what}: ${JSON.stringify(t.text)} at ${t.size}px runs from ${left.toFixed(1)} to ${right.toFixed(1)}`);
		assert.ok(t.y > 14 && t.y < 140, `${what}: ${JSON.stringify(t.text)} at y ${t.y}`);
	}
}

describe("the Session Slot key's face, from its session (session-keys.md, The key face)", () => {
	test("each state's tone, word and lines, as the spec's table has them", () => {
		const cases: [string, SessionView | null, Partial<SlotFace>][] = [
			["empty slot", null, { tone: "empty", word: "No session", title: null, since: null, context: null }],
			["not running", view({ running: false, listed: false, since: NOW - 60_000, context: 40 }), { tone: "notRunning", word: "Not running", title: "Fix the build", since: null, tool: null, context: null }],
			["question", view({ status: "needs-you", need: "question", since: NOW - 4 * 60_000, context: 62 }), { tone: "need", word: "Question", since: "4m", tool: null, context: 62 }],
			["plan", view({ status: "needs-you", need: "plan", since: NOW - 30_000 }), { tone: "need", word: "Plan", since: "30s", tool: null }],
			["needs input", view({ status: "needs-you", need: "input", since: NOW - 2 * 3_600_000 }), { tone: "need", word: "Needs you", since: "2h", tool: null }],
			["working", view({ status: "working", doing: "npm test", since: NOW - 3 * 86_400_000, context: 47.6 }), { tone: "working", word: "Working", since: "3d", tool: "npm test", context: 48 }],
			["done, not seen", view({ status: "done", seen: false, since: NOW - 30_000 }), { tone: "done", word: "Done", since: "30s", tool: null }],
			["failed, not seen", view({ status: "failed", seen: false }), { tone: "failed", word: "Failed" }],
			["interrupted, not seen", view({ status: "interrupted", seen: false }), { tone: "stopped", word: "Stopped" }],
			["done, seen", view({ status: "done", seen: true }), { tone: "quiet", word: "Done" }],
			["failed, seen", view({ status: "failed", seen: true }), { tone: "quiet", word: "Failed" }],
			["interrupted, seen", view({ status: "interrupted", seen: true }), { tone: "quiet", word: "Stopped" }],
			["idle", view({ status: "idle", seen: true, since: NOW - 5 * 60_000 }), { tone: "quiet", word: "Idle", since: "5m" }],
			// After a deck restart: idle, active since it was last on screen, and no turn end seen.
			["idle, its activity not seen", view({ status: "idle", seen: false }), { tone: "done", word: "Done" }],
		];
		for (const [what, session, want] of cases) {
			const face = slotFace(look(session));
			for (const [k, v] of Object.entries(want)) assert.deepEqual(face[k as keyof SlotFace], v, `${what}: ${k}`);
		}
	});

	test("an approval's bottom line is the held request's tool, an MCP tool by its own name; without one, what it's on", () => {
		const s = view({ status: "approval", need: "approval", doing: "s4.txt" });
		assert.deepEqual(slotFace(look(s), (host) => (host === "local_a" ? "Write" : null)).tool, "Write");
		assert.equal(slotFace(look(s), () => "mcp__ccd_session_mgmt__set_session_permission_mode").tool, "set session permission mode");
		assert.equal(slotFace(look(s)).tool, "s4.txt");
		assert.equal(slotFace(look(s)).word, "Approve?");
		assert.equal(toolName("Bash"), "Bash");
		assert.equal(toolName("mcp__server__"), "mcp__server__");
	});

	test("the context is a whole percent from 0 to 100; unknown is none", () => {
		const ctx = (context: number | null) => slotFace(look(view({ status: "working", context }))).context;
		assert.deepEqual([ctx(0.4), ctx(99.5), ctx(150), ctx(-3), ctx(null), ctx(Number.NaN)], [0, 100, 100, 0, null, null]);
	});

	test("only the states that need you are amber, with the light outline", () => {
		const tones: SlotTone[] = ["need", "working", "done", "failed", "stopped", "quiet", "notRunning", "empty"];
		const bgs = new Set<string>();
		for (const tone of tones) {
			const svg = slotKeySvg({ tone, word: "Word", since: "4m", title: "A title", tool: "tool", context: 50 });
			const amber = tone === "need";
			assert.equal(background(svg), slotToneBackground(tone), tone);
			assert.equal(background(svg) === AMBER, amber, `${tone}: amber only when it needs you`);
			assert.equal(svg.includes(OUTLINE), amber, `${tone}: the outline only when it needs you`);
			bgs.add(slotToneBackground(tone));
		}
		// Each tone has its own colour, except the two darker ones, told apart by their text.
		assert.equal(bgs.size, tones.length - 1);
		assert.equal(slotToneBackground("notRunning"), slotToneBackground("empty"));
		assert.equal(slotToneBackground("quiet"), "#1F2430", "seen and idle are the dark #1F2430");
	});

	test("the top line has the word and since; the title sits in the middle on up to two lines, cut with …; the bottom has the tool and the %, over the bar", () => {
		const svg = slotKeySvg({ tone: "working", word: "Working", since: "4m", title: "Stream Deck plugins revision for the session keys", tool: "npm test --workspace=claude-code/deck", context: 47 });
		const t = texts(svg);
		const at = (y: number) => t.filter((x) => x.y === y).map((x) => x.text);
		assert.deepEqual(at(34), ["Working", "4m"]);
		const title = t.filter((x) => x.y > 40 && x.y < 100);
		assert.equal(title.length, 2, "two lines");
		assert.ok(title[1]?.text.endsWith("…"), `the second line is cut: ${title[1]?.text}`);
		assert.ok(title.every((x) => x.anchor === "middle" && x.x === 72), "in the middle");
		const bottom = at(117);
		assert.equal(bottom.length, 2);
		assert.ok(bottom[0]?.startsWith("npm test") && bottom[0].endsWith("…") && !bottom[0].includes(" …"), `the tool, cut clear of the %: ${bottom[0]}`);
		assert.equal(bottom[1], "47%");
		assert.deepEqual(barFill(svg), { width: Math.round((116 * 47) / 100), fill: "#FFFFFF" });
		assertInside(svg, "working");
		assertApart(svg, 117, "working");
		// One short title is one line, a little lower.
		const one = texts(slotKeySvg({ tone: "done", word: "Done", since: null, title: "Build", tool: null, context: null })).filter((x) => x.y > 40 && x.y < 100);
		assert.deepEqual(one.map((x) => [x.text, x.y]), [["Build", 78]]);
	});

	test("the bar turns orange from 80%, has no fill at 0%, and isn't drawn when the context is unknown", () => {
		const bar = (context: number | null, tone: SlotTone = "done") => barFill(slotKeySvg({ tone, word: "Done", since: null, title: "T", tool: null, context }));
		assert.equal(bar(79)?.fill, "#FFFFFF");
		assert.equal(bar(80)?.fill, "#F2994A");
		assert.deepEqual(bar(100), { width: 116, fill: "#F2994A" });
		assert.equal(bar(0), null, "the groove alone");
		assert.equal(bar(null), undefined, "no bar");
		assert.equal(bar(85, "quiet")?.fill, "#9C6A3C", "dimmed on a seen key");
		assert.ok(!slotKeySvg({ tone: "done", word: "Done", since: null, title: "T", tool: null, context: null }).includes("%<"), "no % either");
	});

	test("not running: the word and the title, dimmed, with no bottom line; an empty slot says how to fill it", () => {
		const off = slotKeySvg(slotFace(look(view({ running: false, listed: false, title: "Old session from yesterday" }))));
		const t = texts(off);
		assert.deepEqual(t[0], { x: 14, y: 34, anchor: "start", size: 17, weight: 700, fill: "#4B515C", text: "Not running" });
		assert.ok(t.slice(1).every((x) => x.y < 100 && x.fill === "#6A707A"), "only the title, dimmed");
		assert.equal(barFill(off), undefined);
		const empty = slotKeySvg(slotFace(look(null)));
		assert.deepEqual(
			texts(empty).map((x) => x.text),
			["No session", "Hold to add the", "one on screen"],
		);
		assertInside(empty, "empty");
		assertInside(off, "not running");
	});

	test("text that fits: every line of every state stays inside the key, long words and titles included, and is escaped", () => {
		const long = "Supercalifragilisticexpialidocious-and-a-path/that/goes/on/and/on";
		const sessions: SessionView[] = [
			view({ status: "needs-you", need: "question", since: NOW - 999 * 86_400_000, title: long, context: 100 }),
			view({ status: "approval", need: "approval", title: `${long} <&> "quotes"`, since: NOW - 59_000, context: 99 }),
			view({ status: "needs-you", need: "input", since: NOW - 23 * 3_600_000, title: "A B C D E F G H I J K L M N O P Q R S T U V W X Y Z" }),
			view({ status: "working", doing: long, since: NOW, context: 100 }),
			view({ status: "interrupted", seen: false, since: NOW - 3_000_000, title: "x" }),
			view({ running: false, title: long }),
		];
		for (const s of sessions) {
			const svg = slotKeySvg(slotFace(look(s), () => long));
			assertInside(svg, s.title);
			assertApart(svg, 34, `${s.title}: the top line`);
			assertApart(svg, 117, `${s.title}: the bottom line`);
			assert.ok(!/<text[^>]*>[^<]*[<>"][^<]*<\/text>/.test(svg.replace(/&lt;|&gt;|&quot;|&amp;|&apos;/g, "")), "no raw markup inside a text");
		}
		const escaped = slotKeySvg(slotFace(look(view({ title: 'a <b> & "c"' }))));
		assert.ok(escaped.includes("a &lt;b&gt; &amp; &quot;c&quot;"));
	});

	test("the cut leaves no space before its ellipsis, wherever it falls", () => {
		assert.equal(clip("Fix the build now", 9), "Fix the…", "a cut right after a space");
		assert.equal(clip("Fix the build now", 10), "Fix the b…");
		assert.equal(clip("Fix the …", 20), "Fix the…", "wrap()'s last line, cut with a space before its ellipsis");
		assert.equal(clip("Short", 20), "Short");
		// The bottom line beside "5%" holds 10 characters, so "npm test lint" is cut after "npm test ".
		assert.equal(texts(slotKeySvg({ tone: "working", word: "Working", since: "4m", title: "T", tool: "npm test lint", context: 5 })).find((t) => t.y === 117)?.text, "npm test…");
	});

	test("the words for what a session waits on", () => {
		assert.deepEqual(NEED_WORDS, { question: "Question", plan: "Plan", approval: "Approve?", input: "Needs you" });
		// fits(), the shared measure, is about 0.54 em a character.
		assert.equal(fits(18, 120), 12);
	});
});

describe("the Others key's face (session-keys.md, Others)", () => {
	test("with some needing you: amber with the outline, how many, the title, what it waits on and its since, and the unseen in small type", () => {
		const face: OthersFace = othersFace({ needing: 2, oldest: view({ title: "Deck test T6", need: "plan", since: NOW - 4 * 60_000 }), unseen: 1, running: 5, others: 2, now: NOW });
		assert.deepEqual(face, { needing: 2, oldest: { title: "Deck test T6", word: "Plan", since: "4m" }, unseen: 1, running: 5 });
		const svg = othersKeySvg(face);
		assert.equal(background(svg), AMBER);
		assert.ok(svg.includes(OUTLINE));
		assert.deepEqual(
			texts(svg).map((t) => t.text),
			["2 need you", "Deck test T6", "Plan", "4m", "1 done, not seen"],
		);
		assert.equal(texts(othersKeySvg({ ...face, needing: 1, unseen: 0 }))[0]?.text, "1 needs you");
		assert.ok(!texts(othersKeySvg({ ...face, unseen: 0 })).some((t) => t.text.includes("not seen")));
		assertInside(svg, "others lit");
	});

	test("with none needing you: dim, how many others are running, and the unseen", () => {
		const dim = othersKeySvg(othersFace({ needing: 0, oldest: null, unseen: 2, running: 3, others: 1, now: NOW }));
		assert.notEqual(background(dim), AMBER);
		assert.ok(!dim.includes(OUTLINE));
		assert.deepEqual(
			texts(dim).map((t) => t.text),
			["Others", "3 running", "2 done, not seen"],
		);
		assert.deepEqual(
			texts(othersKeySvg({ needing: 0, oldest: null, unseen: 0, running: 0 })).map((t) => t.text),
			["Others", "No others"],
		);
		assertInside(dim, "others dim");
	});
});

describe("the faces on live keys, through the core's SlotKeys and OthersKeys", () => {
	class Reply implements PollReply {
		open = true;
		send(): void {
			this.open = false;
		}
		onClose(): void {}
	}

	function reg(pid: number, host: string, fields: Partial<RegistrySession> = {}): RegistrySession {
		return { key: String(pid), name: `Session ${pid}`, status: "busy", cwd: `/p/${pid}`, hostSessionId: host, sessionId: `sid-${pid}`, statusUpdatedAt: 1000, startedAt: pid, ...fields };
	}

	test("a held Bash request turns its slot key amber, Approve?, with Bash on the bottom line: the plugin's heldTool reads the model's held requests", () => {
		const clock = new FakeClock();
		const model = new SessionModel({ clock, wallNow: () => 5000 });
		model.setRegistry([reg(1, "local_a"), reg(2, "local_b")]);
		const slot = slotId("dev", 1, 0);
		const slots = new Slots(model, { store: new MemorySlotStore(new Map([[slot, "local_a"]])), clock, fillDelayMs: 0 });
		const keys = new SlotKeys(slots, model, { art: slotKeyArt({ heldTool: heldToolOf(model) }), clock, wallNow: () => 5000, paintIntervalMs: 0 });
		const images: string[] = [];
		keys.add("k", slot, { setImage: (svg) => images.push(svg), showOk: () => {}, showAlert: () => {} });
		assert.equal(texts(images.at(-1) ?? "")[0]?.text, "Working");
		model.permission({ session_id: "sid-1", tool_name: "Bash", tool_input: { command: "npm test" } }, "local_a", new Reply());
		const svg = keys.painted("k") ?? "";
		assert.equal(background(svg), AMBER);
		assert.deepEqual(
			texts(svg)
				.filter((t) => t.y === 34 || t.y === 117)
				.map((t) => t.text),
			["Approve?", "0s", "Bash"],
		);
		const others = new OthersKeys(slots, model, { art: othersArt, clock, wallNow: () => 5000, paintIntervalMs: 0 });
		const otherImages: string[] = [];
		others.add("o", { setImage: (s) => otherImages.push(s), showOk: () => {}, showAlert: () => {} });
		assert.deepEqual(
			texts(otherImages.at(-1) ?? "").map((t) => t.text),
			["Others", "1 running"],
		);
		assert.deepEqual(othersLook(model.sessions(), slots.slotted(), 5000).running, 1);
	});
});
