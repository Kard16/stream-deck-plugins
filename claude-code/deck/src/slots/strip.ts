import { CONTEXT_HIGH, clip, clipKeep, fits, wrap } from "../keys/art.js";
import { agentPages, agentsHead, costText, ENDED_COLOR, type Label, modeName, modelAndEffort, sinceText, STATUS_COLORS, tokensText, workLabel } from "../model/format.js";
import { askNeed, type SessionView } from "../model/sessions.js";
import type { Feedback } from "../util/painter.js";
import { contextPercent, NEED_WORDS, toolName } from "./art.js";
import type { SlotScreen, SlotStripRender } from "./dials.js";

/**
 * The Session Slot dials' strips (session-keys.md, The strip): one layout per screen kind, under the plugin's
 * layouts/, which the dial switches with setFeedbackLayout. Text and bar items only, as the other strips; a chip is a
 * text item with a `background`. Every layout key is ours, never the app's `title` or `icon`. Plain functions, no SDK:
 * the dial's StripPainter sends only the keys that change, at most 10 times a second.
 */

export type SlotScreenKind = SlotScreen["kind"];

/** Each screen kind's layout, as setFeedbackLayout takes it: a path inside the plugin folder. */
export const SLOT_LAYOUTS = {
	empty: "layouts/slot-empty.json",
	pages: "layouts/slot-pages.json",
	approval: "layouts/slot-approval.json",
	inApp: "layouts/slot-inapp.json",
} as const satisfies Record<SlotScreenKind, string>;

/**
 * Each layout's text items: the width their text is cut to and the font size, from the layout files' `rect` and
 * `font` (the tests hold the two together). A chip's text is cut a little inside its rect, clear of the edges.
 */
export const SLOT_TEXT = {
	empty: { name: [184, 18], line1: [184, 14], line2: [184, 14] },
	pages: { name: [130, 17], dots: [52, 12], line1: [184, 15], line2: [184, 14], line3: [184, 14] },
	approval: { head: [148, 17], since: [34, 13], line1: [184, 14], line2: [184, 14], allow: [80, 15], deny: [80, 15] },
	inApp: { head: [148, 17], since: [34, 13], line1: [184, 14], line2: [184, 14], chip: [176, 15] },
} as const satisfies Record<SlotScreenKind, Record<string, readonly [number, number]>>;

/** The strips' colours, beside the layouts' defaults. */
export const SLOT_STRIP_COLORS = {
	title: "#F2F2F2",
	caption: "#A7ADB8",
	dim: "#6A707A",
	needsYou: "#F2C94C",
	/** A chip nothing has picked, and its text. */
	chip: "#2A2F3A",
	chipText: "#A7ADB8",
	/** A picked Allow. */
	yes: "#1E6B43",
	/** A picked Deny. */
	no: "#8E2B2B",
	picked: "#FFFFFF",
	/** The Answer in app chip: a question's amber. */
	inApp: "#7A5A12",
	/** The Context page's bar, and its fill from CONTEXT_HIGH. */
	fill: "#4A9EFF",
	full: "#F2994A",
	/** The Agents pages' first line: the keys' accent, working's blue. */
	accent: "#4A9EFF",
} as const;

type Text = { value: string; color?: string; background?: string; font?: { size: number; weight: number } };

/** One line of text for a layout's item, its whitespace folded and cut to the item's width. */
function text<K extends SlotScreenKind>(kind: K, key: keyof (typeof SLOT_TEXT)[K] & string, value: string, extra: Omit<Text, "value"> = {}): Text {
	const [width, size] = (SLOT_TEXT[kind] as Record<string, readonly [number, number]>)[key] ?? [184, 14];
	return { value: clip(oneLine(value), fits(size, width)), ...extra };
}

/** Up to `max` lines of text for a layout's items of one width and size, by approximate width, as the keys wrap. */
function lines<K extends SlotScreenKind>(kind: K, key: keyof (typeof SLOT_TEXT)[K] & string, value: string | null, max: number): string[] {
	const [width, size] = (SLOT_TEXT[kind] as Record<string, readonly [number, number]>)[key] ?? [184, 14];
	const per = fits(size, width);
	const out = value === null ? [] : wrap(oneLine(value), per, max).map((l) => clip(l, per));
	while (out.length < max) out.push("");
	return out;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** `prefix` then a label, on one line cut to a text item's width, the label's counts kept whole (clipKeep). */
function withLabel(prefix: string, label: Label, [width, size]: readonly [number, number]): string {
	return clipKeep(oneLine(`${prefix}${label.text}`), fits(size, width), label.keep);
}

/** The dots under a page: `●○○`. */
export function pageDots(page: number, pages: number): string {
	return Array.from({ length: Math.max(1, pages) }, (_, i) => (i === page ? "●" : "○")).join("");
}

/**
 * How wide a page dot can be drawn, in em. The strips' text is in the app's own font, `.AppleSystemUIFont` (SF, by
 * the registration info in the deck's log), whose ● and ○ are 0.951 and 0.952 em wide at the dots' weight, 700, the
 * widest of the Mac's fonts the reviews measured (2026-11-07), and SF's tracking adds about 0.02 em at these sizes:
 * far wider than fits()'s 0.54 em a character. This leaves a little over that, so six dots take 8 px. Whether the app
 * clips or cuts with an ellipsis an item without `text-overflow` is unknown: its schema says both.
 */
export const DOT_EM = 1;

/** The page dots' weight, the layout's. */
const DOTS_WEIGHT = 700;

/**
 * The page dots' font size: the layout's, or smaller when that many dots wouldn't fit their item at it, so the last
 * dots are never cut off. Five pages (two Agents pages) take 10 px, six take 8.
 */
export function dotsSize(pages: number): number {
	const [width, size] = SLOT_TEXT.pages.dots;
	return Math.max(1, Math.min(size, Math.floor(width / (Math.max(1, pages) * DOT_EM))));
}

/** A chip's look: `none`, nothing picked; `yes` or `no`, picked (Allow; Deny). */
type ChipLook = "none" | "yes" | "no";

function chip<K extends SlotScreenKind>(kind: K, key: keyof (typeof SLOT_TEXT)[K] & string, label: string, look: ChipLook): Text {
	const c = SLOT_STRIP_COLORS;
	switch (look) {
		case "yes":
			return text(kind, key, label, { color: c.picked, background: c.yes });
		case "no":
			return text(kind, key, label, { color: c.picked, background: c.no });
		case "none":
			return text(kind, key, label, { color: c.chipText, background: c.chip });
	}
}

/** The bar's look on the pages: the context %, orange from CONTEXT_HIGH; hidden off the Context page or when unknown. */
function contextBar(pct: number | null, show: boolean): Feedback[string] {
	if (!show || pct === null) return { value: 0, opacity: 0 };
	return { value: pct, opacity: 1, bar_fill_c: pct >= CONTEXT_HIGH ? SLOT_STRIP_COLORS.full : SLOT_STRIP_COLORS.fill };
}

// ---- the screens ----

/** The empty slot: how to fill it. */
function emptyStrip(): Feedback {
	return {
		name: text("empty", "name", "No session"),
		line1: text("empty", "line1", "Hold the key above"),
		line2: text("empty", "line2", "to add the one on screen"),
	};
}

/** What the Now page says a session waits on; the dial shows a held one's own screen, so these are seldom seen. */
const NOW_NEED: Record<NonNullable<SessionView["need"]>, string> = {
	approval: "Approval waiting",
	question: "Question waiting",
	plan: "Plan waiting",
	input: NEED_WORDS.input,
};

/**
 * The Now page's first line: what the session is doing, or how its last turn ended, and when. Working and background
 * say what other work is at as the key does, `Background: review 5/9`, `Working: 3 agents`, `Background: 2 threads`;
 * else working says the tool it's on (agents-and-wake.md, B2; PROTOCOL.md's 2026-11-08 amendment).
 */
export function nowLine(s: SessionView, now: number): { value: string; color: string } {
	const since = sinceText(s.since, now);
	const c = SLOT_STRIP_COLORS;
	if (!s.running) return { value: "Not running", color: ENDED_COLOR };
	if (s.need !== null) return { value: since === null ? NOW_NEED[s.need] : `${NOW_NEED[s.need]} for ${since}`, color: c.needsYou };
	switch (s.status) {
		case "working":
		case "background": {
			const word = s.status === "working" ? "Working" : "Background";
			const loops = workLabel(s.threads, s.sideSessions);
			const color = STATUS_COLORS[s.status];
			if (loops !== null) return { value: withLabel(`${word}: `, loops, SLOT_TEXT.pages.line1), color };
			if (s.status === "working" && s.doing) return { value: `Working: ${s.doing}`, color };
			return { value: since === null ? word : `${word} for ${since}`, color };
		}
		case "done":
		case "failed":
		case "interrupted": {
			const word = s.status === "done" ? "Done" : s.status === "failed" ? "Failed" : "Stopped";
			return { value: since === null ? word : `${word} ${since} ago`, color: STATUS_COLORS[s.status] };
		}
		case "idle":
			return { value: since === null ? "Idle" : `Idle for ${since}`, color: STATUS_COLORS.idle };
		case "approval":
		case "needs-you":
			return { value: since === null ? NEED_WORDS.input : `${NEED_WORDS.input} for ${since}`, color: c.needsYou };
	}
}

/** What marks a session's Claude Code version on its Setup page when it's newer than the one the repo was checked against. */
export const NEWER_MARK = "↑";

/**
 * The Setup page's second line: the mode, then the session's Claude Code version when its hello gave one, marked with
 * NEWER_MARK, and the line in amber, when it's newer than the one the repo was checked against (hardening.md, C1):
 * `Auto mode · 2.1.318 ↑`. The version stays whole: on a line too long for its item, the word "mode" goes first
 * (`Accept edits · 2.1.318 ↑`), then the mode's name is cut.
 */
function modeLine(s: SessionView): Text {
	const c = SLOT_STRIP_COLORS;
	const name = s.mode === null ? null : modeName(s.mode);
	const mode = name === null ? "Mode —" : `${name} mode`;
	if (s.cc === null) return text("pages", "line2", mode, { color: c.caption });
	const tail = ` · ${s.cc}${s.ccNewer ? ` ${NEWER_MARK}` : ""}`;
	const [width, size] = SLOT_TEXT.pages.line2;
	const room = fits(size, width) - tail.length;
	const head = mode.length <= room || name === null ? mode : clip(name, Math.max(1, room));
	return text("pages", "line2", `${head}${tail}`, { color: s.ccNewer ? c.needsYou : c.caption });
}

/**
 * The pages, while the session has nothing held (session-keys.md, The strip): the title and the page dots (dotsSize) on
 * each, then
 * 1. Now: what it's doing or how its last turn ended; then what the app says it needs, while it needs input, else the
 *    last summary, on up to two lines;
 * 2. Agents, while other loops are in a turn or threads are unfinished, up to three pages (format.ts's agentPages): the
 *    run they follow as `review · 5/9 done` or `review · 5/9, 1 failed`, or `3 agents running`, or `2 threads`, in the
 *    accent colour (agentsHead), then two running agents or threads a page (agents-and-wake.md, B2; PROTOCOL.md's
 *    2026-11-08 amendment);
 * 3. Context: `Context 62%` with its bar, `620k of 1M tokens`, `Cost $1.24`;
 * 4. Setup: model and effort; mode, and the Claude Code version when the session's hello gave one (modeLine); project.
 * `page` counts every page the session has now, the Agents pages included, as the dial does.
 *
 * The second line has its colour on every page, since the Setup page's can be amber, and the strip keeps a colour it
 * isn't sent again.
 */
function pagesStrip(s: SessionView, page: number, pages: number, now: number): Feedback {
	const c = SLOT_STRIP_COLORS;
	const pct = contextPercent(s.context);
	const head = {
		name: text("pages", "name", s.title, { color: s.running ? c.title : c.dim }),
		dots: text("pages", "dots", pageDots(page, pages), { font: { size: dotsSize(pages), weight: DOTS_WEIGHT } }),
	};
	const agents = agentPages(s.threads, s.sideSessions);
	const shown = agents[page - 1];
	if (shown !== undefined) {
		const [l2 = "", l3 = ""] = shown;
		return {
			...head,
			line1: text("pages", "line1", withLabel("", agentsHead(s.threads, s.sideSessions), SLOT_TEXT.pages.line1), { color: c.accent }),
			line2: text("pages", "line2", l2, { color: c.caption }),
			line3: text("pages", "line3", l3),
			bar: contextBar(pct, false),
		};
	}
	// Context and Setup come after the Agents pages.
	if (page === agents.length + 1) {
		return {
			...head,
			line1: text("pages", "line1", pct === null ? "Context —" : `Context ${pct}%`, { color: c.title }),
			line2: text("pages", "line2", tokensText(s.tokens, s.window) ?? "", { color: c.caption }),
			line3: text("pages", "line3", costText(s.cost) === null ? "" : `Cost ${costText(s.cost)}`),
			bar: contextBar(pct, true),
		};
	}
	if (page === agents.length + 2) {
		const known = s.model !== null || s.effort !== null;
		return {
			...head,
			line1: text("pages", "line1", known ? modelAndEffort(s.model, s.effort) : "Model —", { color: c.title }),
			line2: modeLine(s),
			line3: text("pages", "line3", s.project ?? ""),
			bar: contextBar(pct, false),
		};
	}
	const first = nowLine(s, now);
	const note = s.need === "input" && s.needs !== null ? s.needs : s.summary;
	const [l2 = "", l3 = ""] = lines("pages", "line2", !s.running && note === null ? "Press to open it" : note, 2);
	return { ...head, line1: text("pages", "line1", first.value, { color: first.color }), line2: { value: l2, color: c.caption }, line3: { value: l3 }, bar: contextBar(pct, false) };
}

/** An approval: `Allow Bash?`, its command or file on up to two lines, and the Allow and Deny chips. */
function approvalStrip(screen: Extract<SlotScreen, { kind: "approval" }>, now: number): Feedback {
	const [l1 = "", l2 = ""] = lines("approval", "line1", screen.summary, 2);
	const out: Feedback = {
		head: text("approval", "head", `Allow ${toolName(screen.tool)}?`),
		since: text("approval", "since", sinceText(screen.session.since, now) ?? ""),
		line1: { value: l1 },
		line2: { value: l2 },
	};
	screen.choices.forEach((choice, i) => {
		const picked = screen.pick === i;
		out[choice.t] = chip("approval", choice.t, choice.t === "allow" ? "✓ Allow" : "✗ Deny", !picked ? "none" : choice.t === "allow" ? "yes" : "no");
	});
	return out;
}

/**
 * An `ask`, which the deck never answers (PROTOCOL.md, Held requests): the key's word for it (`Question`, `Plan`, or
 * `Approve?` for a tool the app approves on its own card), its summary on up to two lines, and `Answer in app`, which
 * a press opens.
 */
function inAppStrip(screen: Extract<SlotScreen, { kind: "inApp" }>, now: number): Feedback {
	const [l1 = "", l2 = ""] = lines("inApp", "line1", screen.summary, 2);
	return {
		head: text("inApp", "head", NEED_WORDS[askNeed(screen.tool)]),
		since: text("inApp", "since", sinceText(screen.session.since, now) ?? ""),
		line1: { value: l1 },
		line2: { value: l2 },
		chip: text("inApp", "chip", "Answer in app", { color: SLOT_STRIP_COLORS.picked, background: SLOT_STRIP_COLORS.inApp }),
	};
}

/** Draws a Session Slot dial's screen (SlotDials' `render`): its layout, and the feedback that fills it. */
export const slotStrip: SlotStripRender = (screen, now) => {
	const layout = SLOT_LAYOUTS[screen.kind];
	switch (screen.kind) {
		case "empty":
			return { layout, feedback: emptyStrip() };
		case "pages":
			return { layout, feedback: pagesStrip(screen.session, screen.page, screen.pages, now) };
		case "approval":
			return { layout, feedback: approvalStrip(screen, now) };
		case "inApp":
			return { layout, feedback: inAppStrip(screen, now) };
	}
};
