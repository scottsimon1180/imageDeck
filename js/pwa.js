(function () {
  "use strict";

  function init() {
    registerServiceWorker();
    registerFileLaunchHandler();
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
    if (!window.launchQueue || typeof window.launchQueue.setConsumer !== "function") {
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

  function isServedOverHttp() {
    return window.location.protocol === "http:" || window.location.protocol === "https:";
  }

  window.ImageViewer = window.ImageViewer || {};
  window.ImageViewer.Pwa = {
    init
  };
}());
