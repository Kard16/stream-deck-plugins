// Saved Prompt: the text sent to the target session, and an optional short label for the key. Saved as
// settings {text, label} a moment after typing stops, so every keystroke isn't a settings write.
"use strict";

(function () {
	var text = document.getElementById("text");
	var label = document.getElementById("label");
	var timer = null;

	function show(settings) {
		if (document.activeElement !== text) text.value = typeof settings.text === "string" ? settings.text : "";
		if (document.activeElement !== label) label.value = typeof settings.label === "string" ? settings.label : "";
	}

	function save() {
		clearTimeout(timer);
		timer = null;
		PI.setSettings(Object.assign({}, PI.settings, { text: text.value, label: label.value.trim() }));
	}

	function soon() {
		clearTimeout(timer);
		timer = setTimeout(save, 400);
	}

	PI.on("connected", show);
	PI.on("settings", show);
	text.addEventListener("input", soon);
	label.addEventListener("input", soon);
	// Leaving a field saves at once, so a press right after typing sends what was typed.
	text.addEventListener("blur", save);
	label.addEventListener("blur", save);
})();
