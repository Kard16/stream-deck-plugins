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
 * The shortest run of the secret's characters that {@link scrub} takes out on its own. A value cut short can end
 * in the start of the secret, or a summary keep only its end, so the whole of it needn't be there to give it away.
 */
export const SCRUB_RUN = 8;

/**
 * `text` with `secret` taken out: the whole of it, and every run of {@link SCRUB_RUN} or more characters that's
 * also part of it, each become `<token>`. A secret shorter than that is only taken out whole.
 */
export function scrub(text: string, secret: string): string {
	if (secret === "") return text;
	if (secret.length < SCRUB_RUN) return text.split(secret).join("<token>");
	const windows = new Set<string>();
	for (let i = 0; i + SCRUB_RUN <= secret.length; i++) windows.add(secret.slice(i, i + SCRUB_RUN));
	// Only a stretch made wholly of the secret's characters can hold part of it, and most text has few.
	const stretches = new RegExp(`[${secret.replace(/[\\\]^-]/g, "\\$&")}]{${SCRUB_RUN},}`, "g");
	return text.replace(stretches, (stretch) => scrubStretch(stretch, windows));
}

/**
 * A stretch of the secret's characters with each part of the secret in it taken out: every window of
 * SCRUB_RUN characters that's in the secret is covered, and each run of overlapping or touching windows
 * becomes one `<token>`.
 */
function scrubStretch(stretch: string, windows: ReadonlySet<string>): string {
	let out = "";
	let copied = 0;
	// The covered run being built, [start, end).
	let start = -1;
	let end = -1;
	const close = (): void => {
		out += `${stretch.slice(copied, start)}<token>`;
		copied = end;
	};
	for (let i = 0; i + SCRUB_RUN <= stretch.length; i++) {
		if (!windows.has(stretch.slice(i, i + SCRUB_RUN))) continue;
		if (i > end) {
			if (start >= 0) close();
			start = i;
		}
		end = i + SCRUB_RUN;
	}
	if (start >= 0) close();
	return out + stretch.slice(copied);
}

/**
 * A log that scrubs `secret` from every message (see {@link scrub}), so the bridge token, or any part of it
 * SCRUB_RUN characters long, can't reach the log file.
 */
export function redacting(log: Log, secret: string): Log {
	if (secret === "") return log;
	return {
		error: (m) => log.error(scrub(m, secret)),
		warn: (m) => log.warn(scrub(m, secret)),
		info: (m) => log.info(scrub(m, secret)),
		debug: (m) => log.debug(scrub(m, secret)),
		trace: (m) => log.trace(scrub(m, secret)),
	};
}
