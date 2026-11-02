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
/** The Mode key while its mode is the target's. */
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

/** About how many characters of semibold Helvetica fit `width` units at a font size (checked by rendering). */
function fits(fontSize: number, width = 128): number {
	return Math.max(1, Math.floor(width / (fontSize * 0.54)));
}

/** A glyph drawn smaller and higher, clear of a caption at the bottom. */
function raised(glyph: string): string {
	return `<g transform="translate(18 4) scale(0.75)">${glyph}</g>`;
}

/** Cut to `max` characters with an ellipsis. */
function cut(text: string, max: number): string {
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

/** Three rows, the middle one picked: a list of sessions. */
function rows(color: string, accent: string, width = 9): string {
	return (
		`<path d="M30 36H114" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>` +
		`<path d="M30 72H114" stroke="${accent}" stroke-width="${width}" stroke-linecap="round"/>` +
		`<path d="M30 108H114" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`
	);
}

/** A speech bubble: a saved prompt. */
function bubble(color: string, width = 10): string {
	return `<path d="M30 34H114Q122 34 122 42V86Q122 94 114 94H66L44 112V94H30Q22 94 22 86V42Q22 34 30 34Z" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" fill="none"/>`;
}

/** A switch, its knob to the right: a mode. */
function toggle(color: string, accent: string, width = 10): string {
	return `<rect x="22" y="46" width="100" height="52" rx="26" stroke="${color}" stroke-width="${width}" fill="none"/><circle cx="96" cy="72" r="15" fill="${accent}"/>`;
}

/** A window with a dot in its bar: one session. */
function windowGlyph(color: string, accent: string, width = 10): string {
	return `<rect x="22" y="30" width="100" height="84" rx="12" stroke="${color}" stroke-width="${width}" fill="none"/><path d="M22 54H122" stroke="${color}" stroke-width="${width}"/><circle cx="40" cy="42" r="5" fill="${accent}"/>`;
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
	/** The bridge is listening. */
	online: boolean;
	/** Requests held now, across sessions. */
	count: number;
	/** The oldest: its session's title, and its summary; `ask` for a question or a plan, which a press jumps to. */
	oldest: { title: string; summary: string; ask: boolean } | null;
};

/**
 * Approve or Deny: the oldest held request's session and what it's for, with the count in a badge. Green
 * (Approve) or red (Deny) while a tool waits; amber with "Answer in app" for a question or a plan. Dimmed,
 * saying "Offline", while the bridge isn't listening.
 */
export function decisionKeySvg(look: DecisionLook, size = 144): string {
	const allow = look.decision === "allow";
	const name = allow ? "Approve" : "Deny";
	const glyph = (color: string, small: boolean): string =>
		allow ? check(color, small ? 11 : 13, small ? CHECK_SMALL : CHECK) : cross(color, small ? 11 : 13, small ? CROSS_SMALL : CROSS);
	if (!look.online) return key(DIM_BG, glyph(DIM_FG, false) + caption("Offline", DIM_FG), size);
	const oldest = look.oldest;
	if (look.count <= 0 || !oldest) return key(BG, glyph(CAPTION, false) + caption(name, CAPTION), size);
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

// ---- Mode key ----

export type ModeKeyLook = {
	/** The mode's name, as the app shows it; null when none is set. */
	mode: string | null;
	/** It's the target's mode now. */
	active: boolean;
	/** The last press's change is in flight. */
	pending: boolean;
	target: string | null;
	online: boolean;
};

/** A Mode key: its mode, blue while it's the target's mode, with the target below. */
export function modeKeySvg(look: ModeKeyLook, size = 144): string {
	if (look.mode === null) return key(BG, raised(toggle(CAPTION, CAPTION)) + caption("Set mode", CAPTION, 18), size);
	const bg = !look.online ? DIM_BG : look.active ? ACTIVE_BG : BG;
	const fg = look.online ? FG : DIM_FG;
	const lines = wrap(look.mode, fits(24), 2);
	const top = lines.length === 1 ? 74 : 62;
	const body = lines.map((l, i) => line(l, top + i * 28, fg, 24, 700)).join("");
	const bottom = !look.online ? "Offline" : look.pending ? "Setting…" : look.target ?? "No target";
	return key(bg, line("MODE", 30, look.active ? "#BFD8FF" : CAPTION, 14, 700) + body + line(bottom, 128, look.pending ? "#F2C94C" : CAPTION, 15, 500), size);
}

// ---- Session key ----

export type SessionKeyLook = {
	/** The target's title; null for no target. */
	title: string | null;
	/** "working: notes.md", "approval"… */
	status: string;
	statusColor: string;
};

/** The Session key: the target session's title, and its status in its colour. */
export function sessionKeySvg(look: SessionKeyLook, size = 144): string {
	if (look.title === null) return key(BG, raised(windowGlyph(CAPTION, CAPTION)) + caption("No target", CAPTION, 18), size);
	const lines = wrap(look.title, fits(19), 3);
	const top = lines.length === 1 ? 64 : lines.length === 2 ? 52 : 40;
	const body = lines.map((l, i) => line(l, top + i * 25, FG, 19, 600)).join("");
	return key(BG, body + line(look.status, 128, look.statusColor, 17, 700), size);
}

// ---- the dials' images ----

/** The Sessions dial's key image (its manifest state image): the rows glyph on the key background. */
export function sessionsKeySvg(size = 144): string {
	return key(BG, rows(FG, ACCENT), size);
}

/** The Sessions dial's encoder icon: the rows glyph without a background. */
export function sessionsEncoderSvg(size = 72): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144">${rows(FG, ACCENT)}</svg>`;
}

/** The Mode dial's key image and encoder icon: the switch. */
export function modeDialKeySvg(size = 144): string {
	return key(BG, toggle(FG, ACCENT), size);
}

export function modeEncoderSvg(size = 72): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144">${toggle(FG, ACCENT)}</svg>`;
}

// ---- the action list ----

export type IconKind = "sessions" | "approve" | "deny" | "prompt" | "mode" | "mode-key" | "session";

/** The 20 px action-list icons: monochrome white on transparent, as the manifest asks. */
export function actionIconSvg(kind: IconKind): string {
	const white = "#FFFFFF";
	const bodies: Record<IconKind, string> = {
		sessions: rows(white, white, 13),
		approve: check(white, 17),
		deny: cross(white, 17),
		prompt: bubble(white, 13),
		mode: toggle(white, white, 13),
		"mode-key": toggle(white, white, 13),
		session: windowGlyph(white, white, 13),
	};
	return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 144 144">${bodies[kind]}</svg>`;
}

/** The 28 px category icon: a prompt chevron and cursor, white on transparent. */
export function categoryIconSvg(size = 28): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144"><path d="M28 36L68 72L28 108" stroke="#FFFFFF" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M80 108H118" stroke="#FFFFFF" stroke-width="16" stroke-linecap="round"/></svg>`;
}
