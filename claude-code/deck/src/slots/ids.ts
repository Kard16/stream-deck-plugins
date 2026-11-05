/**
 * A Session Slot's id: `<device>:<row>:<col>`, the place of a Session Slot key (session-keys.md, Slots). A Session
 * Slot dial joins the slot of the key above it, the bottom row's key in its column: `<device>:<rows − 1>:<col>`, from
 * the device's size (row 1 on a Stream Deck +). A dial with no key above still has that slot, and a slot key on the
 * top row has no dial.
 */
export type SlotId = string;

export type SlotPlace = { device: string; row: number; col: number };

/** The device id may hold colons; the row and column are the last two parts, whole numbers. */
const SLOT_PATTERN = /^(.+):(\d{1,3}):(\d{1,3})$/;

/** The id of the slot at a key's place. */
export function slotId(device: string, row: number, col: number): SlotId {
	return `${device}:${row}:${col}`;
}

/** The slot a dial in column `col` joins: the bottom row's key above it, on a device `rows` keys high. */
export function dialSlotId(device: string, rows: number, col: number): SlotId {
	return slotId(device, Math.max(0, rows - 1), col);
}

/** A slot id's parts; null for anything that isn't one. */
export function parseSlotId(id: string): SlotPlace | null {
	const m = SLOT_PATTERN.exec(id);
	if (!m?.[1] || m[2] === undefined || m[3] === undefined) return null;
	// No control characters: the id goes into the log and the saved file.
	if (/[\u0000-\u001f\u007f]/.test(m[1])) return null;
	return { device: m[1], row: Number(m[2]), col: Number(m[3]) };
}

/**
 * The order empty slots fill in: by device, then bottom row first, then left to right (session-keys.md, Fill). Ids
 * that don't parse come last, by text.
 */
export function compareSlots(a: SlotId, b: SlotId): number {
	const pa = parseSlotId(a);
	const pb = parseSlotId(b);
	if (!pa || !pb) return pa ? -1 : pb ? 1 : a < b ? -1 : a > b ? 1 : 0;
	if (pa.device !== pb.device) return pa.device < pb.device ? -1 : 1;
	if (pa.row !== pb.row) return pb.row - pa.row;
	return pa.col - pb.col;
}
