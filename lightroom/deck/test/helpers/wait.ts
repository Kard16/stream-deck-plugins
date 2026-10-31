import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `check` is true. Fails with `what` after `timeoutMs`. */
export async function waitFor(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await sleep(5);
	}
}

/** lightroom/deck, found from the compiled test file by its package.json. */
export function deckRoot(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const pkg = path.join(dir, "package.json");
		if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name === "lightroom-deck") return dir;
		const up = path.dirname(dir);
		if (up === dir) throw new Error("couldn't find lightroom/deck/package.json");
		dir = up;
	}
}
