/**
 * The bridge's address: 127.0.0.1:47600, IPv4 only (PROTOCOL.md, Transport). The plugin's hooks.json and mod
 * use the same port. The spike bridge (spikes/cc-bridge/) listened there during Phase 1; while anything else
 * holds the port, the bridge retries with backoff (server.ts) until it's free. Every other use of the port
 * derives from this constant, and tests bind port 0.
 */
export const BRIDGE_PORT = 47600;

/** Loopback only. Clients use 127.0.0.1, never localhost, which can resolve to ::1 first (S6). */
export const BRIDGE_HOST = "127.0.0.1";

/**
 * The Host headers the bridge accepts on a given port. Anything else (a browser page rebinding DNS to
 * 127.0.0.1, a proxy) gets 403 before the token is looked at.
 */
export function allowedHosts(port: number): string[] {
	return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** Bodies over this size get 413. A PermissionRequest carries the tool's input, which a Write can make large. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** The run folder, inside the .sdPlugin folder, and the token file in it. The root .gitignore's `**\/run/` covers both. */
export const RUN_DIR = "run";
export const TOKEN_FILE = "token";

/** Which session each Session Slot holds, in the run folder (src/slots/store.ts). */
export const SLOTS_FILE = "slots.json";
