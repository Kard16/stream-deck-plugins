import type { Log } from "./log.js";

type Listener<A extends unknown[]> = (...args: A) => void;

/**
 * A small typed event emitter. A listener that throws is logged and skipped, so one broken listener can't
 * stop the Lightroom client or the value model from handling the rest of a message.
 */
export class Emitter<M extends { [K in keyof M]: unknown[] }> {
	readonly #listeners = new Map<keyof M, Set<Listener<never[]>>>();
	readonly #log: Log | undefined;

	constructor(log?: Log) {
		this.#log = log;
	}

	/** Adds a listener and returns a function that removes it. */
	on<K extends keyof M>(event: K, listener: Listener<M[K]>): () => void {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		const entry = listener as unknown as Listener<never[]>;
		set.add(entry);
		return () => {
			set.delete(entry);
		};
	}

	emit<K extends keyof M>(event: K, ...args: M[K]): void {
		const set = this.#listeners.get(event);
		if (!set) return;
		for (const listener of [...set]) {
			try {
				(listener as unknown as Listener<M[K]>)(...args);
			} catch (err) {
				this.#log?.error(`listener for "${String(event)}" threw: ${describeError(err)}`);
			}
		}
	}
}

export function describeError(err: unknown): string {
	if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
	return String(err);
}
