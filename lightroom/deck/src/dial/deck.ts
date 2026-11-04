import { DEFAULT_MODEL_TIMING, type LrModel, type TurnResult } from "../model/model.js";
import { accelerate, type TurnMode } from "../model/steps.js";
import { defaultParam, type Slider, type SliderConfig, sliderFor } from "../sliders.js";
import { type Clock, realClock, type TimerHandle } from "../util/clock.js";
import { nullLog, type Log } from "../util/log.js";
import { type SlidersReply, slidersReply } from "./inspector.js";
import { type Feedback, StripPainter } from "./painter.js";
import { stripFor } from "./strip.js";

/** A dial's settings, as the Stream Deck app keeps them: the slider it shows, chosen in its Property Inspector. */
export type DialSettings = { param?: string };

/** What the SDK adapter gives the deck for one dial. */
export type DialSurface = {
	setFeedback(payload: Feedback): void;
	showAlert(): void;
	/** Saves the dial's settings with the app (setSettings), so they stay with the dial on its page. */
	setSettings(settings: { param: string }): void;
};

/** What a turn did: the model's answer, or "unlisted" for a dial whose param sliders.json doesn't list. */
export type DialResult = TurnResult | "unlisted";

/** A dial whose param isn't listed alerts once per burst: inputs less than this far apart, as while a photo is locked. */
const REFUSED_BURST_MS = DEFAULT_MODEL_TIMING.doneAfterMs;

type Dial = {
	id: string;
	column: number;
	/** From the dial's settings. It may be one sliders.json doesn't list. */
	param: string;
	surface: DialSurface;
	painter: StripPainter;
	pressed: boolean;
	/** Turned while held, so the release ends a fine gesture rather than resetting. */
	turnedWhilePressed: boolean;
	/** Big steps are on: from a tap until macroSeconds without a turn, another tap, dial-down, or another param. */
	big: boolean;
	bigTimer: TimerHandle | null;
	/** When an input was last refused because sliders.json doesn't list the param. */
	refusedAt: number;
};

/** The param in a dial's settings, or null when they have none. */
function paramIn(settings: unknown): string | null {
	const param = typeof settings === "object" && settings !== null ? (settings as { param?: unknown }).param : undefined;
	return typeof param === "string" && param !== "" ? param : null;
}

/**
 * The Develop Dial behaviour, without the SDK. Each placed dial is its own action instance, with the slider its
 * settings name; Stream Deck pages swap them through willDisappear and willAppear, and two dials may show the
 * same slider. A dial that appears without one gets its column's default, saved with setSettings.
 *
 * Turn adjusts (accelerated); push + turn adjusts in fine steps; a press without turning resets. A tap or a long
 * touch on the strip switches big steps on or off for that dial: each tick then moves the slider's `macro`, with
 * no acceleration. They go off after macroSeconds without a turn, on dial-down, and when the dial disappears or
 * its param changes. Taps send nothing, in every state. While the photo is locked the model drops turns and
 * resets. A dial whose param sliders.json doesn't list only alerts.
 */
export class DialDeck {
	readonly #config: SliderConfig;
	readonly #model: LrModel;
	readonly #clock: Clock;
	readonly #log: Log;
	readonly #dials = new Map<string, Dial>();

	constructor(config: SliderConfig, model: LrModel, opts: { clock?: Clock; log?: Log } = {}) {
		this.#config = config;
		this.#model = model;
		this.#clock = opts.clock ?? realClock;
		this.#log = opts.log ?? nullLog;
		model.onChange(() => this.repaintAll());
		model.onAlert((origin) => this.#dials.get(origin)?.surface.showAlert());
	}

	get sliders(): readonly Slider[] {
		return this.#config.sliders;
	}

	/** A dial appeared, on its page or after a move: it shows the slider its settings name, and repaints in full. */
	add(id: string, column: number, surface: DialSurface, settings: unknown = {}): void {
		const param = this.#paramFrom(column, surface, settings);
		let dial = this.#dials.get(id);
		if (!dial) {
			dial = {
				id,
				column,
				param,
				surface,
				// Through the dial's current surface: one that appears again keeps its painter but may bring a new surface.
				painter: new StripPainter((payload) => this.#dials.get(id)?.surface.setFeedback(payload), { clock: this.#clock }),
				pressed: false,
				turnedWhilePressed: false,
				big: false,
				bigTimer: null,
				refusedAt: Number.NEGATIVE_INFINITY,
			};
			this.#dials.set(id, dial);
		} else if (this.#stopBig(dial)) this.#log.debug(`big steps off for ${dial.param} (dial ${dial.column + 1}): the dial appeared again`);
		dial.column = column;
		dial.surface = surface;
		dial.param = param;
		dial.painter.forget();
		this.#repaint(dial);
	}

	remove(id: string): void {
		const dial = this.#dials.get(id);
		if (!dial) return;
		if (this.#stopBig(dial)) this.#log.debug(`big steps off for ${dial.param} (dial ${dial.column + 1}): the dial disappeared`);
		dial.painter.dispose();
		this.#dials.delete(id);
	}

	/** The Property Inspector saved the dial's settings (didReceiveSettings): it shows its new slider at once. */
	settings(id: string, settings: unknown): void {
		const dial = this.#dials.get(id);
		if (!dial) return;
		const param = this.#paramFrom(dial.column, dial.surface, settings);
		if (param === dial.param) return;
		this.#log.debug(`dial ${dial.column + 1} now shows ${param}, in place of ${dial.param}`);
		if (this.#stopBig(dial)) this.#log.debug(`big steps off for ${dial.param} (dial ${dial.column + 1}): its slider changed`);
		// A press that hasn't turned began on the old slider, so its release mustn't reset the new one. One that
		// has turned keeps its release, which only ends the fine gesture early.
		if (dial.pressed && !dial.turnedWhilePressed) dial.pressed = false;
		dial.param = param;
		this.#repaint(dial);
	}

	/** The dial's param, from its settings. */
	paramOf(id: string): string | null {
		return this.#dials.get(id)?.param ?? null;
	}

	bigSteps(id: string): boolean {
		return this.#dials.get(id)?.big ?? false;
	}

	/** The Property Inspector's answer for this dial: every slider, and the dial's param. */
	slidersReply(id: string): SlidersReply {
		return slidersReply(this.#config.sliders, this.paramOf(id));
	}

	/** How a turn of the dial moves its slider now: fine with the press, big steps while they're on, else normal. */
	mode(id: string, pressed: boolean): TurnMode {
		if (pressed) return "fine";
		return this.#dials.get(id)?.big ? "macro" : "normal";
	}

	rotate(id: string, ticks: number, pressed: boolean): DialResult {
		const dial = this.#dials.get(id);
		if (!dial) return "ignored";
		const mode = this.mode(id, pressed);
		if (pressed) {
			// A push + turn shows the dial is down, even when its dialDown came before this plugin saw the dial.
			dial.pressed = true;
			dial.turnedWhilePressed = true;
		}
		const slider = sliderFor(this.#config, dial.param);
		if (!slider) {
			this.#refuse(dial, "turned");
			return "unlisted";
		}
		if (dial.big) this.#armBig(dial); // every turn while they're on starts the countdown again
		// Fine and big steps move the same amount for every tick of an event: no acceleration.
		const effective = mode === "normal" ? accelerate(ticks, this.#config.acceleration) : ticks;
		return this.#model.turn(slider.param, effective, mode, slider, id);
	}

	down(id: string): void {
		const dial = this.#dials.get(id);
		if (!dial) return;
		dial.pressed = true;
		dial.turnedWhilePressed = false;
		// So the press still resets, and push + turn is fine.
		this.#bigOff(dial, "the dial was pressed");
	}

	up(id: string): void {
		const dial = this.#dials.get(id);
		// Only a press this plugin saw can reset. A dialUp alone means the dial was already held when the plugin
		// started or the dial appeared, or its slider changed while it was held, and releasing it must not reset.
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

	/** A tap or a long touch: big steps on or off for this dial. It sends Lightroom nothing, whatever its state. */
	tap(id: string, hold: boolean): void {
		const dial = this.#dials.get(id);
		if (!dial) return;
		const how = hold ? "long touch" : "tap";
		if (!sliderFor(this.#config, dial.param)) {
			this.#refuse(dial, how);
			return;
		}
		if (dial.big) this.#bigOff(dial, how);
		else this.#bigOn(dial, how);
	}

	repaintAll(): void {
		for (const dial of this.#dials.values()) this.#repaint(dial);
	}

	/** What a dial's strip shows now, for tests. */
	painted(id: string): Feedback | null {
		return this.#dials.get(id)?.painter.painted ?? null;
	}

	/** The param in `settings`, or else the column's default, saved with setSettings so the app keeps it. */
	#paramFrom(column: number, surface: DialSurface, settings: unknown): string {
		const saved = paramIn(settings);
		if (saved !== null) return saved;
		const param = defaultParam(this.#config, column);
		this.#log.debug(`dial ${column + 1} has no slider in its settings: saving its column's default, ${param}`);
		surface.setSettings({ param });
		return param;
	}

	#reset(dial: Dial): void {
		const slider = sliderFor(this.#config, dial.param);
		if (!slider) {
			this.#refuse(dial, "pressed");
			return;
		}
		this.#model.reset(slider.param, dial.id);
	}

	#bigOn(dial: Dial, how: string): void {
		dial.big = true;
		this.#armBig(dial);
		this.#log.debug(`big steps on for ${dial.param} (dial ${dial.column + 1}, ${how})`);
		this.#repaint(dial);
	}

	/** Big steps go off macroSeconds after the tap or the dial's last turn. */
	#armBig(dial: Dial): void {
		if (dial.bigTimer !== null) this.#clock.clearTimeout(dial.bigTimer);
		dial.bigTimer = this.#clock.setTimeout(() => {
			dial.bigTimer = null;
			this.#bigOff(dial, `${this.#config.macroSeconds} s without a turn`);
		}, this.#config.macroSeconds * 1000);
	}

	/** Going off only repaints the strip: nothing goes to Lightroom. */
	#bigOff(dial: Dial, why: string): void {
		if (!this.#stopBig(dial)) return;
		this.#log.debug(`big steps off for ${dial.param} (dial ${dial.column + 1}): ${why}`);
		this.#repaint(dial);
	}

	/** Turns big steps off without a repaint; true if they were on. */
	#stopBig(dial: Dial): boolean {
		const was = dial.big;
		dial.big = false;
		if (dial.bigTimer !== null) this.#clock.clearTimeout(dial.bigTimer);
		dial.bigTimer = null;
		return was;
	}

	/** An input on a dial whose param sliders.json doesn't list: nothing goes out, and the dial alerts once per burst. */
	#refuse(dial: Dial, what: string): void {
		const now = this.#clock.now();
		const last = dial.refusedAt;
		dial.refusedAt = now;
		this.#log.debug(`dial ${dial.column + 1} ${what}: ${dial.param} isn't in sliders.json`);
		if (now - last >= REFUSED_BURST_MS) dial.surface.showAlert();
	}

	#repaint(dial: Dial): void {
		const slider = sliderFor(this.#config, dial.param);
		const model = this.#model;
		dial.painter.update(
			stripFor({
				slider,
				param: dial.param,
				big: dial.big,
				view: slider ? model.view(slider.param) : null,
				conn: model.conn,
				writable: model.writable,
				inDevelop: model.inDevelop,
				locked: model.state.locked,
			}),
		);
	}
}
