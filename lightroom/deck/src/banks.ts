/** One dial position in a bank: the strip label and the LrDevelopController parameter it drives. */
export type Slot = { label: string; param: string };

/**
 * Dial banks, in Basic-panel order (kickoff answer 1 in docs/lightroom/plan.md). All four dials page
 * together, and a dial's position in a bank is its column. `null` is an empty slot.
 */
export const BANKS: readonly (readonly (Slot | null)[])[] = [
	[
		{ label: "Temp", param: "Temperature" },
		{ label: "Tint", param: "Tint" },
		{ label: "Exposure", param: "Exposure" },
		{ label: "Contrast", param: "Contrast" },
	],
	[
		{ label: "Highlights", param: "Highlights" },
		{ label: "Shadows", param: "Shadows" },
		{ label: "Whites", param: "Whites" },
		{ label: "Blacks", param: "Blacks" },
	],
	[
		{ label: "Texture", param: "Texture" },
		{ label: "Clarity", param: "Clarity" },
		{ label: "Vibrance", param: "Vibrance" },
		{ label: "Saturation", param: "Saturation" },
	],
	[{ label: "Vignette", param: "PostCropVignetteAmount" }, null, null, null],
];

export function slotAt(bank: number, column: number): Slot | null {
	return BANKS[bank]?.[column] ?? null;
}
