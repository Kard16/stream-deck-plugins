import { ENDED_COLOR, STATUS_COLORS, statusLine } from "../model/format.js";
import type { SessionView } from "../model/sessions.js";
import type { Clock } from "../util/clock.js";
import { type Log, nullLog, quote } from "../util/log.js";
import { KeyPainter, PAINT_INTERVAL_MS } from "../util/painter.js";
import { type SessionKeyLook, sessionKeySvg } from "./art.js";
import type { KeySurface } from "./decision.js";

/** What the Session key needs from the session model. */
export interface TargetModel {
	target(): SessionView | null;
	onChange(listener: () => void): () => void;
}

export function sessionKeyLook(target: SessionView | null): SessionKeyLook {
	if (!target) return { title: null, status: "", statusColor: ENDED_COLOR };
	if (!target.listed) return { title: target.title, status: "ended", statusColor: ENDED_COLOR };
	return { title: target.title, status: statusLine(target.status, target.doing), statusColor: STATUS_COLORS[target.status] };
}

type Key = { surface: KeySurface; painter: KeyPainter<null> };

/**
 * The Session keys, without the SDK: the target session's title and status. A press jumps to it in the
 * app; with no target, or one that has ended, it alerts.
 */
export class SessionKeys {
	readonly #model: TargetModel;
	readonly #log: Log;
	readonly #clock: Clock | undefined;
	readonly #paintIntervalMs: number;
	readonly #open: (host: string) => void;
	readonly #keys = new Map<string, Key>();

	constructor(model: TargetModel, opts: { log?: Log; clock?: Clock; paintIntervalMs?: number; open?: (host: string) => void } = {}) {
		this.#model = model;
		this.#log = opts.log ?? nullLog;
		this.#clock = opts.clock;
		this.#paintIntervalMs = opts.paintIntervalMs ?? PAINT_INTERVAL_MS;
		this.#open = opts.open ?? (() => {});
		model.onChange(() => this.repaintAll());
	}

	add(id: string, surface: KeySurface): void {
		this.#keys.get(id)?.painter.dispose();
		const key = { surface, painter: new KeyPainter<null>((svg) => surface.setImage(svg), { clock: this.#clock, minIntervalMs: this.#paintIntervalMs }) };
		this.#keys.set(id, key);
		this.#paint(key);
	}

	remove(id: string): void {
		this.#keys.get(id)?.painter.dispose();
		this.#keys.delete(id);
	}

	press(id: string): void {
		const key = this.#keys.get(id);
		if (!key) return;
		const target = this.#model.target();
		if (!target || !target.listed || target.host === null) {
			this.#log.info(`Session key: ${!target ? "no target session" : !target.listed ? `${quote(target.title)} has ended` : `${quote(target.title)} has no app id`}`);
			key.surface.showAlert();
			return;
		}
		this.#log.info(`Session key: jump ${target.host}: ${quote(target.title)}`);
		this.#open(target.host);
	}

	repaintAll(): void {
		for (const key of this.#keys.values()) this.#paint(key);
	}

	painted(id: string): string | null {
		return this.#keys.get(id)?.painter.svg ?? null;
	}

	#paint(key: Key): void {
		key.painter.update(sessionKeySvg(sessionKeyLook(this.#model.target())), null);
	}
}
