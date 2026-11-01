/**
 * The bridge's address. Port 47601, not the plan's 47600: the main thread's spike bridge
 * (spikes/cc-bridge/) owns 47600 during the spikes. Every other use of the port derives from this constant.
 */
export const BRIDGE_PORT = 47601;

/** Loopback only. */
export const BRIDGE_HOST = "127.0.0.1";

/**
 * The Host headers the bridge accepts on a given port. Anything else (a browser page rebinding DNS to
 * 127.0.0.1, a proxy) gets 403 before the token is looked at.
 */
export function allowedHosts(port: number): string[] {
	return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** The held-request route. Claude Code's PermissionRequest http hook posts here. */
export const PERMISSION_PATH = "/permission";

/** Bodies over this size get 413. A PermissionRequest carries the tool's input, which a Write can make large. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** The run folder, inside the .sdPlugin folder, and the token file in it. The root .gitignore's `**\/run/` covers both. */
export const RUN_DIR = "run";
export const TOKEN_FILE = "token";
