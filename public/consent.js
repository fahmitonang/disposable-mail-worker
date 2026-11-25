(function () {
	try {
		if (window.localStorage.getItem("tonmail_consent_v1") === "1") {
			document.documentElement.classList.add("consented");
		}
	} catch {
		// Ignore storage access errors in restricted browsing modes
	}
})();
