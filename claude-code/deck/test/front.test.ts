import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CLAUDE_BUNDLE_ID, type ExecFile, FRONT_CHECK_MS, FRONT_STUCK_MS, FrontWatcher, LSAPPINFO, lsappinfoCheck, parseBundleId, parseFrontAsn } from "../src/model/front.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { RecordingLog } from "./helpers/recording-log.js";

/** Lets the check's promises settle. */
const settle = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** An execFile that answers each command from a table, and records each call; nothing is spawned. */
function fakeExec(answers: Record<string, { err?: Error; stdout?: string }>): {
	exec: ExecFile;
	calls: { file: string; args: string[]; timeout: number; killSignal: string; encoding: string }[];
} {
	const calls: { file: string; args: string[]; timeout: number; killSignal: string; encoding: string }[] = [];
	const exec: ExecFile = (file, args, opts, callback) => {
		calls.push({ file, args: [...args], timeout: opts.timeout, killSignal: opts.killSignal, encoding: opts.encoding });
		const answer = answers[args[0] ?? ""] ?? { err: new Error("no such command") };
		queueMicrotask(() => callback(answer.err ?? null, answer.stdout ?? "", ""));
	};
	return { exec, calls };
}

describe("the front-app check (lsappinfo)", () => {
	test("reads lsappinfo's answers as this Mac gives them", () => {
		assert.equal(parseFrontAsn("ASN:0x0-0x620620:\n"), "ASN:0x0-0x620620:");
		assert.equal(parseFrontAsn("  ASN:0x0-0x1A01a0:  "), "ASN:0x0-0x1A01a0:");
		for (const bad of ["", "\n", "ASN:", "ASN:0x0-0x620620", "ASN:0x0-0x62; rm -rf /:", "error"]) assert.equal(parseFrontAsn(bad), null, JSON.stringify(bad));
		assert.equal(parseBundleId('"CFBundleIdentifier"="com.anthropic.claudefordesktop"\n'), CLAUDE_BUNDLE_ID);
		assert.equal(parseBundleId('"CFBundleIdentifier"="com.adobe.LightroomClassicCC7"'), "com.adobe.LightroomClassicCC7");
		assert.equal(parseBundleId('"CFBundleIdentifier"=[ NULL ] '), null);
		assert.equal(parseBundleId(""), null);
	});

	test("asks /usr/bin/lsappinfo front, then info -only bundleid for that app, each with a 1 s timeout and SIGKILL after it, and compares the bundle id", async () => {
		const { exec, calls } = fakeExec({ front: { stdout: "ASN:0x0-0x620620:\n" }, info: { stdout: `"CFBundleIdentifier"="${CLAUDE_BUNDLE_ID}"\n` } });
		assert.equal(await lsappinfoCheck({ execFile: exec })(), true);
		assert.deepEqual(calls, [
			{ file: LSAPPINFO, args: ["front"], timeout: 1000, killSignal: "SIGKILL", encoding: "utf8" },
			{ file: LSAPPINFO, args: ["info", "-only", "bundleid", "ASN:0x0-0x620620:"], timeout: 1000, killSignal: "SIGKILL", encoding: "utf8" },
		]);
		assert.equal(LSAPPINFO, "/usr/bin/lsappinfo");
		const other = fakeExec({ front: { stdout: "ASN:0x0-0x1:\n" }, info: { stdout: '"CFBundleIdentifier"="com.apple.finder"' } });
		assert.equal(await lsappinfoCheck({ execFile: other.exec })(), false);
	});

	test("a failure counts as not in front: an error, a timeout, or an answer it can't read; the first of each is warned of once", async () => {
		const log = new RecordingLog();
		const failing = fakeExec({ front: { err: Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" }) } });
		const check = lsappinfoCheck({ execFile: failing.exec, log });
		assert.equal(await check(), false);
		assert.equal(await check(), false);
		assert.equal(log.at("warn").length, 1, log.at("debug").join("\n"));
		assert.equal(log.at("debug").length, 2);
		const unreadable = fakeExec({ front: { stdout: "nothing\n" } });
		assert.equal(await lsappinfoCheck({ execFile: unreadable.exec })(), false);
		assert.equal(unreadable.calls.length, 1, "no second call without an app");
		const infoFails = fakeExec({ front: { stdout: "ASN:0x0-0x2:\n" }, info: { err: new Error("boom") } });
		assert.equal(await lsappinfoCheck({ execFile: infoFails.exec })(), false);
		const nullApp = fakeExec({ front: { stdout: "ASN:0x0-0x2:\n" }, info: { stdout: '"CFBundleIdentifier"=[ NULL ] ' } });
		assert.equal(await lsappinfoCheck({ execFile: nullApp.exec })(), false);
	});
});

describe("the front-app check's gate (FrontWatcher)", () => {
	function setup(answer: () => Promise<boolean> = async () => true) {
		const clock = new FakeClock();
		const log = new RecordingLog();
		let asks = 0;
		let fronts = 0;
		const watcher = new FrontWatcher(
			() => {
				asks++;
				return answer();
			},
			() => fronts++,
			{ clock, log },
		);
		return { clock, log, watcher, asks: () => asks, fronts: () => fronts };
	}

	test("asks nothing while nothing needs it", async () => {
		const { clock, watcher, asks } = setup();
		watcher.want(false);
		for (let i = 0; i < 20; i++) {
			clock.advance(500);
			await settle();
		}
		assert.equal(asks(), 0);
		assert.equal(clock.pendingTimers, 0);
	});

	test("asks at once when needed, then once a second while it is, and stops when it isn't", async () => {
		assert.equal(FRONT_CHECK_MS, 1000);
		const { clock, watcher, asks, fronts } = setup(async () => false);
		watcher.want(true);
		assert.equal(asks(), 1);
		await settle();
		// Being told again that it's needed asks nothing more within the second.
		watcher.want(true);
		watcher.want(true);
		assert.equal(asks(), 1);
		for (let i = 0; i < 5; i++) {
			clock.advance(FRONT_CHECK_MS);
			await settle();
		}
		assert.equal(asks(), 6);
		assert.equal(fronts(), 0, "never in front");
		watcher.want(false);
		clock.advance(10_000);
		await settle();
		assert.equal(asks(), 6);
		// Wanted again soon after the last ask: it waits out the second.
		watcher.want(true);
		assert.equal(asks(), 7, "the last ask was over a second ago");
		await settle();
		watcher.want(false);
		watcher.want(true);
		assert.equal(asks(), 7);
		clock.advance(FRONT_CHECK_MS);
		await settle();
		assert.equal(asks(), 8);
	});

	test("never asks twice at once: a check that hasn't answered holds the next, however often it's wanted meanwhile", async () => {
		let release: (v: boolean) => void = () => {};
		const { clock, watcher, asks, fronts } = setup(() => new Promise<boolean>((resolve) => (release = resolve)));
		watcher.want(true);
		clock.advance(3 * FRONT_CHECK_MS);
		await settle();
		assert.equal(asks(), 1);
		// The model says it's wanted on every change: still the one check, though its second has long passed.
		watcher.want(true);
		watcher.want(true);
		clock.advance(FRONT_CHECK_MS);
		watcher.want(true);
		await settle();
		assert.equal(asks(), 1);
		release(true);
		await settle();
		assert.equal(fronts(), 1);
		// The next comes a second after the last ask began, which has passed.
		assert.equal(asks(), 2);
	});

	test("a check that never answers is given up on after FRONT_STUCK_MS: a warn line, the next ask, and its late answer counts for nothing", async () => {
		assert.ok(FRONT_STUCK_MS > 2 * 1000, "past the two calls' timeouts");
		const pending: ((v: boolean) => void)[] = [];
		const { clock, log, watcher, asks, fronts } = setup(() => new Promise<boolean>((resolve) => pending.push(resolve)));
		watcher.want(true);
		clock.advance(FRONT_STUCK_MS - 1);
		await settle();
		assert.equal(asks(), 1);
		assert.equal(log.at("warn").length, 0);
		clock.advance(1);
		await settle();
		assert.equal(asks(), 2, "asked again");
		assert.deepEqual(log.at("warn").map((l) => l.replace(/\d+ ms/, "N ms")), ["warn front app check: no answer in N ms; given up on, and asked again"]);
		pending[0]?.(true);
		await settle();
		assert.equal(fronts(), 0, "the first check's late answer counts for nothing");
		pending[1]?.(true);
		await settle();
		assert.equal(fronts(), 1, "the current one's does");
		// Stuck again: a debug line this time, not another warn.
		clock.advance(FRONT_CHECK_MS);
		await settle();
		clock.advance(FRONT_STUCK_MS);
		await settle();
		assert.equal(log.at("warn").length, 1);
		assert.ok(log.at("debug").some((l) => l.includes("given up on")), log.at("debug").join("\n"));
		watcher.dispose();
		assert.equal(clock.pendingTimers, 0, "dispose stops the watchdog too");
	});

	test("a check that throws or rejects counts as not in front", async () => {
		let n = 0;
		const { clock, watcher, asks, fronts } = setup(() => {
			n++;
			if (n === 1) throw new Error("sync");
			return Promise.reject(new Error("async"));
		});
		watcher.want(true);
		await settle();
		clock.advance(FRONT_CHECK_MS);
		await settle();
		assert.equal(asks(), 2);
		assert.equal(fronts(), 0);
	});

	test("a check that answers once it isn't wanted any more marks nothing; after dispose, nothing at all", async () => {
		let release: (v: boolean) => void = () => {};
		const { clock, watcher, asks, fronts } = setup(() => new Promise<boolean>((resolve) => (release = resolve)));
		watcher.want(true);
		watcher.want(false);
		release(true);
		await settle();
		assert.equal(fronts(), 0);
		watcher.dispose();
		watcher.want(true);
		clock.advance(5000);
		await settle();
		assert.equal(asks(), 1);
	});
});
