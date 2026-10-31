// Pick, Reject and Unflag: the "advance after flagging" setting. Absent means on.
"use strict";

(function () {
	var box = document.getElementById("advance");

	function show(settings) {
		box.checked = settings.advance !== false;
	}

	PI.on("connected", show);
	PI.on("settings", show);
	box.addEventListener("change", function () {
		PI.setSettings(Object.assign({}, PI.settings, { advance: box.checked }));
	});
})();
