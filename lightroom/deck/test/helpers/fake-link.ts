import { type ClientEvents, type ConnState, LrError, type LrLink, type SendOptions } from "../../src/lr/client.js";
import { type Command, type ErrEvt, type LrEvent, parseEvent, type RequestInput } from "../../src/lr/protocol.js";
import { validateCommand } from "../../src/lr/validate.js";
import { Emitter } from "../../src/util/emitter.js";
import type { FakeClock } from "./fake-clock.js";

export type Sent = { cmd: Command; at: number };

/**
 * Stands in for the Lightroom client in model and dial tests: records every command (and checks its shape
 * against PROTOCOL.md through the validator), and lets the test play Lightroom's events.
 */
export class FakeLink implements LrLink {
	state: ConnState = "online";
	readonly sent: Sent[] = [];
	/** Shape problems in sent commands; tests assert it stays empty. */
	readonly problems: string[] = [];
	readonly #events = new Emitter<ClientEvents>();
	readonly #errRoutes = new Map<number, (err: ErrEvt) => void>();
	readonly #clock: FakeClock | undefined;
	#nextId = 1;
	/** Answers request(); rejects with "offline" when unset. */
	onRequest: ((cmd: RequestInput & { id: number }) => Promise<LrEvent>) | null = null;

	constructor(clock?: FakeClock) {
		this.#clock = clock;
	}

	on<K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void): () => void {
		return this.#events.on(event, listener);
	}

	send(cmd: Command, opts?: SendOptions): boolean {
		if (this.state === "offline") return false;
		if (this.state === "mismatch" && cmd.t !== "hello" && cmd.t !== "ping") return false;
		let out = cmd;
		if (opts?.onErr) {
			const id = this.#nextId++;
			this.#errRoutes.set(id, opts.onErr);
			out = { ...cmd, id } as Command;
		}
		const problems = validateCommand(out);
		if (problems.length > 0) this.problems.push(`${JSON.stringify(out)}: ${problems.join("; ")}`);
		this.sent.push({ cmd: out, at: this.#clock?.now() ?? Date.now() });
		return true;
	}

	request(input: RequestInput): Promise<LrEvent> {
		const id = this.#nextId++;
		const cmd = { ...input, id };
		const problems = validateCommand(cmd);
		if (problems.length > 0) this.problems.push(`${JSON.stringify(cmd)}: ${problems.join("; ")}`);
		this.sent.push({ cmd: cmd as Command, at: this.#clock?.now() ?? Date.now() });
		if (!this.onRequest) return Promise.reject(new LrError("offline", "no Lightroom in this test"));
		return this.onRequest(cmd);
	}

	// ---- playing Lightroom ----

	/** Delivers an event, after checking it parses the way the real client would parse it. */
	lr(raw: Record<string, unknown>): void {
		const parsed = parseEvent(raw);
		if (parsed.kind !== "event") throw new Error(`test event doesn't parse: ${JSON.stringify(raw)} (${parsed.kind}: ${parsed.why})`);
		this.#events.emit("event", parsed.evt);
	}

	setState(state: ConnState): void {
		const prev = this.state;
		this.state = state;
		this.#events.emit("state", state, prev);
	}

	newInst(inst: string, prev: string | null): void {
		this.#events.emit("inst", inst, prev);
	}

	disconnect(): void {
		this.setState("offline");
		this.#events.emit("disconnect", "test");
	}

	/** Answers the given sent command with `err {id, cmd, code}`, as Lightroom would. */
	err(cmd: Command, code: string): void {
		const id = (cmd as { id?: number }).id;
		if (id === undefined) throw new Error(`command has no id to answer: ${JSON.stringify(cmd)}`);
		const route = this.#errRoutes.get(id);
		this.#errRoutes.delete(id);
		route?.({ t: "err", id, cmd: cmd.t, code, msg: "test" });
	}

	/** The commands sent since the last call. */
	take(): Command[] {
		return this.sent.splice(0).map((s) => s.cmd);
	}

	/** Sent commands of one type, without removing them. */
	ofType<T extends Command["t"]>(t: T): Extract<Command, { t: T }>[] {
		return this.sent.filter((s) => s.cmd.t === t).map((s) => s.cmd as Extract<Command, { t: T }>);
	}
}
