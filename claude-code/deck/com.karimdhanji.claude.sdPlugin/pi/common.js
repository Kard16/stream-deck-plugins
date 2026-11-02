// A minimal Property Inspector client for the Stream Deck app's WebSocket API: no SDK, no CDN, no downloads.
// The app loads the page, then calls connectElgatoStreamDeckSocket. Pages use window.PI:
//   PI.on("connected" | "settings" | "message", fn), PI.settings, PI.setSettings(obj), PI.sendToPlugin(obj).
"use strict";

(function () {
	var listeners = { connected: [], settings: [], message: [] };
	var socket = null;
	var queue = [];

	var PI = {
		uuid: null,
		action: null,
		settings: {},
		on: function (name, fn) {
			listeners[name].push(fn);
		},
		/** Saves the action's settings; the plugin gets didReceiveSettings. */
		setSettings: function (settings) {
			PI.settings = settings;
			send({ event: "setSettings", action: PI.action, context: PI.uuid, payload: settings });
		},
		sendToPlugin: function (payload) {
			send({ event: "sendToPlugin", action: PI.action, context: PI.uuid, payload: payload });
		},
	};

	function send(message) {
		var text = JSON.stringify(message);
		if (socket && socket.readyState === WebSocket.OPEN) socket.send(text);
		else queue.push(text); // registration has to go first
	}

	function emit(name, arg) {
		listeners[name].forEach(function (fn) {
			try {
				fn(arg);
			} catch (err) {
				console.error(err);
			}
		});
	}

	window.connectElgatoStreamDeckSocket = function (port, uuid, registerEvent, info, actionInfo) {
		PI.uuid = uuid;
		try {
			var action = JSON.parse(actionInfo);
			PI.action = action.action;
			PI.settings = (action.payload && action.payload.settings) || {};
		} catch (err) {
			console.error("bad actionInfo", err);
		}
		socket = new WebSocket("ws://127.0.0.1:" + port);
		socket.onopen = function () {
			socket.send(JSON.stringify({ event: registerEvent, uuid: uuid }));
			while (queue.length > 0) socket.send(queue.shift());
			emit("connected", PI.settings);
		};
		socket.onmessage = function (ev) {
			var message;
			try {
				message = JSON.parse(ev.data);
			} catch (err) {
				return;
			}
			if (message.event === "didReceiveSettings" && message.payload) {
				PI.settings = message.payload.settings || {};
				emit("settings", PI.settings);
			} else if (message.event === "sendToPropertyInspector") {
				emit("message", message.payload);
			}
		};
	};

	window.PI = PI;
})();
