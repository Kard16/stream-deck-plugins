import { StringDecoder } from "node:string_decoder";

/** Lines longer than this are dropped rather than buffered forever (the preset list is about 40 KB). */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Splits a socket's byte stream into lines, per PROTOCOL.md's framing: one message per line, ending in `\n`,
 * UTF-8. A trailing `\r` is trimmed. Multi-byte characters split across chunks are decoded correctly.
 */
export class LineSplitter {
	readonly #decoder = new StringDecoder("utf8");
	#buffer = "";
	/** Bytes thrown away because a line grew past {@link MAX_LINE_BYTES} without a newline. */
	overflows = 0;

	push(chunk: Buffer | string): string[] {
		this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
		const lines: string[] = [];
		let start = 0;
		let end: number;
		while ((end = this.#buffer.indexOf("\n", start)) !== -1) {
			const line = this.#buffer.slice(start, end);
			lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
			start = end + 1;
		}
		this.#buffer = this.#buffer.slice(start);
		if (this.#buffer.length > MAX_LINE_BYTES) {
			this.overflows += 1;
			this.#buffer = "";
		}
		return lines;
	}

	/** Characters waiting for their newline. */
	get pending(): number {
		return this.#buffer.length;
	}
}
