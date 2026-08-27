(function () {
  var RESCUE_DELAY_MS = 8000;
  var launch = document.getElementById("stella-launch");
  var rescue = document.getElementById("stella-launch-rescue");
  var restartBtn = document.getElementById("stella-launch-restart");
  if (!launch || !rescue || !restartBtn) return;

  var timer = window.setTimeout(function () {
    if (!document.body.contains(launch)) return;
    rescue.setAttribute("data-visible", "true");
  }, RESCUE_DELAY_MS);

  var observer = new MutationObserver(function () {
    if (!document.body.contains(launch)) {
      window.clearTimeout(timer);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  var setBusy = function (busy) {
    restartBtn.disabled = busy;
  };

  var relaunchOrReload = function () {
    var api = window.electronAPI;
    if (api && api.ui && typeof api.ui.relaunch === "function") {
      try {
        api.ui.relaunch();
        return;
      } catch (_) {

      }
    }
    window.location.reload();
  };

  restartBtn.addEventListener("click", function () {
    setBusy(true);
    relaunchOrReload();
  });
})();
