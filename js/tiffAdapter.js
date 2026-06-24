(function () {
  "use strict";

  const TIFF_EXTENSIONS = new Set(["tif", "tiff"]);

  function isTiffFile(file) {
    const extension = getExtension(file.name);
    return TIFF_EXTENSIONS.has(extension) || /tiff/i.test(file.type || "");
  }

  async function decodeFile(file) {
    if (!window.UTIF) {
      throw new Error("TIFF decoder is not available.");
    }

    const buffer = await file.arrayBuffer();
    const ifds = window.UTIF.decode(buffer);
    const imageIfds = ifds.filter((ifd) => Number(ifd.width) > 0 && Number(ifd.height) > 0);

    if (!imageIfds.length) {
      throw new Error("No TIFF image pages were found.");
    }

    const pageCount = imageIfds.length;
    const decodedPages = [];

    for (let index = 0; index < imageIfds.length; index += 1) {
      const ifd = imageIfds[index];
      window.UTIF.decodeImage(buffer, ifd);

      const width = Number(ifd.width);
      const height = Number(ifd.height);
      const rgba = window.UTIF.toRGBA8(ifd);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d", { alpha: true });
      if (!context) {
        throw new Error("Canvas rendering is not available.");
      }

      const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
      context.putImageData(imageData, 0, 0);

      const pageLabel = pageCount > 1 ? " page " + (index + 1) : "";
      const thumbnail = await window.ImageViewer.Thumbnail.fromCanvas(canvas, {
        format: "TIFF",
        mimeType: file.type || "image/tiff"
      });
      decodedPages.push({
        id: createId(),
        fileName: file.name,
        displayName: file.name + pageLabel,
        format: "TIFF",
        mimeType: file.type || "image/tiff",
        size: file.size,
        width,
        height,
        objectUrl: "",
        thumbnailUrl: thumbnail.url,
        thumbnailObjectUrl: thumbnail.objectUrl,
        displayMode: "tiff-canvas",
        canvas,
        hasTransparency: window.ImageViewer.Thumbnail.detectTransparency(canvas, width, height),
        sourceMode: pageCount > 1 ? "Decoded TIFF " + (index + 1) + "/" + pageCount : "Decoded TIFF",
        pageNumber: index + 1,
        pageCount,
        sourceFile: file
      });
    }

    return decodedPages;
  }

  function getExtension(name) {
    const parts = String(name || "").toLowerCase().split(".");
    return parts.length > 1 ? parts.pop() : "";
  }

  function createId() {
    if (window.crypto && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "image-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  window.ImageViewer = window.ImageViewer || {};
  window.ImageViewer.TiffAdapter = {
    isTiffFile,
    decodeFile
  };
}());
