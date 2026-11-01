import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { deckRoot } from "./wait.js";

type Obj = Record<string, unknown>;
export type Photo = { id: string; file: string; fmt: string; flag: number; rating: number; label: string; values: Record<string, number> };
export type Setup = {
	catalog?: string;
	module?: string;
	photos?: Photo[];
	target?: string;
	selected?: string[];
	ranges?: Record<string, Record<string, [number, number]>>;
	presets?: Obj[];
	autoAdvance?: boolean;
	watch?: string[];
};
/** One line of a fixture conversation (PROTOCOL.md, Fixtures). */
export type FixtureLine =
	| { note: string }
	| { setup: Setup }
	| { deck: Obj }
	| { raw: string }
	| { lr: Obj }
	| { never: Obj }
	| { user: Obj }
	| { wait: number }
	| { expect: Obj };
export type Fixture = { name: string; lines: FixtureLine[]; setup: Setup };

/** The guard's test catalog, PROTOCOL.md's default for `setup.catalog`. */
export const TEST_CATALOG = "/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat";

export function fixturesDir(): string {
	return path.join(deckRoot(), "..", "protocol", "fixtures");
}

export function loadFixtures(): Fixture[] {
	const dir = fixturesDir();
	return readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.sort()
		.map((name) => {
			const lines = readFileSync(path.join(dir, name), "utf8")
				.split("\n")
				.filter((l) => l.trim() !== "")
				.map((l, i) => {
					try {
						return JSON.parse(l) as FixtureLine;
					} catch (err) {
						throw new Error(`${name}:${i + 1} isn't JSON: ${String(err)}`);
					}
				});
			// PROTOCOL.md calls setup the first line; the files open with a note, which is ignored, so it's the first non-note line.
			const first = lines.find((l) => !("note" in l));
			if (!first || !("setup" in first)) throw new Error(`${name}: the first line after the notes isn't a setup`);
			return { name, lines, setup: first.setup };
		});
}

/** PROTOCOL.md's setup defaults: `target` is the first id in `selected`, or else the first photo. */
export function targetPhoto(setup: Setup): Photo | undefined {
	const photos = setup.photos ?? [];
	const id = setup.target ?? setup.selected?.[0];
	return photos.find((p) => p.id === id) ?? photos[0];
}

/** `selected` defaults to `[target]`, and a target missing from it is added. */
function selectedIds(setup: Setup): string[] {
	const photo = targetPhoto(setup);
	const ids = setup.selected ?? (photo ? [photo.id] : []);
	return photo && !ids.includes(photo.id) ? [...ids, photo.id] : ids;
}

/** setup.ranges, or PROTOCOL.md's defaults: the measured raw ranges for RAW and DNG, and -100..100 Temperature and Tint for JPG. */
export function rangesFor(setup: Setup, photo: Photo): Record<string, [number, number]> {
	const out: Record<string, [number, number]> = {};
	for (const p of Object.keys(photo.values)) out[p] = [-100, 100];
	if (photo.fmt === "JPG") {
		out.Exposure = [-5, 5];
	} else {
		out.Temperature = [2000, 50000];
		out.Tint = [-150, 150];
		out.Exposure = [-5, 5];
	}
	return { ...out, ...(setup.ranges?.[photo.fmt] ?? {}) };
}

/** What Lightroom sends when the deck connects, given the setup: hello, then state. */
export function connectHello(setup: Setup, inst: string): Obj {
	const catalog = setup.catalog ?? TEST_CATALOG;
	return {
		t: "hello",
		v: 1,
		lr: "15.3",
		catalog: path.basename(catalog),
		path: catalog,
		guard: "on",
		writable: catalog.toLowerCase() === TEST_CATALOG.toLowerCase(),
		inst,
	};
}

/** The state Lightroom sends on connect. A setup has no locked photos, and `locked` is false without a target photo anyway. */
export function connectState(setup: Setup): Obj {
	const photo = targetPhoto(setup);
	return {
		t: "state",
		module: setup.module ?? "develop",
		photo: photo?.id ?? null,
		file: photo?.file ?? null,
		flag: photo?.flag ?? 0,
		rating: photo?.rating ?? 0,
		label: photo?.label ?? "none",
		sel: selectedIds(setup).length,
		locked: false,
	};
}

/**
 * ranges and vals for `params`, as Lightroom sends them in Develop after a watch, on entering Develop and
 * on every photo change. Empty outside Develop.
 */
export function watchedValues(setup: Setup, params: readonly string[]): Obj[] {
	const photo = targetPhoto(setup);
	if ((setup.module ?? "develop") !== "develop" || !photo) return [];
	const ranges = rangesFor(setup, photo);
	const r: Record<string, [number, number]> = {};
	const v: Record<string, number> = {};
	for (const p of params) {
		const range = ranges[p];
		const value = photo.values[p];
		if (range) r[p] = range;
		if (value !== undefined) v[p] = value;
	}
	return [
		{ t: "ranges", ranges: r },
		{ t: "vals", vals: v },
	];
}

/** Replaces the fixtures' "*" wildcards with plausible concrete values, so an lr line can be sent as Lightroom would. */
export function concrete(value: unknown, inst: string, key = ""): unknown {
	if (value === "*") {
		if (key === "lt") return 812345.25;
		if (key === "inst") return inst;
		if (key === "id" || key === "n" || key === "locked" || key === "g") return 1;
		return "fixture";
	}
	if (Array.isArray(value)) return value.map((v) => concrete(v, inst));
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, concrete(v, inst, k)]));
	}
	return value;
}
