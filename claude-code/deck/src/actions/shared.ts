import streamDeck from "@elgato/streamdeck";

import { svgDataUrl } from "../keys/art.js";
import type { KeySurface } from "../keys/decision.js";
import { countIdle } from "../util/idle.js";
import { describeError } from "../util/log.js";

const logger = streamDeck.logger.createScope("Actions");

/** Fire-and-forget calls to the app: a failure is only logged. */
export function fireAndForget(what: string, call: () => Promise<void>): void {
	call().catch((err: unknown) => logger.warn(`${what} failed: ${describeError(err)}`));
}

type KeyLike = { setImage(image?: string): Promise<void>; showOk(): Promise<void>; showAlert(): Promise<void> };

/** A key's surface for the logic classes: images go as SVG data URLs. */
export function keySurface(key: KeyLike): KeySurface {
	return {
		setImage: (svg) => {
			countIdle("send.image");
			fireAndForget("setImage", () => key.setImage(svgDataUrl(svg)));
		},
		showOk: () => fireAndForget("showOk", () => key.showOk()),
		showAlert: () => fireAndForget("showAlert", () => key.showAlert()),
	};
}
