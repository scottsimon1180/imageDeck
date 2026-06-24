(function () {
  "use strict";

  const state = {
    images: [],
    activeId: null,
    message: "Ready",
    listVersion: 0,
    activeVersion: 0,
    messageVersion: 0
  };

  const listeners = new Set();

  function notify() {
    const snapshot = {
      images: state.images.slice(),
      activeId: state.activeId,
      message: state.message,
      listVersion: state.listVersion,
      activeVersion: state.activeVersion,
      messageVersion: state.messageVersion
    };
    listeners.forEach((listener) => listener(snapshot));
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener({
      images: state.images.slice(),
      activeId: state.activeId,
      message: state.message,
      listVersion: state.listVersion,
      activeVersion: state.activeVersion,
      messageVersion: state.messageVersion
    });
    return function unsubscribe() {
      listeners.delete(listener);
    };
  }

  function addImages(images) {
    if (!images.length) {
      notify();
      return;
    }

    state.images.push.apply(state.images, images);
    state.listVersion += 1;

    state.activeId = images[0].id;
    state.activeVersion += 1;

    state.message = images.length === 1
      ? "Loaded " + images[0].displayName
      : "Loaded " + images.length + " images";
    state.messageVersion += 1;
    notify();
  }

  function setActive(id) {
    if (state.activeId === id) {
      return;
    }

    if (state.images.some((image) => image.id === id)) {
      state.activeId = id;
      state.activeVersion += 1;
      state.message = "Viewing " + getActive().displayName;
      state.messageVersion += 1;
      notify();
    }
  }

  function removeImage(id) {
    const index = state.images.findIndex((image) => image.id === id);
    if (index === -1) {
      return;
    }

    releaseImage(state.images[index]);
    state.images.splice(index, 1);
    state.listVersion += 1;

    if (state.activeId === id) {
      const replacement = state.images[index] || state.images[index - 1] || null;
      state.activeId = replacement ? replacement.id : null;
      state.activeVersion += 1;
    }

    state.message = state.images.length ? "Removed image" : "Ready";
    state.messageVersion += 1;
    notify();
  }

  function clearImages() {
    state.images.forEach(releaseImage);
    state.images = [];
    state.activeId = null;
    state.message = "Ready";
    state.listVersion += 1;
    state.activeVersion += 1;
    state.messageVersion += 1;
    notify();
  }

  function reorderImages(orderedIds) {
    if (!Array.isArray(orderedIds) || orderedIds.length !== state.images.length) {
      return false;
    }

    const imageById = new Map(state.images.map((image) => [image.id, image]));
    const seen = new Set();
    const reordered = [];

    for (const id of orderedIds) {
      if (!imageById.has(id) || seen.has(id)) {
        return false;
      }
      seen.add(id);
      reordered.push(imageById.get(id));
    }

    const changed = reordered.some((image, index) => image !== state.images[index]);
    if (!changed) {
      return false;
    }

    state.images = reordered;
    state.listVersion += 1;
    notify();
    return true;
  }

  function renameImage(id, rawName) {
    const image = state.images.find((item) => item.id === id);
    if (!image) {
      return "";
    }

    const fallback = getOriginalDisplayName(image);
    const nextName = String(rawName || "").trim() || fallback;
    if (image.displayName === nextName) {
      return image.displayName;
    }

    image.displayName = nextName;
    state.listVersion += 1;
    if (state.activeId === id) {
      state.message = "Viewing " + nextName;
      state.messageVersion += 1;
    }
    notify();
    return image.displayName;
  }

  function selectIcoFrame(id, frameId) {
    const image = state.images.find((item) => item.id === id);
    if (!image || !Array.isArray(image.icoFrames)) {
      return false;
    }

    const frame = image.icoFrames.find((item) => item.id === frameId);
    if (!frame || image.icoSelectedFrameId === frame.id) {
      return false;
    }

    image.icoSelectedFrameId = frame.id;
    image.objectUrl = frame.objectUrl;
    image.width = frame.width;
    image.height = frame.height;
    image.sourceMode = "ICO size " + frame.label;
    state.listVersion += 1;

    if (state.activeId === id) {
      state.activeVersion += 1;
      state.message = "Viewing " + image.displayName + " at " + frame.label;
      state.messageVersion += 1;
    }

    notify();
    return true;
  }

  function selectSvgSpriteEntry(id, entryId) {
    const image = state.images.find((item) => item.id === id);
    if (!image || !Array.isArray(image.svgSpriteEntries)) {
      return false;
    }

    const entry = image.svgSpriteEntries.find((item) => item.id === entryId);
    if (!entry || image.svgSelectedSpriteEntryId === entry.id) {
      return false;
    }

    image.svgSelectedSpriteEntryId = entry.id;
    image.objectUrl = entry.objectUrl;
    image.width = entry.width;
    image.height = entry.height;
    image.sourceMode = "SVG sprite: " + entry.label;
    state.listVersion += 1;

    if (state.activeId === id) {
      state.activeVersion += 1;
      state.message = "Viewing " + image.displayName + " sprite " + entry.label;
      state.messageVersion += 1;
    }

    notify();
    return true;
  }

  function setMessage(message) {
    if (state.message === message) {
      return;
    }
    state.message = message;
    state.messageVersion += 1;
    notify();
  }

  function getActive() {
    return state.images.find((image) => image.id === state.activeId) || null;
  }

  function getActiveIndex() {
    return state.images.findIndex((image) => image.id === state.activeId);
  }

  function getOriginalDisplayName(image) {
    if (image.pageCount > 1 && image.pageNumber) {
      return (image.fileName || image.displayName || "Untitled image") + " page " + image.pageNumber;
    }
    return image.fileName || image.displayName || "Untitled image";
  }

  function nextImage() {
    if (!state.images.length) {
      return;
    }
    const index = getActiveIndex();
    const nextIndex = index === -1 ? 0 : (index + 1) % state.images.length;
    setActive(state.images[nextIndex].id);
  }

  function previousImage() {
    if (!state.images.length) {
      return;
    }
    const index = getActiveIndex();
    const previousIndex = index <= 0 ? state.images.length - 1 : index - 1;
    setActive(state.images[previousIndex].id);
  }

  function releaseImage(image) {
    const objectUrls = new Set();

    if (image.objectUrl) {
      objectUrls.add(image.objectUrl);
    }
    if (Array.isArray(image.icoFrames)) {
      image.icoFrames.forEach((frame) => {
        if (frame.objectUrl) {
          objectUrls.add(frame.objectUrl);
        }
      });
    }
    if (Array.isArray(image.svgSpriteEntries)) {
      image.svgSpriteEntries.forEach((entry) => {
        if (entry.objectUrl) {
          objectUrls.add(entry.objectUrl);
        }
      });
    }

    objectUrls.forEach((url) => URL.revokeObjectURL(url));

    if (image.thumbnailObjectUrl && image.thumbnailUrl && !objectUrls.has(image.thumbnailUrl)) {
      URL.revokeObjectURL(image.thumbnailUrl);
    }
  }

  window.ImageViewer = window.ImageViewer || {};
  window.ImageViewer.State = {
    subscribe,
    addImages,
    setActive,
    removeImage,
    clearImages,
    reorderImages,
    renameImage,
    selectIcoFrame,
    selectSvgSpriteEntry,
    setMessage,
    getActive,
    getActiveIndex,
    nextImage,
    previousImage
  };
}());
