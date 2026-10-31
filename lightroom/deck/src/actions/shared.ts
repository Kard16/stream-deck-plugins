import type { LrLink } from "../lr/client.js";
import type { LrModel } from "../model/model.js";
import { svgDataUrl } from "../keys/art.js";
import { describeError } from "../util/emitter.js";
import type { Log } from "../util/log.js";

/** What every action gets: the value model, the Lightroom client, and a log. */
export type ActionContext = { model: LrModel; link: LrLink; log: Log };

type ImageTarget = { readonly id: string; setImage(image?: string): Promise<void> };

/** The visible instances of one key action, their settings, and the image last sent to each. */
export class KeySet<A extends ImageTarget, S> {
	readonly #keys = new Map<string, { action: A; settings: S; svg: string | null }>();
	readonly #log: Log;

	constructor(log: Log) {
		this.#log = log;
	}

	add(action: A, settings: S): void {
		// A fresh appearance always gets its image, since the app shows the manifest's until then.
		this.#keys.set(action.id, { action, settings, svg: null });
	}

	remove(id: string): void {
		this.#keys.delete(id);
	}

	ids(): string[] {
		return [...this.#keys.keys()];
	}

	settings(id: string): S | undefined {
		return this.#keys.get(id)?.settings;
	}

	setSettings(id: string, settings: S): void {
		const key = this.#keys.get(id);
		if (key) key.settings = settings;
	}

	/** Sends the image only when it differs from the last one sent to that key. */
	paint(id: string, svg: string): void {
		const key = this.#keys.get(id);
		if (!key || key.svg === svg) return;
		key.svg = svg;
		key.action.setImage(svgDataUrl(svg)).catch((err: unknown) => this.#log.warn(`setImage failed: ${describeError(err)}`));
	}
}

/** Fire-and-forget feedback on a key or dial; a failure is only logged. */
export function feedback(log: Log, what: string, call: () => Promise<void>): void {
	call().catch((err: unknown) => log.warn(`${what} failed: ${describeError(err)}`));
}
