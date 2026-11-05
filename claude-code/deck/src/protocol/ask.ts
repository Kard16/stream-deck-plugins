import { ASK_QUESTION, EXIT_PLAN, isObj, type Obj } from "./wire.js";

/**
 * What the deck reads from a held `ask` request, an AskUserQuestion or an ExitPlanMode, so that its session's Session
 * Slot dial can show it and answer it (PROTOCOL.md, Permission requests and Held requests; session-keys.md, The
 * strip). Plain functions, no SDK.
 */

/** A held `ask` request keeps its `tool_input` while JSON.stringify of it is at most this many UTF-8 bytes. */
export const KEEP_INPUT_BYTES = 64 * 1024;

export type AskOption = { readonly label: string; readonly description: string | null };

export type AskQuestion = {
	/** The question's text, which `answers` is keyed by. */
	readonly question: string;
	readonly header: string | null;
	readonly options: readonly AskOption[];
	readonly multiSelect: boolean;
};

/** An AskUserQuestion's form, as `tool_input.questions` carries it (T5). */
export type AskForm = { readonly questions: readonly AskQuestion[] };

/**
 * Why a held `ask` request is display-only (HeldAsk's `inApp`):
 * - `scrubbed`: the bridge's token scrub changed something inside its `tool_input` (src/bridge/server.ts), so the input
 *   as it came is gone, and an Answer or an Approve plan couldn't echo it exactly (PROTOCOL.md, Held requests).
 * - `too big`: its `tool_input`'s JSON is over KEEP_INPUT_BYTES, or can't be written out.
 * - `unreadable`: an AskUserQuestion whose form the deck can't read, or a plan whose `tool_input` isn't an object.
 */
export type InAppWhy = "scrubbed" | "too big" | "unreadable";

/**
 * How a dial can treat a held `ask` request:
 * - `question`: an AskUserQuestion whose form the deck reads; the dial answers it with an Answer.
 * - `plan`: an ExitPlanMode whose `tool_input` is an object; the dial approves it with an Approve plan, or denies it.
 * - `inApp`: display-only, for `why` (InAppWhy). The strip says "Answer in app", and a press jumps.
 *
 * `input` is the request's `tool_input` exactly as it came, which an Answer or an Approve plan echoes back.
 */
export type HeldAsk =
	| { readonly t: "question"; readonly input: Obj; readonly form: AskForm }
	| { readonly t: "plan"; readonly input: Obj; readonly firstLine: string | null }
	| { readonly t: "inApp"; readonly why: InAppWhy };

/** The picks for each question, by the question's text: the chosen labels. */
export type AskPicks = Readonly<Record<string, readonly string[]>>;

export type AnswersResult = { ok: true; answers: Record<string, string> } | { ok: false; why: string };

/**
 * The size of `input` as JSON, in UTF-8 bytes; null when it can't be written out (nested too deeply, say) or isn't
 * JSON at all.
 */
export function jsonBytes(input: unknown): number | null {
	let json: string | undefined;
	try {
		json = JSON.stringify(input);
	} catch {
		return null;
	}
	return typeof json === "string" ? Buffer.byteLength(json, "utf8") : null;
}

/**
 * What a dial can do with a held `ask` request for `tool`, from its `tool_input`. `scrubbed`: the bridge's token scrub
 * changed something inside that input, which makes the request display-only whatever else it is, as in the tools' fake
 * deck (claude-code/tools/lib/deck.mjs, notKept).
 */
export function heldAsk(tool: string, input: unknown, opts: { scrubbed?: boolean } = {}): HeldAsk {
	if (opts.scrubbed === true) return { t: "inApp", why: "scrubbed" };
	const bytes = jsonBytes(input);
	if (bytes === null || bytes > KEEP_INPUT_BYTES) return { t: "inApp", why: "too big" };
	if (tool === ASK_QUESTION) {
		const form = parseAskForm(input);
		return form && isObj(input) ? { t: "question", input, form } : { t: "inApp", why: "unreadable" };
	}
	if (tool === EXIT_PLAN && isObj(input)) return { t: "plan", input, firstLine: planFirstLine(input) };
	return { t: "inApp", why: "unreadable" };
}

/**
 * An AskUserQuestion's form; null for one the deck can't read, which stays display-only: no `questions` array, or an
 * empty one; a question that isn't an object, or whose `question` isn't a non-empty string, or that two questions
 * share (the answers are keyed by it); a `header` or `multiSelect` of the wrong type; a question without options; an
 * option that isn't an object, whose `label` isn't a non-empty string or repeats another's, or whose `description` is
 * there but not a string. Other fields don't matter, and go back unchanged in the Answer.
 */
export function parseAskForm(input: unknown): AskForm | null {
	if (!isObj(input) || !Array.isArray(input.questions) || input.questions.length === 0) return null;
	const texts = new Set<string>();
	const questions: AskQuestion[] = [];
	for (const q of input.questions as unknown[]) {
		if (!isObj(q) || typeof q.question !== "string" || q.question === "" || texts.has(q.question)) return null;
		texts.add(q.question);
		if (q.header !== undefined && typeof q.header !== "string") return null;
		if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean") return null;
		if (!Array.isArray(q.options) || q.options.length === 0) return null;
		const labels = new Set<string>();
		const options: AskOption[] = [];
		for (const o of q.options as unknown[]) {
			if (!isObj(o) || typeof o.label !== "string" || o.label === "" || labels.has(o.label)) return null;
			if (o.description !== undefined && typeof o.description !== "string") return null;
			labels.add(o.label);
			options.push({ label: o.label, description: typeof o.description === "string" ? o.description : null });
		}
		questions.push({ question: q.question, header: typeof q.header === "string" ? q.header : null, options, multiSelect: q.multiSelect === true });
	}
	return { questions };
}

/**
 * A multi-select answer: the labels, already in the order of the question's options, joined with `", "`. A label that
 * holds `", "` or `"` is written as a JSON string, as Claude Code joins its own (the engine check, 2026-11-04), so
 * `Apple` and `Pear, ripe` give `Apple, "Pear, ripe"`.
 */
export function joinLabels(labels: readonly string[]): string {
	return labels.map((label) => (label.includes(", ") || label.includes('"') ? JSON.stringify(label) : label)).join(", ");
}

/**
 * The `answers` for a form from the picks, checked first: every question answered; every label one of its question's
 * options, and none twice; exactly one for a single-select question, at least one for a multi-select one; and no picks
 * for a question the form doesn't have. A single-select answer is the label as it is; a multi-select one is the labels
 * in the order of the options, joined (joinLabels). Anything else answers nothing, with the reason.
 */
export function askAnswers(form: AskForm, picks: AskPicks): AnswersResult {
	const asked = new Set(form.questions.map((q) => q.question));
	for (const text of Object.keys(picks)) if (!asked.has(text)) return { ok: false, why: `${JSON.stringify(text)} isn't one of the form's questions` };
	const entries: [string, string][] = [];
	for (const q of form.questions) {
		const chosen = Object.hasOwn(picks, q.question) ? picks[q.question] : undefined;
		if (!Array.isArray(chosen) || chosen.length === 0) return { ok: false, why: `${JSON.stringify(q.question)} isn't answered` };
		const set = new Set<string>(chosen);
		if (set.size !== chosen.length) return { ok: false, why: `${JSON.stringify(q.question)} has a label picked twice` };
		for (const label of set) if (!q.options.some((o) => o.label === label)) return { ok: false, why: `${JSON.stringify(label)} isn't one of the options of ${JSON.stringify(q.question)}` };
		if (!q.multiSelect && set.size !== 1) return { ok: false, why: `${JSON.stringify(q.question)} takes one answer, and has ${set.size}` };
		const inOrder = q.options.filter((o) => set.has(o.label)).map((o) => o.label);
		entries.push([q.question, q.multiSelect ? joinLabels(inOrder) : (inOrder[0] ?? "")]);
	}
	// Defined as JSON.parse defines keys, so a question whose text is "__proto__" stays an ordinary key.
	return { ok: true, answers: Object.fromEntries(entries) };
}

/**
 * The plan's first heading or line, for the strip: the first line of `plan` with text in it, without a heading's `#`
 * marks, trimmed. Null when the input has no `plan` string (Claude wrote no plan file) or no line with text.
 */
export function planFirstLine(input: unknown): string | null {
	if (!isObj(input) || typeof input.plan !== "string") return null;
	for (const raw of input.plan.split(/\r\n|\n|\r/)) {
		const line = raw.replace(/^\s*#+\s*/, "").trim();
		if (line !== "") return line;
	}
	return null;
}
