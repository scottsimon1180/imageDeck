(function () {
  "use strict";

  let imageList;
  let listEmpty;
  let imageCount;
  let lastListVersion = -1;
  let lastActiveId = null;
  let lastImageCount = 0;
  let listScrollFrame = 0;
  let suppressNextClick = false;
  let pendingRenameFlashId = null;
  const THUMBNAIL_SLOT_SIZE = 46;
  const rowMap = new Map();

  function init() {
    imageList = document.getElementById("imageList");
    listEmpty = document.getElementById("listEmpty");
    imageCount = document.getElementById("imageCount");

    imageList.addEventListener("click", handleListClick);
    imageList.addEventListener("keydown", handleListKeyDown);
    initImageReorder();
  }

  function render(snapshot) {
    imageCount.textContent = snapshot.images.length === 1 ? "1 loaded" : snapshot.images.length + " loaded";
    listEmpty.classList.toggle("is-visible", snapshot.images.length === 0);

    const imagesAdded = snapshot.images.length > lastImageCount;
    lastImageCount = snapshot.images.length;

    if (snapshot.listVersion !== lastListVersion) {
      syncRows(snapshot.images);
      lastListVersion = snapshot.listVersion;
      lastActiveId = null;
    }

    if (snapshot.activeId !== lastActiveId) {
      updateActiveRow(snapshot.activeId);
      // A freshly added image is appended to the bottom and becomes active, so
      // let the smooth scroll-to-bottom below handle it rather than jumping.
      if (!imagesAdded) {
        scrollActiveRowIntoView(snapshot.activeId);
      }
      lastActiveId = snapshot.activeId;
    }

    if (imagesAdded) {
      smoothScrollListToBottom();
    }
  }

  function scrollActiveRowIntoView(activeId) {
    const row = rowMap.get(activeId);
    if (row) {
      row.scrollIntoView({ block: "nearest" });
    }
  }

  // Animate the list to the bottom (where newly added rows land) instead of
  // snapping. Skips the animation when there's nothing to scroll or the user
  // prefers reduced motion.
  function smoothScrollListToBottom() {
    const target = imageList.scrollHeight - imageList.clientHeight;
    const start = imageList.scrollTop;
    const distance = target - start;

    if (listScrollFrame) {
      cancelAnimationFrame(listScrollFrame);
      listScrollFrame = 0;
    }

    if (distance <= 1) {
      return;
    }

    const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      imageList.scrollTop = target;
      return;
    }

    const duration = Math.min(420, Math.max(180, distance * 0.6));
    const startTime = performance.now();

    function step(now) {
      const t = Math.min(1, (now - startTime) / duration);
      // easeInOutQuad
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      imageList.scrollTop = start + distance * eased;

      if (t < 1) {
        listScrollFrame = requestAnimationFrame(step);
      } else {
        listScrollFrame = 0;
      }
    }

    listScrollFrame = requestAnimationFrame(step);
  }

  // Keyed reconciliation: reuse existing row nodes instead of rebuilding the
  // whole list on every change. This keeps batched bulk loads from doing O(n^2)
  // DOM work and avoids re-decoding thumbnails (and flicker) on remove,
  // rename, and reorder.
  function syncRows(images) {
    const nextIds = new Set();
    images.forEach((image) => nextIds.add(image.id));

    rowMap.forEach((row, id) => {
      if (!nextIds.has(id)) {
        row.remove();
        rowMap.delete(id);
      }
    });

    let cursor = imageList.firstChild;
    images.forEach((image) => {
      let row = rowMap.get(image.id);
      if (!row) {
        row = createRow(image);
        rowMap.set(image.id, row);
      } else {
        updateRow(row, image);
      }

      if (row === cursor) {
        cursor = cursor.nextSibling;
      } else {
        imageList.insertBefore(row, cursor);
      }
    });
  }

  // Reflect mutable image fields onto a reused row. Skip the name node while it
  // is being edited so an unrelated render cannot clobber the in-progress input.
  function updateRow(row, image) {
    const detailText = getImageDetailText(image);
    const displayNameChanged = row.dataset.displayName !== image.displayName;
    const detailChanged = row.dataset.detailText !== detailText;

    if (!displayNameChanged && !detailChanged) {
      return;
    }

    if (displayNameChanged) {
      row.dataset.displayName = image.displayName;
      row.setAttribute("aria-label", "View " + image.displayName);

      const removeButton = row.querySelector(".remove-image-btn");
      if (removeButton) {
        removeButton.setAttribute("aria-label", "Remove " + image.displayName);
      }

      const name = row.querySelector(".image-name");
      if (name && !name.querySelector("input")) {
        name.textContent = image.displayName;
      }
    }

    if (detailChanged) {
      row.dataset.detailText = detailText;
      const detail = row.querySelector(".image-detail");
      if (detail) {
        detail.textContent = detailText;
      }
      const thumbnailFrame = row.querySelector(".thumb-frame");
      if (thumbnailFrame) {
        setThumbnailDisplaySize(thumbnailFrame, image);
      }
    }
  }

  function createRow(image) {
    const row = document.createElement("li");
    row.className = "image-row";
    row.dataset.id = image.id;
    row.dataset.displayName = image.displayName;
    row.dataset.detailText = getImageDetailText(image);
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", "View " + image.displayName);

    const removeButton = document.createElement("button");
    removeButton.className = "remove-image-btn";
    removeButton.type = "button";
    removeButton.dataset.action = "remove";
    removeButton.dataset.id = image.id;
    removeButton.setAttribute("aria-label", "Remove " + image.displayName);
    removeButton.title = "Remove image";
    removeButton.innerHTML = '<svg aria-hidden="true"><use href="#x"></use></svg>';

    const thumbnailFrame = document.createElement("span");
    thumbnailFrame.className = "thumb-frame";
    setThumbnailDisplaySize(thumbnailFrame, image);

    const thumbnail = document.createElement("img");
    thumbnail.className = "thumb";
    thumbnail.src = image.thumbnailUrl || image.objectUrl;
    thumbnail.alt = "";
    thumbnail.loading = "lazy";
    thumbnail.decoding = "async";
    thumbnail.draggable = false;
    thumbnailFrame.appendChild(thumbnail);

    const info = document.createElement("span");
    info.className = "image-info";

    const name = document.createElement("span");
    name.className = "image-name";
    name.textContent = image.displayName;
    name.title = "Double-click to rename";
    name.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      beginRename(name, image);
    });
    if (image.id === pendingRenameFlashId) {
      name.classList.add("rename-flash");
      setTimeout(() => {
        name.classList.remove("rename-flash");
      }, 450);
      pendingRenameFlashId = null;
    }

    const detail = document.createElement("span");
    detail.className = "image-detail";
    detail.textContent = getImageDetailText(image);

    info.append(name, detail);
    row.append(thumbnailFrame, info, removeButton);
    return row;
  }

  function getImageDetailText(image) {
    const parts = [
      image.format,
      image.width + " x " + image.height,
      formatBytes(image.size)
    ];
    return parts.filter(Boolean).join(" | ");
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "";
    }
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return (unitIndex === 0 ? size : size.toFixed(size >= 10 ? 1 : 2)) + " " + units[unitIndex];
  }

  function setThumbnailDisplaySize(thumbnail, image) {
    const width = Number(image.width);
    const height = Number(image.height);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      thumbnail.style.width = THUMBNAIL_SLOT_SIZE + "px";
      thumbnail.style.height = THUMBNAIL_SLOT_SIZE + "px";
      return;
    }

    const scale = Math.min(THUMBNAIL_SLOT_SIZE / width, THUMBNAIL_SLOT_SIZE / height);
    thumbnail.style.width = Math.max(1, Math.round(width * scale)) + "px";
    thumbnail.style.height = Math.max(1, Math.round(height * scale)) + "px";
  }

  function updateActiveRow(activeId) {
    rowMap.forEach((row, id) => {
      const isActive = id === activeId;
      row.classList.toggle("is-active", isActive);
      if (isActive) {
        row.setAttribute("aria-current", "true");
      } else {
        row.removeAttribute("aria-current");
      }
    });
  }

  function handleListClick(event) {
    if (suppressNextClick) {
      suppressNextClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.target.closest("input")) {
      return;
    }

    const removeButton = event.target.closest("[data-action='remove']");
    if (removeButton) {
      event.stopPropagation();
      window.ImageViewer.State.removeImage(removeButton.dataset.id);
      return;
    }

    const row = event.target.closest(".image-row");
    if (row) {
      window.ImageViewer.State.setActive(row.dataset.id);
    }
  }

  function handleListKeyDown(event) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    const row = event.target.closest(".image-row");
    if (!row || event.target.closest("button, input")) {
      return;
    }

    event.preventDefault();
    window.ImageViewer.State.setActive(row.dataset.id);
  }

  function initImageReorder() {
    const threshold = 4;
    const edge = 36;
    const maxScroll = 16;
    const dragScale = 1.018;
    const targetHysteresis = 0.58;
    const dropDuration = 210;
    const dropEasing = "cubic-bezier(.2, .8, .2, 1)";
    let cand = null;
    let dragging = false;
    let dropping = false;
    let items = [];
    let dragItem = null;
    let originalIndex = 0;
    let currentTarget = 0;
    let step = 0;
    let startContentY = 0;
    let lastClientY = 0;
    let rafId = 0;

    function applyShifts() {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];

        if (item === dragItem) {
          continue;
        }

        item.classList.add("is-drag-shift");

        let translateY = 0;
        if (currentTarget > originalIndex && index > originalIndex && index <= currentTarget) {
          translateY = -step;
        } else if (currentTarget < originalIndex && index < originalIndex && index >= currentTarget) {
          translateY = step;
        }

        item.style.transform = translateY ? getTranslateYTransform(translateY) : "";
      }
    }

    function frame() {
      if (!dragging) {
        return;
      }

      const listRect = imageList.getBoundingClientRect();
      let scrollSpeed = 0;

      if (lastClientY < listRect.top + edge) {
        scrollSpeed = -Math.ceil(((listRect.top + edge - lastClientY) / edge) * maxScroll);
      } else if (lastClientY > listRect.bottom - edge) {
        scrollSpeed = Math.ceil(((lastClientY - (listRect.bottom - edge)) / edge) * maxScroll);
      }

      if (scrollSpeed) {
        imageList.scrollTop += scrollSpeed;
      }

      const contentY = lastClientY - listRect.top + imageList.scrollTop;
      const deltaY = contentY - startContentY;

      dragItem.style.transform = getDragTransform(deltaY);

      const target = getDragTarget(deltaY);

      if (target !== currentTarget) {
        currentTarget = target;
        applyShifts();
      }

      rafId = requestAnimationFrame(frame);
    }

    function cleanup() {
      items.forEach((item) => {
        item.classList.remove("is-drag-shift", "is-drag-source");
        item.style.transition = "none";
        item.style.transform = "";
        item.style.boxShadow = "";
        item.style.zIndex = "";
      });

      void imageList.offsetHeight;
      items.forEach((item) => {
        item.style.transition = "";
      });

      document.body.classList.remove("is-reordering-images");
      imageList.classList.remove("is-reordering");
    }

    function stopPointerListeners() {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);

      if (dragItem) {
        dragItem.removeEventListener("lostpointercapture", onPointerLost);
      }
    }

    function cancelDrag() {
      stopPointerListeners();

      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }

      if (dragging || dropping) {
        cleanup();
      }

      dragging = false;
      dropping = false;
      cand = null;
    }

    function commitDrop() {
      const moved = currentTarget !== originalIndex;

      if (moved) {
        const newOrder = items.slice();
        newOrder.splice(originalIndex, 1);
        newOrder.splice(currentTarget, 0, dragItem);
        newOrder.forEach((item) => imageList.appendChild(item));

        cleanup();
        window.ImageViewer.State.reorderImages(newOrder.map((item) => item.dataset.id));
      } else {
        cleanup();
      }

      dragging = false;
      dropping = false;
      cand = null;
    }

    function onPointerMove(event) {
      if (!cand) {
        return;
      }

      lastClientY = event.clientY;

      if (!dragging) {
        if (Math.abs(event.clientY - cand.startY) < threshold && Math.abs(event.clientX - cand.startX) < threshold) {
          return;
        }

        startDrag(event);
      }
    }

    function onPointerUp() {
      stopPointerListeners();

      if (!dragging) {
        cand = null;
        return;
      }

      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }

      suppressNextClick = true;
      setTimeout(() => {
        suppressNextClick = false;
      }, 0);

      dropping = true;

      const finalDeltaY = (currentTarget - originalIndex) * step;
      dragItem.style.transition = "transform " + dropDuration + "ms " + dropEasing;
      dragItem.style.transform = getTranslateYTransform(finalDeltaY) + " scale(1)";

      let done = false;
      const finish = () => {
        if (done) {
          return;
        }
        done = true;
        commitDrop();
      };
      const onEnd = (event) => {
        if (event.propertyName === "transform") {
          dragItem.removeEventListener("transitionend", onEnd);
          finish();
        }
      };

      dragItem.addEventListener("transitionend", onEnd);
      setTimeout(finish, dropDuration + 120);
    }

    function onPointerCancel() {
      cancelDrag();
    }

    function onPointerLost() {
      if (!dropping) {
        cancelDrag();
      }
    }

    function startDrag(event) {
      event.preventDefault();
      dragging = true;
      dropping = false;

      items = Array.from(imageList.querySelectorAll(".image-row"));
      dragItem = cand.item;
      originalIndex = items.indexOf(dragItem);

      if (originalIndex === -1) {
        cancelDrag();
        return;
      }

      const listRect = imageList.getBoundingClientRect();
      step = getRowStep(items, dragItem);
      startContentY = cand.startY - listRect.top + imageList.scrollTop;
      currentTarget = originalIndex;

      dragItem.classList.add("is-drag-source");

      document.body.classList.add("is-reordering-images");
      imageList.classList.add("is-reordering");

      try {
        dragItem.setPointerCapture(cand.pointerId);
      } catch (error) {
        // Some browsers can reject capture if the pointer is already cancelled.
      }

      dragItem.addEventListener("lostpointercapture", onPointerLost);
      lastClientY = event.clientY;
      rafId = requestAnimationFrame(frame);
    }

    function getDragTarget(deltaY) {
      const proposedTarget = Math.max(
        0,
        Math.min(items.length - 1, originalIndex + Math.round(deltaY / step))
      );

      if (proposedTarget === currentTarget) {
        return currentTarget;
      }

      const currentDelta = (currentTarget - originalIndex) * step;
      const distanceFromCurrentSlot = Math.abs(deltaY - currentDelta);
      if (distanceFromCurrentSlot < step * targetHysteresis) {
        return currentTarget;
      }

      return proposedTarget;
    }

    function getTranslateYTransform(translateY) {
      return "translate3d(0, " + translateY + "px, 0)";
    }

    function getDragTransform(translateY) {
      return getTranslateYTransform(translateY) + " scale(" + dragScale + ")";
    }

    imageList.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || dropping) {
        return;
      }

      const row = event.target.closest(".image-row");
      if (!row || !imageList.contains(row) || event.target.closest("button, input")) {
        return;
      }

      cand = {
        item: row,
        startX: event.clientX,
        startY: event.clientY,
        pointerId: event.pointerId
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
    });
  }

  function beginRename(nameElement, image) {
    if (nameElement.querySelector("input")) {
      return;
    }

    const fallback = image.displayName;
    const input = document.createElement("input");
    input.className = "image-name-input";
    input.type = "text";
    input.value = fallback;
    input.spellcheck = false;
    input.setAttribute("aria-label", "Rename " + fallback);

    nameElement.textContent = "";
    nameElement.appendChild(input);

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });

    let done = false;
    const finish = (commit) => {
      if (done) {
        return;
      }
      done = true;

      const name = commit
        ? commitImageRename(image.id, input.value)
        : fallback;

      nameElement.textContent = name || fallback;
      nameElement.title = "Double-click to rename";
      if (commit) {
        nameElement.classList.add("rename-flash");
        setTimeout(() => {
          nameElement.classList.remove("rename-flash");
        }, 450);
      }
    };

    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
  }

  function commitImageRename(id, value) {
    pendingRenameFlashId = id;
    const name = window.ImageViewer.State.renameImage(id, value);
    if (pendingRenameFlashId === id) {
      pendingRenameFlashId = null;
    }
    return name;
  }

  function getRowStep(items, dragItem) {
    if (items.length > 1) {
      const stepFromNeighbor = Math.abs(items[1].offsetTop - items[0].offsetTop);
      if (stepFromNeighbor > 0) {
        return stepFromNeighbor;
      }
    }

    const style = window.getComputedStyle(dragItem);
    const marginBottom = parseFloat(style.marginBottom) || 0;
    return dragItem.offsetHeight + marginBottom;
  }

  window.ImageViewer = window.ImageViewer || {};
  window.ImageViewer.ImageList = {
    init,
    render
  };
}());
