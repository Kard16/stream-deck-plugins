import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { SessionModel } from "../src/model/sessions.js";
import { asVersion, checkedVersion, compareVersions, pluginVersion, VersionCheck, type VersionFiles, versionFiles } from "../src/model/versions.js";
import type { RegistrySession } from "../src/registry/registry.js";
import { idleCounts, resetIdleCounts } from "../src/util/idle.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { deckRoot } from "./helpers/paths.js";
import { RecordingLog } from "./helpers/recording-log.js";

const root = mkdtempSync(path.join(os.tmpdir(), "claude-deck-versions-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** The reference's first lines, as vendor/refresh.mjs writes them. */
function writeReference(f: VersionFiles, cc: string): void {
	writeFileSync(f.reference, `// Written by Claude Code ${cc}.\n// Claude Code function hooks: the plugin API's TypeScript declarations.\n//\n`);
}

function writePlugin(f: VersionFiles, version: string): void {
	writeFileSync(f.plugin, `${JSON.stringify({ name: "streamdeck-bridge", version, description: "Reports this session's status…" }, null, 2)}\n`);
}

let made = 0;
/** The two files in a folder of their own, each written when its version is given. */
function files(cc: string | null, plugin: string | null): VersionFiles {
	const dir = path.join(root, String(++made));
	mkdirSync(dir);
	const f = { reference: path.join(dir, "claude-code.d.ts"), plugin: path.join(dir, "plugin.json") };
	if (cc !== null) writeReference(f, cc);
	if (plugin !== null) writePlugin(f, plugin);
	return f;
}

const A = "local_a";
const B = "local_b";
const C = "local_c";
const SIDS: Record<string, string> = { [A]: "sid-1", [B]: "sid-2", [C]: "sid-3" };

function reg(pid: number, host: string): RegistrySession {
	return { key: String(pid), name: `Session ${pid}`, status: "idle", cwd: `/p/${pid}`, hostSessionId: host, sessionId: `sid-${pid}`, statusUpdatedAt: 1000, startedAt: pid };
}

/** A model with three listed sessions, holding hellos to the two files; `log` is the check's own. */
function setup(f: VersionFiles) {
	const log = new RecordingLog();
	const versions = new VersionCheck(f, { log });
	const model = new SessionModel({ clock: new FakeClock(), log: new RecordingLog(), versions });
	model.setRegistry([reg(1, A), reg(2, B), reg(3, C)]);
	/** A hello from `inst` of the session on `host`, with the hello's other fields. */
	const hello = (host: string, inst: string, fields: Record<string, unknown> = {}): void => {
		const answer = model.hello({ v: 1, sid: SIDS[host], host, inst, model: "m", ...fields });
		assert.ok(!(answer instanceof Promise), "answered at once");
		assert.equal(answer.status, 200);
	};
	/** The check's info lines after the one at startup. */
	const said = (): string[] => log.lines.filter((l) => l.level === "info").slice(1).map((l) => l.message);
	return { model, versions, log, hello, said, view: (host: string) => model.session(host) };
}

const NEWER = (cc: string, host: string, checked: string): string =>
	`Claude Code ${cc} in ${host}: newer than ${checked}, which the repo was checked against; run the routine after an update (CLAUDE.md)`;
const OLDER = (host: string, plugin: string, repo: string): string => `${host} runs plugin ${plugin}, older than ${repo} in the repo: it loads the new one when it next starts`;

describe("the versions a hello is held to (versions.ts, hardening.md C1)", () => {
	test("the reference's first line names the version the repo was checked against, exactly as refresh.mjs writes it and recheck.mjs reads it", () => {
		assert.equal(checkedVersion("// Written by Claude Code 2.1.317.\n// Claude Code function hooks: the plugin API's TypeScript declarations.\n"), "2.1.317");
		assert.equal(checkedVersion("// Written by Claude Code 10.20.300."), "10.20.300");
		for (const head of [
			"",
			"// Written by Claude Code 2.1.317",
			"// Written by Claude Code 2.1.",
			"// Written by Claude Code v2.1.317.",
			"// Written by Claude Code 2.1.317-dev.",
			" // Written by Claude Code 2.1.317.",
			"// Written by Claude Code 2.1.317. ",
			"// Written by Claude Code 2.1.317.\r\n// as recheck.mjs reads it, a CRLF line names none",
			"// Claude Code function hooks\n// Written by Claude Code 2.1.317.",
		])
			assert.equal(checkedVersion(head), null, JSON.stringify(head));
	});

	test("versions compare as x.y.z by number; unknown, or anything else that isn't x.y.z, compares with nothing", () => {
		const sign = (a: string | null, b: string | null): number | null => {
			const d = compareVersions(a, b);
			return d === null ? null : Math.sign(d);
		};
		assert.deepEqual([sign("2.1.318", "2.1.317"), sign("2.1.317", "2.1.318")], [1, -1]);
		assert.deepEqual([sign("2.1.317", "2.1.4"), sign("2.1.4", "2.1.317")], [1, -1], "317 is more than 4, though the text sorts it first");
		assert.deepEqual([sign("10.0.0", "2.1.317"), sign("2.1.317", "10.0.0")], [1, -1], "10 is more than 2, though the text sorts it first");
		assert.deepEqual([sign("2.1.317", "2.1.317"), sign("2.2.0", "2.1.999"), sign("3.0.0", "2.99.99")], [0, 1, 1]);
		for (const unknown of ["unknown", "", "2.1", "2.1.317.1", "v2.1.317", "2.1.318-dev.20261105.t101500.sha1a2b3c4", null]) {
			assert.equal(compareVersions("2.1.317", unknown), null, String(unknown));
			assert.equal(compareVersions(unknown, "2.1.317"), null, String(unknown));
		}
		assert.deepEqual(["2.1.318", "unknown", "2.1", 2, null].map(asVersion), ["2.1.318", null, null, null, null]);
	});

	test("plugin.json's version, when it's x.y.z", () => {
		assert.equal(pluginVersion('{"name":"streamdeck-bridge","version":"0.3.0"}'), "0.3.0");
		for (const json of ['{"version":"0.3"}', '{"version":3}', "{}", "[]", '"0.3.0"', "not JSON", ""]) assert.equal(pluginVersion(json), null, json);
	});

	test("at startup both files are read and said, and newer means newer than the reference's version", () => {
		const log = new RecordingLog();
		const check = new VersionCheck(files("2.1.317", "0.3.0"), { log });
		assert.deepEqual([check.checked, check.plugin], ["2.1.317", "0.3.0"]);
		assert.deepEqual(log.at("info"), ["info the repo was checked against Claude Code 2.1.317, and has plugin 0.3.0"]);
		const newer = ["2.1.318", "10.0.0", "2.1.317", "2.1.4", "unknown", null].map((v) => check.newer(v));
		assert.deepEqual(newer, [true, true, false, false, false, false]);
	});

	test("one line for each newer Claude Code version a run, whichever sessions run it; none for the checked one, an older one or unknown", () => {
		const { hello, said, view } = setup(files("2.1.317", "0.3.0"));
		hello(A, "ia", { cc: "2.1.318", plugin: "0.3.0" });
		hello(A, "ia", { cc: "2.1.318", plugin: "0.3.0" });
		hello(B, "ib", { cc: "2.1.318", plugin: "0.3.0" });
		hello(C, "ic", { cc: "2.1.317", plugin: "0.3.0" });
		hello(C, "ic2", { cc: "unknown", plugin: "0.3.0" });
		hello(B, "ib2", { cc: "2.1.4", plugin: "0.3.0" });
		hello(A, "ia2", { cc: "2.1.319", plugin: "0.3.0" });
		assert.deepEqual(said(), [NEWER("2.1.318", A, "2.1.317"), NEWER("2.1.319", A, "2.1.317")]);
		assert.deepEqual([view(A)?.cc, view(B)?.cc, view(C)?.cc], ["2.1.319", "2.1.4", null]);
		assert.deepEqual([view(A)?.ccNewer, view(B)?.ccNewer, view(C)?.ccNewer], [true, false, false]);
	});

	test("one line for each session on an older plugin, however often and from whichever instance it says hello; none for the repo's or a newer one", () => {
		const { hello, said } = setup(files("2.1.317", "0.3.0"));
		hello(A, "ia", { cc: "2.1.317", plugin: "0.2.1" });
		hello(A, "ia", { cc: "2.1.317", plugin: "0.2.1" });
		hello(A, "ia2", { cc: "2.1.317", plugin: "0.2.1" });
		hello(B, "ib", { cc: "2.1.317", plugin: "0.2.1" });
		hello(C, "ic", { cc: "2.1.317", plugin: "0.3.0" });
		hello(C, "ic2", { cc: "2.1.317", plugin: "0.3.1" });
		hello(C, "ic3", { cc: "2.1.317", plugin: "unknown" });
		assert.deepEqual(said(), [OLDER(A, "0.2.1", "0.3.0"), OLDER(B, "0.2.1", "0.3.0")]);
	});

	test("a refresh or a release mid-run is seen at the next hello that's newer than the file's version, without a restart; a hello that isn't reads nothing", () => {
		const f = files("2.1.317", "0.3.0");
		const { versions, hello, said, view } = setup(f);
		hello(A, "ia", { cc: "2.1.318", plugin: "0.3.0" });
		assert.equal(view(A)?.ccNewer, true);
		// The routine after an update: refresh.mjs rewrites the reference. The session's next hello, as after a Deny, sees it.
		writeReference(f, "2.1.318");
		hello(A, "ia", { cc: "2.1.318", plugin: "0.3.0" });
		assert.deepEqual([versions.checked, view(A)?.ccNewer], ["2.1.318", false]);
		// A hello that isn't newer than what was read reads nothing: the file's change waits for one that is.
		writeReference(f, "2.1.300");
		hello(B, "ib", { cc: "2.1.318", plugin: "0.3.0" });
		assert.equal(versions.checked, "2.1.318");
		hello(C, "ic", { cc: "2.1.319", plugin: "0.3.0" });
		assert.equal(versions.checked, "2.1.300");
		// A release: plugin.json goes to 0.3.1. A newer plugin's hello reads it again; an older one's after that is logged.
		hello(C, "ic", { cc: "2.1.319", plugin: "0.3.1" });
		assert.equal(versions.plugin, "0.3.0", "not released yet: still 0.3.0, and nothing said");
		writePlugin(f, "0.3.1");
		hello(B, "ib2", { cc: "2.1.318", plugin: "0.3.1" });
		hello(A, "ia", { cc: "2.1.318", plugin: "0.3.0" });
		assert.deepEqual(said(), [
			NEWER("2.1.318", A, "2.1.317"),
			"the Claude Code version the repo was checked against is now 2.1.318, not 2.1.317",
			"the Claude Code version the repo was checked against is now 2.1.300, not 2.1.318",
			NEWER("2.1.319", C, "2.1.300"),
			"the plugin's version in the repo is now 0.3.1, not 0.3.0",
			OLDER(A, "0.3.0", "0.3.1"),
		]);
	});

	test("a file that's missing, or names no version: one warn, and nothing marked or said, however many hellos read it again, until a read works", () => {
		const f = files(null, null);
		const { versions, log, hello, said, view } = setup(f);
		const warns = [
			`warn can't read the Claude Code version the repo was checked against from ${f.reference} (ENOENT), so no session's version is marked newer`,
			`warn can't read the plugin's version in the repo from ${f.plugin} (ENOENT), so no session is said to run an older plugin`,
		];
		assert.deepEqual(log.at("warn"), warns);
		assert.equal(log.lines.find((l) => l.level === "info")?.message, "the repo was checked against Claude Code (unknown), and has plugin (unknown)");
		hello(A, "ia", { cc: "2.1.318", plugin: "0.2.1" });
		hello(B, "ib", { cc: "2.1.400", plugin: "0.0.1" });
		writeFileSync(f.reference, "// Claude Code function hooks\n");
		hello(C, "ic", { cc: "2.1.318", plugin: "0.0.1" });
		assert.deepEqual(log.at("warn"), warns, "one warn each, however many reads fail");
		assert.deepEqual(said(), []);
		assert.deepEqual([versions.checked, versions.plugin, view(A)?.cc, view(A)?.ccNewer], [null, null, "2.1.318", false]);
		// It's there now: the next hello with a version reads it.
		writeReference(f, "2.1.317");
		hello(A, "ia", { cc: "2.1.318", plugin: "0.2.1" });
		assert.deepEqual(said(), ["the Claude Code version the repo was checked against is now 2.1.317", NEWER("2.1.318", A, "2.1.317")]);
		assert.equal(view(A)?.ccNewer, true);
		// Gone again at a read: a new failure, so one more warn, and nothing is marked.
		rmSync(f.reference);
		hello(B, "ib", { cc: "2.1.320", plugin: "0.0.1" });
		assert.deepEqual(log.at("warn"), [...warns, warns[0]]);
		assert.deepEqual([versions.checked, view(A)?.ccNewer, view(B)?.ccNewer], [null, false, false]);
		// What a file that's there but names no version says.
		const bad = files(null, null);
		writeFileSync(bad.reference, "// Claude Code function hooks\n// Written by Claude Code 2.1.317.\n");
		writeFileSync(bad.plugin, "not JSON");
		const badLog = new RecordingLog();
		new VersionCheck(bad, { log: badLog });
		assert.deepEqual(badLog.at("warn"), [
			`warn can't read the Claude Code version the repo was checked against from ${bad.reference} (its first line, "// Claude Code function hooks", names no version), so no session's version is marked newer`,
			`warn can't read the plugin's version in the repo from ${bad.plugin} (it has no version that reads x.y.z), so no session is said to run an older plugin`,
		]);
	});

	test("a session's view carries its Claude Code version from a hello that counts, frozen and built once per change as every view", () => {
		const { model, hello, said, view } = setup(files("2.1.317", "0.3.0"));
		assert.deepEqual([view(A)?.cc, view(A)?.ccNewer], [null, false], "before a hello");
		hello(A, "ia", { cc: "2.1.318", plugin: "0.3.0" });
		assert.deepEqual([view(A)?.cc, view(A)?.ccNewer], ["2.1.318", true]);
		assert.ok(Object.isFrozen(view(A)));
		resetIdleCounts();
		assert.equal(view(A), view(A));
		assert.equal(idleCounts().view ?? 0, 0, "read again with no change, none is built");
		// ib replaces ia; ia's hello, said again, doesn't count: it neither gives the version nor is held to the repo's.
		hello(A, "ib", { cc: "2.1.317", plugin: "0.3.0" });
		hello(A, "ia", { cc: "2.1.319", plugin: "0.2.1" });
		assert.deepEqual([view(A)?.cc, view(A)?.ccNewer], ["2.1.317", false]);
		assert.deepEqual(said(), [NEWER("2.1.318", A, "2.1.317")]);
		// `unknown`, the mod's when it can't read one, is no version, and nor is a hello without one.
		hello(B, "ib", { cc: "unknown", plugin: "0.3.0" });
		hello(C, "ic");
		assert.deepEqual([view(B)?.cc, view(C)?.cc], [null, null]);
		// A slotted session that isn't running has its record alone.
		model.keepHosts(["local_gone"]);
		assert.deepEqual([model.slotView("local_gone")?.cc, model.slotView("local_gone")?.ccNewer], [null, false]);
	});

	test("the deck's plugin folder finds the repo's reference and plugin.json, and both read", () => {
		const f = versionFiles(path.join(deckRoot(), "com.karimdhanji.claude.sdPlugin"));
		assert.deepEqual(f, {
			reference: path.join(deckRoot(), "..", "vendor", "checked-version.txt"),
			plugin: path.join(deckRoot(), "..", "plugin", ".claude-plugin", "plugin.json"),
		});
		const log = new RecordingLog();
		const check = new VersionCheck(f, { log });
		assert.deepEqual(log.at("warn"), []);
		assert.match(check.checked ?? "", /^\d+\.\d+\.\d+$/);
		assert.match(check.plugin ?? "", /^\d+\.\d+\.\d+$/);
	});
});
