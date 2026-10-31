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
