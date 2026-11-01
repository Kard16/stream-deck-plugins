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

/** `text` with every occurrence of `secret` replaced by `<token>`. */
export function scrub(text: string, secret: string): string {
	return secret === "" ? text : text.split(secret).join("<token>");
}

/** A log that replaces `secret` wherever it appears in a message, so the bridge token can't reach the log file. */
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
