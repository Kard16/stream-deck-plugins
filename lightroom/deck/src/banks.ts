import { readFileSync } from "node:fs";

import type { Range } from "./lr/protocol.js";
import { isKelvinRange, type StepSpec } from "./model/steps.js";

/** The Stream Deck + has four dials, and all four page through the banks together. */
export const DIALS_PER_BANK = 4;
export const MAX_BANKS = 16;

/** How a slot moves and shows its value. */
export type SlotVariant = {
	/** Value units per tick. */
	step: number;
	/** Value units per tick during push + turn, with no acceleration. */
	fine: number;
	/** Decimal places shown on the strip. */
	precision: number;
	/** Shown after the value, with a space: "5500 K". */
	unit: string;
	/** Positive values get a "+": "+0.35", "+15". */
	signed: boolean;
};

/** One dial position in a bank. */
export type Slot = SlotVariant &
	StepSpec & {
		/** An `LrDevelopController` parameter name, e.g. `Exposure`. */
		param: string;
		/** The strip's label. */
		label: string;
		/** Replaces steps and display while Lightroom reports a Kelvin range for the param (Temperature on raw and DNG files). */
		kelvin: SlotVariant | null;
	};

export type Bank = readonly (Slot | null)[];

export type BankConfig = {
	banks: readonly Bank[];
	/** `k` in effective ticks = ticks × (1 + k × (|ticks| − 1)). */
	acceleration: number;
};

const variant = (step: number, extra: Partial<SlotVariant> = {}): SlotVariant => ({
	step,
	fine: step / 4,
	precision: 0,
	unit: "",
	signed: true,
	...extra,
});

const slot = (param: string, label: string, step = 1, extra: Partial<SlotVariant> = {}, kelvin: SlotVariant | null = null): Slot => ({
	param,
	label,
	...variant(step, extra),
	kelvin,
});

/**
 * The kickoff banks (docs/lightroom/plan.md, kickoff answer 1), in Basic-panel order, with the plan's steps:
 * Exposure 1/30 EV a tick; Temperature 50 K a tick on raw files and 1 on rendered ones; the rest 1 a tick,
 * about 1/200 of -100..100. Fine steps are a quarter of those.
 */
export const DEFAULT_BANKS: BankConfig = {
	acceleration: 0.5,
	banks: [
		[
			slot("Temperature", "Temp", 1, {}, variant(50, { unit: "K", signed: false })),
			slot("Tint", "Tint"),
			slot("Exposure", "Exposure", 1 / 30, { precision: 2 }),
			slot("Contrast", "Contrast"),
		],
		[slot("Highlights", "Highlights"), slot("Shadows", "Shadows"), slot("Whites", "Whites"), slot("Blacks", "Blacks")],
		[slot("Texture", "Texture"), slot("Clarity", "Clarity"), slot("Vibrance", "Vibrance"), slot("Saturation", "Saturation")],
		[slot("PostCropVignetteAmount", "Vignette"), null, null, null],
	],
};

export function slotAt(config: BankConfig, bank: number, column: number): Slot | null {
	return config.banks[bank]?.[column] ?? null;
}

/** Every param in the banks, once each, in bank order: the deck watches all of them (PROTOCOL.md, `watch`). */
export function watchList(config: BankConfig): string[] {
	const params: string[] = [];
	for (const bank of config.banks) for (const s of bank) if (s && !params.includes(s.param)) params.push(s.param);
	return params;
}

/** The variant in force for the param's current range. */
export function variantFor(s: Slot, range: Range | null | undefined): SlotVariant {
	return isKelvinRange(range) && s.kelvin ? s.kelvin : s;
}

// ---- banks.json ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const SLOT_KEYS = new Set(["param", "label", "step", "fine", "precision", "unit", "signed", "kelvin"]);
const VARIANT_KEYS = new Set(["step", "fine", "precision", "unit", "signed"]);
const TOP_KEYS = new Set(["banks", "acceleration", "help"]);

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

function readVariant(raw: Obj, where: string, errors: string[], defaults: Omit<SlotVariant, "step" | "fine">, keys: Set<string>): SlotVariant | null {
	for (const key of Object.keys(raw)) if (!keys.has(key)) errors.push(`${where}.${key} isn't a slot field (${[...keys].join(", ")})`);
	const before = errors.length;
	const step = readAmount(raw.step, `${where}.step`, errors);
	const fine = raw.fine === undefined ? (step === undefined ? undefined : step / 4) : readAmount(raw.fine, `${where}.fine`, errors);
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
	if (errors.length > before || step === undefined || fine === undefined) return null;
	return { step, fine, precision, unit, signed };
}

function readSlot(raw: unknown, where: string, errors: string[]): Slot | null {
	if (raw === null) return null;
	if (!isObj(raw)) {
		errors.push(`${where} must be a slot object or null`);
		return null;
	}
	const before = errors.length;
	const param = raw.param;
	if (typeof param !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(param)) {
		errors.push(`${where}.param must be an LrDevelopController parameter name such as "Exposure"`);
	}
	const label = raw.label;
	if (typeof label !== "string" || label.trim() === "" || label.length > 24) errors.push(`${where}.label must be a non-empty string of at most 24 characters`);
	const base = readVariant(raw, where, errors, { precision: 0, unit: "", signed: true }, SLOT_KEYS);
	let kelvin: SlotVariant | null = null;
	if (raw.kelvin !== undefined && raw.kelvin !== null) {
		if (isObj(raw.kelvin)) kelvin = readVariant(raw.kelvin, `${where}.kelvin`, errors, { precision: 0, unit: "K", signed: false }, VARIANT_KEYS);
		else errors.push(`${where}.kelvin must be an object or null`);
	}
	if (errors.length > before || !base || typeof param !== "string" || typeof label !== "string") return null;
	return { param, label, ...base, kelvin };
}

/**
 * Parses banks.json. Any problem makes the whole file invalid: `config` is then the built-in defaults and
 * `errors` says why, so a typo never leaves the dials half-configured.
 */
export function parseBanks(text: string): { config: BankConfig; errors: string[] } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return { config: DEFAULT_BANKS, errors: [`not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
	}
	const errors: string[] = [];
	if (!isObj(raw)) return { config: DEFAULT_BANKS, errors: ["the file must hold a JSON object with a banks list"] };
	for (const key of Object.keys(raw)) {
		if (!TOP_KEYS.has(key) && !key.startsWith("_") && !key.startsWith("$")) errors.push(`${key} isn't a top-level field (banks, acceleration, help)`);
	}
	let acceleration = DEFAULT_BANKS.acceleration;
	if (raw.acceleration !== undefined) {
		if (typeof raw.acceleration === "number" && Number.isFinite(raw.acceleration) && raw.acceleration >= 0 && raw.acceleration <= 4) acceleration = raw.acceleration;
		else errors.push("acceleration must be a number from 0 (none) to 4");
	}
	const banks: Bank[] = [];
	if (!Array.isArray(raw.banks) || raw.banks.length === 0 || raw.banks.length > MAX_BANKS) {
		errors.push(`banks must be a list of 1 to ${MAX_BANKS} banks`);
	} else {
		raw.banks.forEach((bank: unknown, b: number) => {
			const where = `banks[${b}]`;
			if (!Array.isArray(bank) || bank.length === 0 || bank.length > DIALS_PER_BANK) {
				errors.push(`${where} must be a list of 1 to ${DIALS_PER_BANK} slots (null for an empty one)`);
				return;
			}
			const slots = bank.map((s: unknown, i: number) => readSlot(s, `${where}[${i}]`, errors));
			while (slots.length < DIALS_PER_BANK) slots.push(null);
			if (slots.every((s) => s === null)) errors.push(`${where} has no slots`);
			banks.push(slots);
		});
	}
	if (errors.length > 0) return { config: DEFAULT_BANKS, errors };
	return { config: { banks, acceleration }, errors: [] };
}

/** Reads banks.json at startup. A missing or invalid file falls back to the built-in banks, with a warning. */
export function loadBanksFile(file: string): { config: BankConfig; warnings: string[] } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code ?? String(err);
		return { config: DEFAULT_BANKS, warnings: [`couldn't read ${file} (${code}); using the built-in banks`] };
	}
	const { config, errors } = parseBanks(text);
	if (errors.length === 0) return { config, warnings: [] };
	const shown = errors.slice(0, 8).join("; ");
	const more = errors.length > 8 ? ` (and ${errors.length - 8} more)` : "";
	return { config, warnings: [`${file} is invalid, so the built-in banks are in use: ${shown}${more}`] };
}
