/**
 * Key and icon images, as SVG, in the Lightroom plugin's style (lightroom/deck/src/keys/art.ts): a dark
 * rounded square, light glyphs, one accent. The plugin draws live keys with these; scripts/make-icons.mjs
 * writes the manifest's static images from the same functions. Self-contained, with only erasable TypeScript,
 * so Node can import it directly.
 */

const BG = "#1F2430";
const FG = "#F2F2F2";
const CAPTION = "#A7ADB8";
const DIM_BG = "#16191F";
const DIM_FG = "#4B515C";
/** The Approve key while requests are held. */
const HELD_BG = "#1E6B43";
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

function caption(text: string, color: string, fontSize = 20): string {
	return `<text x="72" y="129" text-anchor="middle" font-family="${FONT}" font-size="${fontSize}" font-weight="600" fill="${color}">${escapeXml(text)}</text>`;
}

// ---- glyphs, in a 144 box ----

/** The check, centred; and moved down and left, clear of the count badge. */
const CHECK = "M36 64L60 88L104 40";
const CHECK_BESIDE_BADGE = "M28 72L52 96L94 54";

function check(stroke: string, width = 1, d = CHECK): string {
	return `<path d="${d}" stroke="${stroke}" stroke-width="${Math.round(13 * width * 10) / 10}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
}

/** Three rows, the middle one picked: a list of sessions. */
function rows(stroke: string, accent: string, width = 1): string {
	const sw = Math.round(9 * width * 10) / 10;
	return (
		`<path d="M30 36H114" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>` +
		`<path d="M30 72H114" stroke="${accent}" stroke-width="${sw}" stroke-linecap="round"/>` +
		`<path d="M30 108H114" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`
	);
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

// ---- keys ----

export type ApproveLook = {
	/** Requests held now. */
	count: number;
	/** The oldest one's tool_name, when its body had one. */
	tool: string | null;
	/** The bridge is listening. */
	online: boolean;
};

/** About how many characters of semibold Helvetica fit the key's caption width at a font size. */
function fits(fontSize: number): number {
	return Math.floor(128 / (fontSize * 0.58));
}

/**
 * The Approve key: a check, a badge with the count of held requests, and the oldest one's tool as the caption.
 * Green while something is held. Dimmed, saying "Offline", while the bridge isn't listening.
 */
export function approveKeySvg(look: ApproveLook, size = 144): string {
	if (!look.online) return key(DIM_BG, check(DIM_FG) + caption("Offline", DIM_FG), size);
	if (look.count <= 0) return key(BG, check(CAPTION) + caption("Approve", CAPTION), size);
	let text = look.tool ?? "Approve";
	let fontSize = 20;
	if (text.length > fits(fontSize)) fontSize = 16;
	if (text.length > fits(fontSize)) text = `${text.slice(0, fits(fontSize) - 1)}…`;
	return key(HELD_BG, check(FG, 1, CHECK_BESIDE_BADGE) + badge(look.count, "#FFFFFF", HELD_BG) + caption(text, "#FFFFFF", fontSize), size);
}

/** The Sessions dial's key image (its manifest state image): the rows glyph on the key background. */
export function sessionsKeySvg(size = 144): string {
	return key(BG, rows(FG, "#4A9EFF"), size);
}

/** The Sessions dial's encoder icon: the rows glyph without a background. */
export function sessionsEncoderSvg(size = 72): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144">${rows(FG, "#4A9EFF")}</svg>`;
}

/** The 20 px action-list icons: monochrome white on transparent, as the manifest asks. */
export function actionIconSvg(kind: "sessions" | "approve"): string {
	const white = "#FFFFFF";
	const body = kind === "sessions" ? rows(white, white, 1.4) : check(white, 1.3);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 144 144">${body}</svg>`;
}

/** The 28 px category icon: a prompt chevron and cursor, white on transparent. */
export function categoryIconSvg(size = 28): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144"><path d="M28 36L68 72L28 108" stroke="#FFFFFF" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M80 108H118" stroke="#FFFFFF" stroke-width="16" stroke-linecap="round"/></svg>`;
}
