/**
 * Key images, as SVG, in the plugin's existing style (scripts/make-icons.mjs): a dark rounded square, light
 * glyphs, the blue accent. The plugin renders them live; make-icons.mjs writes the static manifest images from
 * the same functions. Self-contained, with only erasable TypeScript, so Node can import it directly.
 */

export type FlagKind = "pick" | "reject" | "unflag";
export type IconKind = FlagKind | "next" | "prev" | "beforeAfter" | "preset";

export type KeyLook = {
	/** The current photo has this key's flag (flag keys), or Before is held (Before/After). */
	active: boolean;
	/** Lightroom is offline or busy, or writes are off. */
	dim: boolean;
};

const BG = "#1F2430";
const FG = "#F2F2F2";
const CAPTION = "#A7ADB8";
const ACCENT = "#4A9EFF";
const DIM_BG = "#16191F";
const DIM_FG = "#4B515C";
const ACTIVE_BG: Record<FlagKind | "beforeAfter", string> = {
	pick: "#1F5596",
	reject: "#8E2B30",
	unflag: "#3E4656",
	beforeAfter: "#1F5596",
};
const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";

type Colors = { bg: string; fg: string; caption: string; fill: string };

function colors(look: KeyLook, activeBg: string): Colors {
	if (look.dim) return { bg: DIM_BG, fg: DIM_FG, caption: DIM_FG, fill: look.active ? DIM_FG : "none" };
	if (look.active) return { bg: activeBg, fg: "#FFFFFF", caption: "#FFFFFF", fill: "#FFFFFF" };
	return { bg: BG, fg: FG, caption: CAPTION, fill: "none" };
}

export function escapeXml(text: string): string {
	return text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] ?? c);
}

/** A 144-unit key: `size` is the rendered size (72 for the manifest's static images). */
function key(bg: string, body: string, size: number): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144"><rect width="144" height="144" rx="26" fill="${bg}"/>${body}</svg>`;
}

function caption(text: string, color: string, fontSize = 20): string {
	return `<text x="72" y="129" text-anchor="middle" font-family="${FONT}" font-size="${fontSize}" font-weight="600" fill="${color}">${escapeXml(text)}</text>`;
}

// ---- glyphs, in a 144 box, roughly 24..104 high so a caption fits underneath ----

const POLE = "M48 22V104";
const PENNANT = "M48 24H100L88 44L100 64H48Z";

function flagGlyph(kind: FlagKind, stroke: string, fill: string, cut: string, width = 1): string {
	const sw = (n: number): number => Math.round(n * width * 10) / 10;
	let out = `<path d="${POLE}" stroke="${stroke}" stroke-width="${sw(9)}" stroke-linecap="round" fill="none"/>`;
	out += `<path d="${PENNANT}" stroke="${stroke}" stroke-width="${sw(7)}" stroke-linejoin="round" fill="${fill}"/>`;
	if (kind === "reject") {
		// An X inside the pennant, cut out of it when it's filled.
		const x = fill === "none" ? stroke : cut;
		out += `<path d="M61 33L79 55M79 33L61 55" stroke="${x}" stroke-width="${sw(7)}" stroke-linecap="round"/>`;
	}
	if (kind === "unflag") {
		out += `<path d="M30 102L114 26" stroke="${cut}" stroke-width="${sw(17)}" stroke-linecap="round"/>`;
		out += `<path d="M30 102L114 26" stroke="${stroke}" stroke-width="${sw(8)}" stroke-linecap="round"/>`;
	}
	return out;
}

function chevron(dir: "next" | "prev", stroke: string, width = 1): string {
	const d = dir === "next" ? "M58 30L92 64L58 98" : "M86 30L52 64L86 98";
	return `<path d="${d}" stroke="${stroke}" stroke-width="${Math.round(12 * width * 10) / 10}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
}

function splitBox(stroke: string, left: string, right: string, width = 1): string {
	const sw = Math.round(6 * width * 10) / 10;
	return (
		`<path d="M41 28H72V98H41A7 7 0 0 1 34 91V35A7 7 0 0 1 41 28Z" fill="${left}"/>` +
		`<path d="M72 28H103A7 7 0 0 1 110 35V91A7 7 0 0 1 103 98H72Z" fill="${right}"/>` +
		`<rect x="34" y="28" width="76" height="70" rx="7" stroke="${stroke}" stroke-width="${sw}" fill="none"/>` +
		`<path d="M72 28V98" stroke="${stroke}" stroke-width="${sw}"/>`
	);
}

function sliders(stroke: string, knob: string, cy: number, scale = 1): string {
	const rows: [number, number][] = [
		[cy - 14, 60],
		[cy, 86],
		[cy + 14, 70],
	];
	const sw = Math.round(5 * scale * 10) / 10;
	return rows
		.map(
			([y, x]) =>
				`<path d="M44 ${y}H100" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>` +
				`<circle cx="${x}" cy="${y}" r="${Math.round(6.5 * scale * 10) / 10}" fill="${knob}" stroke="${stroke}" stroke-width="${Math.round(3 * scale * 10) / 10}"/>`,
		)
		.join("");
}

// ---- keys ----

const FLAG_CAPTION: Record<FlagKind, [idle: string, active: string]> = {
	pick: ["Pick", "Picked"],
	reject: ["Reject", "Rejected"],
	unflag: ["Unflag", "Unflagged"],
};

/** Pick, Reject or Unflag. `active` means the current photo has this key's flag (no flag, for Unflag). */
export function flagKeySvg(kind: FlagKind, look: KeyLook, size = 144): string {
	const c = colors(look, ACTIVE_BG[kind]);
	const [idle, active] = FLAG_CAPTION[kind];
	return key(c.bg, flagGlyph(kind, c.fg, c.fill, c.bg) + caption(look.active ? active : idle, c.caption), size);
}

export function navKeySvg(dir: "next" | "prev", look: Pick<KeyLook, "dim">, size = 144): string {
	const c = colors({ active: false, dim: look.dim }, BG);
	return key(c.bg, chevron(dir, c.fg) + caption(dir === "next" ? "Next" : "Previous", c.caption), size);
}

/** Before/After, hold to compare: `active` while Before is held. */
export function beforeAfterKeySvg(look: KeyLook, size = 144): string {
	const c = colors(look, ACTIVE_BG.beforeAfter);
	const left = look.dim ? DIM_FG : look.active ? "#FFFFFF" : FG;
	const right = look.active && !look.dim ? "#173E6E" : "none";
	const text = look.active ? "Before" : "Before/After";
	return key(c.bg, splitBox(c.fg, left, right) + caption(text, c.caption, look.active ? 20 : 17), size);
}

/** Breaks a preset name into lines that fit a key: two at the larger sizes, three at the smaller, then an ellipsis. */
export function wrapName(name: string): { lines: string[]; fontSize: number } {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return { lines: [], fontSize: 22 };
	for (const [fontSize, maxLines] of [
		[24, 2],
		[21, 2],
		[18, 3],
		[16, 3],
	]) {
		const lines = greedyLines(words, charsPerLine(fontSize));
		if (lines.length <= maxLines) return { lines, fontSize };
	}
	const max = charsPerLine(16);
	const lines = greedyLines(words, max);
	const last = lines.slice(2).join(" ");
	return { lines: [lines[0] ?? "", lines[1] ?? "", last.length > max ? `${last.slice(0, max - 1)}…` : last], fontSize: 16 };
}

/** About how many characters of semibold Helvetica fit the key's 128-unit text width. */
function charsPerLine(fontSize: number): number {
	return Math.floor(128 / (fontSize * 0.58));
}

function greedyLines(words: string[], max: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		const pieces: string[] = [];
		for (let i = 0; i < word.length; i += max) pieces.push(word.slice(i, i + max));
		for (const piece of pieces) {
			if (line === "") line = piece;
			else if (line.length + 1 + piece.length <= max) line += ` ${piece}`;
			else {
				lines.push(line);
				line = piece;
			}
		}
	}
	if (line !== "") lines.push(line);
	return lines;
}

/** Apply Preset: the preset's name under a sliders glyph, or a prompt when no preset is chosen yet. */
export function presetKeySvg(name: string | null, look: Pick<KeyLook, "dim">, size = 144): string {
	const c = colors({ active: false, dim: look.dim }, BG);
	const chosen = name !== null && name.trim() !== "";
	const { lines, fontSize } = chosen ? wrapName(name) : { lines: ["Choose", "a preset"], fontSize: 20 };
	const textColor = look.dim ? DIM_FG : chosen ? FG : CAPTION;
	const glyph = sliders(look.dim ? DIM_FG : chosen ? ACCENT : CAPTION, c.bg, 38, 0.9);
	const top = lines.length === 1 ? 100 : lines.length === 2 ? 88 : 80;
	const text = lines
		.map(
			(line, i) =>
				`<text x="72" y="${top + i * (fontSize + 4)}" text-anchor="middle" font-family="${FONT}" font-size="${fontSize}" font-weight="600" fill="${textColor}">${escapeXml(line)}</text>`,
		)
		.join("");
	return key(c.bg, glyph + text, size);
}

/** The 20 px action-list icon: monochrome white on transparent, as the manifest asks. */
export function actionIconSvg(kind: IconKind): string {
	const white = "#FFFFFF";
	let body: string;
	if (kind === "pick" || kind === "reject" || kind === "unflag") body = flagGlyph(kind, white, "none", "none", 1.5);
	else if (kind === "next" || kind === "prev") body = chevron(kind, white, 1.4);
	else if (kind === "beforeAfter") body = splitBox(white, white, "none", 1.5);
	else body = sliders(white, "none", 64, 1.5);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 144 144">${body}</svg>`;
}

export function svgDataUrl(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
