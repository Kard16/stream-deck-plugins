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
 * - each registry reading goes to the model, and the hosts whose records it reads to the records watcher, which
 *   reads their new records at once: the hosts the registry lists, and the slotted ones it doesn't (the model's
 *   keepHosts), whenever those change;
 * - each change to the records goes to the model, with the hosts that have no record file;
 * - a hook's request or a hello that the model's latest reading doesn't confirm has the registry read once more,
 *   through the same watcher, at once rather than at its next scan (PROTOCOL.md, Desktop sessions only).
 *
 * Nothing is read until the caller starts the watchers or scans, and the caller stops them. The front-app check for
 * `seen` comes with `model.front` (front.ts's lsappinfoCheck in the plugin); without it, nothing is spawned.
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
	// The slotted hosts change with the slots, not the registry. setHosts does nothing while the list is the same.
	model.onChange(() => records.setHosts(model.hosts()));
	records.onChange((recs, missing) => model.setRecords(recs, missing));
	return { registry, records, model };
}
