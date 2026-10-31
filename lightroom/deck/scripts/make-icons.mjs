// Writes the plugin's images into com.karimdhanji.lightroom.sdPlugin/imgs/.
// Run with `mise exec -- node scripts/make-icons.mjs` after changing a design. No dependencies:
// the PNG icon is rasterised here (4x supersampled) and encoded with node:zlib. The key images come from
// src/keys/art.ts, the same functions the plugin draws live keys with; Node 24 imports it by stripping types.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import * as art from "../src/keys/art.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "com.karimdhanji.lightroom.sdPlugin", "imgs");

const BG = [0x1f, 0x24, 0x30];
const FG = [0xf2, 0xf2, 0xf2];
const ACCENT = [0x4a, 0x9e, 0xff];

/** A dial: a ring with a pointer at about 1 o'clock, on an optional rounded square. */
function dialSvg(size, { background, mono }) {
	const s = size;
	const fg = mono ? "#FFFFFF" : "#F2F2F2";
	const accent = mono ? "#FFFFFF" : "#4A9EFF";
	const ring = s * 0.3;
	const stroke = Math.max(1.5, s * 0.075);
	const c = s / 2;
	const angle = (-60 * Math.PI) / 180;
	const px = c + Math.cos(angle) * ring;
	const py = c + Math.sin(angle) * ring;
	const bg = background
		? `<rect x="0" y="0" width="${s}" height="${s}" rx="${s * 0.18}" fill="#1F2430"/>`
		: "";
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">${bg}<circle cx="${c}" cy="${c}" r="${ring}" fill="none" stroke="${fg}" stroke-width="${stroke}"/><line x1="${c}" y1="${c}" x2="${px.toFixed(2)}" y2="${py.toFixed(2)}" stroke="${accent}" stroke-width="${stroke}" stroke-linecap="round"/></svg>\n`;
}

/** Category glyph: a camera aperture-like ring with a centre dot, white on transparent. */
function categorySvg(s) {
	const c = s / 2;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><circle cx="${c}" cy="${c}" r="${s * 0.36}" fill="none" stroke="#FFFFFF" stroke-width="${s * 0.09}"/><circle cx="${c}" cy="${c}" r="${s * 0.12}" fill="#FFFFFF"/></svg>\n`;
}

/** Rasterises the plugin icon (rounded square, ring, accent pointer) into RGBA. */
function rasterIcon(size) {
	const ss = 4;
	const n = size * ss;
	const c = n / 2;
	const radius = n * 0.18;
	const ringR = n * 0.3;
	const half = (n * 0.075) / 2;
	const angle = (-60 * Math.PI) / 180;
	const ex = Math.cos(angle);
	const ey = Math.sin(angle);
	const rgba = Buffer.alloc(size * size * 4);

	const inRoundedSquare = (x, y) => {
		const dx = Math.max(radius - x, 0, x - (n - radius));
		const dy = Math.max(radius - y, 0, y - (n - radius));
		return dx * dx + dy * dy <= radius * radius;
	};
	const onRing = (x, y) => Math.abs(Math.hypot(x - c, y - c) - ringR) <= half;
	const onPointer = (x, y) => {
		const t = Math.max(0, Math.min(ringR, (x - c) * ex + (y - c) * ey));
		return Math.hypot(x - (c + ex * t), y - (c + ey * t)) <= half;
	};

	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			let r = 0, g = 0, b = 0, a = 0;
			for (let sy = 0; sy < ss; sy++) {
				for (let sx = 0; sx < ss; sx++) {
					const x = px * ss + sx + 0.5;
					const y = py * ss + sy + 0.5;
					if (!inRoundedSquare(x, y)) continue;
					const col = onPointer(x, y) ? ACCENT : onRing(x, y) ? FG : BG;
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
// Category icon (28 px) and action-list icon (20 px): monochrome white SVG.
write("plugin/category-icon.svg", categorySvg(28));
write("actions/dial/icon.svg", dialSvg(20, { background: false, mono: true }));
// State image and dial icon (72 px).
write("actions/dial/key.svg", dialSvg(72, { background: true, mono: false }));
write("actions/dial/encoder.svg", dialSvg(72, { background: false, mono: false }));

// Keys: the manifest's state image is the key's idle look, which the plugin replaces with live images once
// the key appears. Action-list icons are monochrome white on transparent, 20 px.
const idle = { active: false, dim: false };
const keys = {
	pick: art.flagKeySvg("pick", idle, 72),
	reject: art.flagKeySvg("reject", idle, 72),
	unflag: art.flagKeySvg("unflag", idle, 72),
	next: art.navKeySvg("next", idle, 72),
	prev: art.navKeySvg("prev", idle, 72),
	"before-after": art.beforeAfterKeySvg(idle, 72),
	preset: art.presetKeySvg(null, idle, 72),
};
const icons = { pick: "pick", reject: "reject", unflag: "unflag", next: "next", prev: "prev", "before-after": "beforeAfter", preset: "preset" };
for (const [dir, svg] of Object.entries(keys)) {
	write(`actions/${dir}/key.svg`, `${svg}\n`);
	write(`actions/${dir}/icon.svg`, `${art.actionIconSvg(icons[dir])}\n`);
}
