// Preloaded into the plugin by scripts/smoke.mjs (node --import): any attempt to connect to the real
// DeckBridge ports throws, so a smoke run can never reach the Lightroom the user has open.
import net from "node:net";

const FORBIDDEN = new Set([58780, 58781]);
const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(...args) {
	// net.createConnection passes its normalised [options, callback] array as the first argument.
	const first = Array.isArray(args[0]) ? args[0][0] : args[0];
	const port = Number(typeof first === "object" && first !== null ? first.port : first);
	if (FORBIDDEN.has(port)) throw new Error(`smoke guard: refusing to connect to port ${port}`);
	return connect.apply(this, args);
};
