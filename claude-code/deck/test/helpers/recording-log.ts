import { LOG_LEVELS, type LogLevel } from "../../src/util/log-level.js";
import type { Log } from "../../src/util/log.js";

/** A {@link Log} that keeps every line, for tests of what gets logged at which level. */
export class RecordingLog implements Log {
	readonly lines: { level: LogLevel; message: string }[] = [];

	error(message: string): void {
		this.lines.push({ level: "error", message });
	}

	warn(message: string): void {
		this.lines.push({ level: "warn", message });
	}

	info(message: string): void {
		this.lines.push({ level: "info", message });
	}

	debug(message: string): void {
		this.lines.push({ level: "debug", message });
	}

	trace(message: string): void {
		this.lines.push({ level: "trace", message });
	}

	/** The lines a logger set to `level` writes, as "level message". */
	at(level: LogLevel): string[] {
		const max = LOG_LEVELS.indexOf(level);
		return this.lines.filter((l) => LOG_LEVELS.indexOf(l.level) <= max).map((l) => `${l.level} ${l.message}`);
	}
}
