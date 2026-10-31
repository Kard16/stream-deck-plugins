import net from "node:net";

import { LineSplitter } from "../../src/lr/framing.js";
import { validateCommand } from "../../src/lr/validate.js";

export type Conn = { sock: net.Socket; acceptedAt: number; closedAt: number | null };
export type ReceivedLine = { line: string; cmd: Record<string, unknown> | null; problems: string[]; at: number };
type Cmd = Record<string, unknown>;

export type FakeLrOptions = {
	/** Destroy every connection as soon as it's accepted. */
	refuse?: boolean;
	/** Leave the command port closed, so the deck's command connection is refused. */
	noCmdServer?: boolean;
	/** The deck connected to the event socket. */
	onEvtConnect?: (lr: FakeLr) => void;
	/** A command line arrived (after its `ok`). */
	onCommand?: (cmd: Cmd, lr: FakeLr) => void;
};

async function listen(server: net.Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	return (server.address() as net.AddressInfo).port;
}

/** A port nothing listens on: bound to port 0, then closed again. */
export async function closedPort(): Promise<number> {
	const server = net.createServer();
	const port = await listen(server);
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

/**
 * A stand-in for Lightroom's two LrSocket listeners, on ephemeral ports. Like LrSocket's receive mode it
 * answers every command line with `ok`; it records every line and checks its shape with the validator.
 */
export class FakeLr {
	readonly cmdConns: Conn[] = [];
	readonly evtConns: Conn[] = [];
	readonly received: ReceivedLine[] = [];
	/** Every event sent to the deck, in order. */
	readonly sent: Cmd[] = [];
	okDelayMs = 0;
	readonly #opts: FakeLrOptions;
	readonly #cmdServer: net.Server | null;
	readonly #evtServer: net.Server;
	#cmdPort = 0;
	#evtPort = 0;
	#holdOks = false;
	#heldOks: net.Socket[] = [];
	#dropOks = 0;

	private constructor(opts: FakeLrOptions) {
		this.#opts = opts;
		this.#cmdServer = opts.noCmdServer ? null : net.createServer((sock) => this.#onCmd(sock));
		this.#evtServer = net.createServer((sock) => this.#onEvt(sock));
	}

	static async start(opts: FakeLrOptions = {}): Promise<FakeLr> {
		const lr = new FakeLr(opts);
		lr.#cmdPort = lr.#cmdServer ? await listen(lr.#cmdServer) : await closedPort();
		lr.#evtPort = await listen(lr.#evtServer);
		return lr;
	}

	get cmdPort(): number {
		return this.#cmdPort;
	}

	get evtPort(): number {
		return this.#evtPort;
	}

	/** Lines that failed the command validator. */
	get invalid(): ReceivedLine[] {
		return this.received.filter((r) => r.problems.length > 0);
	}

	commands(t?: string): Cmd[] {
		return this.received.flatMap((r) => (r.cmd && (t === undefined || r.cmd.t === t) ? [r.cmd] : []));
	}

	/** Sends an event on the newest open event connection. */
	send(evt: Cmd): void {
		const conn = this.#open(this.evtConns);
		if (!conn) throw new Error(`no event connection to send ${JSON.stringify(evt)} on`);
		this.sent.push(evt);
		conn.sock.write(`${JSON.stringify(evt)}\n`);
	}

	/** Writes raw bytes on the newest event connection, for framing tests. */
	sendRaw(chunk: string | Buffer): void {
		const conn = this.#open(this.evtConns);
		if (!conn) throw new Error("no event connection");
		conn.sock.write(chunk);
	}

	/** Stops answering lines with `ok`, as when Lightroom's plugin tasks pause. */
	holdOks(): void {
		this.#holdOks = true;
	}

	releaseOks(): void {
		this.#holdOks = false;
		for (const sock of this.#heldOks.splice(0)) if (!sock.destroyed) sock.write("ok\n");
	}

	/** The next `n` lines get no `ok` at all, though they're handled as usual. */
	dropOks(n: number): void {
		this.#dropOks += n;
	}

	dropEvt(): void {
		this.#open(this.evtConns)?.sock.destroy();
	}

	dropCmd(): void {
		this.#open(this.cmdConns)?.sock.destroy();
	}

	async close(): Promise<void> {
		for (const c of [...this.cmdConns, ...this.evtConns]) c.sock.destroy();
		await Promise.all(
			[this.#cmdServer, this.#evtServer].map(
				(s) =>
					new Promise<void>((resolve) => {
						if (!s || !s.listening) resolve();
						else s.close(() => resolve());
					}),
			),
		);
	}

	#open(conns: Conn[]): Conn | undefined {
		for (let i = conns.length - 1; i >= 0; i--) {
			const c = conns[i];
			if (c && c.closedAt === null && !c.sock.destroyed) return c;
		}
		return undefined;
	}

	#track(sock: net.Socket, list: Conn[]): Conn {
		const conn: Conn = { sock, acceptedAt: Date.now(), closedAt: null };
		list.push(conn);
		sock.on("close", () => {
			conn.closedAt = Date.now();
		});
		sock.on("error", () => undefined);
		return conn;
	}

	#onEvt(sock: net.Socket): void {
		this.#track(sock, this.evtConns);
		if (this.#opts.refuse) {
			sock.destroy();
			return;
		}
		sock.on("data", () => undefined); // the deck never writes here; keep the stream flowing anyway
		this.#opts.onEvtConnect?.(this);
	}

	#onCmd(sock: net.Socket): void {
		this.#track(sock, this.cmdConns);
		if (this.#opts.refuse) {
			sock.destroy();
			return;
		}
		const lines = new LineSplitter();
		sock.on("data", (chunk: Buffer) => {
			for (const line of lines.push(chunk)) {
				let cmd: Cmd | null = null;
				let problems: string[];
				try {
					cmd = JSON.parse(line) as Cmd;
					problems = validateCommand(cmd);
				} catch {
					problems = ["not JSON"];
				}
				this.received.push({ line, cmd, problems, at: Date.now() });
				this.#ok(sock);
				if (cmd) this.#opts.onCommand?.(cmd, this);
			}
		});
	}

	#ok(sock: net.Socket): void {
		if (this.#dropOks > 0) this.#dropOks -= 1;
		else if (this.#holdOks) this.#heldOks.push(sock);
		else if (this.okDelayMs > 0) setTimeout(() => !sock.destroyed && sock.write("ok\n"), this.okDelayMs);
		else sock.write("ok\n");
	}
}

/** Lightroom's usual answers: hello and state on connect and on hello, pong to ping. */
export function standardLightroom(hello: Cmd, state: Cmd, extra: (cmd: Cmd, lr: FakeLr) => void = () => undefined): FakeLrOptions {
	return {
		onEvtConnect: (lr) => {
			lr.send(hello);
			lr.send(state);
		},
		onCommand: (cmd, lr) => {
			if (cmd.t === "hello") {
				lr.send(hello);
				lr.send(state);
			} else if (cmd.t === "ping") lr.send({ t: "pong", id: cmd.id, lt: 1000.5 });
			extra(cmd, lr);
		},
	};
}
