import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { TOKEN_FILE } from "./config.js";

/** 32 random bytes, written as 64 lowercase hex characters. */
export const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export type LoadedToken = {
	token: string;
	file: string;
	/** True when this call wrote a new token. */
	created: boolean;
	/** What was fixed on the way, for the log. Never contains the token. */
	notes: string[];
};

/**
 * The bridge's bearer token, from `<runDir>/token`. The first start creates it: random hex, the file `0600`
 * and the folder `0700`. Later starts reuse it, tightening the modes if something loosened them. A file that
 * doesn't hold a token of ours (empty, say) is replaced, with a note.
 */
export function loadOrCreateToken(runDir: string): LoadedToken {
	const notes: string[] = [];
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	tighten(runDir, 0o700, notes);
	const file = path.join(runDir, TOKEN_FILE);

	let existing: string | null = null;
	try {
		existing = readFileSync(file, "utf8").trim();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (existing !== null && TOKEN_PATTERN.test(existing)) {
		tighten(file, 0o600, notes);
		return { token: existing, file, created: false, notes };
	}
	if (existing !== null) notes.push(`${TOKEN_FILE} didn't hold a token, so it was replaced`);

	// Written beside it and renamed into place, so a reader never sees half a token.
	const token = randomBytes(TOKEN_BYTES).toString("hex");
	const tmp = path.join(runDir, `.${TOKEN_FILE}.${process.pid}.tmp`);
	try {
		writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: "w" });
		chmodSync(tmp, 0o600);
		renameSync(tmp, file);
	} finally {
		rmSync(tmp, { force: true });
	}
	return { token, file, created: true, notes };
}

function tighten(target: string, mode: number, notes: string[]): void {
	const actual = statSync(target).mode & 0o777;
	if (actual === mode) return;
	chmodSync(target, mode);
	notes.push(`${path.basename(target)} was ${actual.toString(8).padStart(4, "0")}, now ${mode.toString(8).padStart(4, "0")}`);
}

export type AuthResult = "ok" | "missing" | "wrong";

/**
 * Checks an Authorization header against the token: `Bearer <token>`, the scheme in any case. The comparison
 * takes the same time whatever the header holds.
 */
export function checkBearer(header: string | undefined, token: string): AuthResult {
	if (header === undefined || header.trim() === "") return "missing";
	const match = /^bearer\s+(\S+)\s*$/i.exec(header.trim());
	if (!match?.[1]) return "wrong";
	const presented = createHash("sha256").update(match[1]).digest();
	const expected = createHash("sha256").update(token).digest();
	return timingSafeEqual(presented, expected) ? "ok" : "wrong";
}
