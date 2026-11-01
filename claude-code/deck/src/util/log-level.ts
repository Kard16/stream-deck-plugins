import { readFileSync } from "node:fs";

/** The Stream Deck SDK's log levels, the most severe first. */
export const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Normal use logs at info: startup, the bridge's state, every bridge request and close, answers, jumps, and
 * problems. Debug adds registry rescans and dial scrolling.
 */
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/** The optional file in the .sdPlugin folder that sets the level, read once at startup. It's gitignored. */
export const LOG_LEVEL_FILE = "log-level.txt";

/**
 * The level a log-level file asks for: the first word of its first line that isn't blank or a `#` comment,
 * one of {@link LOG_LEVELS} in any case. Anything else is an error, and the level is the default.
 */
export function parseLogLevel(text: string): { level: LogLevel; error: string | null } {
	const line = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find((l) => l !== "" && !l.startsWith("#"));
	const word = line?.split(/\s+/)[0] ?? "";
	const level = LOG_LEVELS.find((l) => l === word.toLowerCase());
	if (level) return { level, error: null };
	const said = word === "" ? "nothing" : `"${word.length > 20 ? `${word.slice(0, 20)}…` : word}"`;
	return { level: DEFAULT_LOG_LEVEL, error: `it says ${said}, not one of ${LOG_LEVELS.join(", ")}` };
}

/** Reads the log-level file at startup. No file means the default; an unreadable or invalid one too, with a warning. */
export function loadLogLevelFile(file: string): { level: LogLevel; warning: string | null } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code ?? String(err);
		if (code === "ENOENT") return { level: DEFAULT_LOG_LEVEL, warning: null };
		return { level: DEFAULT_LOG_LEVEL, warning: `couldn't read ${file} (${code}), so the log level is ${DEFAULT_LOG_LEVEL}` };
	}
	const { level, error } = parseLogLevel(text);
	return { level, warning: error ? `${file} is invalid, so the log level is ${DEFAULT_LOG_LEVEL}: ${error}` : null };
}
