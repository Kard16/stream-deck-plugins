/**
 * The logging surface the plugin's logic needs. The Stream Deck SDK's logger satisfies it, and tests pass
 * {@link nullLog} or a recording log, so nothing outside `src/actions` and `src/plugin.ts` imports the SDK.
 */
export interface Log {
	error(message: string): unknown;
	warn(message: string): unknown;
	info(message: string): unknown;
	debug(message: string): unknown;
	trace(message: string): unknown;
}

export const nullLog: Log = {
	error: () => undefined,
	warn: () => undefined,
	info: () => undefined,
	debug: () => undefined,
	trace: () => undefined,
};

export function describeError(err: unknown): string {
	if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
	return String(err);
}

/** A value from outside (a header, a registry field) made safe for one log line: quoted, escaped and cut short. */
export function quote(value: string | null | undefined, max = 80): string {
	if (value === null || value === undefined) return "none";
	return JSON.stringify(value.length > max ? `${value.slice(0, max)}…` : value);
}

/**
 * The shortest run of the secret's characters that a {@link Scrubber} takes out on its own. A value cut short can
 * end in the start of the secret, or a summary keep only its end, so the whole of it needn't be there to give it away.
 */
export const SCRUB_RUN = 8;

/**
 * Takes one secret out of text: the whole of it, and every run of {@link SCRUB_RUN} or more characters that's also
 * part of it, each become `<token>`. A secret shorter than that is only taken out whole. It's built once per secret,
 * and reads text in one pass, with no regular expression to backtrack, so its time grows only with the text's
 * length and no string is too long for it.
 */
export class Scrubber {
	readonly #secret: string;
	/** The secret's characters, as UTF-16 code units. */
	readonly #chars = new Set<number>();
	/** Every window of SCRUB_RUN characters in the secret. */
	readonly #windows = new Set<string>();

	constructor(secret: string) {
		this.#secret = secret;
		for (let i = 0; i < secret.length; i++) this.#chars.add(secret.charCodeAt(i));
		for (let i = 0; i + SCRUB_RUN <= secret.length; i++) this.#windows.add(secret.slice(i, i + SCRUB_RUN));
	}

	/**
	 * `text` with the secret taken out: every window of SCRUB_RUN characters that's in the secret is covered, and
	 * each run of overlapping or touching windows becomes one `<token>`.
	 */
	scrub(text: string): string {
		const secret = this.#secret;
		if (secret === "") return text;
		if (secret.length < SCRUB_RUN) return text.split(secret).join("<token>");
		if (text.length < SCRUB_RUN) return text;
		let out = "";
		let copied = 0;
		// The covered run being built, [start, end).
		let start = -1;
		let end = -1;
		const close = (): void => {
			out += `${text.slice(copied, start)}<token>`;
			copied = end;
		};
		// How many of the secret's characters in a row end at i. Only a window made wholly of them can be in the
		// secret, and most text has few, so most windows are passed over without being looked up.
		let stretch = 0;
		for (let i = 0; i < text.length; i++) {
			if (!this.#chars.has(text.charCodeAt(i))) {
				stretch = 0;
				continue;
			}
			if (++stretch < SCRUB_RUN) continue;
			const from = i + 1 - SCRUB_RUN;
			if (!this.#windows.has(text.slice(from, i + 1))) continue;
			if (from > end) {
				if (start >= 0) close();
				start = from;
			}
			end = i + 1;
		}
		if (start < 0) return text;
		close();
		return out + text.slice(copied);
	}
}

/**
 * A log that scrubs a secret from every message (see {@link Scrubber}), so the bridge token, or any part of it
 * SCRUB_RUN characters long, can't reach the log file.
 */
export function redacting(log: Log, scrubber: Scrubber): Log {
	return {
		error: (m) => log.error(scrubber.scrub(m)),
		warn: (m) => log.warn(scrubber.scrub(m)),
		info: (m) => log.info(scrubber.scrub(m)),
		debug: (m) => log.debug(scrubber.scrub(m)),
		trace: (m) => log.trace(scrubber.scrub(m)),
	};
}
