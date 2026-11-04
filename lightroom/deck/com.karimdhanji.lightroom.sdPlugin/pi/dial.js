// Develop Dial: lists the sliders in sliders.json (fetched through the plugin), in the file's order, and saves
// the choice as settings {param}. The dial shows it at once.
"use strict";

(function () {
	var select = document.getElementById("slider");
	var statusRow = document.getElementById("status-row");
	var status = document.getElementById("status");
	var items = [];
	var loaded = false;
	/** The plugin's idea of this dial's param, from its answer: the settings can lag behind a default it just saved. */
	var dialParam = "";
	var waiting = false;
	var retryTimer = null;

	function setStatus(text) {
		status.textContent = text;
		statusRow.hidden = text === "";
	}

	/** "Temp (Temperature)": the label, with the param in brackets when they differ. */
	function name(item) {
		return item.label === item.param ? item.label : item.label + " (" + item.param + ")";
	}

	function render() {
		var current = PI.settings.param || dialParam;
		select.textContent = "";
		if (!loaded) select.add(new Option("Loading sliders…", ""));
		var found = false;
		items.forEach(function (item) {
			select.add(new Option(name(item), item.param));
			if (item.param === current) found = true;
		});
		if (current && !found) {
			select.insertBefore(new Option(current + (loaded ? " (not in sliders.json)" : ""), current), select.firstChild);
		}
		select.value = current;
	}

	function request() {
		waiting = true;
		PI.sendToPlugin({ t: "getSliders" });
		clearTimeout(retryTimer);
		var tries = 0;
		// The plugin can miss a request sent before the app told it this inspector appeared: ask again.
		retryTimer = setTimeout(function again() {
			if (!waiting) return;
			if (tries >= 3) {
				setStatus("No answer from the plugin");
				return;
			}
			tries += 1;
			PI.sendToPlugin({ t: "getSliders" });
			retryTimer = setTimeout(again, 2000);
		}, 2000);
	}

	PI.on("message", function (message) {
		if (!message || message.t !== "sliders") return;
		waiting = false;
		clearTimeout(retryTimer);
		items = Array.isArray(message.items) ? message.items : [];
		dialParam = typeof message.param === "string" ? message.param : "";
		loaded = true;
		setStatus("");
		render();
	});

	PI.on("connected", function () {
		render();
		request();
	});
	PI.on("settings", render);

	select.addEventListener("change", function () {
		var param = select.value;
		if (!param) return; // the loading placeholder keeps the current choice
		PI.setSettings({ param: param });
		render();
	});
})();
