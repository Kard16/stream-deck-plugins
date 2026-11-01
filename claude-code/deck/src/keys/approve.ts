import type { HeldQueue } from "../bridge/held.js";
import type { BridgeState } from "../bridge/server.js";
import type { Clock } from "../util/clock.js";
import { type Log, nullLog } from "../util/log.js";
import { KeyPainter, PAINT_INTERVAL_MS } from "../util/painter.js";
import { type ApproveLook, approveKeySvg } from "./art.js";

/** What the SDK adapter gives for one key. */
export type KeySurface = {
	setImage(svg: string): void;
	showOk(): void;
	showAlert(): void;
};

type Key = { surface: KeySurface; painter: KeyPainter<number | null> };

/** The look for the queue and the bridge as they are now. */
export function approveLook(queue: Pick<HeldQueue, "size" | "oldest">, state: BridgeState): ApproveLook {
	return { count: queue.size, tool: queue.oldest?.toolName ?? null, online: state === "listening" };
}

/**
 * The Approve keys, without the SDK. Each shows how many requests are held and the oldest one's tool. A press
 * answers the oldest with allow, but only if it's the request the key last showed: one that ended in the
 * meantime makes the press do nothing but alert, so a press never approves a request the key didn't show.
 */
export class ApproveKeys {
	readonly #queue: HeldQueue;
	readonly #log: Log;
	readonly #clock: Clock | undefined;
	readonly #paintIntervalMs: number;
	readonly #keys = new Map<string, Key>();
	#bridge: BridgeState = "stopped";

	constructor(queue: HeldQueue, opts: { log?: Log; clock?: Clock; paintIntervalMs?: number } = {}) {
		this.#queue = queue;
		this.#log = opts.log ?? nullLog;
		this.#clock = opts.clock;
		this.#paintIntervalMs = opts.paintIntervalMs ?? PAINT_INTERVAL_MS;
		queue.onChange(() => this.repaintAll());
	}

	setBridgeState(state: BridgeState): void {
		this.#bridge = state;
		this.repaintAll();
	}

	add(id: string, surface: KeySurface): void {
		this.#keys.get(id)?.painter.dispose();
		const painter = new KeyPainter<number | null>((svg) => surface.setImage(svg), {
			clock: this.#clock,
			minIntervalMs: this.#paintIntervalMs,
		});
		this.#keys.set(id, { surface, painter });
		this.#paint(painter);
	}

	remove(id: string): void {
		this.#keys.get(id)?.painter.dispose();
		this.#keys.delete(id);
	}

	press(id: string): void {
		const key = this.#keys.get(id);
		if (!key) return;
		// The request this key's image showed; undefined only before its first paint, which then shows nothing.
		const shown = key.painter.shown ?? null;
		const result = this.#queue.answerOldest(shown);
		if (result.ok) {
			this.#log.info(`ANSWER #${result.req.id} ${result.req.toolName ?? "(no tool_name)"}: allow, from a key press; ${result.remaining} held`);
			key.surface.showOk();
			return;
		}
		const why =
			result.why === "empty"
				? "nothing is held"
				: result.why === "gone"
					? `#${result.req?.id ?? "?"} had already closed; removed`
					: `the key showed ${shown === null ? "nothing" : `#${shown}`}, but the oldest is now #${result.req?.id ?? "?"}`;
		this.#log.info(`press: nothing answered: ${why}`);
		key.surface.showAlert();
	}

	repaintAll(): void {
		for (const key of this.#keys.values()) this.#paint(key.painter);
	}

	/** What a key shows now, for tests. */
	painted(id: string): { svg: string | null; shown: number | null | undefined } | null {
		const key = this.#keys.get(id);
		return key ? { svg: key.painter.svg, shown: key.painter.shown } : null;
	}

	#paint(painter: KeyPainter<number | null>): void {
		painter.update(approveKeySvg(approveLook(this.#queue, this.#bridge)), this.#queue.oldest?.id ?? null);
	}
}
