import { DEFAULT_CMD_PORT, DEFAULT_EVT_PORT } from "./protocol.js";

/**
 * Lightroom's ports. `DECKBRIDGE_CMD_PORT` and `DECKBRIDGE_EVT_PORT` point the plugin at another Lightroom, such as
 * the mock in lightroom/tools or scripts/smoke.mjs's fake. The Stream Deck app sets neither, so the plugin uses
 * PROTOCOL.md's 58780 and 58781. A value that isn't a port is ignored.
 */
export function portsFromEnv(env: Readonly<Record<string, string | undefined>>): { cmdPort: number; evtPort: number } {
	const read = (name: string, fallback: number): number => {
		const raw = env[name];
		if (raw === undefined || raw.trim() === "") return fallback;
		const port = Number(raw);
		return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
	};
	return { cmdPort: read("DECKBRIDGE_CMD_PORT", DEFAULT_CMD_PORT), evtPort: read("DECKBRIDGE_EVT_PORT", DEFAULT_EVT_PORT) };
}
