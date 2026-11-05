import { type OthersFace, othersKeySvg, type SlotFace, slotKeySvg } from "../keys/art.js";
import { sinceText } from "../model/format.js";
import type { Need, SessionView } from "../model/sessions.js";
import type { SlotKeyArt, SlotKeyLook } from "./keys.js";
import type { OthersArt, OthersLook } from "./others.js";

/**
 * The Session Slot and Other Sessions keys' faces, from what the core shows (SlotKeyLook, OthersLook), drawn with
 * src/keys/art.ts (session-keys.md, The key face and Others). Plain functions, no SDK.
 */

/** The top line's word for what a session waits on. */
export const NEED_WORDS: Record<Need, string> = {
	question: "Question",
	plan: "Plan",
	approval: "Approve?",
	input: "Needs you",
};

/** A tool's name as a key or strip shows it: an MCP tool by its own name, its server left out (`set session permission mode`). */
export function toolName(tool: string): string {
	if (!tool.startsWith("mcp__")) return tool;
	const name = tool.split("__").slice(2).join("__");
	return name === "" ? tool : name.replaceAll("_", " ");
}

/** Context use as a whole percent, 0–100; null when unknown. */
export function contextPercent(context: number | null): number | null {
	return context === null || !Number.isFinite(context) ? null : Math.max(0, Math.min(100, Math.round(context)));
}

/**
 * What a Session Slot key shows (session-keys.md, The key face), from its slot's session:
 * - none: the empty slot, `No session`, with how to fill it;
 * - not running: `Not running` and the title, dimmed;
 * - waiting on you (`need`): amber, `Question`, `Plan`, `Approve?` or `Needs you`, with the tool for an approval;
 * - working: blue, `Working`, with the tool it's on;
 * - a turn's end not seen: green `Done`, red `Failed`, dark red `Stopped`; an idle session whose activity since it was
 *   last on screen the deck didn't see end (seen false) reads as Done;
 * - seen, or idle: dark, `Done`, `Failed`, `Stopped` or `Idle`.
 * Each but the first two has `since` and the context %. `heldTool` gives the tool of the session's oldest held request
 * (the model's held requests), which an approval's bottom line shows; without it, the tool it's on.
 */
export function slotFace(look: SlotKeyLook, heldTool: (host: string) => string | null = () => null): SlotFace {
	const s = look.session;
	if (s === null) return { tone: "empty", word: "No session", since: null, title: null, tool: null, context: null };
	if (!s.running) return { tone: "notRunning", word: "Not running", since: null, title: s.title, tool: null, context: null };
	const since = sinceText(s.since, look.now);
	const context = contextPercent(s.context);
	const face = (tone: SlotFace["tone"], word: string, tool: string | null = null): SlotFace => ({ tone, word, since, title: s.title, tool, context });
	if (s.need !== null) {
		const held = s.need === "approval" && s.host !== null ? heldTool(s.host) : null;
		return face("need", NEED_WORDS[s.need], s.need === "approval" ? (held === null ? s.doing : toolName(held)) : null);
	}
	const unseen = s.seen === false;
	switch (s.status) {
		case "working":
			return face("working", "Working", s.doing);
		case "done":
			return face(unseen ? "done" : "quiet", "Done");
		case "failed":
			return face(unseen ? "failed" : "quiet", "Failed");
		case "interrupted":
			return face(unseen ? "stopped" : "quiet", "Stopped");
		case "idle":
			return unseen ? face("done", "Done") : face("quiet", "Idle");
		// Approval and needs-you always come with a need; this only covers a view that somehow lacks one.
		case "approval":
		case "needs-you":
			return face("need", NEED_WORDS.input);
	}
}

/** slotFace's `heldTool` from the model's held requests: the tool of the session's oldest one, or null. */
export function heldToolOf(model: { readonly held: { oldestFor(host: string): { readonly tool: string } | null } }): (host: string) => string | null {
	return (host) => model.held.oldestFor(host)?.tool ?? null;
}

/** The Session Slot keys' art (SlotKeys' `art`): `heldTool` as for slotFace (heldToolOf in the plugin). */
export function slotKeyArt(opts: { heldTool?: (host: string) => string | null } = {}): SlotKeyArt {
	const heldTool = opts.heldTool ?? (() => null);
	return (look) => slotKeySvg(slotFace(look, heldTool));
}

/** The word for what the longest-waiting session off the slots waits on. */
function waitsOn(s: SessionView): string {
	return s.need === null ? NEED_WORDS.input : NEED_WORDS[s.need];
}

/** What the Others key shows (session-keys.md, Others), from OthersLook. */
export function othersFace(look: OthersLook): OthersFace {
	const o = look.oldest;
	return {
		needing: look.needing,
		oldest: o === null ? null : { title: o.title, word: waitsOn(o), since: sinceText(o.since, look.now) },
		unseen: look.unseen,
		running: look.running,
	};
}

/** The Others keys' art (OthersKeys' `art`). */
export const othersArt: OthersArt = (look) => othersKeySvg(othersFace(look));
