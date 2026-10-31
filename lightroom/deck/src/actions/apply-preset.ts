import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { presetKeySvg } from "../keys/art.js";
import { presetLook, presetOutcome } from "../keys/looks.js";
import { isPresetRequest, PresetCatalog } from "../keys/presets.js";
import { LrError } from "../lr/client.js";
import { type ActionContext, feedback, KeySet } from "./shared.js";

/** Chosen in the Property Inspector (pi/preset.html): the preset's uuid, and its name for the key image. */
export type PresetSettings = { uuid?: string; name?: string };

type SendToPluginEvent = Parameters<NonNullable<SingletonAction<PresetSettings>["onSendToPlugin"]>>[0];

const logger = streamDeck.logger.createScope("ApplyPreset");

/**
 * Apply Preset: press sends `preset {id, uuid}`, which applies to every target photo. showOk when it reached at
 * least one photo with none locked; showAlert on err, or when photos were locked.
 */
@action({ UUID: "com.karimdhanji.lightroom.preset" })
export class ApplyPresetKey extends SingletonAction<PresetSettings> {
	readonly #ctx: ActionContext;
	readonly #catalog: PresetCatalog;
	readonly #keys = new KeySet<KeyAction<PresetSettings>, PresetSettings>(logger);

	constructor(ctx: ActionContext) {
		super();
		this.#ctx = ctx;
		this.#catalog = new PresetCatalog(ctx.link, logger);
		ctx.model.onChange(() => {
			for (const id of this.#keys.ids()) this.#paint(id);
		});
	}

	override onWillAppear(ev: WillAppearEvent<PresetSettings>): void {
		if (!ev.action.isKey()) return;
		this.#keys.add(ev.action, ev.payload.settings);
		this.#paint(ev.action.id);
	}

	override onWillDisappear(ev: WillDisappearEvent<PresetSettings>): void {
		this.#keys.remove(ev.action.id);
	}

	/** The Property Inspector picked a preset: show its name. */
	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<PresetSettings>): void {
		this.#keys.setSettings(ev.action.id, ev.payload.settings);
		this.#paint(ev.action.id);
	}

	/** The Property Inspector asks for Lightroom's presets. */
	override async onSendToPlugin(ev: SendToPluginEvent): Promise<void> {
		if (!isPresetRequest(ev.payload)) return;
		const reply = await this.#catalog.list();
		await streamDeck.ui.sendToPropertyInspector(reply);
	}

	override async onKeyDown(ev: KeyDownEvent<PresetSettings>): Promise<void> {
		const { uuid, name } = ev.payload.settings;
		const { model, link } = this.#ctx;
		const alert = (why: string): void => {
			logger.info(`preset ${name ?? uuid ?? "(none)"}: ${why}`);
			feedback(logger, "showAlert", () => ev.action.showAlert());
		};
		if (!uuid) {
			alert("no preset chosen yet: pick one in the key's settings");
			return;
		}
		if (model.conn !== "online") {
			alert(`Lightroom is ${model.conn}`);
			return;
		}
		try {
			// Lightroom's write has a 3 s timeout of its own; many target photos can take longer than that to apply.
			const evt = await link.request({ t: "preset", uuid }, { timeoutMs: 15_000 });
			if (evt.t !== "applied") {
				alert(`unexpected reply ${evt.t}`);
				return;
			}
			const summary = `applied to ${evt.n} photo(s), ${evt.locked} locked`;
			if (presetOutcome(evt) === "ok") {
				logger.info(`preset ${name ?? uuid}: ${summary}`);
				feedback(logger, "showOk", () => ev.action.showOk());
			} else alert(summary);
		} catch (err) {
			alert(err instanceof LrError ? `${err.code}: ${err.message}` : String(err));
		}
	}

	#paint(id: string): void {
		const name = this.#keys.settings(id)?.name ?? null;
		this.#keys.paint(id, presetKeySvg(name, presetLook(this.#ctx.model)));
	}
}
