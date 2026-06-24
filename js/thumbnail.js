(function () {
  "use strict";

  const CSS_SLOT_SIZE = 46;
  const MAX_DEVICE_SCALE = 3;
  const PROGRESSIVE_DOWNSCALE_RATIO = 3;
  const HARD_EDGE_PROBE_LIMIT = 64;
  const HARD_EDGE_COLOR_LIMIT = 256;
  const TRANSPARENCY_PROBE_MAX = 256;

  function getOutputSize() {
    const deviceScale = Number(window.devicePixelRatio) || 1;
    const clampedScale = Math.max(1, Math.min(deviceScale, MAX_DEVICE_SCALE));
    return Math.max(1, Math.round(CSS_SLOT_SIZE * clampedScale));
  }

  async function fromImage(image, options) {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    return renderThumbnail(image, width, height, options || {});
  }

  async function fromCanvas(canvas, options) {
    return renderThumbnail(canvas, canvas.width, canvas.height, options || {});
  }

  // Rasterize a static thumbnail for an SVG once at load. Embedding the live
  // document in the list instead would keep every visible (often animated) SVG
  // row painting, which competes with the main viewer and makes non-fullscreen
  // playback stutter. width/height are the SVG's logical size: an SVG <img>'s
  // intrinsic size is unreliable for percentage-sized documents, and drawing
  // with an explicit destination size rasterizes a single static frame.
  async function fromSvgMarkup(markup, width, height, options) {
    if (!isValidSize(width, height)) {
      throw new Error("SVG has no usable dimensions for a thumbnail.");
    }

    const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
    try {
      const image = await loadImage(url);
      return await renderThumbnail(image, width, height, options || {});
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Browser could not load SVG for rasterization."));
      image.src = src;
    });
  }

  async function renderThumbnail(source, sourceWidth, sourceHeight, options) {
    if (!isValidSize(sourceWidth, sourceHeight)) {
      return { url: "", objectUrl: false };
    }

    const maxSize = getOutputSize();
    const scale = Math.min(maxSize / sourceWidth, maxSize / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const upscale = scale > 1;
    const downscaleRatio = Math.max(sourceWidth / width, sourceHeight / height);
    const preserveHardEdges = upscale && isLikelyHardEdgeImage(source, sourceWidth, sourceHeight, options);
    const canvas = preserveHardEdges
      ? drawScaled(source, width, height, false)
      : downscaleRatio >= PROGRESSIVE_DOWNSCALE_RATIO
        ? progressiveDownscale(source, sourceWidth, sourceHeight, width, height)
        : drawScaled(source, width, height, true);

    return canvasToThumbnailUrl(canvas);
  }

  function progressiveDownscale(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
    let currentSource = source;
    let currentWidth = sourceWidth;
    let currentHeight = sourceHeight;

    while (currentWidth / targetWidth > PROGRESSIVE_DOWNSCALE_RATIO || currentHeight / targetHeight > PROGRESSIVE_DOWNSCALE_RATIO) {
      const nextWidth = Math.max(targetWidth, Math.round(currentWidth / 2));
      const nextHeight = Math.max(targetHeight, Math.round(currentHeight / 2));
      currentSource = drawScaled(currentSource, nextWidth, nextHeight, true);
      currentWidth = nextWidth;
      currentHeight = nextHeight;
    }

    return drawScaled(currentSource, targetWidth, targetHeight, true);
  }

  function drawScaled(source, width, height, smooth) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
      return canvas;
    }

    context.imageSmoothingEnabled = smooth;
    if (smooth) {
      context.imageSmoothingQuality = "high";
    }
    context.drawImage(source, 0, 0, width, height);
    return canvas;
  }

  function isLikelyHardEdgeImage(source, width, height, options) {
    const format = String(options.format || "").toUpperCase();

    if (format === "ICO" || format === "CUR") {
      return true;
    }

    if (width > HARD_EDGE_PROBE_LIMIT || height > HARD_EDGE_PROBE_LIMIT) {
      return false;
    }

    try {
      const probe = drawScaled(source, width, height, false);
      const context = probe.getContext("2d", { alpha: true });
      if (!context) {
        return false;
      }

      const pixels = context.getImageData(0, 0, width, height).data;
      const colors = new Set();
      for (let index = 0; index < pixels.length; index += 4) {
        colors.add(
          pixels[index] + "," +
          pixels[index + 1] + "," +
          pixels[index + 2] + "," +
          pixels[index + 3]
        );
        if (colors.size > HARD_EDGE_COLOR_LIMIT) {
          return false;
        }
      }

      return colors.size <= Math.max(2, Math.floor((width * height) * 0.35));
    } catch (error) {
      return false;
    }
  }

  function canvasToThumbnailUrl(canvas) {
    if (!canvas.toBlob) {
      return Promise.resolve({
        url: canvas.toDataURL("image/png"),
        objectUrl: false
      });
    }

    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          resolve({
            url: canvas.toDataURL("image/png"),
            objectUrl: false
          });
          return;
        }

        resolve({
          url: URL.createObjectURL(blob),
          objectUrl: true
        });
      }, "image/png");
    });
  }

  function isValidSize(width, height) {
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  }

  // True when any pixel is not fully opaque. The source is drawn to a small probe
  // (capped at TRANSPARENCY_PROBE_MAX) before scanning so the cost is bounded for
  // large images. Downscaling averages alpha, so a fully opaque source stays at
  // 255 everywhere (no false positives) while any transparency survives as < 255.
  function detectTransparency(source, sourceWidth, sourceHeight) {
    if (!isValidSize(sourceWidth, sourceHeight)) {
      return false;
    }

    try {
      const scale = Math.min(1, TRANSPARENCY_PROBE_MAX / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = drawScaled(source, width, height, scale < 1);
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) {
        return false;
      }

      const pixels = context.getImageData(0, 0, width, height).data;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] < 255) {
          return true;
        }
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  window.ImageViewer = window.ImageViewer || {};
  window.ImageViewer.Thumbnail = {
    fromImage,
    fromCanvas,
    fromSvgMarkup,
    detectTransparency
  };
}());
