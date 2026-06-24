(function () {
  "use strict";

  const ICONDIR_SIZE = 6;
  const DIRECTORY_ENTRY_SIZE = 16;
  const SINGLE_FRAME_ICON_OFFSET = ICONDIR_SIZE + DIRECTORY_ENTRY_SIZE;
  const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

  function isIcoFile(file) {
    return getExtension(file.name) === "ico";
  }

  async function decodeFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const frames = getUniqueSizeFrames(parseIcoDirectory(bytes));

    if (!frames.length) {
      throw new Error("ICO file has no readable image sizes.");
    }

    const icoFrames = frames.map((frame) => {
      const objectUrl = URL.createObjectURL(createSingleFrameIconBlob(bytes, frame));
      return Object.assign({}, frame, {
        id: "ico-frame-" + frame.index,
        objectUrl
      });
    });

    applyFrameLabels(icoFrames);

    const selectedFrame = getLargestFrame(icoFrames);
    let selectedImage;

    try {
      selectedImage = await loadImage(selectedFrame.objectUrl);
    } catch (error) {
      releaseFrames(icoFrames);
      throw error;
    }

    const thumbnail = await window.ImageViewer.Thumbnail.fromImage(selectedImage, {
      format: "ICO",
      mimeType: file.type || "image/x-icon"
    }).catch(() => ({
      url: selectedFrame.objectUrl,
      objectUrl: false
    }));

    return {
      id: createId(),
      fileName: file.name,
      displayName: file.name,
      format: "ICO",
      mimeType: file.type || "image/x-icon",
      size: file.size,
      width: selectedFrame.width,
      height: selectedFrame.height,
      objectUrl: selectedFrame.objectUrl,
      thumbnailUrl: thumbnail.url || selectedFrame.objectUrl,
      thumbnailObjectUrl: thumbnail.objectUrl,
      displayMode: "native",
      animated: false,
      hasTransparency: window.ImageViewer.Thumbnail.detectTransparency(selectedImage, selectedFrame.width, selectedFrame.height),
      sourceMode: "ICO size " + selectedFrame.label,
      icoFrames,
      icoSelectedFrameId: selectedFrame.id
    };
  }

  function parseIcoDirectory(bytes) {
    if (bytes.length < ICONDIR_SIZE) {
      return [];
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const reserved = view.getUint16(0, true);
    const type = view.getUint16(2, true);
    const count = view.getUint16(4, true);

    if (reserved !== 0 || type !== 1 || count < 1) {
      return [];
    }

    const directoryEnd = ICONDIR_SIZE + count * DIRECTORY_ENTRY_SIZE;
    if (directoryEnd > bytes.length) {
      return [];
    }

    const frames = [];

    for (let index = 0; index < count; index += 1) {
      const entryOffset = ICONDIR_SIZE + index * DIRECTORY_ENTRY_SIZE;
      const widthByte = bytes[entryOffset];
      const heightByte = bytes[entryOffset + 1];
      const colorCount = bytes[entryOffset + 2];
      const reservedByte = bytes[entryOffset + 3];
      const planes = view.getUint16(entryOffset + 4, true);
      const bitDepth = view.getUint16(entryOffset + 6, true);
      const byteLength = view.getUint32(entryOffset + 8, true);
      const imageOffset = view.getUint32(entryOffset + 12, true);
      const imageEnd = imageOffset + byteLength;

      if (
        byteLength <= 0 ||
        imageOffset < directoryEnd ||
        imageEnd > bytes.length ||
        imageEnd < imageOffset
      ) {
        continue;
      }

      frames.push({
        index,
        widthByte,
        heightByte,
        colorCount,
        reservedByte,
        planes,
        bitDepth,
        byteLength,
        imageOffset,
        width: widthByte === 0 ? 256 : widthByte,
        height: heightByte === 0 ? 256 : heightByte,
        imageType: hasPngSignature(bytes, imageOffset) ? "PNG" : "BMP"
      });
    }

    return frames.sort(compareFramesForMenu);
  }

  function createSingleFrameIconBlob(sourceBytes, frame) {
    const imageBytes = sourceBytes.slice(frame.imageOffset, frame.imageOffset + frame.byteLength);
    const output = new Uint8Array(SINGLE_FRAME_ICON_OFFSET + imageBytes.length);
    const view = new DataView(output.buffer);

    view.setUint16(0, 0, true);
    view.setUint16(2, 1, true);
    view.setUint16(4, 1, true);
    output[6] = frame.widthByte;
    output[7] = frame.heightByte;
    output[8] = frame.colorCount;
    output[9] = frame.reservedByte;
    view.setUint16(10, frame.planes, true);
    view.setUint16(12, frame.bitDepth, true);
    view.setUint32(14, imageBytes.length, true);
    view.setUint32(18, SINGLE_FRAME_ICON_OFFSET, true);
    output.set(imageBytes, SINGLE_FRAME_ICON_OFFSET);

    return new Blob([output], { type: "image/x-icon" });
  }

  function applyFrameLabels(frames) {
    frames.forEach((frame) => {
      frame.label = frame.width + " x " + frame.height;
    });
  }

  function getUniqueSizeFrames(frames) {
    const byDimension = new Map();

    frames.forEach((frame) => {
      const dimensionKey = getDimensionKey(frame);
      const current = byDimension.get(dimensionKey);
      if (!current || isPreferredDuplicateFrame(frame, current)) {
        byDimension.set(dimensionKey, frame);
      }
    });

    return Array.from(byDimension.values()).sort(compareFramesForMenu);
  }

  function isPreferredDuplicateFrame(frame, current) {
    if (frame.bitDepth !== current.bitDepth) {
      return frame.bitDepth > current.bitDepth;
    }
    if (frame.byteLength !== current.byteLength) {
      return frame.byteLength > current.byteLength;
    }
    return frame.index < current.index;
  }

  function getLargestFrame(frames) {
    return frames.reduce((largest, frame) => {
      const area = frame.width * frame.height;
      const largestArea = largest.width * largest.height;

      if (area !== largestArea) {
        return area > largestArea ? frame : largest;
      }
      if (frame.bitDepth !== largest.bitDepth) {
        return frame.bitDepth > largest.bitDepth ? frame : largest;
      }
      return frame.byteLength > largest.byteLength ? frame : largest;
    }, frames[0]);
  }

  function compareFramesForMenu(a, b) {
    const areaDifference = (a.width * a.height) - (b.width * b.height);
    if (areaDifference !== 0) {
      return areaDifference;
    }
    if (a.width !== b.width) {
      return a.width - b.width;
    }
    if (a.height !== b.height) {
      return a.height - b.height;
    }
    if (a.bitDepth !== b.bitDepth) {
      return a.bitDepth - b.bitDepth;
    }
    return a.index - b.index;
  }

  function hasPngSignature(bytes, offset) {
    if (offset + PNG_SIGNATURE.length > bytes.length) {
      return false;
    }

    return PNG_SIGNATURE.every((value, index) => bytes[offset + index] === value);
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();

      image.onload = function () {
        resolve(image);
      };
      image.onerror = function () {
        reject(new Error("Browser could not decode ICO image size."));
      };
      image.decoding = "async";
      image.src = url;
    });
  }

  function releaseFrames(frames) {
    frames.forEach((frame) => {
      if (frame.objectUrl) {
        URL.revokeObjectURL(frame.objectUrl);
      }
    });
  }

  function getDimensionKey(frame) {
    return frame.width + "x" + frame.height;
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
  window.ImageViewer.IcoAdapter = {
    isIcoFile,
    decodeFile
  };
}());
