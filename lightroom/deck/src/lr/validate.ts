/**
 * Checks a command against PROTOCOL.md's Commands table before it goes on the wire. The client refuses to
 * send anything this rejects, and the tests run every command the plugin sends through it.
 *
 * It is stricter than Lightroom needs to be: our own commands carry no unknown fields, `set` carries `g`,
 * and `set.v` is already rounded (Exposure to 0.01, everything else to whole numbers).
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isName = (v: unknown): v is string => typeof v === "string" && v.length > 0;

type FieldRule = { required: boolean; check: (v: unknown) => string | null };

const req = (check: FieldRule["check"]): FieldRule => ({ required: true, check });
const opt = (check: FieldRule["check"]): FieldRule => ({ required: false, check });

const integer: FieldRule["check"] = (v) => (isInt(v) ? null : "must be an integer");
const name: FieldRule["check"] = (v) => (isName(v) ? null : "must be a non-empty string");
const bool: FieldRule["check"] = (v) => (typeof v === "boolean" ? null : "must be a boolean");
const oneOf =
	(...values: string[]): FieldRule["check"] =>
	(v) =>
		typeof v === "string" && values.includes(v) ? null : `must be one of ${values.map((x) => `"${x}"`).join(", ")}`;
const names: FieldRule["check"] = (v) =>
	Array.isArray(v) && v.every(isName) ? null : "must be a list of non-empty strings";
const finite: FieldRule["check"] = (v) => (typeof v === "number" && Number.isFinite(v) ? null : "must be a finite number");

/** Every command type and its fields. `id` is allowed on any command ("Any command may carry an integer id"). */
const RULES: Record<string, Record<string, FieldRule>> = {
	hello: { v: req((v) => (v === 1 ? null : "must be 1")), client: req(name), ver: req(name), id: opt(integer) },
	ping: { id: req(integer) },
	watch: { ps: req(names), id: opt(integer) },
	set: { p: req(name), v: req(finite), g: req(integer), id: opt(integer) },
	done: { g: opt(integer), id: opt(integer) },
	reset: { p: req(name), id: opt(integer) },
	module: { v: req(oneOf("develop", "library")), id: opt(integer) },
	flag: { v: req(oneOf("pick", "reject", "none")), advance: opt(bool), id: opt(integer) },
	nav: { v: req(oneOf("next", "prev")), id: opt(integer) },
	view: { v: req(oneOf("before", "after")), id: opt(integer) },
	presets: { id: req(integer) },
	preset: { id: req(integer), uuid: req(name) },
	reload: { id: req(integer), mods: opt(names) },
};

/** Returns the problems with `cmd`; an empty list means it may be sent. */
export function validateCommand(cmd: unknown): string[] {
	if (!isObj(cmd)) return ["a command must be a JSON object"];
	const t = cmd.t;
	if (typeof t !== "string") return ["t must be a string"];
	// Own properties only: "constructor" or "__proto__" must not find Object.prototype's.
	const rules = Object.hasOwn(RULES, t) ? RULES[t] : undefined;
	if (!rules) return [`unknown command type "${t}"`];
	const problems: string[] = [];
	for (const [field, rule] of Object.entries(rules)) {
		const value = cmd[field];
		if (value === undefined) {
			if (rule.required) problems.push(`${t}.${field} is missing`);
			continue;
		}
		const problem = rule.check(value);
		if (problem) problems.push(`${t}.${field} ${problem}`);
	}
	for (const field of Object.keys(cmd)) {
		if (field !== "t" && !Object.hasOwn(rules, field)) problems.push(`${t}.${field} isn't a field of ${t}`);
	}
	if (t === "set" && typeof cmd.v === "number" && typeof cmd.p === "string") {
		const scale = cmd.p === "Exposure" ? 100 : 1;
		const scaled = cmd.v * scale;
		if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
			problems.push(`set.v ${cmd.v} isn't rounded to ${cmd.p === "Exposure" ? "0.01" : "a whole number"}`);
		}
	}
	return problems;
}
