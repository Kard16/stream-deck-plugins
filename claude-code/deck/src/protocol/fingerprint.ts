/**
 * The fingerprint and summary of a tool call (PROTOCOL.md, "Fingerprints and summaries"), as the reference
 * implementation in claude-code/protocol/make-fixtures.mjs has them. Both sides compute them: the bridge from a
 * PermissionRequest's `tool_name` and `tool_input`, the mod from `tool.call`. test/vectors.test.ts checks this
 * file against fixtures/vectors.json.
 */

/**
 * JSON with no spaces and keys sorted by UTF-16 code units (JavaScript's default sort). Keys whose value is
 * undefined are left out of objects; arrays keep their order, with undefined written as null, as
 * JSON.stringify does.
 */
export function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map((x: unknown) => (x === undefined ? "null" : canonical(x))).join(",")}]`;
	if (v !== null && typeof v === "object") {
		const o = v as Record<string, unknown>;
		const keys = Object.keys(o)
			.sort()
			.filter((k) => o[k] !== undefined);
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
	}
	// Only reachable for undefined or a function at the top, which JSON bodies never hold.
	return JSON.stringify(v) ?? "null";
}

/** FNV-1a, 32 bits, over UTF-16 code units. */
export function fnv1a32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
	return h;
}

/** `fnv1a32(tool + "\n" + canonical(input))` as 8 lowercase hex digits. */
export function fingerprint(tool: string, input: unknown): string {
	return fnv1a32(`${tool}\n${canonical(input)}`).toString(16).padStart(8, "0");
}

/** A summary is at most this many UTF-16 code units. */
export const SUMMARY_MAX = 40;

/** Cut to SUMMARY_MAX: the first 39 code units and an ellipsis. */
export function cutSummary(s: string): string {
	return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const lastSegment = (p: string): string | null => p.split("/").filter((x) => x !== "").at(-1) ?? null;

/** The host of a URL: after `://`, up to the next `/`, `?` or `#`, without `user@` or `:port`. */
function hostOf(url: string): string | null {
	const i = url.indexOf("://");
	if (i < 0) return null;
	let rest = url.slice(i + 3);
	const end = rest.search(/[/?#]/);
	if (end >= 0) rest = rest.slice(0, end);
	rest = rest.slice(rest.lastIndexOf("@") + 1).replace(/:\d*$/, "");
	return rest === "" ? null : rest;
}

/** What the deck shows for a call: a command's first line, a file's name, a pattern, a host… else the tool's name. */
export function summary(tool: string, input: unknown): string {
	const i = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
	let s: string | null = null;
	switch (tool) {
		case "Bash": {
			const c = str(i.command);
			s = c === null ? null : str((c.split("\n")[0] ?? "").trim());
			break;
		}
		case "Read":
		case "Write":
		case "Edit":
		case "MultiEdit": {
			const p = str(i.file_path);
			s = p === null ? null : lastSegment(p);
			break;
		}
		case "NotebookEdit": {
			const p = str(i.notebook_path);
			s = p === null ? null : lastSegment(p);
			break;
		}
		case "Glob":
		case "Grep":
			s = str(i.pattern);
			break;
		case "WebFetch": {
			const u = str(i.url);
			s = u === null ? null : hostOf(u);
			break;
		}
		case "WebSearch":
			s = str(i.query);
			break;
		case "Agent":
		case "Task":
			s = str(i.description) ?? str(i.subagent_type);
			break;
		case "AskUserQuestion": {
			const first: unknown = Array.isArray(i.questions) ? i.questions[0] : undefined;
			s = first !== null && typeof first === "object" ? str((first as Record<string, unknown>).question) : null;
			break;
		}
		case "ExitPlanMode":
			s = "Plan ready";
			break;
		default:
			if (tool.startsWith("mcp__")) {
				const name = tool.split("__").slice(2).join("__");
				s = name === "" ? null : name.replaceAll("_", " ");
			}
	}
	return cutSummary(s ?? tool);
}
