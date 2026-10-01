(function () {
  try {
    var t = localStorage.getItem("theme");
    if (t !== "light" && t !== "dark") {
      t = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();

// Pre-paint locale resolution: the stored language decides `lang` and `dir`
// before the first frame, so the app never flashes the wrong direction.
(function () {
  try {
    var stored = localStorage.getItem("yaseir:locale");
    var locale = stored === "ar" || stored === "en" ? stored : "en";
    var root = document.documentElement;
    root.lang = locale;
    root.dir = locale === "ar" ? "rtl" : "ltr";
  } catch (e) {}
})();
