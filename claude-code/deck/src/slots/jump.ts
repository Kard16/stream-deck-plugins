import { type Log, quote } from "../util/log.js";

/** What a jump needs from the session model (SessionModel implements it). */
export interface JumpModel {
	/** Makes the session the target for prompts and mode, as a pick on the Sessions dial does. */
	pick(key: string, via?: string): void;
	/** A turn's end before now counts as seen. */
	markSeen(host: string): void;
}

/**
 * A press on a slot key, a jump from a slot dial, or a press on Others (session-keys.md, Slots and Others): the
 * session opens in the app with the existing jump (`claude://code/continue?session=<host>`, which the plugin's `open`
 * runs), becomes the target, and counts as seen. A session that isn't running opens too: the app starts it again.
 */
export function jumpTo(model: JumpModel, host: string, open: (host: string) => void, via: string, log: Log, title?: string): void {
	model.pick(host, via);
	model.markSeen(host);
	log.info(`jump ${host} via ${via}${title === undefined ? "" : `: ${quote(title, 60)}`}`);
	open(host);
}
