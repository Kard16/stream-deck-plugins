import { type BankConfig, type Slot, slotAt } from "../banks.js";
import type { LrModel, TurnResult } from "../model/model.js";
import { accelerate } from "../model/steps.js";
import { type Clock, realClock } from "../util/clock.js";
import { nullLog, type Log } from "../util/log.js";
import { type Feedback, StripPainter } from "./painter.js";
import { stripFor } from "./strip.js";

/** What the SDK adapter gives the deck for one dial. */
export type DialSurface = {
	setFeedback(payload: Feedback): void;
	showAlert(): void;
};

type Dial = {
	id: string;
	column: number;
	surface: DialSurface;
	painter: StripPainter;
	pressed: boolean;
	/** Turned while held, so the release ends a fine gesture rather than resetting. */
	turnedWhilePressed: boolean;
};

/**
 * The Develop Dial behaviour, without the SDK: each dial takes its slot from its column and the shared bank.
 * Turn adjusts (accelerated); push + turn adjusts in fine steps; a press without turning resets, and so does
 * a long touch; a tap moves every dial to the next bank.
 */
export class DialDeck {
	readonly #config: BankConfig;
	readonly #model: LrModel;
	readonly #clock: Clock;
	readonly #log: Log;
	readonly #dials = new Map<string, Dial>();
	#bank = 0;

	constructor(config: BankConfig, model: LrModel, opts: { clock?: Clock; log?: Log } = {}) {
		this.#config = config;
		this.#model = model;
		this.#clock = opts.clock ?? realClock;
		this.#log = opts.log ?? nullLog;
		model.onChange(() => this.repaintAll());
		model.onAlert((origin) => this.#dials.get(origin)?.surface.showAlert());
	}

	get bank(): number {
		return this.#bank;
	}

	get bankCount(): number {
		return this.#config.banks.length;
	}

	/** A dial appeared (or moved): it repaints in full. */
	add(id: string, column: number, surface: DialSurface): void {
		let dial = this.#dials.get(id);
		if (!dial) {
			dial = {
				id,
				column,
				surface,
				painter: new StripPainter((payload) => surface.setFeedback(payload), { clock: this.#clock }),
				pressed: false,
				turnedWhilePressed: false,
			};
			this.#dials.set(id, dial);
		}
		dial.column = column;
		dial.surface = surface;
		dial.painter.forget();
		this.#repaint(dial);
	}

	remove(id: string): void {
		this.#dials.get(id)?.painter.dispose();
		this.#dials.delete(id);
	}

	slotFor(id: string): Slot | null {
		const dial = this.#dials.get(id);
		return dial ? slotAt(this.#config, this.#bank, dial.column) : null;
	}

	rotate(id: string, ticks: number, pressed: boolean): TurnResult | "empty" {
		const dial = this.#dials.get(id);
		if (!dial) return "ignored";
		if (pressed) {
			// A push + turn shows the dial is down, even when its dialDown came before this plugin saw the dial.
			dial.pressed = true;
			dial.turnedWhilePressed = true;
		}
		const slot = slotAt(this.#config, this.#bank, dial.column);
		if (!slot) return "empty";
		// Push + turn is fine adjust: a quarter step per tick, no acceleration.
		const effective = pressed ? ticks : accelerate(ticks, this.#config.acceleration);
		return this.#model.turn(slot.param, effective, pressed, slot, id);
	}

	down(id: string): void {
		const dial = this.#dials.get(id);
		if (!dial) return;
		dial.pressed = true;
		dial.turnedWhilePressed = false;
	}

	up(id: string): void {
		const dial = this.#dials.get(id);
		// Only a press this plugin saw can reset. A dialUp alone means the dial was already held when the
		// plugin started or the dial appeared, and releasing it must not reset the slider.
		if (!dial || !dial.pressed) return;
		const turned = dial.turnedWhilePressed;
		dial.pressed = false;
		dial.turnedWhilePressed = false;
		if (turned) {
			this.#model.release(id);
			return;
		}
		this.#reset(dial);
	}

	/** Tap: next bank for every dial. Long touch: reset, the touch alternative to pressing (dial stacks take the press). */
	tap(id: string, hold: boolean): void {
		const dial = this.#dials.get(id);
		if (!dial) return;
		if (hold) {
			this.#reset(dial);
			return;
		}
		this.#bank = (this.#bank + 1) % this.#config.banks.length;
		this.#log.debug(`bank ${this.#bank + 1}/${this.#config.banks.length}`);
		this.repaintAll();
	}

	repaintAll(): void {
		for (const dial of this.#dials.values()) this.#repaint(dial);
	}

	/** What a dial's strip shows now, for tests. */
	painted(id: string): Feedback | null {
		return this.#dials.get(id)?.painter.painted ?? null;
	}

	#reset(dial: Dial): void {
		const slot = slotAt(this.#config, this.#bank, dial.column);
		if (slot) this.#model.reset(slot.param, dial.id);
	}

	#repaint(dial: Dial): void {
		const slot = slotAt(this.#config, this.#bank, dial.column);
		const model = this.#model;
		dial.painter.update(
			stripFor({
				slot,
				bank: this.#bank,
				bankCount: this.#config.banks.length,
				view: slot ? model.view(slot.param) : null,
				conn: model.conn,
				writable: model.writable,
				inDevelop: model.inDevelop,
			}),
		);
	}
}
