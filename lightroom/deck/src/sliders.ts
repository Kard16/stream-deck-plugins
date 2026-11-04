import { readFileSync } from "node:fs";

import type { Range } from "./lr/protocol.js";
import { isKelvinRange, type StepSpec } from "./model/steps.js";

/** sliders.json lists 1 to this many sliders. */
export const MAX_SLIDERS = 64;

/** A big step is this many normal steps unless sliders.json says otherwise. */
export const MACRO_FACTOR = 10;

/** Big steps switch off after this long without a turn: the default, and the bounds sliders.json may set. */
export const DEFAULT_MACRO_SECONDS = 2;
export const MIN_MACRO_SECONDS = 0.5;
export const MAX_MACRO_SECONDS = 10;

/**
 * The params a dial gets when it appears without one, by column: bank 1 of the old banks, so the dials the user
 * already placed keep their sliders. Other columns get the first slider.
 */
export const COLUMN_DEFAULTS: readonly string[] = ["Temperature", "Tint", "Exposure", "Contrast"];

/** How a slider moves and shows its value. */
export type SliderVariant = {
	/** Value units per tick. */
	step: number;
	/** Value units per tick during push + turn, with no acceleration. */
	fine: number;
	/** Value units per tick in big steps, after a tap on the strip, with no acceleration. */
	macro: number;
	/** Decimal places shown on the strip. */
	precision: number;
	/** Shown after the value, with a space: "5500 K". */
	unit: string;
	/** Positive values get a "+": "+0.35", "+15". */
	signed: boolean;
};

/** One entry in sliders.json: a Develop param a dial can show. */
export type Slider = SliderVariant &
	StepSpec & {
		/** An `LrDevelopController` parameter name, e.g. `Exposure`. */
		param: string;
		/** The strip's label. */
		label: string;
		/** Replaces steps and display while Lightroom reports a Kelvin range for the param (Temperature on raw and DNG files). */
		kelvin: SliderVariant | null;
	};

export type SliderConfig = {
	/** In the order a dial's Property Inspector lists them. Params are unique. */
	sliders: readonly Slider[];
	/** `k` in effective ticks = ticks × (1 + k × (|ticks| − 1)). Fine and big steps have none. */
	acceleration: number;
	/** Big steps switch off after this many seconds without a turn on that dial. */
	macroSeconds: number;
};

const variant = (step: number, extra: Partial<SliderVariant> = {}): SliderVariant => ({
	step,
	fine: step / 4,
	macro: step * MACRO_FACTOR,
	precision: 0,
	unit: "",
	signed: true,
	...extra,
});

const slider = (param: string, label: string, step = 1, extra: Partial<SliderVariant> = {}, kelvin: SliderVariant | null = null): Slider => ({
	param,
	label,
	...variant(step, extra),
	kelvin,
});

/**
 * The built-in 17, in Lightroom's panel order (docs/lightroom/plan.md, Phase 7): Exposure 1/30 EV a tick;
 * Temperature 50 K a tick on raw files and 1 on rendered ones; the rest 1 a tick. Fine steps are a quarter of
 * those, and big steps ten of them: 1/3 EV, 500 K, 10 points.
 */
export const DEFAULT_SLIDERS: SliderConfig = {
	acceleration: 0.5,
	macroSeconds: DEFAULT_MACRO_SECONDS,
	sliders: [
		slider("Temperature", "Temp", 1, {}, variant(50, { unit: "K", signed: false })),
		slider("Tint", "Tint"),
		slider("Exposure", "Exposure", 1 / 30, { precision: 2 }),
		slider("Contrast", "Contrast"),
		slider("Highlights", "Highlights"),
		slider("Shadows", "Shadows"),
		slider("Whites", "Whites"),
		slider("Blacks", "Blacks"),
		slider("Texture", "Texture"),
		slider("Clarity", "Clarity"),
		slider("Dehaze", "Dehaze"),
		slider("Vibrance", "Vibrance"),
		slider("Saturation", "Saturation"),
		slider("Sharpness", "Sharpening", 1, { signed: false }),
		slider("LuminanceSmoothing", "Noise", 1, { signed: false }),
		slider("PostCropVignetteAmount", "Vignette"),
		slider("GrainAmount", "Grain", 1, { signed: false }),
	],
};

export function sliderFor(config: SliderConfig, param: string): Slider | null {
	return config.sliders.find((s) => s.param === param) ?? null;
}

/** The param a dial gets when it appears without one: its column's, when sliders.json lists it, or else the first slider. */
export function defaultParam(config: SliderConfig, column: number): string {
	const named = COLUMN_DEFAULTS[column];
	if (named !== undefined && sliderFor(config, named)) return named;
	return config.sliders[0]?.param ?? COLUMN_DEFAULTS[0] ?? "Temperature";
}

/** Every slider's param, in list order: the deck watches all of them (PROTOCOL.md, `watch`). */
export function watchList(config: SliderConfig): string[] {
	return config.sliders.map((s) => s.param);
}

/** The variant in force for the param's current range. */
export function variantFor(s: Slider, range: Range | null | undefined): SliderVariant {
	return isKelvinRange(range) && s.kelvin ? s.kelvin : s;
}

// ---- sliders.json ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const SLIDER_KEYS = new Set(["param", "label", "step", "fine", "macro", "precision", "unit", "signed", "kelvin"]);
const VARIANT_KEYS = new Set(["step", "fine", "macro", "precision", "unit", "signed"]);
const TOP_KEYS = new Set(["help", "acceleration", "macroSeconds", "sliders"]);

/** A positive number, or a fraction such as "1/30". */
function readAmount(v: unknown, where: string, errors: string[]): number | undefined {
	let n: number | undefined;
	if (typeof v === "number") n = v;
	else if (typeof v === "string") {
		const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(v);
		if (m) n = Number(m[1]) / Number(m[2]);
	}
	if (n === undefined || !Number.isFinite(n) || n <= 0) {
		errors.push(`${where} must be a positive number or a fraction like "1/30"`);
		return undefined;
	}
	return n;
}

/** step is required; fine defaults to step / 4 and macro to 10 × step, in kelvin too. */
function readVariant(raw: Obj, where: string, errors: string[], defaults: Omit<SliderVariant, "step" | "fine" | "macro">, keys: Set<string>): SliderVariant | null {
	for (const key of Object.keys(raw)) if (!keys.has(key)) errors.push(`${where}.${key} isn't a slider field (${[...keys].join(", ")})`);
	const before = errors.length;
	const step = readAmount(raw.step, `${where}.step`, errors);
	const fine = raw.fine === undefined ? (step === undefined ? undefined : step / 4) : readAmount(raw.fine, `${where}.fine`, errors);
	const macro = raw.macro === undefined ? (step === undefined ? undefined : step * MACRO_FACTOR) : readAmount(raw.macro, `${where}.macro`, errors);
	let precision = defaults.precision;
	if (raw.precision !== undefined) {
		if (typeof raw.precision === "number" && Number.isInteger(raw.precision) && raw.precision >= 0 && raw.precision <= 4) precision = raw.precision;
		else errors.push(`${where}.precision must be a whole number from 0 to 4`);
	}
	let unit = defaults.unit;
	if (raw.unit !== undefined) {
		if (typeof raw.unit === "string" && raw.unit.length <= 8) unit = raw.unit;
		else errors.push(`${where}.unit must be a string of at most 8 characters`);
	}
	let signed = defaults.signed;
	if (raw.signed !== undefined) {
		if (typeof raw.signed === "boolean") signed = raw.signed;
		else errors.push(`${where}.signed must be true or false`);
	}
	if (errors.length > before || step === undefined || fine === undefined || macro === undefined) return null;
	return { step, fine, macro, precision, unit, signed };
}

function readSlider(raw: unknown, where: string, errors: string[]): Slider | null {
	if (!isObj(raw)) {
		errors.push(`${where} must be a slider object`);
		return null;
	}
	const before = errors.length;
	const param = raw.param;
	if (typeof param !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(param)) {
		errors.push(`${where}.param must be an LrDevelopController parameter name such as "Exposure"`);
	}
	const label = raw.label;
	if (typeof label !== "string" || label.trim() === "" || label.length > 24) errors.push(`${where}.label must be a non-empty string of at most 24 characters`);
	const base = readVariant(raw, where, errors, { precision: 0, unit: "", signed: true }, SLIDER_KEYS);
	let kelvin: SliderVariant | null = null;
	if (raw.kelvin !== undefined && raw.kelvin !== null) {
		if (isObj(raw.kelvin)) kelvin = readVariant(raw.kelvin, `${where}.kelvin`, errors, { precision: 0, unit: "K", signed: false }, VARIANT_KEYS);
		else errors.push(`${where}.kelvin must be an object or null`);
	}
	if (errors.length > before || !base || typeof param !== "string" || typeof label !== "string") return null;
	return { param, label, ...base, kelvin };
}

/**
 * Parses sliders.json. Any problem makes the whole file invalid: `config` is then the built-in 17 and `errors`
 * says why, so a typo never leaves the dials half-configured.
 */
export function parseSliders(text: string): { config: SliderConfig; errors: string[] } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return { config: DEFAULT_SLIDERS, errors: [`not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
	}
	const errors: string[] = [];
	if (!isObj(raw)) return { config: DEFAULT_SLIDERS, errors: ["the file must hold a JSON object with a sliders list"] };
	for (const key of Object.keys(raw)) {
		if (!TOP_KEYS.has(key) && !key.startsWith("_") && !key.startsWith("$")) errors.push(`${key} isn't a top-level field (${[...TOP_KEYS].join(", ")})`);
	}
	if (raw.help !== undefined && !(Array.isArray(raw.help) && raw.help.every((line) => typeof line === "string"))) errors.push("help must be a list of strings");
	let acceleration = DEFAULT_SLIDERS.acceleration;
	if (raw.acceleration !== undefined) {
		if (typeof raw.acceleration === "number" && Number.isFinite(raw.acceleration) && raw.acceleration >= 0 && raw.acceleration <= 4) acceleration = raw.acceleration;
		else errors.push("acceleration must be a number from 0 (none) to 4");
	}
	let macroSeconds = DEFAULT_SLIDERS.macroSeconds;
	if (raw.macroSeconds !== undefined) {
		const s = raw.macroSeconds;
		if (typeof s === "number" && Number.isFinite(s) && s >= MIN_MACRO_SECONDS && s <= MAX_MACRO_SECONDS) macroSeconds = s;
		else errors.push(`macroSeconds must be a number of seconds from ${MIN_MACRO_SECONDS} to ${MAX_MACRO_SECONDS}`);
	}
	const sliders: Slider[] = [];
	if (!Array.isArray(raw.sliders) || raw.sliders.length === 0 || raw.sliders.length > MAX_SLIDERS) {
		errors.push(`sliders must be a list of 1 to ${MAX_SLIDERS} sliders`);
	} else {
		const seen = new Map<string, number>();
		raw.sliders.forEach((entry: unknown, i: number) => {
			const s = readSlider(entry, `sliders[${i}]`, errors);
			if (s) sliders.push(s);
			// Duplicates count even among sliders with other mistakes, so the log lists every problem at once.
			const param = isObj(entry) && typeof entry.param === "string" ? entry.param : null;
			if (param === null) return;
			const first = seen.get(param);
			if (first !== undefined) errors.push(`sliders[${i}].param ${param} is already sliders[${first}]: each param can be listed once`);
			else seen.set(param, i);
		});
	}
	if (errors.length > 0) return { config: DEFAULT_SLIDERS, errors };
	return { config: { sliders, acceleration, macroSeconds }, errors: [] };
}

/** Reads sliders.json at startup. A missing or invalid file falls back to the built-in 17, with a warning. */
export function loadSlidersFile(file: string): { config: SliderConfig; warnings: string[] } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code ?? String(err);
		return { config: DEFAULT_SLIDERS, warnings: [`couldn't read ${file} (${code}); using the built-in sliders`] };
	}
	const { config, errors } = parseSliders(text);
	if (errors.length === 0) return { config, warnings: [] };
	const shown = errors.slice(0, 8).join("; ");
	const more = errors.length > 8 ? ` (and ${errors.length - 8} more)` : "";
	return { config, warnings: [`${file} is invalid, so the built-in sliders are in use: ${shown}${more}`] };
}
