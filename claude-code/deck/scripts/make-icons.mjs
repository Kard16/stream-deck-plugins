// Writes the plugin's images into com.karimdhanji.claude.sdPlugin/imgs/.
// Run with `mise exec -- npm run icons` after changing a design. No dependencies, as in lightroom/deck: the
// PNG plugin icon is rasterised here (4x supersampled) and encoded with node:zlib. The SVGs come from
// src/keys/art.ts, the same functions the plugin draws live keys with; Node 24 imports it by stripping types.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import * as art from "../src/keys/art.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "com.karimdhanji.claude.sdPlugin", "imgs");

const BG = [0x1f, 0x24, 0x30];
const FG = [0xf2, 0xf2, 0xf2];
const ACCENT = [0x4a, 0x9e, 0xff];

/** The plugin icon's glyph in a 144 box: a prompt chevron, and a cursor in the accent colour. */
const CHEVRON = [
	[40, 44, 74, 72],
	[74, 72, 40, 100],
];
const CURSOR = [[86, 100, 108, 100]];
const STROKE = 14;

/** Distance from (x, y) to the segment (x1, y1)-(x2, y2). */
function toSegment(x, y, [x1, y1, x2, y2]) {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
	return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/** Rasterises the plugin icon (rounded square, chevron, accent cursor) into RGBA. */
function rasterIcon(size) {
	const ss = 4;
	const n = size * ss;
	const scale = n / 144;
	const radius = n * 0.18;
	const half = (STROKE * scale) / 2;
	const rgba = Buffer.alloc(size * size * 4);

	const inRoundedSquare = (x, y) => {
		const dx = Math.max(radius - x, 0, x - (n - radius));
		const dy = Math.max(radius - y, 0, y - (n - radius));
		return dx * dx + dy * dy <= radius * radius;
	};
	const on = (segments, x, y) => segments.some((s) => toSegment(x / scale, y / scale, s) * scale <= half);

	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			let r = 0, g = 0, b = 0, a = 0;
			for (let sy = 0; sy < ss; sy++) {
				for (let sx = 0; sx < ss; sx++) {
					const x = px * ss + sx + 0.5;
					const y = py * ss + sy + 0.5;
					if (!inRoundedSquare(x, y)) continue;
					const col = on(CURSOR, x, y) ? ACCENT : on(CHEVRON, x, y) ? FG : BG;
					r += col[0];
					g += col[1];
					b += col[2];
					a += 255;
				}
			}
			const samples = ss * ss;
			const i = (py * size + px) * 4;
			const covered = a / 255;
			rgba[i] = covered ? Math.round(r / covered) : 0;
			rgba[i + 1] = covered ? Math.round(g / covered) : 0;
			rgba[i + 2] = covered ? Math.round(b / covered) : 0;
			rgba[i + 3] = Math.round(a / samples);
		}
	}
	return rgba;
}

function png(size, rgba) {
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(zlib.crc32(body));
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	const rows = [];
	for (let y = 0; y < size; y++) {
		rows.push(Buffer.from([0]), rgba.subarray(y * size * 4, (y + 1) * size * 4));
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function write(rel, contents) {
	const file = path.join(root, rel);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, contents);
	console.log(`wrote imgs/${rel}`);
}

// Plugin icon: PNG only, 256 and 512 (@2x).
write("plugin/icon.png", png(256, rasterIcon(256)));
write("plugin/icon@2x.png", png(512, rasterIcon(512)));
// Category icon (28 px) and action-list icons (20 px): monochrome white SVG.
write("plugin/category-icon.svg", `${art.categoryIconSvg(28)}\n`);
for (const kind of ["approve", "deny", "prompt", "slot", "others"]) {
	write(`actions/${kind}/icon.svg`, `${art.actionIconSvg(kind)}\n`);
}
// State images and the Session Slot dial's encoder icon (72 px). Each key's is its look with the bridge up and nothing to
// show; the plugin replaces it with live images once the key appears.
write("actions/approve/key.svg", `${art.decisionKeySvg({ decision: "allow", online: true, count: 0, oldest: null }, 72)}\n`);
write("actions/deny/key.svg", `${art.decisionKeySvg({ decision: "deny", online: true, count: 0, oldest: null }, 72)}\n`);
write("actions/prompt/key.svg", `${art.promptKeySvg({ label: null, target: null, state: "idle", online: true }, 72)}\n`);
// The Session Slot's key image is an empty slot's face, and its dial's encoder icon the slot glyph; Other Sessions'
// is its dim face with no other sessions.
write("actions/slot/key.svg", `${art.slotKeySvg({ tone: "empty", word: "No session", since: null, title: null, tool: null, context: null }, 72)}\n`);
write("actions/slot/encoder.svg", `${art.slotEncoderSvg(72)}\n`);
write("actions/others/key.svg", `${art.othersKeySvg({ needing: 0, oldest: null, unseen: 0, running: 0 }, 72)}\n`);
