import type { AppliedEvt, FlagValue } from "../lr/protocol.js";
import type { LrModel } from "../model/model.js";
import type { FlagKind, KeyLook } from "./art.js";

/** The `flag` command value for each key, and the `state.flag` value that means "this photo has it". */
export const FLAG_COMMAND: Record<FlagKind, FlagValue> = { pick: "pick", reject: "reject", unflag: "none" };
export const FLAG_STATE: Record<FlagKind, number> = { pick: 1, reject: -1, unflag: 0 };

type ModelView = Pick<LrModel, "conn" | "writable" | "state">;

/** Pick, Reject, Unflag: lit when the current photo has that flag; dimmed when offline or read-only. */
export function flagLook(kind: FlagKind, model: ModelView): KeyLook {
	const online = model.conn === "online";
	const known = online && model.state.photo !== null && model.state.flag !== null;
	return { active: known && model.state.flag === FLAG_STATE[kind], dim: !online || model.writable === false };
}

/** Next, Previous and Before/After don't write, so only the connection dims them. */
export function viewLook(model: Pick<LrModel, "conn">, active = false): KeyLook {
	return { active, dim: model.conn !== "online" };
}

/** Apply Preset writes, so read-only dims it too. */
export function presetLook(model: Pick<LrModel, "conn" | "writable">): KeyLook {
	return { active: false, dim: model.conn !== "online" || model.writable === false };
}

/** showOk when the preset reached at least one photo and none was locked; showAlert otherwise. */
export function presetOutcome(applied: Pick<AppliedEvt, "n" | "locked">): "ok" | "alert" {
	return applied.locked > 0 || applied.n <= 0 ? "alert" : "ok";
}
