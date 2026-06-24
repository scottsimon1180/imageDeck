(function () {
  "use strict";

  function init() {
    window.ImageViewer.Settings.init();
    window.ImageViewer.Viewer.init();
    window.ImageViewer.ImageList.init();
    window.ImageViewer.FileLoader.init();
    window.ImageViewer.Controls.init();

    window.ImageViewer.State.subscribe((snapshot) => {
      window.ImageViewer.ImageList.render(snapshot);
      window.ImageViewer.Viewer.render(snapshot);
      window.ImageViewer.Controls.render(snapshot);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}());
