import streamDeck, {
	action,
	type KeyAction,
	type KeyDownEvent,
	type KeyUpEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { beforeAfterKeySvg, navKeySvg } from "../keys/art.js";
import { viewLook } from "../keys/looks.js";
import type { NavDirection } from "../lr/protocol.js";
import { type ActionContext, feedback, KeySet } from "./shared.js";

export type NavSettings = Record<string, never>;
export type BeforeAfterSettings = Record<string, never>;

const navLogger = streamDeck.logger.createScope("NavKey");
const compareLogger = streamDeck.logger.createScope("BeforeAfter");

/** Next and Previous photo: press sends `nav`. */
class NavKey extends SingletonAction<NavSettings> {
	readonly #dir: NavDirection;
	readonly #ctx: ActionContext;
	readonly #keys = new KeySet<KeyAction<NavSettings>, NavSettings>(navLogger);

	constructor(ctx: ActionContext, dir: NavDirection) {
		super();
		this.#ctx = ctx;
		this.#dir = dir;
		ctx.model.onChange(() => {
			for (const id of this.#keys.ids()) this.#paint(id);
		});
	}

	override onWillAppear(ev: WillAppearEvent<NavSettings>): void {
		if (!ev.action.isKey()) return;
		this.#keys.add(ev.action, ev.payload.settings);
		this.#paint(ev.action.id);
	}

	override onWillDisappear(ev: WillDisappearEvent<NavSettings>): void {
		this.#keys.remove(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<NavSettings>): void {
		const { model, link } = this.#ctx;
		const alert = (why: string): void => {
			navLogger.info(`${this.#dir}: ${why}`);
			feedback(navLogger, "showAlert", () => ev.action.showAlert());
		};
		if (model.conn !== "online") {
			alert(`Lightroom is ${model.conn}`);
			return;
		}
		// An open dial gesture finishes on this photo, and turns wait for the next one's values.
		model.beforePhotoChange();
		if (!link.send({ t: "nav", v: this.#dir }, { onErr: (err) => alert(`Lightroom refused nav: ${err.code}`) })) alert("couldn't send nav");
	}

	#paint(id: string): void {
		this.#keys.paint(id, navKeySvg(this.#dir, viewLook(this.#ctx.model)));
	}
}

@action({ UUID: "com.karimdhanji.lightroom.next" })
export class NextKey extends NavKey {
	constructor(ctx: ActionContext) {
		super(ctx, "next");
	}
}

@action({ UUID: "com.karimdhanji.lightroom.prev" })
export class PrevKey extends NavKey {
	constructor(ctx: ActionContext) {
		super(ctx, "prev");
	}
}

/**
 * Before/After, hold to compare: key down sends `view before`, key up `view after` (kickoff decision; there's
 * no SDK getter for the current view, so a toggle couldn't know where it stands).
 */
@action({ UUID: "com.karimdhanji.lightroom.before-after" })
export class BeforeAfterKey extends SingletonAction<BeforeAfterSettings> {
	readonly #ctx: ActionContext;
	readonly #keys = new KeySet<KeyAction<BeforeAfterSettings>, BeforeAfterSettings>(compareLogger);
	/** Keys showing Before right now: their key down went out, so their key up must too. */
	readonly #held = new Set<string>();

	constructor(ctx: ActionContext) {
		super();
		this.#ctx = ctx;
		ctx.model.onChange(() => {
			for (const id of this.#keys.ids()) this.#paint(id);
		});
	}

	override onWillAppear(ev: WillAppearEvent<BeforeAfterSettings>): void {
		if (!ev.action.isKey()) return;
		this.#keys.add(ev.action, ev.payload.settings);
		this.#paint(ev.action.id);
	}

	override onWillDisappear(ev: WillDisappearEvent<BeforeAfterSettings>): void {
		// Leaving the page while held: go back to After rather than stay on Before.
		if (this.#held.delete(ev.action.id)) this.#ctx.link.send({ t: "view", v: "after" });
		this.#keys.remove(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<BeforeAfterSettings>): void {
		const { model, link } = this.#ctx;
		const alert = (why: string): void => {
			compareLogger.info(why);
			feedback(compareLogger, "showAlert", () => ev.action.showAlert());
		};
		if (model.conn !== "online") {
			alert(`Lightroom is ${model.conn}`);
			return;
		}
		if (!link.send({ t: "view", v: "before" }, { onErr: (err) => alert(`Lightroom refused view before: ${err.code}`) })) {
			alert("couldn't send view before");
			return;
		}
		this.#held.add(ev.action.id);
		this.#paint(ev.action.id);
	}

	override onKeyUp(ev: KeyUpEvent<BeforeAfterSettings>): void {
		if (!this.#held.delete(ev.action.id)) return;
		const sent = this.#ctx.link.send({ t: "view", v: "after" }, { onErr: (err) => compareLogger.warn(`Lightroom refused view after: ${err.code}`) });
		if (!sent) compareLogger.info("couldn't send view after: Lightroom went away while Before was held");
		this.#paint(ev.action.id);
	}

	#paint(id: string): void {
		this.#keys.paint(id, beforeAfterKeySvg(viewLook(this.#ctx.model, this.#held.has(id))));
	}
}
