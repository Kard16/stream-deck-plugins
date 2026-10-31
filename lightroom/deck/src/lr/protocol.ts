/**
 * DeckBridge protocol v1: message types and event parsing. The contract is lightroom/protocol/PROTOCOL.md;
 * this file follows it and adds nothing to the wire.
 */

export const PROTOCOL_VERSION = 1;
/** Lightroom's receive socket: commands from the deck. */
export const DEFAULT_CMD_PORT = 58780;
/** Lightroom's send socket: events to the deck. */
export const DEFAULT_EVT_PORT = 58781;

export type FlagValue = "pick" | "reject" | "none";
export type ModuleName = "develop" | "library";
export type NavDirection = "next" | "prev";
export type ViewName = "before" | "after";

// ---- Commands (deck → Lightroom) ----

export type HelloCmd = { t: "hello"; v: 1; client: string; ver: string; id?: number };
export type PingCmd = { t: "ping"; id: number };
export type WatchCmd = { t: "watch"; ps: string[]; id?: number };
export type SetCmd = { t: "set"; p: string; v: number; g: number; id?: number };
export type DoneCmd = { t: "done"; g?: number; id?: number };
export type ResetCmd = { t: "reset"; p: string; id?: number };
export type ModuleCmd = { t: "module"; v: ModuleName; id?: number };
export type FlagCmd = { t: "flag"; v: FlagValue; advance?: boolean; id?: number };
export type NavCmd = { t: "nav"; v: NavDirection; id?: number };
export type ViewCmd = { t: "view"; v: ViewName; id?: number };
export type PresetsCmd = { t: "presets"; id: number };
export type PresetCmd = { t: "preset"; id: number; uuid: string };
export type ReloadCmd = { t: "reload"; id: number; mods?: string[] };

export type Command =
	| HelloCmd
	| PingCmd
	| WatchCmd
	| SetCmd
	| DoneCmd
	| ResetCmd
	| ModuleCmd
	| FlagCmd
	| NavCmd
	| ViewCmd
	| PresetsCmd
	| PresetCmd
	| ReloadCmd;

export type CommandType = Command["t"];

/** Commands with a reply that carries their `id`, and the reply's type. */
export const REPLY_TYPE = {
	ping: "pong",
	presets: "presets",
	preset: "applied",
	reload: "reloaded",
} as const;

export type RequestCommand = PingCmd | PresetsCmd | PresetCmd | ReloadCmd;
/** A request as the caller writes it: the client assigns the `id`. */
export type RequestInput = DistributiveOmit<RequestCommand, "id">;
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

// ---- Events (Lightroom → deck) ----

export type HelloEvt = {
	t: "hello";
	v: number;
	lr?: string;
	catalog?: string;
	path?: string;
	guard?: string;
	writable?: boolean;
	inst?: string;
};

/** `state` always carries every field on the wire; the parser keeps whichever arrive well-typed. */
export type StateEvt = {
	t: "state";
	module?: string;
	photo?: string | null;
	file?: string | null;
	flag?: number;
	rating?: number;
	label?: string;
	sel?: number;
};

export type Range = readonly [min: number, max: number];
export type RangesEvt = { t: "ranges"; ranges: Record<string, Range> };
export type ValsEvt = { t: "vals"; vals: Record<string, number> };
export type AckEvt = { t: "ack"; p: string; v: number; g?: number };
export type PresetItem = { uuid: string; name: string; folder: string };
export type PresetsEvt = { t: "presets"; id?: number; items: PresetItem[] };
export type AppliedEvt = { t: "applied"; id?: number; uuid?: string; n: number; locked: number };
export type ReloadedEvt = { t: "reloaded"; id?: number; mods?: string[]; ok: boolean; msg?: string };
export type PongEvt = { t: "pong"; id?: number; lt?: number };
export type ErrCode = "guard" | "bad" | "unknown" | "noDevelop" | "noPhoto" | "notFound" | "busy" | "failed";
export type ErrEvt = { t: "err"; id?: number; cmd?: string; code: string; msg?: string };

export type LrEvent =
	| HelloEvt
	| StateEvt
	| RangesEvt
	| ValsEvt
	| AckEvt
	| PresetsEvt
	| AppliedEvt
	| ReloadedEvt
	| PongEvt
	| ErrEvt;

export type EventType = LrEvent["t"];

export type ParseResult =
	| { kind: "event"; evt: LrEvent; dropped: string[] }
	/** A well-formed message of a type v1 doesn't define. Unknown types are ignored, for forward compatibility. */
	| { kind: "ignored"; why: string }
	| { kind: "invalid"; why: string };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/**
 * Turns one decoded JSON line from the event socket into a typed event. Required fields must be present and
 * well-typed; optional fields that arrive with the wrong type are dropped (and named in `dropped`), and
 * unknown fields are ignored, as PROTOCOL.md's framing rules say.
 */
export function parseEvent(raw: unknown): ParseResult {
	if (!isObj(raw)) return { kind: "invalid", why: "not a JSON object" };
	const t = raw.t;
	if (!isStr(t)) return { kind: "invalid", why: "no string field t" };
	const dropped: string[] = [];
	const event = (evt: LrEvent): ParseResult => ({ kind: "event", evt, dropped });
	const invalid = (why: string): ParseResult => ({ kind: "invalid", why: `${t}: ${why}` });
	/** Copies an optional field when it has the right type; notes it otherwise. */
	const opt = <T>(name: string, ok: (v: unknown) => v is T): T | undefined => {
		const v = raw[name];
		if (v === undefined) return undefined;
		if (ok(v)) return v;
		dropped.push(name);
		return undefined;
	};
	const optId = (): number | undefined => opt("id", isNum);

	switch (t) {
		case "hello": {
			if (!isNum(raw.v)) return invalid("v must be a number");
			const evt: HelloEvt = { t, v: raw.v };
			assign(evt, "lr", opt("lr", isStr));
			assign(evt, "catalog", opt("catalog", isStr));
			assign(evt, "path", opt("path", isStr));
			assign(evt, "guard", opt("guard", isStr));
			assign(evt, "writable", opt("writable", (v): v is boolean => typeof v === "boolean"));
			assign(evt, "inst", opt("inst", isStr));
			return event(evt);
		}
		case "state": {
			const evt: StateEvt = { t };
			assign(evt, "module", opt("module", isStr));
			assign(evt, "photo", optIdentifier(raw, "photo", dropped));
			assign(evt, "file", opt("file", (v): v is string | null => v === null || isStr(v)));
			assign(evt, "flag", opt("flag", (v): v is number => v === -1 || v === 0 || v === 1));
			assign(evt, "rating", opt("rating", (v): v is number => isNum(v) && v >= 0 && v <= 5));
			assign(evt, "label", opt("label", isStr));
			assign(evt, "sel", opt("sel", (v): v is number => isNum(v) && v >= 0));
			return event(evt);
		}
		case "ranges": {
			if (!isObj(raw.ranges)) return invalid("ranges must be an object");
			const ranges: Record<string, Range> = {};
			for (const [p, r] of Object.entries(raw.ranges)) {
				if (Array.isArray(r) && r.length === 2 && isNum(r[0]) && isNum(r[1]) && r[0] < r[1]) ranges[p] = [r[0], r[1]];
				else dropped.push(`ranges.${p}`);
			}
			return event({ t, ranges });
		}
		case "vals": {
			if (!isObj(raw.vals)) return invalid("vals must be an object");
			const vals: Record<string, number> = {};
			for (const [p, v] of Object.entries(raw.vals)) {
				if (isNum(v)) vals[p] = v;
				else dropped.push(`vals.${p}`);
			}
			return event({ t, vals });
		}
		case "ack": {
			if (!isStr(raw.p) || raw.p === "") return invalid("p must be a parameter name");
			if (!isNum(raw.v)) return invalid("v must be a number");
			const evt: AckEvt = { t, p: raw.p, v: raw.v };
			assign(evt, "g", opt("g", isNum));
			return event(evt);
		}
		case "presets": {
			if (!Array.isArray(raw.items)) return invalid("items must be a list");
			const items: PresetItem[] = [];
			raw.items.forEach((item: unknown, i: number) => {
				if (isObj(item) && isStr(item.uuid) && item.uuid !== "" && isStr(item.name)) {
					items.push({ uuid: item.uuid, name: item.name, folder: isStr(item.folder) ? item.folder : "" });
				} else dropped.push(`items[${i}]`);
			});
			const evt: PresetsEvt = { t, items };
			assign(evt, "id", optId());
			return event(evt);
		}
		case "applied": {
			const evt: AppliedEvt = { t, n: 0, locked: 0 };
			assign(evt, "id", optId());
			assign(evt, "uuid", opt("uuid", isStr));
			evt.n = opt("n", isNum) ?? 0;
			evt.locked = opt("locked", isNum) ?? 0;
			return event(evt);
		}
		case "reloaded": {
			const evt: ReloadedEvt = { t, ok: raw.ok === true };
			assign(evt, "id", optId());
			assign(evt, "mods", opt("mods", (v): v is string[] => Array.isArray(v) && v.every(isStr)));
			assign(evt, "msg", opt("msg", isStr));
			return event(evt);
		}
		case "pong": {
			const evt: PongEvt = { t };
			assign(evt, "id", optId());
			assign(evt, "lt", opt("lt", isNum));
			return event(evt);
		}
		case "err": {
			if (!isStr(raw.code) || raw.code === "") return invalid("code must be a string");
			const evt: ErrEvt = { t, code: raw.code };
			assign(evt, "id", optId());
			assign(evt, "cmd", opt("cmd", isStr));
			assign(evt, "msg", opt("msg", isStr));
			return event(evt);
		}
		default:
			return { kind: "ignored", why: `unknown event type "${t}"` };
	}
}

/** `photo` is a `localIdentifier` as a string, or null. A bare number is accepted and kept as a string. */
function optIdentifier(raw: Obj, name: string, dropped: string[]): string | null | undefined {
	const v = raw[name];
	if (v === undefined) return undefined;
	if (v === null || isStr(v)) return v;
	if (isNum(v)) return String(v);
	dropped.push(name);
	return undefined;
}

/** Sets an optional property only when it has a value, so absent fields stay absent. */
function assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
	if (value !== undefined) target[key] = value;
}

/**
 * Rounds to `decimals` places, halves away from zero: Math.round takes halves up, so fine adjust from 0 would
 * reach +1 after two quarter ticks but -1 only after three. Never returns -0.
 */
export function roundHalfAway(value: number, decimals = 0): number {
	const factor = 10 ** decimals;
	const r = (Math.sign(value) * Math.round(Math.abs(value) * factor)) / factor;
	return r === 0 ? 0 : r;
}

/** The rounding PROTOCOL.md's Develop values section asks for before sending: Exposure to 0.01, the rest to whole numbers. */
export function roundForSend(param: string, value: number): number {
	return roundHalfAway(value, param === "Exposure" ? 2 : 0); // no -0 on the wire
}
