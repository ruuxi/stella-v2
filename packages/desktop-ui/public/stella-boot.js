(function () {
  var root = document.documentElement;

  // Shared UI state snapshot (~/.stella/ui-state.json), exposed before this
  // script by the Electron preload or the dev server's injected inline
  // script. localStorage remains only as a first-boot-after-migration
  // fallback while the shared store is still empty.
  var uiState = window.__stellaUiState || {};

  var readStorage = function (key) {
    if (Object.prototype.hasOwnProperty.call(uiState, key)) {
      return uiState[key];
    }
    try {
      return window.localStorage ? window.localStorage.getItem(key) : null;
    } catch (_error) {
      return null;
    }
  };

  var params = new URLSearchParams(window.location.search);
  root.dataset.stellaWindow = params.get("window") === "mini" ? "mini" : "full";
  var forceLowPower = params.get("lowPower") === "1";

  // The mobile app's WebView loads `/?mobile=1` and its injected shim sets
  // data-platform="mobile" before any page script runs. Honoring the param
  // here too makes the tag independent of injection timing and lets a plain
  // browser exercise the mobile layout.
  if (params.get("mobile") === "1") {
    root.setAttribute("data-platform", "mobile");
  }

  // Dark is the default appearance; mirrors theme-context.tsx. Retired theme
  // ids were pinned to one appearance and still win until React migrates them.
  var themeId = readStorage("stella-theme-id");
  var colorMode = readStorage("stella-color-mode") || "dark";
  var resolvedColorMode = "dark";
  if (themeId === "noir" || themeId === "dark") {
    resolvedColorMode = "dark";
  } else if (themeId === "pearl" || themeId === "light") {
    resolvedColorMode = "light";
  } else if (colorMode === "light") {
    resolvedColorMode = "light";
  } else if (
    colorMode === "system" &&
    !(
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    )
  ) {
    resolvedColorMode = "light";
  }
  root.dataset.stellaBootTheme = resolvedColorMode;
  root.classList.toggle("dark", resolvedColorMode === "dark");
  root.style.setProperty("color-scheme", resolvedColorMode);

  if (readStorage("stella:sidebar:visible") === "0") {
    root.dataset.sidebarHidden = "true";
  }

  var displayPanelWidth = Number(readStorage("stella.displayPanel.width"));
  if (Number.isFinite(displayPanelWidth) && displayPanelWidth > 0) {
    var clampedWidth = Math.min(
      1600,
      Math.max(320, Math.round(displayPanelWidth)),
    );
    root.style.setProperty("--display-panel-width", clampedWidth + "px");
  }

  var lastLocation = readStorage("stella:lastLocation");
  if (lastLocation && lastLocation[0] === "/" && lastLocation.length <= 2048) {
    var route = lastLocation.split(/[?#]/)[0].split("/")[1] || "home";
    root.dataset.stellaBootRoute = route;
  }

  // Low-power devices: drop blur entrances, decorative infinite loops, and
  // backdrop-filter glass before React paints. Mirrors shared/lib/device-perf.ts.
  try {
    var n = navigator;
    var cores =
      typeof n.hardwareConcurrency === "number" ? n.hardwareConcurrency : 0;
    var mem = typeof n.deviceMemory === "number" ? n.deviceMemory : 0;
    var platform = typeof n.platform === "string" ? n.platform : "";
    var userAgent = typeof n.userAgent === "string" ? n.userAgent : "";
    var isWindows = /^Win/i.test(platform) || /\bWindows\b/i.test(userAgent);
    var reduce = false;
    if (window.matchMedia) {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    if (
      reduce ||
      forceLowPower ||
      (cores > 0 && cores <= 4) ||
      (mem > 0 && mem <= 4) ||
      (isWindows && mem > 0 && mem <= 8)
    ) {
      root.setAttribute("data-low-power", "true");
    }
  } catch (_error) {}
})();
