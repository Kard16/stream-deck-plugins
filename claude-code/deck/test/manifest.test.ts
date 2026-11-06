import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { SLOT_LAYOUTS } from "../src/slots/strip.js";
import { deckRoot } from "./helpers/paths.js";

const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(deckRoot(), file), "utf8")) as Record<string, unknown>;

describe("the plugin's version", () => {
	test("the manifest's Version is package.json's, with a fourth part of 0, and the lock file's matches", () => {
		const manifest = read("com.karimdhanji.claude.sdPlugin/manifest.json");
		const pkg = read("package.json");
		const lock = read("package-lock.json") as { version?: unknown; packages?: Record<string, { version?: unknown }> };
		assert.equal(manifest.Version, "0.5.0.0");
		assert.equal(manifest.Version, `${String(pkg.version)}.0`);
		assert.deepEqual([lock.version, lock.packages?.[""]?.version], [pkg.version, pkg.version]);
	});
});

describe("npm test (package.json's test script)", () => {
	test("gives every test a deadline of a minute at most, and exits once the last test has run: an answer that never comes fails its test instead of holding up the run", () => {
		const scripts = read("package.json").scripts as Record<string, unknown> | undefined;
		const script = String(scripts?.test ?? "");
		// node --test takes its flags before the files only: one after them is ignored, as `npm test -- --test-timeout=…` is.
		const run = /\bnode --test((?: --[a-z-]+(?:=\S+)?)*) build\/test\/test\/\*\.test\.js$/.exec(script);
		assert.ok(run, `the script runs node --test on the built tests, its flags first: ${script}`);
		const flags = (run[1] ?? "").trim().split(" ");
		const timeout = flags.find((f) => f.startsWith("--test-timeout="));
		const ms = Number(timeout?.slice("--test-timeout=".length));
		assert.ok(Number.isInteger(ms) && ms > 0 && ms <= 60_000, `each test has a deadline (--test-timeout) of a minute at most: ${script}`);
		// A test that runs out of time never reaches its own clean-up, and what it left open would keep node running.
		assert.ok(flags.includes("--test-force-exit"), `the run ends with its last test (--test-force-exit): ${script}`);
	});
});

type ManifestAction = {
	UUID: string;
	Name: string;
	Tooltip: string;
	Icon: string;
	Controllers: string[];
	SupportedInMultiActions?: boolean;
	UserTitleEnabled?: boolean;
	States: { Image: string }[];
	Encoder?: { layout: string; Icon: string; TriggerDescription: Record<string, string> };
};

describe("the manifest's actions", () => {
	const manifest = read("com.karimdhanji.claude.sdPlugin/manifest.json") as { Description: string; Actions: ManifestAction[] };
	const byUuid = (uuid: string): ManifestAction => {
		const a = manifest.Actions.find((x) => x.UUID === uuid);
		assert.ok(a, uuid);
		return a;
	};
	const sdPlugin = (rel: string): string => path.join(deckRoot(), "com.karimdhanji.claude.sdPlugin", rel);

	test("Session Slot: keys and dials, not in a multi-action, no user title, with its dial's layout, icon and trigger descriptions", () => {
		const slot = byUuid("com.karimdhanji.claude.slot");
		assert.equal(slot.Name, "Session Slot");
		assert.deepEqual(slot.Controllers, ["Keypad", "Encoder"]);
		assert.equal(slot.SupportedInMultiActions, false);
		assert.equal(slot.UserTitleEnabled, false);
		assert.deepEqual(slot.Encoder?.TriggerDescription, {
			Rotate: "Page details or pick an answer",
			Push: "Jump, or send the answer",
			Touch: "Jump, or send the answer",
			LongTouch: "Back a step",
		});
		// The layout before the plugin's first paint: one of the dial's own, which the plugin then switches.
		assert.ok((Object.values(SLOT_LAYOUTS) as string[]).includes(slot.Encoder?.layout ?? ""), slot.Encoder?.layout);
		assert.match(slot.Tooltip, /Press to jump/);
		assert.match(slot.Tooltip, /hold to put the session on screen in the app on this key/);
	});

	test("Other Sessions: keys only, not in a multi-action, no user title", () => {
		const others = byUuid("com.karimdhanji.claude.others");
		assert.equal(others.Name, "Other Sessions");
		assert.deepEqual(others.Controllers, ["Keypad"]);
		assert.equal(others.SupportedInMultiActions, false);
		assert.equal(others.UserTitleEnabled, false);
		assert.equal(others.Encoder, undefined);
	});

	test("every image an action names is there, as SVG or PNG, and every encoder layout file", () => {
		const image = (rel: string): boolean => existsSync(sdPlugin(`${rel}.svg`)) || existsSync(sdPlugin(`${rel}.png`));
		for (const a of manifest.Actions) {
			assert.ok(image(a.Icon), `${a.UUID}: ${a.Icon}`);
			for (const st of a.States) assert.ok(image(st.Image), `${a.UUID}: ${st.Image}`);
			if (a.Encoder) {
				assert.ok(image(a.Encoder.Icon), `${a.UUID}: ${a.Encoder.Icon}`);
				assert.ok(existsSync(sdPlugin(a.Encoder.layout)), `${a.UUID}: ${a.Encoder.layout}`);
			}
		}
	});

	test("each action has its class, with the manifest's UUID, and plugin.ts registers each one", () => {
		const actionsDir = path.join(deckRoot(), "src", "actions");
		const declared = new Map<string, string>();
		for (const file of readdirSync(actionsDir).filter((f) => f.endsWith(".ts"))) {
			const text = readFileSync(path.join(actionsDir, file), "utf8");
			for (const m of text.matchAll(/@action\(\{ UUID: "([^"]+)" \}\)\s*export class (\w+)/g)) declared.set(m[1] ?? "", m[2] ?? "");
		}
		assert.deepEqual([...declared.keys()].sort(), manifest.Actions.map((a) => a.UUID).sort());
		const plugin = readFileSync(path.join(deckRoot(), "src", "plugin.ts"), "utf8");
		for (const [uuid, cls] of declared) assert.match(plugin, new RegExp(`registerAction\\(new ${cls}\\(`), `${uuid}: ${cls} is registered`);
	});

	test("the plugin's Description names the session keys", () => {
		assert.match(manifest.Description, /a key and a dial for each session/);
	});
});
