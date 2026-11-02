import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The deck project's folder (claude-code/deck), found from the compiled test file's place in build/test/. */
export function deckRoot(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	while (!existsSync(path.join(dir, "package.json"))) {
		const up = path.dirname(dir);
		if (up === dir) throw new Error("can't find the deck's package.json");
		dir = up;
	}
	return dir;
}

/** claude-code/protocol/fixtures, which both sides test against. */
export function fixturesDir(): string {
	return path.join(deckRoot(), "..", "protocol", "fixtures");
}
