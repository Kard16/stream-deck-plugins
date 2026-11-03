import { RecordsReader, RecordsWatcher } from "../records/records.js";
import { RegistryReader } from "../registry/registry.js";
import { RegistryWatcher } from "../registry/watcher.js";
import { type Log, nullLog } from "../util/log.js";
import { SessionModel, type SessionModelOptions } from "./sessions.js";

/** The logs for each part, by the scope the plugin gives it; a part without one logs nothing. */
export type SourceLogs = { registry?: Log; records?: Log; sessions?: Log };

export type Sources = { registry: RegistryWatcher; records: RecordsWatcher; model: SessionModel };

/**
 * The session model and the two folders it reads, wired as the plugin runs them (src/plugin.ts), so tests run the
 * same wiring:
 * - each registry reading goes to the model, and the hosts it lists to the records watcher, which reads their new
 *   records at once;
 * - each change to the records goes to the model;
 * - a hook's request or a hello that the model's latest reading doesn't confirm has the registry read once more,
 *   through the same watcher, at once rather than at its next scan (PROTOCOL.md, Desktop sessions only).
 *
 * Nothing is read until the caller starts the watchers or scans, and the caller stops them.
 */
export function connectSources(opts: {
	registryDir: string;
	recordsDir: string;
	logs?: SourceLogs;
	/** The model's clocks and limits; its log and its second reading come from here. */
	model?: Omit<SessionModelOptions, "log" | "rescan">;
}): Sources {
	const registryLog = opts.logs?.registry ?? nullLog;
	const recordsLog = opts.logs?.records ?? nullLog;
	const registry = new RegistryWatcher(new RegistryReader(opts.registryDir, { log: registryLog }), { log: registryLog });
	const model = new SessionModel({ ...opts.model, log: opts.logs?.sessions ?? nullLog, rescan: () => registry.scanNow() });
	const records = new RecordsWatcher(new RecordsReader(opts.recordsDir, { log: recordsLog }), { log: recordsLog });
	registry.onChange((sessions) => {
		model.setRegistry(sessions);
		records.setHosts(model.hosts());
	});
	records.onChange((recs) => model.setRecords(recs));
	return { registry, records, model };
}
