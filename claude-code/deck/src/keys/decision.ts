import type { Decision, HeldRequests } from "../bridge/held.js";
import { type Clock, realClock } from "../util/clock.js";
import { type Log, nullLog, quote } from "../util/log.js";
import { KeyPainter, type Live, PAINT_INTERVAL_MS } from "../util/painter.js";
import { type DecisionLook, decisionKeySvg } from "./art.js";

/** What the SDK adapter gives for one key. */
export type KeySurface = {
	setImage(svg: string): void;
	showOk(): void;
	showAlert(): void;
};

/** What Approve and Deny need from the session model. */
export interface DecisionModel {
	readonly held: HeldRequests;
	readonly online: boolean;
	titleFor(host: string): string;
	onChange(listener: () => void): () => void;
}

/**
 * How long a request must have been in plain sight on a key before a press acts on it. A press that answers
 * the oldest request paints the next one at once, under the app's OK overlay, so without this a quick second
 * press would answer a request the user never saw, perhaps another session's. It counts from the request's
 * first paint on the key, or from the key's last OK or alert, whichever is later, since each overlay hides the
 * image. The SDK doesn't say how long its overlays last; this is meant to outlast them.
 */
export const SETTLE_MS = 1000;

/** The look for the held requests and the bridge as they are now. */
export function decisionLook(model: DecisionModel, decision: Decision): DecisionLook {
	const oldest = model.held.oldest;
	return {
		decision,
		online: model.online,
		count: model.held.size,
		oldest: oldest && { title: model.titleFor(oldest.host), summary: oldest.summary, ask: oldest.kind === "ask" },
	};
}

type Key = {
	surface: KeySurface;
	painter: KeyPainter<number | null>;
	/** When the key last showed OK or an alert, either of which hides its image for a moment. */
	feedbackAt: number;
};

/**
 * The Approve or the Deny keys, without the SDK (PROTOCOL.md, Held requests). Each shows the oldest held
 * request across sessions: its session's title and what it's for, or "Answer in app" for a question or a
 * plan. A press acts only on the request the key last showed, and only once it has been in sight for
 * {@link SETTLE_MS}: a `tool` request is answered (allow or deny); an `ask` jumps to its session, shows the
 * OK so the press reads as done, and stays held. A press after the shown request ended, or before it could
 * be seen, does nothing but alert.
 */
export class DecisionKeys {
	readonly #model: DecisionModel;
	readonly #decision: Decision;
	readonly #log: Log;
	readonly #clock: Clock;
	readonly #paintIntervalMs: number;
	readonly #settleMs: number;
	readonly #open: (host: string) => void;
	readonly #live: Live | undefined;
	readonly #keys = new Map<string, Key>();

	/** `live`: whether a Stream Deck is connected; the keys' painters send nothing while none is (agents-and-wake.md, C3). */
	constructor(
		model: DecisionModel,
		decision: Decision,
		opts: { log?: Log; clock?: Clock; paintIntervalMs?: number; settleMs?: number; open?: (host: string) => void; live?: Live } = {},
	) {
		this.#model = model;
		this.#decision = decision;
		this.#log = opts.log ?? nullLog;
		this.#clock = opts.clock ?? realClock;
		this.#paintIntervalMs = opts.paintIntervalMs ?? PAINT_INTERVAL_MS;
		this.#settleMs = opts.settleMs ?? SETTLE_MS;
		this.#open = opts.open ?? (() => {});
		this.#live = opts.live;
		model.onChange(() => this.repaintAll());
	}

	add(id: string, surface: KeySurface): void {
		this.#keys.get(id)?.painter.dispose();
		const painter = new KeyPainter<number | null>((svg) => surface.setImage(svg), { clock: this.#clock, minIntervalMs: this.#paintIntervalMs, live: this.#live });
		const key: Key = { surface, painter, feedbackAt: -Infinity };
		this.#keys.set(id, key);
		this.#paint(key);
	}

	remove(id: string): void {
		this.#keys.get(id)?.painter.dispose();
		this.#keys.delete(id);
	}

	press(id: string): void {
		const key = this.#keys.get(id);
		if (!key) return;
		const name = this.#decision === "allow" ? "Approve" : "Deny";
		// The request this key's image showed; undefined only before its first paint, which then shows nothing.
		const shown = key.painter.shown ?? null;
		// How long it has been in sight: since its first paint, or since the last OK or alert covered it.
		const seenMs = this.#clock.now() - Math.max(key.painter.shownSince ?? -Infinity, key.feedbackAt);
		if (shown !== null && seenMs < this.#settleMs) {
			this.#log.info(`${name} press: nothing answered: #${shown} had been in sight on the key for ${Math.round(seenMs)} ms, under ${this.#settleMs} ms`);
			this.#alert(key);
			return;
		}
		const result = this.#model.held.press(shown, this.#decision);
		if (result.ok && result.did === "answered") {
			this.#ok(key);
			return;
		}
		if (result.ok && result.did === "jump") {
			const { held } = result;
			this.#log.info(`${name}: jump to ${held.host} for #${held.id} ${quote(held.tool, 40)}, which needs the user in the app`);
			this.#open(held.host);
			// Without feedback the press looked dead when the session was already on screen (Phase 4).
			this.#ok(key);
			return;
		}
		const why =
			result.why === "empty"
				? "nothing is held"
				: result.why === "gone"
					? `#${result.held?.id ?? "?"} had already closed; removed`
					: `the key showed ${shown === null ? "nothing" : `#${shown}`}, but the oldest is now #${result.held?.id ?? "?"}`;
		this.#log.info(`${name} press: nothing answered: ${why}`);
		this.#alert(key);
	}

	repaintAll(): void {
		for (const key of this.#keys.values()) this.#paint(key);
	}

	/** A device connected, or the Mac woke: every key sends its image again, the same one too (agents-and-wake.md, C2). */
	repaintInFull(): void {
		for (const key of this.#keys.values()) key.painter.forget();
		this.repaintAll();
	}

	/** What a key shows now, for tests. */
	painted(id: string): { svg: string | null; shown: number | null | undefined } | null {
		const key = this.#keys.get(id);
		return key ? { svg: key.painter.svg, shown: key.painter.shown } : null;
	}

	#ok(key: Key): void {
		key.feedbackAt = this.#clock.now();
		key.surface.showOk();
	}

	#alert(key: Key): void {
		key.feedbackAt = this.#clock.now();
		key.surface.showAlert();
	}

	#paint(key: Key): void {
		// The oldest held request, whether the bridge is listening or not: one its old server holds is still answered
		// through it (decisionKeySvg), so the key shows what a press acts on, and reads Offline only with nothing held.
		key.painter.update(decisionKeySvg(decisionLook(this.#model, this.#decision)), this.#model.held.oldest?.id ?? null);
	}
}
