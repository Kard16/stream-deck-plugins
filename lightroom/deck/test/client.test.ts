import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { backoffDelay, type ClientTiming, type ConnState, DEFAULT_TIMING, LrClient, LrError } from "../src/lr/client.js";
import { LrModel } from "../src/model/model.js";
import { FakeLr, standardLightroom } from "./helpers/fake-lr.js";
import { sleep, waitFor } from "./helpers/wait.js";

/** PROTOCOL.md's timings scaled down about ten times, so heartbeat and backoff tests take a second or two. */
const FAST: Partial<ClientTiming> = {
	backoffMinMs: 40,
	backoffMaxMs: 320,
	pingIntervalMs: 120,
	staleMs: 600,
	okWindowMs: 200,
	okResyncMs: 100,
	tickMs: 15,
	connectTimeoutMs: 2000,
	errRouteTtlMs: 2000,
	requestTimeoutMs: 1000,
};

const WATCH = ["Temperature", "Tint", "Exposure", "Contrast"];

const hello = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	t: "hello",
	v: 1,
	lr: "15.3",
	catalog: "Plugin Test.lrcat",
	path: "/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat",
	guard: "on",
	writable: true,
	inst: "inst-A",
	...extra,
});
const state = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	t: "state",
	module: "develop",
	photo: "101",
	file: "DSC0101.ARW",
	flag: 0,
	rating: 0,
	label: "none",
	sel: 1,
	...extra,
});

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const fn of cleanups.reverse()) await fn();
	cleanups = [];
});

async function setup(lrOpts: Parameters<typeof FakeLr.start>[0], timing: Partial<ClientTiming> = FAST) {
	const lr = await FakeLr.start(lrOpts);
	const client = new LrClient({ cmdPort: lr.cmdPort, evtPort: lr.evtPort, ver: "0.2.0-test", watch: WATCH, timing });
	const states: ConnState[] = [];
	client.on("state", (s) => states.push(s));
	cleanups.push(async () => {
		client.stop();
		await lr.close();
	});
	return { lr, client, states };
}

/** Every command the fake received must pass the PROTOCOL.md shape check. */
function assertValidCommands(lr: FakeLr): void {
	assert.deepEqual(
		lr.invalid.map((r) => `${r.line}: ${r.problems.join("; ")}`),
		[],
	);
}

describe("LrClient", () => {
	test("backoff starts at 250 ms and doubles to at most 2 s, forever", () => {
		assert.deepEqual(
			[0, 1, 2, 3, 4, 5, 10, 100].map((n) => backoffDelay(n)),
			[250, 500, 1000, 2000, 2000, 2000, 2000, 2000],
		);
		assert.equal(DEFAULT_TIMING.pingIntervalMs, 2000);
		assert.equal(DEFAULT_TIMING.staleMs, 6000);
		assert.equal(DEFAULT_TIMING.okWindowMs, 1500);
	});

	test("connects both sockets, says hello, goes online and watches the bank params once", async () => {
		const { lr, client } = await setup(standardLightroom(hello(), state()));
		client.start();
		await waitFor(() => client.state === "online", "online");
		await waitFor(() => lr.commands("watch").length === 1, "watch");
		const [first] = lr.commands();
		assert.deepEqual(first, { t: "hello", v: 1, client: "deck", ver: "0.2.0-test" });
		assert.deepEqual(lr.commands("watch")[0], { t: "watch", ps: WATCH });
		assert.equal(client.hello?.inst, "inst-A");
		await sleep(300); // a couple of pings, and the second hello's answer
		assert.equal(lr.commands("watch").length, 1, "watch goes out once per connection");
		assert.ok(lr.commands("ping").length >= 1, "pings every pingIntervalMs");
		assert.equal(client.stats.badLines, 0);
		assertValidCommands(lr);
	});

	test("the pair rule: losing the event socket closes the command socket too, then both reconnect", async () => {
		const { lr, client } = await setup(standardLightroom(hello(), state()));
		client.start();
		await waitFor(() => client.state === "online", "online");
		lr.dropEvt();
		await waitFor(() => lr.cmdConns[0]?.closedAt !== null, "the deck to close its command socket");
		assert.equal(client.state === "online", false);
		await waitFor(() => lr.cmdConns.length === 2 && lr.evtConns.length === 2 && client.state === "online", "both sockets to reconnect");
		assertValidCommands(lr);
	});

	test("the pair rule: losing the command socket closes the event socket too", async () => {
		const { lr, client } = await setup(standardLightroom(hello(), state()));
		client.start();
		await waitFor(() => client.state === "online", "online");
		lr.dropCmd();
		await waitFor(() => lr.evtConns[0]?.closedAt !== null, "the deck to close its event socket");
		await waitFor(() => lr.evtConns.length === 2 && client.state === "online", "reconnect");
	});

	test("the pair rule: a refused command socket closes the connected event socket, and retries continue", async () => {
		const { lr, client, states } = await setup({ noCmdServer: true });
		client.start();
		await waitFor(() => lr.evtConns.length >= 3, "three attempts");
		await waitFor(() => lr.evtConns.slice(0, 3).every((c) => c.closedAt !== null), "the deck to close each event connection");
		assert.deepEqual(states, [], "never left offline");
	});

	test("reconnects with backoff that doubles from the minimum to the maximum", async () => {
		const { lr, client } = await setup({ refuse: true });
		client.start();
		await waitFor(() => lr.evtConns.length >= 7, "seven attempts", 6000);
		const times = lr.evtConns.map((c) => c.acceptedAt);
		const gaps = times.slice(1, 7).map((t, i) => t - (times[i] ?? 0));
		const expected = [40, 80, 160, 320, 320, 320];
		gaps.forEach((gap, i) => {
			const want = expected[i] ?? 0;
			assert.ok(gap >= want - 5 && gap <= want + 150, `gap ${i} was ${gap} ms, expected about ${want} (gaps ${gaps.join(", ")})`);
		});
	});

	test("a session that said hello starts the backoff again from the minimum", async () => {
		const { lr, client } = await setup(standardLightroom(hello(), state()));
		client.start();
		await waitFor(() => client.state === "online", "online");
		const droppedAt = Date.now();
		lr.dropEvt();
		await waitFor(() => lr.evtConns.length === 2, "reconnect");
		const gap = (lr.evtConns[1]?.acceptedAt ?? 0) - droppedAt;
		assert.ok(gap < 40 + 150, `reconnected after ${gap} ms`);
	});

	test("reads and discards the ok lines, tracking their latency", async () => {
		const { lr, client } = await setup(standardLightroom(hello(), state()));
		lr.okDelayMs = 30;
		client.start();
		await waitFor(() => client.state === "online", "online");
		await waitFor(() => client.stats.oks >= 4, "four oks");
		assert.ok(client.stats.okLatencyMs.last >= 25, `ok latency ${client.stats.okLatencyMs.last} ms`);
		assert.equal(client.stats.extraOks, 0);
		assert.equal(client.stats.badLines, 0, "ok lines are neither events nor bad lines");
		assert.equal(client.state, "online");
		assert.equal(client.stats.events, lr.sent.length, "every event the fake sent was parsed as an event, and only those");
	});

	test("heartbeat: no events while oks keep coming means a stale event socket, so both reconnect", async () => {
		let connections = 0;
		const { lr, client, states } = await setup({
			onEvtConnect: (fake) => {
				connections += 1;
				fake.send(hello());
				fake.send(state());
			},
			// No pongs and no other events: only LrSocket's oks come back.
		});
		client.start();
		await waitFor(() => client.state === "online", "online");
		const onlineAt = Date.now();
		await waitFor(() => connections === 2, "a reconnect", 3000);
		const after = Date.now() - onlineAt;
		assert.ok(after >= 600 - 20, `reconnected after ${after} ms, before staleMs`);
		assert.equal(client.stats.staleReconnects, 1);
		assert.equal(states.includes("busy"), false, "oks kept coming, so never busy");
		// The fake can accept the new event socket a moment before the new command socket.
		await waitFor(() => lr.cmdConns.length === 2 && lr.cmdConns[0]?.closedAt !== null, "the command socket to be replaced too", 1000);
	});

	test("heartbeat: when the oks stop too, Lightroom is busy: wait instead of reconnecting", async () => {
		let paused = false;
		const { lr, client, states } = await setup({
			onEvtConnect: (fake) => {
				fake.send(hello());
				fake.send(state());
			},
			onCommand: (cmd, fake) => {
				if (cmd.t === "hello") {
					fake.send(hello());
					fake.send(state());
				}
				if (cmd.t === "ping" && !paused) fake.send({ t: "pong", id: cmd.id, lt: 1 });
			},
		});
		client.start();
		await waitFor(() => client.state === "online", "online");
		// A menu opens: Lightroom's plugin tasks pause, so neither oks nor events come back.
		paused = true;
		lr.holdOks();
		await waitFor(() => client.state === "busy", "busy", 2000);
		await sleep(900); // well past staleMs without an event
		assert.equal(client.state, "busy");
		assert.equal(lr.cmdConns.length, 1, "no reconnect while busy");
		assert.equal(lr.evtConns.length, 1);
		// The menu closes: the queued lines get their oks and pings get pongs again.
		paused = false;
		lr.releaseOks();
		await waitFor(() => client.state === "online", "online again");
		await sleep(300);
		assert.equal(client.state, "online");
		assert.equal(lr.cmdConns.length, 1, "still the first connection");
		assert.equal(client.stats.busyEpisodes, 1);
		assert.equal(client.stats.staleReconnects, 0);
		assert.deepEqual(states.slice(-2), ["busy", "online"]);
		assertValidCommands(lr);
	});

	test("heartbeat: a lost ok doesn't leave the busy check a line behind; the next pong settles it", async () => {
		// PROTOCOL.md's ratios: pings (2 s) are further apart than the ok window (1.5 s), so a line left waiting
		// for an ok that never comes would go overdue between every two pings.
		const timing = { ...FAST, pingIntervalMs: 400, okWindowMs: 300, staleMs: 1500, okResyncMs: 100 };
		const { lr, client, states } = await setup(standardLightroom(hello(), state()), timing);
		client.start();
		await waitFor(() => client.state === "online" && client.stats.oks >= 2, "online, with the handshake's oks");
		lr.dropOks(1); // the next line, a ping, never gets its ok; its pong still comes
		const pings = lr.commands("ping").length;
		await waitFor(() => lr.commands("ping").length > pings, "the ping whose ok is lost", 2000);
		await sleep(2000); // five more pings
		assert.equal(client.stats.busyEpisodes, 0, `never busy, but went ${states.join(" → ")}`);
		assert.equal(client.state, "online");
		assert.equal(client.stats.lostOks, 1);
		assert.equal(client.stats.extraOks, 0, "every later ok matched its own line");
		assertValidCommands(lr);
	});

	test("version mismatch: shows mismatch and sends nothing but hello and ping", async () => {
		const { lr, client } = await setup(standardLightroom(hello({ v: 2 }), state()));
		client.start();
		await waitFor(() => client.state === "mismatch", "mismatch");
		assert.equal(client.send({ t: "flag", v: "pick", advance: true }), false);
		assert.equal(client.send({ t: "set", p: "Exposure", v: 0.5, g: 1 }), false);
		await assert.rejects(client.request({ t: "presets" }), (err: unknown) => err instanceof LrError && err.code === "mismatch");
		await sleep(400);
		const types = new Set(lr.commands().map((c) => c.t));
		assert.deepEqual([...types].sort(), ["hello", "ping"]);
		assert.ok(lr.commands("ping").length >= 2, "the heartbeat keeps running");
		assertValidCommands(lr);
	});

	test("a new inst drops cached values and ranges and sends watch again; the same inst keeps them", async () => {
		const h = hello({ inst: "inst-A" });
		const { lr, client } = await setup(
			standardLightroom(h, state(), (cmd, fake) => {
				if (cmd.t === "watch") {
					fake.send({ t: "ranges", ranges: { Exposure: [-5, 5] } });
					fake.send({ t: "vals", vals: { Exposure: 0.35 } });
				}
			}),
		);
		const model = new LrModel(client);
		const insts: (string | null)[][] = [];
		client.on("inst", (inst, prev) => insts.push([inst, prev]));
		client.start();
		await waitFor(() => model.view("Exposure").value === 0.35, "Exposure from the first instance");

		// Same instance after a reconnect: values stay (dimmed until vals refresh them), watch goes out again.
		lr.dropEvt();
		await waitFor(() => lr.commands("watch").length === 2, "watch on the new connection");
		assert.deepEqual(insts, [["inst-A", null]]);

		// A reload: new inst, so the cache goes.
		const valuesSeen: (number | null)[] = [];
		model.onChange(() => valuesSeen.push(model.view("Exposure").value));
		h.inst = "inst-B";
		lr.dropEvt();
		await waitFor(() => insts.length === 2, "the new inst");
		assert.deepEqual(insts[1], ["inst-B", "inst-A"]);
		assert.ok(valuesSeen.includes(null), "Exposure was dropped on the new inst");
		await waitFor(() => lr.commands("watch").length === 3, "watch for the new instance");
		await waitFor(() => model.view("Exposure").value === 0.35, "Exposure from the new instance");
		assertValidCommands(lr);
	});

	test("reconnectNow drops both sockets and reconnects at once (wake from sleep)", async () => {
		const { lr, client } = await setup(standardLightroom(hello(), state()), { ...FAST, backoffMinMs: 1000, backoffMaxMs: 2000 });
		client.start();
		await waitFor(() => client.state === "online", "online");
		const t0 = Date.now();
		client.reconnectNow("test wake");
		await waitFor(() => lr.evtConns.length === 2 && client.state === "online", "a new session");
		assert.ok(Date.now() - t0 < 500, "no backoff before the first attempt");
		assert.notEqual(lr.evtConns[0]?.closedAt, null);
	});

	test("requests: replies resolve by id, err rejects with its code, and silence times out", async () => {
		const { lr, client } = await setup(
			standardLightroom(hello(), state(), (cmd, fake) => {
				if (cmd.t === "presets") fake.send({ t: "presets", id: cmd.id, items: [{ uuid: "U1", name: "Velvia", folder: "Cobalt Fuji" }] });
				if (cmd.t === "preset") fake.send({ t: "err", id: cmd.id, cmd: "preset", code: "notFound", msg: "no such preset" });
				if (cmd.t === "flag") fake.send({ t: "err", id: cmd.id, cmd: "flag", code: "guard", msg: "test catalog not open" });
			}),
		);
		client.start();
		await waitFor(() => client.state === "online", "online");
		const presets = await client.request({ t: "presets" });
		assert.equal(presets.t, "presets");
		assert.deepEqual(presets.t === "presets" ? presets.items : null, [{ uuid: "U1", name: "Velvia", folder: "Cobalt Fuji" }]);
		await assert.rejects(client.request({ t: "preset", uuid: "U2" }), (err: unknown) => err instanceof LrError && err.code === "notFound");
		const errs: string[] = [];
		assert.equal(client.send({ t: "flag", v: "pick", advance: true }, { onErr: (e) => errs.push(e.code) }), true);
		await waitFor(() => errs.length === 1, "the err callback");
		assert.deepEqual(errs, ["guard"]);
		await assert.rejects(client.request({ t: "reload", mods: ["Develop"] }, { timeoutMs: 100 }), (err: unknown) => err instanceof LrError && err.code === "timeout");
		assertValidCommands(lr);
	});

	test("refuses to send a command that breaks the protocol", async () => {
		const { lr, client } = await setup(standardLightroom(hello(), state()));
		client.start();
		await waitFor(() => client.state === "online", "online");
		const notPings = (): number => lr.received.filter((r) => r.cmd?.t !== "ping").length;
		const before = notPings();
		assert.equal(client.send({ t: "set", p: "Exposure", v: 0.123, g: 1 }), false, "Exposure must be rounded to 0.01");
		assert.equal(client.send({ t: "set", p: "Contrast", v: 1.5, g: 1 }), false, "other params must be whole numbers");
		assert.equal(client.send({ t: "module", v: "map" } as never), false);
		await sleep(50);
		assert.equal(notPings(), before, "nothing reached Lightroom");
		assertValidCommands(lr);
	});

	test("reads events split across chunks, with CRLF endings and multi-byte UTF-8", async () => {
		const { lr, client } = await setup(standardLightroom(hello(), state()));
		const model = new LrModel(client);
		client.start();
		await waitFor(() => client.state === "online", "online");
		const line = Buffer.from(`${JSON.stringify(state({ photo: "202", file: "Ünïcødé_ß.ARW" }))}\r\n`, "utf8");
		const cut = line.indexOf(Buffer.from("ï", "utf8")) + 1; // inside a two-byte character
		lr.sendRaw(line.subarray(0, cut));
		await sleep(20);
		lr.sendRaw(line.subarray(cut));
		await waitFor(() => model.state.photo === "202", "the split state");
		assert.equal(model.state.file, "Ünïcødé_ß.ARW");
		lr.sendRaw("this is not json\n");
		lr.sendRaw(`${JSON.stringify({ t: "future", x: 1 })}\n`);
		lr.sendRaw(`${JSON.stringify({ t: "vals", vals: "nope" })}\n`);
		await waitFor(() => client.stats.badLines === 1 && client.stats.ignoredEvents === 1 && client.stats.invalidEvents === 1, "bad lines counted");
		assert.equal(client.state, "online", "bad lines don't break the session");
	});
});
