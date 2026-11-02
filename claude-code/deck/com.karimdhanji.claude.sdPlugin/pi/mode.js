// Mode key: the one mode the key sets, saved as settings {mode}: default (Manual), acceptEdits, plan or auto.
"use strict";

(function () {
	var select = document.getElementById("mode");
	var MODES = ["default", "acceptEdits", "plan", "auto"];

	function show(settings) {
		select.value = MODES.indexOf(settings.mode) >= 0 ? settings.mode : "";
	}

	PI.on("connected", show);
	PI.on("settings", show);
	select.addEventListener("change", function () {
		if (!select.value) return; // the placeholder keeps the current choice
		PI.setSettings(Object.assign({}, PI.settings, { mode: select.value }));
	});
})();
