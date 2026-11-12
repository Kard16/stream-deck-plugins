/**
 * Key and icon images, as SVG, in the Lightroom plugin's style (lightroom/deck/src/keys/art.ts): a dark
 * rounded square, light glyphs, one accent. The plugin draws live keys with these; scripts/make-icons.mjs
 * writes the manifest's static images from the same functions. Self-contained, with only erasable TypeScript,
 * so Node can import it directly: callers pass text already formatted.
 */

const BG = "#1F2430";
const FG = "#F2F2F2";
const CAPTION = "#A7ADB8";
const DIM_BG = "#16191F";
const DIM_FG = "#4B515C";
const ACCENT = "#4A9EFF";
/** Held-request backgrounds: Approve green, Deny red, a question amber. */
const ALLOW_BG = "#1E6B43";
const DENY_BG = "#8E2B2B";
const ASK_BG = "#7A5A12";
/** Saved Prompt states. */
const WAITING_BG = "#5C4A1A";
const SENT_BG = "#1E6B43";
const REFUSED_BG = "#7A2626";
/** A working session's slot key. */
const ACTIVE_BG = "#1F4E8C";
const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";

export function escapeXml(text: string): string {
	return text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] ?? c);
}

export function svgDataUrl(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/** A 144-unit key: `size` is the rendered size (72 for the manifest's static images). */
function key(bg: string, body: string, size: number): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144"><rect width="144" height="144" rx="26" fill="${bg}"/>${body}</svg>`;
}

/**
 * About how many characters of semibold Helvetica fit `width` units at a font size (checked by rendering). The
 * Session Slot strips (src/slots/strip.ts) measure their text items with it too, in strip pixels.
 */
export function fits(fontSize: number, width = 128): number {
	return Math.max(1, Math.floor(width / (fontSize * 0.54)));
}

/** A glyph drawn smaller and higher, clear of a caption at the bottom. */
function raised(glyph: string): string {
	return `<g transform="translate(18 4) scale(0.75)">${glyph}</g>`;
}

/** Cut to `max` characters with an ellipsis. */
export function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/** Words into at most `maxLines` lines of `perLine` characters; what doesn't fit ends the last line with an ellipsis. */
export function wrap(text: string, perLine: number, maxLines: number): string[] {
	const words = text.trim().split(/\s+/).filter((w) => w !== "");
	const lines: string[] = [];
	let current = "";
	/** The index of the current line's first word. */
	let start = 0;
	for (let i = 0; i < words.length; i++) {
		const word = words[i] ?? "";
		const candidate = current === "" ? word : `${current} ${word}`;
		if (candidate.length <= perLine || current === "") {
			current = candidate;
			continue;
		}
		// The last line takes the rest of the words, cut.
		if (lines.length === maxLines - 1) break;
		lines.push(current);
		current = word;
		start = i;
	}
	if (start < words.length) lines.push(cut(words.slice(start).join(" "), perLine));
	return lines;
}

/** One line of text, cut to fit the key's width. */
function line(text: string, y: number, color: string, fontSize = 18, weight = 600, x = 72, anchor = "middle", width = 128): string {
	return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${FONT}" font-size="${fontSize}" font-weight="${weight}" fill="${color}">${escapeXml(cut(text, fits(fontSize, width)))}</text>`;
}

function caption(text: string, color: string, fontSize = 20): string {
	return line(text, 129, color, fontSize);
}

// ---- glyphs, in a 144 box ----

/** The check, centred; and smaller at the top left, beside the count badge. */
const CHECK = "M36 64L60 88L104 40";
const CHECK_SMALL = "M20 36L36 52L64 22";
/** The cross, centred and small. */
const CROSS = "M42 38L102 98M102 38L42 98";
const CROSS_SMALL = "M22 18L58 54M58 18L22 54";

function stroke(d: string, color: string, width: number): string {
	return `<path d="${d}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
}

function check(color: string, width = 13, d = CHECK): string {
	return stroke(d, color, width);
}

function cross(color: string, width = 13, d = CROSS): string {
	return stroke(d, color, width);
}

/** A question mark at the top left: a request that needs the user in the app. */
function question(color: string): string {
	return `<text x="38" y="58" text-anchor="middle" font-family="${FONT}" font-size="56" font-weight="800" fill="${color}">?</text>`;
}

/** A speech bubble: a saved prompt. */
function bubble(color: string, width = 10): string {
	return `<path d="M30 34H114Q122 34 122 42V86Q122 94 114 94H66L44 112V94H30Q22 94 22 86V42Q22 34 30 34Z" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" fill="none"/>`;
}

/** A key with a dot at its top and a bar along its foot: one session's slot. */
function slotGlyph(color: string, accent: string, width = 10): string {
	return `<rect x="24" y="24" width="96" height="96" rx="20" stroke="${color}" stroke-width="${width}" fill="none"/><circle cx="52" cy="54" r="9" fill="${accent}"/><path d="M46 94H98" stroke="${accent}" stroke-width="${width}" stroke-linecap="round"/>`;
}

/** Two keys, one behind the other: the sessions on no slot. */
function stackGlyph(color: string, width = 10): string {
	return `<rect x="46" y="22" width="76" height="76" rx="16" stroke="${color}" stroke-width="${width}" fill="none"/><path d="M22 54V106Q22 122 38 122H90" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
}

/** The count of held requests, in a badge at the top right. */
function badge(count: number, fill: string, text: string): string {
	const label = count > 99 ? "99+" : String(count);
	const fontSize = label.length >= 3 ? 19 : 26;
	return (
		`<circle cx="114" cy="30" r="23" fill="${fill}"/>` +
		`<text x="114" y="${30 + fontSize * 0.36}" text-anchor="middle" font-family="${FONT}" font-size="${fontSize}" font-weight="700" fill="${text}">${label}</text>`
	);
}

// ---- Approve and Deny ----

export type DecisionLook = {
	decision: "allow" | "deny";
	/** The bridge is listening. Not listening, with nothing held, the key reads Offline. */
	online: boolean;
	/** Requests held now, across sessions. */
	count: number;
	/** The oldest: its session's title, and its summary; `ask` for a question or a plan, which a press jumps to. */
	oldest: { title: string; summary: string; ask: boolean } | null;
};

/**
 * Approve or Deny: the oldest held request's session and what it's for, with the count in a badge. Green
 * (Approve) or red (Deny) while a tool waits; amber with "Answer in app" for an `ask`. With nothing
 * held, dimmed and saying "Offline" while the bridge isn't listening. A request held when the bridge's server closed
 * or failed stays on the key all the same, as on its Session Slot dial: that server keeps its connection open, so a
 * press still answers it (PROTOCOL.md, Failure and recovery), and the key shows what a press acts on.
 */
export function decisionKeySvg(look: DecisionLook, size = 144): string {
	const allow = look.decision === "allow";
	const name = allow ? "Approve" : "Deny";
	const glyph = (color: string, small: boolean): string =>
		allow ? check(color, small ? 11 : 13, small ? CHECK_SMALL : CHECK) : cross(color, small ? 11 : 13, small ? CROSS_SMALL : CROSS);
	const oldest = look.oldest;
	if (look.count <= 0 || !oldest) {
		if (!look.online) return key(DIM_BG, glyph(DIM_FG, false) + caption("Offline", DIM_FG), size);
		return key(BG, glyph(CAPTION, false) + caption(name, CAPTION), size);
	}
	const bg = oldest.ask ? ASK_BG : allow ? ALLOW_BG : DENY_BG;
	const mark = oldest.ask ? question("#FFFFFF") : glyph("#FFFFFF", true);
	return key(bg, mark + badge(look.count, "#FFFFFF", bg) + line(oldest.title, 98, "#FFFFFF", 17, 600) + line(oldest.ask ? "Answer in app" : oldest.summary, 126, "#E8E8E8", 17, 500), size);
}

// ---- Saved Prompt ----

export type PromptLook = {
	/** What the key says: its label, or the start of its text; null when no text is set. */
	label: string | null;
	/** The target session's title; null for none. */
	target: string | null;
	/** The last press's command: waiting until it's final, then sent or refused for a few seconds. */
	state: "idle" | "waiting" | "sent" | "refused";
	online: boolean;
};

const PROMPT_STATES = {
	waiting: { bg: WAITING_BG, text: "Waiting…" },
	sent: { bg: SENT_BG, text: "Sent" },
	refused: { bg: REFUSED_BG, text: "Refused" },
} as const;

/** A Saved Prompt key: its label in up to three lines, and below it where it goes, or how the last press went. */
export function promptKeySvg(look: PromptLook, size = 144): string {
	if (look.label === null) return key(BG, raised(bubble(CAPTION)) + caption("Set text", CAPTION, 18), size);
	const state = look.state === "idle" ? null : PROMPT_STATES[look.state];
	const bg = !look.online ? DIM_BG : (state?.bg ?? BG);
	const fg = look.online ? FG : DIM_FG;
	const lines = wrap(look.label, fits(19), 3);
	const top = lines.length === 1 ? 64 : lines.length === 2 ? 52 : 40;
	const body = lines.map((l, i) => line(l, top + i * 25, fg, 19, 600)).join("");
	const bottom = !look.online ? "Offline" : state ? state.text : look.target ? `→ ${look.target}` : "No target";
	return key(bg, body + line(bottom, 128, state ? "#FFFFFF" : CAPTION, 15, state ? 700 : 500), size);
}

// ---- Session Slot ----

/**
 * A Session Slot key's tone (session-keys.md, The key face): the state's colour fills the key, and only the states
 * that need you are amber, with a light outline, so a glance at the row finds them.
 * - `need`: a question, a plan, an approval, or needs input.
 * - `working`: blue, for Background too (agents-and-wake.md, B2).
 * - `done`, `failed`, `stopped`: a turn's end the user hasn't seen: green, red, dark red.
 * - `quiet`: a turn's end that has been seen, or idle: dark, with the bottom line dimmed.
 * - `notRunning`: darker, with dim text. `empty`: a slot with no session, darker.
 */
export type SlotTone = "need" | "working" | "done" | "failed" | "stopped" | "quiet" | "notRunning" | "empty";

/** A slot key's face, with its text already formatted (src/slots/art.ts makes it from the session). */
export type SlotFace = {
	tone: SlotTone;
	/** The top line's word: `Question`, `Plan`, `Approve?`, `Needs you`, `Working`, `Background`, `Done`, `No session`… */
	word: string;
	/** How long the state has lasted, as `30s`, `4m`, `2h` or `3d`; null when unknown. */
	since: string | null;
	/** The session's title, in the middle on up to two lines; null for none. */
	title: string | null;
	/**
	 * The bottom line's left: what other loops are at (`review 5/9`, `3 agents`) or the tool it's on (working,
	 * background), or the tool that waits (approval); null for none.
	 */
	tool: string | null;
	/** How many characters at the end of `tool` stay whole when it's cut (clipKeep): a run's counts. */
	keep?: number;
	/** Context use, 0–100, as the bottom line's % over a thin bar; null when unknown. */
	context: number | null;
};

/** The light outline round the states that need you. */
const NEED_LINE = "#F2C94C";
/** An interrupted turn's dark red, darker than Failed's DENY_BG. */
const STOPPED_BG = "#5A1F1F";
/** Context use from which the bar turns orange, on the slot keys and the slot strips (src/slots/strip.ts). */
export const CONTEXT_HIGH = 80;

type ToneColors = {
	bg: string;
	word: string;
	since: string;
	title: string;
	/** The bottom line. */
	small: string;
	groove: string;
	fill: string;
	/** The bar's fill from CONTEXT_HIGH. */
	full: string;
};

const SLOT_TONES: Record<SlotTone, ToneColors> = {
	need: { bg: ASK_BG, word: "#FFFFFF", since: "#F5E3B5", title: "#FFFFFF", small: "#F5E3B5", groove: "#4D390B", fill: "#FFFFFF", full: "#F2994A" },
	working: { bg: ACTIVE_BG, word: "#FFFFFF", since: "#C8DBF5", title: "#FFFFFF", small: "#C8DBF5", groove: "#143561", fill: "#FFFFFF", full: "#F2994A" },
	done: { bg: ALLOW_BG, word: "#FFFFFF", since: "#C6E8D3", title: "#FFFFFF", small: "#C6E8D3", groove: "#12442A", fill: "#FFFFFF", full: "#F2994A" },
	failed: { bg: DENY_BG, word: "#FFFFFF", since: "#F2CACA", title: "#FFFFFF", small: "#F2CACA", groove: "#5A1B1B", fill: "#FFFFFF", full: "#F2994A" },
	stopped: { bg: STOPPED_BG, word: "#FFFFFF", since: "#E6C3C3", title: "#FFFFFF", small: "#E6C3C3", groove: "#3A1414", fill: "#FFFFFF", full: "#F2994A" },
	quiet: { bg: BG, word: CAPTION, since: CAPTION, title: FG, small: "#6A707A", groove: "#2A2F3A", fill: "#6A707A", full: "#9C6A3C" },
	notRunning: { bg: DIM_BG, word: DIM_FG, since: DIM_FG, title: "#6A707A", small: DIM_FG, groove: "#22262E", fill: DIM_FG, full: DIM_FG },
	empty: { bg: DIM_BG, word: CAPTION, since: CAPTION, title: CAPTION, small: "#8A8F99", groove: "#22262E", fill: DIM_FG, full: DIM_FG },
};

/** The background a tone fills the key with, for the tests. */
export function slotToneBackground(tone: SlotTone): string {
	return SLOT_TONES[tone].bg;
}

/** The key's text runs from x 14 to x 130 on its top and bottom lines. */
const EDGE_L = 14;
const EDGE_R = 130;
const ROW = EDGE_R - EDGE_L;

/** Roughly how wide `text` is at a font size, in key units: the measure fits() uses, the other way round. */
function textWidth(text: string, fontSize: number): number {
	return Math.ceil(text.length * fontSize * 0.54);
}

/**
 * Cut to `max` characters with an ellipsis, as cut() does, but with no space left before the ellipsis, wrap()'s last
 * line included. The Session Slot keys and strips cut with it.
 */
export function clip(text: string, max: number): string {
	if (text.length > max) return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
	return text.replace(/\s+…$/, "…");
}

/**
 * Cut to `max` characters as clip() does, but with its last `keep` characters whole, so a workflow run's label keeps
 * its counts: `agents-and-wake 5/9` → `agents-… 5/9`. When those alone leave no room, it's cut as clip() cuts.
 */
export function clipKeep(text: string, max: number, keep: number): string {
	if (text.length <= max || keep <= 0 || keep >= max - 1) return clip(text, max);
	return `${clip(text.slice(0, -keep), max - keep)}${text.slice(-keep)}`;
}

/**
 * A line with a word on the left and a short value on the right (`Working … 4m`, `npm test … 62%`), a gap between. The
 * left is cut to its room, its last `keep` characters whole (clipKeep). With `shrink`, a left too long for its room
 * takes the largest smaller size, down to `shrink`, that holds it whole, and the right goes with it: the top line's
 * `Background` beside its since.
 */
function splitLine(
	left: string | null,
	right: string | null,
	y: number,
	fontSize: number,
	colors: { left: string; right: string },
	weights = { left: 600, right: 700 },
	opts: { keep?: number; shrink?: number } = {},
): string {
	const roomAt = (size: number): number => Math.max(1, right === null || right === "" ? ROW : ROW - textWidth(right, size) - 14);
	let size = fontSize;
	while (left !== null && size > (opts.shrink ?? fontSize) && left.length > fits(size, roomAt(size))) size--;
	const r = right === null || right === "" ? "" : line(right, y, colors.right, size, weights.right, EDGE_R, "end", ROW);
	const room = roomAt(size);
	const l = left === null || left === "" ? "" : line(clipKeep(left, fits(size, room), opts.keep ?? 0), y, colors.left, size, weights.left, EDGE_L, "start", room);
	return l + r;
}

/** How wide the title may run, clear of the amber outline. */
const TITLE_WIDTH = 120;

/** A title in the middle of the key, on up to two lines, each cut with an ellipsis. */
function middleTitle(title: string, color: string): string {
	const per = fits(18, TITLE_WIDTH);
	const lines = wrap(title, per, 2).map((l) => clip(l, per));
	const top = lines.length === 1 ? 78 : 66;
	return lines.map((l, i) => line(l, top + i * 23, color, 18, 600, 72, "middle", TITLE_WIDTH)).join("");
}

/** The thin context bar under the bottom line. */
function contextBar(context: number, c: ToneColors): string {
	const pct = Math.max(0, Math.min(100, context));
	const fillWidth = Math.round((ROW * pct) / 100);
	const fill = pct >= CONTEXT_HIGH ? c.full : c.fill;
	const groove = `<rect x="${EDGE_L}" y="126" width="${ROW}" height="5" rx="2.5" fill="${c.groove}"/>`;
	return fillWidth > 0 ? `${groove}<rect x="${EDGE_L}" y="126" width="${fillWidth}" height="5" rx="2.5" fill="${fill}"/>` : groove;
}

function needOutline(): string {
	return `<rect x="3" y="3" width="138" height="138" rx="23" fill="none" stroke="${NEED_LINE}" stroke-width="5"/>`;
}

/** The empty slot's hint, at the bottom in small type. */
const EMPTY_SLOT_HINT = "Hold to add the one on screen";

/** The smallest the top line goes so that its word fits whole beside its since: `Background 30s` takes 14. */
const TOP_LINE_MIN = 13;

/**
 * A Session Slot key: the state's colour fills it; the top line has the state's word and `since`, smaller when the
 * word wouldn't fit whole; the title sits in the middle on up to two lines; the bottom line has what other loops are
 * at or the tool (working, background or approval) and the context %, over a thin context bar. A slot that isn't
 * running shows only its title, dimmed; an empty one, how to fill it.
 */
export function slotKeySvg(face: SlotFace, size = 144): string {
	const c = SLOT_TONES[face.tone];
	let body = face.tone === "need" ? needOutline() : "";
	body += splitLine(face.word, face.since, 34, 17, { left: c.word, right: c.since }, { left: 700, right: 600 }, { shrink: TOP_LINE_MIN });
	if (face.tone === "empty") {
		body += `<path d="M72 54V86M56 70H88" stroke="${DIM_FG}" stroke-width="8" stroke-linecap="round"/>`;
		const per = fits(13);
		body += wrap(EMPTY_SLOT_HINT, per, 2)
			.map((l, i) => line(clip(l, per), 114 + i * 17, c.small, 13, 500))
			.join("");
		return key(c.bg, body, size);
	}
	if (face.title !== null) body += middleTitle(face.title, c.title);
	if (face.tone === "notRunning") return key(c.bg, body, size);
	const pct = face.context === null ? null : Math.max(0, Math.min(100, Math.round(face.context)));
	body += splitLine(face.tool, pct === null ? null : `${pct}%`, 117, 15, { left: c.small, right: c.small }, undefined, { keep: face.keep });
	if (pct !== null) body += contextBar(pct, c);
	return key(c.bg, body, size);
}

// ---- Other Sessions ----

/** The Others key's face, with its text already formatted (src/slots/art.ts makes it from OthersLook). */
export type OthersFace = {
	/** How many running sessions on no slot need you; with none, the key is dim. */
	needing: number;
	/** The one that has waited longest: its title, what it waits on (`Question`…) and `since`. */
	oldest: { title: string; word: string; since: string | null } | null;
	/** How many ended a turn you haven't seen, in small type. */
	unseen: number;
	/** How many sessions on no slot are running, for the dim key. */
	running: number;
};

/**
 * The Others key, for the running sessions on no slot (session-keys.md, Others). With some needing you, it's amber
 * with the light outline: how many, the title of the one waiting longest, what it waits on and its `since`. With none,
 * it's dim and says how many are running. Either way, how many are done and not seen, in small type at the foot.
 */
export function othersKeySvg(face: OthersFace, size = 144): string {
	const unseen = face.unseen > 0 ? `${face.unseen} done, not seen` : null;
	const oldest = face.oldest;
	if (face.needing > 0 && oldest !== null) {
		const c = SLOT_TONES.need;
		let body = needOutline();
		body += line(`${face.needing} need${face.needing === 1 ? "s" : ""} you`, 34, c.word, 17, 700, EDGE_L, "start", ROW);
		body += middleTitle(oldest.title, c.title);
		body += splitLine(oldest.word, oldest.since, 117, 15, { left: c.small, right: c.small }, { left: 600, right: 600 });
		if (unseen !== null) body += line(unseen, 135, c.small, 12, 600);
		return key(c.bg, body, size);
	}
	let body = line("Others", 34, CAPTION, 17, 700, EDGE_L, "start", ROW);
	body += line(face.running > 0 ? `${face.running} running` : "No others", 80, "#6A707A", 19, 600);
	if (unseen !== null) body += line(unseen, 124, "#8A8F99", 13, 600);
	return key(DIM_BG, body, size);
}

// ---- the dial's image ----

/** The Session Slot dial's encoder icon: the slot glyph without a background. Its key image is the empty slot's face. */
export function slotEncoderSvg(size = 72): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144">${slotGlyph(FG, ACCENT)}</svg>`;
}

// ---- the action list ----

export type IconKind = "approve" | "deny" | "prompt" | "slot" | "others";

/** The 20 px action-list icons: monochrome white on transparent, as the manifest asks. */
export function actionIconSvg(kind: IconKind): string {
	const white = "#FFFFFF";
	const bodies: Record<IconKind, string> = {
		approve: check(white, 17),
		deny: cross(white, 17),
		prompt: bubble(white, 13),
		slot: slotGlyph(white, white, 13),
		others: stackGlyph(white, 13),
	};
	return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 144 144">${bodies[kind]}</svg>`;
}

/** The 28 px category icon: a prompt chevron and cursor, white on transparent. */
export function categoryIconSvg(size = 28): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144"><path d="M28 36L68 72L28 108" stroke="#FFFFFF" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M80 108H118" stroke="#FFFFFF" stroke-width="16" stroke-linecap="round"/></svg>`;
}
