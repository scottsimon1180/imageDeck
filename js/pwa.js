(function () {
  "use strict";

  let titlebarToggle;
  let titlebarCollapsed = true;

  function init() {
    registerServiceWorker();
    registerFileLaunchHandler();
    initTitlebarControls();
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || !isServedOverHttp()) {
      return;
    }

    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {
        // The viewer still works normally without install/offline support.
      });
    });
  }

  function registerFileLaunchHandler() {
    if (!canHandleLaunchedFiles()) {
      return;
    }

    window.launchQueue.setConsumer(async (launchParams) => {
      const handles = Array.from(launchParams.files || []);
      if (!handles.length) {
        return;
      }

      const files = [];
      for (const handle of handles) {
        if (!handle || typeof handle.getFile !== "function") {
          continue;
        }
        try {
          files.push(await handle.getFile());
        } catch (error) {
          // Ignore individual handles that are no longer readable.
        }
      }

      if (files.length) {
        await window.ImageViewer.FileLoader.loadFiles(files);
      } else {
        window.ImageViewer.State.setMessage("Couldn't open launched file");
      }
    });
  }

  function canHandleLaunchedFiles() {
    if (!window.launchQueue || typeof window.launchQueue.setConsumer !== "function") {
      return false;
    }
    if (!("LaunchParams" in window) || !window.LaunchParams.prototype) {
      return true;
    }
    return "files" in window.LaunchParams.prototype;
  }

  function initTitlebarControls() {
    titlebarToggle = document.getElementById("appTitlebarToggle");
    if (!titlebarToggle || !window.ImageViewer.Settings) {
      return;
    }

    titlebarToggle.addEventListener("click", toggleTitlebar);
    window.ImageViewer.Settings.subscribe(handleSettingsChange);
  }

  function handleSettingsChange(nextSettings) {
    titlebarCollapsed = nextSettings.titlebarCollapsed === true;
    document.documentElement.dataset.titlebarCollapsed = titlebarCollapsed ? "true" : "false";
    updateTitlebarToggle();
  }

  function toggleTitlebar() {
    window.ImageViewer.Settings.setSetting("titlebarCollapsed", !titlebarCollapsed);
  }

  function updateTitlebarToggle() {
    const label = titlebarCollapsed ? "Expand window bar" : "Collapse window bar";
    titlebarToggle.setAttribute("aria-label", label);
    titlebarToggle.setAttribute("aria-pressed", titlebarCollapsed ? "true" : "false");
    titlebarToggle.title = label;
  }

  function isServedOverHttp() {
    return window.location.protocol === "http:" || window.location.protocol === "https:";
  }

  window.ImageViewer = window.ImageViewer || {};
  window.ImageViewer.Pwa = {
    init
  };
}());
