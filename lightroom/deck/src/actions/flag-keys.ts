import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { type FlagKind, flagKeySvg } from "../keys/art.js";
import { FLAG_COMMAND, flagLook } from "../keys/looks.js";
import { type ActionContext, feedback, KeySet } from "./shared.js";

/** Set in the Property Inspector (pi/flag.html). Absent means on: the default is to advance. */
export type FlagSettings = { advance?: boolean };

const logger = streamDeck.logger.createScope("FlagKey");

/** Pick, Reject and Unflag: press sends `flag {v, advance}`; the image shows whether the current photo has that flag. */
class FlagKey extends SingletonAction<FlagSettings> {
	readonly #kind: FlagKind;
	readonly #ctx: ActionContext;
	readonly #keys = new KeySet<KeyAction<FlagSettings>, FlagSettings>(logger);

	constructor(ctx: ActionContext, kind: FlagKind) {
		super();
		this.#ctx = ctx;
		this.#kind = kind;
		ctx.model.onChange(() => {
			for (const id of this.#keys.ids()) this.#paint(id);
		});
	}

	override onWillAppear(ev: WillAppearEvent<FlagSettings>): void {
		if (!ev.action.isKey()) return;
		this.#keys.add(ev.action, ev.payload.settings);
		this.#paint(ev.action.id);
	}

	override onWillDisappear(ev: WillDisappearEvent<FlagSettings>): void {
		this.#keys.remove(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<FlagSettings>): void {
		this.#keys.setSettings(ev.action.id, ev.payload.settings);
	}

	override onKeyDown(ev: KeyDownEvent<FlagSettings>): void {
		const { model, link } = this.#ctx;
		const alert = (why: string): void => {
			logger.info(`${this.#kind}: ${why}`);
			feedback(logger, "showAlert", () => ev.action.showAlert());
		};
		if (model.conn !== "online") {
			alert(`Lightroom is ${model.conn}`);
			return;
		}
		const advance = ev.payload.settings.advance !== false;
		// Advancing changes the photo: an open dial gesture finishes on this one, and turns wait for the next one's values.
		if (advance) model.beforePhotoChange();
		const sent = link.send({ t: "flag", v: FLAG_COMMAND[this.#kind], advance }, { onErr: (err) => alert(`Lightroom refused flag: ${err.code}`) });
		if (!sent) alert("couldn't send flag");
	}

	#paint(id: string): void {
		this.#keys.paint(id, flagKeySvg(this.#kind, flagLook(this.#kind, this.#ctx.model)));
	}
}

@action({ UUID: "com.karimdhanji.lightroom.pick" })
export class PickKey extends FlagKey {
	constructor(ctx: ActionContext) {
		super(ctx, "pick");
	}
}

@action({ UUID: "com.karimdhanji.lightroom.reject" })
export class RejectKey extends FlagKey {
	constructor(ctx: ActionContext) {
		super(ctx, "reject");
	}
}

@action({ UUID: "com.karimdhanji.lightroom.unflag" })
export class UnflagKey extends FlagKey {
	constructor(ctx: ActionContext) {
		super(ctx, "unflag");
	}
}
