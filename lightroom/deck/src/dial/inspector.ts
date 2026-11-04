import type { Slider } from "../sliders.js";

/** What the Develop Dial's Property Inspector (pi/dial.js) asks for, through sendToPlugin. */
export type SlidersRequest = { t: "getSliders" };

/**
 * The plugin's answer, through sendToPropertyInspector: every slider in sliders.json's order, and the dial's
 * current param, which may be one the list doesn't have. Null only for a dial the plugin doesn't know.
 */
export type SlidersReply = { t: "sliders"; items: { param: string; label: string }[]; param: string | null };

export function isSlidersRequest(payload: unknown): payload is SlidersRequest {
	return typeof payload === "object" && payload !== null && (payload as { t?: unknown }).t === "getSliders";
}

export function slidersReply(sliders: readonly Slider[], param: string | null): SlidersReply {
	return { t: "sliders", items: sliders.map((s) => ({ param: s.param, label: s.label })), param };
}
