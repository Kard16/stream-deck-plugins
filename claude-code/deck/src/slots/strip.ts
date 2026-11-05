import { clip, fits, wrap } from "../keys/art.js";
import { costText, ENDED_COLOR, modeName, modelAndEffort, sinceText, STATUS_COLORS, tokensText } from "../model/format.js";
import type { SessionView } from "../model/sessions.js";
import type { InAppWhy } from "../protocol/ask.js";
import { EXIT_PLAN } from "../protocol/wire.js";
import { CONTEXT_HIGH, STRIP_COLORS } from "../sessions/strip.js";
import type { Feedback } from "../util/painter.js";
import { contextPercent, NEED_WORDS, toolName } from "./art.js";
import type { QuestionItem, SlotScreen, SlotStripRender } from "./dials.js";

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
	question: "layouts/slot-question.json",
	plan: "layouts/slot-plan.json",
	inApp: "layouts/slot-inapp.json",
} as const satisfies Record<SlotScreenKind, string>;

/**
 * Each layout's text items: the width their text is cut to and the font size, from the layout files' `rect` and
 * `font` (the tests hold the two together). A chip's text is cut a little inside its rect, clear of the edges.
 */
export const SLOT_TEXT = {
	empty: { name: [184, 18], line1: [184, 14], line2: [184, 14] },
	pages: { name: [150, 17], dots: [32, 12], line1: [184, 15], line2: [184, 14], line3: [184, 14] },
	approval: { head: [148, 17], since: [34, 13], line1: [184, 14], line2: [184, 14], allow: [80, 15], deny: [80, 15] },
	question: { head: [148, 13], since: [34, 13], q1: [184, 14], q2: [184, 14], opt: [136, 15], pos: [38, 13], desc: [184, 12] },
	plan: { head: [148, 16], since: [34, 13], line1: [184, 14], c0: [66, 13], c1: [104, 13], c2: [66, 13], c3: [104, 13] },
	inApp: { head: [148, 17], since: [34, 13], line1: [184, 14], line2: [184, 14], chip: [176, 15] },
} as const satisfies Record<SlotScreenKind, Record<string, readonly [number, number]>>;

/** The strips' colours, beside the layouts' defaults. */
export const SLOT_STRIP_COLORS = {
	title: "#F2F2F2",
	text: "#E8E8E8",
	caption: "#A7ADB8",
	dim: "#6A707A",
	needsYou: "#F2C94C",
	/** A chip nothing has picked, and its text. */
	chip: "#2A2F3A",
	chipText: "#A7ADB8",
	/** The question's cursor, Next while it can go on. */
	cursor: "#1F4E8C",
	/** A picked Allow or Approve, and Send. */
	yes: "#1E6B43",
	/** A picked Deny or Reject. */
	no: "#8E2B2B",
	picked: "#FFFFFF",
	/** The Answer in app chip: a question's amber. */
	inApp: "#7A5A12",
} as const;

type Text = { value: string; color?: string; background?: string };

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

/** The dots under a page: `●○○`. */
export function pageDots(page: number, pages: number): string {
	return Array.from({ length: Math.max(1, pages) }, (_, i) => (i === page ? "●" : "○")).join("");
}

/**
 * A chip's look: `none`, nothing picked; `yes` or `no`, picked (Allow, an Approve, Send; Deny, Reject); `cursor`, the
 * question's place turned to; `off`, Next or Send with nothing ticked yet.
 */
type ChipLook = "none" | "yes" | "no" | "cursor" | "off";

function chip<K extends SlotScreenKind>(kind: K, key: keyof (typeof SLOT_TEXT)[K] & string, label: string, look: ChipLook): Text {
	const c = SLOT_STRIP_COLORS;
	switch (look) {
		case "yes":
			return text(kind, key, label, { color: c.picked, background: c.yes });
		case "no":
			return text(kind, key, label, { color: c.picked, background: c.no });
		case "cursor":
			return text(kind, key, label, { color: c.picked, background: c.cursor });
		case "off":
			return text(kind, key, label, { color: c.dim, background: c.chip });
		case "none":
			return text(kind, key, label, { color: c.chipText, background: c.chip });
	}
}

/** The bar's look on the pages: the context %, orange from CONTEXT_HIGH; hidden off the Context page or when unknown. */
function contextBar(pct: number | null, show: boolean): Feedback[string] {
	if (!show || pct === null) return { value: 0, opacity: 0 };
	return { value: pct, opacity: 1, bar_fill_c: pct >= CONTEXT_HIGH ? STRIP_COLORS.full : STRIP_COLORS.fill };
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

/** The Now page's first line: what the session is doing, or how its last turn ended, and when. */
export function nowLine(s: SessionView, now: number): { value: string; color: string } {
	const since = sinceText(s.since, now);
	const c = SLOT_STRIP_COLORS;
	if (!s.running) return { value: "Not running", color: ENDED_COLOR };
	if (s.need !== null) return { value: since === null ? NOW_NEED[s.need] : `${NOW_NEED[s.need]} for ${since}`, color: c.needsYou };
	switch (s.status) {
		case "working":
			return { value: s.doing ? `Working: ${s.doing}` : since === null ? "Working" : `Working for ${since}`, color: STATUS_COLORS.working };
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

/**
 * The pages, while the session needs nothing the dial can answer (session-keys.md, The strip): the title and the page
 * dots on each, then
 * 1. Now: what it's doing or how its last turn ended; then what the app says it needs, while it needs input, else the
 *    last summary, on up to two lines;
 * 2. Context: `Context 62%` with its bar, `620k of 1M tokens`, `Cost $1.24`;
 * 3. Setup: model and effort, mode, project.
 */
function pagesStrip(s: SessionView, page: number, pages: number, now: number): Feedback {
	const c = SLOT_STRIP_COLORS;
	const pct = contextPercent(s.context);
	const head = { name: text("pages", "name", s.title, { color: s.running ? c.title : c.dim }), dots: text("pages", "dots", pageDots(page, pages)) };
	if (page === 1) {
		return {
			...head,
			line1: text("pages", "line1", pct === null ? "Context —" : `Context ${pct}%`, { color: c.title }),
			line2: text("pages", "line2", tokensText(s.tokens, s.window) ?? ""),
			line3: text("pages", "line3", costText(s.cost) === null ? "" : `Cost ${costText(s.cost)}`),
			bar: contextBar(pct, true),
		};
	}
	if (page === 2) {
		const known = s.model !== null || s.effort !== null;
		return {
			...head,
			line1: text("pages", "line1", known ? modelAndEffort(s.model, s.effort) : "Model —", { color: c.title }),
			line2: text("pages", "line2", s.mode === null ? "Mode —" : `${modeName(s.mode)} mode`),
			line3: text("pages", "line3", s.project ?? ""),
			bar: contextBar(pct, false),
		};
	}
	const first = nowLine(s, now);
	const note = s.need === "input" && s.needs !== null ? s.needs : s.summary;
	const [l2 = "", l3 = ""] = lines("pages", "line2", !s.running && note === null ? "Press to open it" : note, 2);
	return { ...head, line1: text("pages", "line1", first.value, { color: first.color }), line2: { value: l2 }, line3: { value: l3 }, bar: contextBar(pct, false) };
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

/** What the question screen's chip, position and description say for the place under the cursor. */
function questionItem(screen: Extract<SlotScreen, { kind: "question" }>): { opt: Text; pos: string; desc: string } {
	const cursor = screen.cursor;
	const item: QuestionItem | undefined = cursor === null ? undefined : screen.items[cursor];
	if (item === undefined || cursor === null) {
		// A press now jumps only before any turn on the form: on the first question, nothing picked yet.
		const jumps = screen.index === 0 && screen.picked.length === 0;
		return { opt: chip("question", "opt", "Turn to pick", "none"), pos: "", desc: jumps ? "Or press to answer in app" : "" };
	}
	const pos = `${cursor + 1}/${screen.items.length}`;
	switch (item.t) {
		case "option": {
			const label = item.ticked ? `✓ ${item.label}` : item.label;
			const fallback = screen.multi ? (item.ticked ? "Press to untick" : "Press to tick") : "Press to pick";
			return { opt: chip("question", "opt", label, "cursor"), pos, desc: item.description ?? fallback };
		}
		case "other":
			return { opt: chip("question", "opt", "Other…", "cursor"), pos, desc: "Press to type it in the app" };
		case "next": {
			if (!item.ready) return { opt: chip("question", "opt", item.send ? "Send" : "Next", "off"), pos, desc: "Tick at least one first" };
			if (item.send) return { opt: chip("question", "opt", "Send", "yes"), pos, desc: "Press to send the answers" };
			return { opt: chip("question", "opt", "Next →", "cursor"), pos, desc: `On to question ${screen.index + 2} of ${screen.count}` };
		}
	}
}

/**
 * A question: its header and `1 of 2` when there are several, the question on up to two lines, then the place under
 * the cursor (an option, ticked or not, with its description; Other…; Next or Send) and `2/3`.
 */
function questionStrip(screen: Extract<SlotScreen, { kind: "question" }>, now: number): Feedback {
	const header = screen.header ?? "Question";
	const head = screen.count > 1 ? `${header} · ${screen.index + 1} of ${screen.count}` : header;
	const [q1 = "", q2 = ""] = lines("question", "q1", screen.question, 2);
	const place = questionItem(screen);
	return {
		head: text("question", "head", head),
		since: text("question", "since", sinceText(screen.session.since, now) ?? ""),
		q1: { value: q1 },
		q2: { value: q2 },
		opt: place.opt,
		pos: text("question", "pos", place.pos),
		desc: text("question", "desc", place.desc),
	};
}

/** The plan chips' keys, in PLAN_CHOICES' order, and their short labels: ✓ approves into the mode, ✗ rejects. */
const PLAN_KEYS = ["c0", "c1", "c2", "c3"] as const;

/** `Plan ready`, the plan's first line, and its choices as chips, two by two. */
function planStrip(screen: Extract<SlotScreen, { kind: "plan" }>, now: number): Feedback {
	const out: Feedback = {
		head: text("plan", "head", "Plan ready"),
		since: text("plan", "since", sinceText(screen.session.since, now) ?? ""),
		line1: text("plan", "line1", screen.firstLine ?? "Press to read it in app", { color: screen.firstLine === null ? SLOT_STRIP_COLORS.caption : SLOT_STRIP_COLORS.text }),
	};
	screen.choices.forEach((choice, i) => {
		const key = PLAN_KEYS[i];
		if (key === undefined) return;
		const picked = screen.pick === i;
		const label = choice.t === "approve" ? `✓ ${modeName(choice.mode)}` : "✗ Reject";
		out[key] = chip("plan", key, label, !picked ? "none" : choice.t === "approve" ? "yes" : "no");
	});
	return out;
}

/** Why the dial can't answer a question or plan, on its strip (InAppWhy). */
const IN_APP_WHY = {
	"too big": "Too long for the deck",
	unreadable: "The deck can't read it",
	scrubbed: "Holds the deck's token",
} as const satisfies Record<InAppWhy, string>;

/** A question or plan the dial can't answer: what it is, why, and `Answer in app`, which a press opens. */
function inAppStrip(screen: Extract<SlotScreen, { kind: "inApp" }>, now: number): Feedback {
	const plan = screen.tool === EXIT_PLAN;
	const why = IN_APP_WHY[screen.why];
	const [l1 = "", l2 = ""] = plan ? [why, ""] : [lines("inApp", "line1", screen.summary, 1)[0] ?? "", why];
	return {
		head: text("inApp", "head", plan ? "Plan ready" : "Question"),
		since: text("inApp", "since", sinceText(screen.session.since, now) ?? ""),
		line1: text("inApp", "line1", l1),
		line2: text("inApp", "line2", l2),
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
		case "question":
			return { layout, feedback: questionStrip(screen, now) };
		case "plan":
			return { layout, feedback: planStrip(screen, now) };
		case "inApp":
			return { layout, feedback: inAppStrip(screen, now) };
	}
};
