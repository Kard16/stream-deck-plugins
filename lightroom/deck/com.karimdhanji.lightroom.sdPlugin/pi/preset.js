// Apply Preset: lists Lightroom's Develop presets by folder (fetched through the plugin with the presets
// command) and saves the choice as settings {uuid, name}.
"use strict";

(function () {
	var select = document.getElementById("preset");
	var search = document.getElementById("search");
	var refresh = document.getElementById("refresh");
	var status = document.getElementById("status");
	var items = [];
	var loaded = false;
	var waiting = false;
	var retryTimer = null;

	var REASONS = {
		offline: "Lightroom isn't connected",
		busy: "Lightroom is busy: close its menus and dialogs",
		mismatch: "the Lightroom plugin needs updating",
		timeout: "Lightroom didn't answer",
		disconnected: "Lightroom disconnected",
		failed: "Lightroom couldn't list its presets",
	};

	function setStatus(text, isError) {
		status.textContent = text;
		status.className = isError ? "status error" : "status";
	}

	function describe(error) {
		return REASONS[error] || "Lightroom said " + error;
	}

	function render() {
		var current = PI.settings.uuid || "";
		var filter = search.value.trim().toLowerCase();
		select.textContent = "";
		select.add(new Option(loaded ? "Choose a preset" : "Loading presets…", ""));
		var groups = new Map();
		var found = false;
		items.forEach(function (item) {
			var match = !filter || item.name.toLowerCase().indexOf(filter) >= 0 || item.folder.toLowerCase().indexOf(filter) >= 0;
			if (!match && item.uuid !== current) return;
			var group = groups.get(item.folder);
			if (!group) {
				group = document.createElement("optgroup");
				group.label = item.folder || "(no folder)";
				groups.set(item.folder, group);
				select.appendChild(group);
			}
			group.appendChild(new Option(item.name, item.uuid));
			if (item.uuid === current) found = true;
		});
		if (current && !found) {
			var label = (PI.settings.name || current) + (loaded ? " (not in Lightroom's list)" : "");
			select.insertBefore(new Option(label, current), select.children[1] || null);
		}
		select.value = current;
	}

	function request() {
		waiting = true;
		setStatus("Asking Lightroom…", false);
		PI.sendToPlugin({ t: "getPresets", refresh: true });
		clearTimeout(retryTimer);
		var tries = 0;
		// The plugin can miss a request sent before the app told it this inspector appeared: ask again.
		retryTimer = setTimeout(function again() {
			if (!waiting) return;
			if (tries >= 3) {
				setStatus("No answer from the plugin", true);
				return;
			}
			tries += 1;
			PI.sendToPlugin({ t: "getPresets", refresh: true });
			retryTimer = setTimeout(again, 2000);
		}, 2000);
	}

	PI.on("message", function (message) {
		if (!message || message.t !== "presets") return;
		waiting = false;
		clearTimeout(retryTimer);
		items = Array.isArray(message.items) ? message.items : [];
		loaded = items.length > 0 || !message.error;
		if (message.error) setStatus((message.stale ? "Last list shown: " : "") + describe(message.error), true);
		else setStatus(items.length + " presets", false);
		render();
	});

	PI.on("connected", function () {
		render();
		request();
	});
	PI.on("settings", render);

	select.addEventListener("change", function () {
		var uuid = select.value;
		if (!uuid) return; // the placeholder keeps the current choice
		var item = items.find(function (i) {
			return i.uuid === uuid;
		});
		PI.setSettings({ uuid: uuid, name: item ? item.name : PI.settings.name || "" });
	});
	search.addEventListener("input", render);
	refresh.addEventListener("click", request);
})();
