import type { SessionView } from "../../src/model/sessions.js";

/** A running session as the model shows it, with the fields a test names. */
export function view(fields: Partial<SessionView> = {}): SessionView {
	return {
		key: "local_a",
		host: "local_a",
		pid: "1",
		title: "Fix the build",
		status: "idle",
		doing: null,
		context: null,
		model: null,
		effort: null,
		mode: null,
		plugin: true,
		listed: true,
		running: true,
		need: null,
		since: null,
		seen: null,
		tokens: null,
		window: null,
		cost: null,
		summary: null,
		needs: null,
		project: null,
		startedAt: null,
		archived: false,
		...fields,
	};
}
