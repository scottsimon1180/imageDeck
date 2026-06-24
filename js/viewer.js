(function () {
  "use strict";

  const MIN_SCALE = 0.02;
  const MAX_SCALE = 64;
  const MAX_VECTOR_SCALE = 4096;
  const WHEEL_ZOOM_INTENSITY = 0.001;
  const WHEEL_DELTA_LIMIT = 240;
  const VECTOR_SETTLE_DELAY = 180;
  const VECTOR_ZOOM_CLASS_DELAY = 260;
  const VECTOR_RENDER_MAX_EDGE = 4096;
  const VECTOR_RENDER_MAX_AREA = 9000000;
  const VECTOR_RENDER_MIN_SCALE = 0.0001;
  const MAX_SVG_SURFACE_CACHE_SIZE = 3;
  const FULLSCREEN_IDLE_DELAY = 2200;
  const FULLSCREEN_TOOLBAR_MARGIN = 14;
  const DEFAULT_VIEWER_SETTINGS = {
    toolbarPosition: "bottom",
    fullscreenToolbarPosition: "bottom-center",
    fullscreenShowImageName: true,
    transparencyBackdrop: "black"
  };
  const TRANSPARENCY_BACKDROP_COLORS = {
    black: "#000",
    white: "#fff"
  };

  let viewerPanel;
  let viewerFooter;
  let viewport;
  let viewerImage;
  let viewerCanvas;
  let viewerSvg;
  let fullscreenCursor;
  let toolbarDragHandle;
  let emptyState;
  let imageMeta;
  let zoomReadout;
  let fullscreenToolbarName;

  let activeImage = null;
  let activeSurfaceKey = "";
  let scale = 1;
  let fitScale = 1;
  let panX = 0;
  let panY = 0;
  let isFitMode = true;
  let isActualSizeMode = false;
  let isPanning = false;
  let panStart = null;
  let transformFrame = 0;
  let renderedVectorWidth = 0;
  let renderedVectorHeight = 0;
  let renderedVectorScale = 1;
  let vectorSettleTimer = 0;
  let vectorZoomClassTimer = 0;
  let forceVectorRenderOnNextFrame = false;
  let fullscreenIdleTimer = 0;
  let toolbarDragStart = null;
  let toolbarHasCustomPosition = false;
  let toolbarPlacement = null;
  let viewerSettings = Object.assign({}, DEFAULT_VIEWER_SETTINGS);
  let svgSurfaceUseCounter = 0;
  const svgSurfaces = new Map();

  function init() {
    viewerPanel = document.querySelector(".viewer-panel");
    viewerFooter = document.querySelector(".viewer-footer");
    viewport = document.getElementById("viewport");
    viewerImage = document.getElementById("viewerImage");
    viewerCanvas = document.getElementById("viewerCanvas");
    fullscreenCursor = document.getElementById("fullscreenCursor");
    toolbarDragHandle = document.getElementById("toolbarDragHandle");
    emptyState = document.getElementById("emptyState");
    imageMeta = document.getElementById("imageMeta");
    zoomReadout = document.getElementById("zoomReadout");
    fullscreenToolbarName = document.getElementById("fullscreenToolbarName");

    viewport.addEventListener("wheel", handleWheel, { passive: false });
    viewport.addEventListener("pointerdown", startPan);
    toolbarDragHandle.addEventListener("pointerdown", startToolbarDrag);
    toolbarDragHandle.addEventListener("dblclick", resetFullscreenToolbarPlacement);
    viewerPanel.addEventListener("pointermove", handleFullscreenPointerActivity);
    viewerPanel.addEventListener("pointerdown", handleFullscreenPointerActivity);
    viewerPanel.addEventListener("pointerup", handleFullscreenPointerActivity);
    window.addEventListener("pointermove", moveToolbarDrag);
    window.addEventListener("pointerup", stopToolbarDrag);
    window.addEventListener("pointercancel", stopToolbarDrag);
    window.addEventListener("pointermove", movePan);
    window.addEventListener("pointerup", stopPan);
    window.addEventListener("pointercancel", stopPan);
    window.addEventListener("resize", handleResize);
    document.addEventListener("fullscreenchange", handleFullscreenChange);

    if (window.ImageViewer.Settings) {
      window.ImageViewer.Settings.subscribe(handleSettingsChange);
    } else {
      applyViewerSettings();
    }
  }

  function render(snapshot) {
    const nextImage = snapshot.images.find((image) => image.id === snapshot.activeId) || null;
    syncSvgSurfaces(snapshot.images, nextImage);

    if (!nextImage) {
      activeImage = null;
      activeSurfaceKey = "";
      resetInteraction();
      clearFullscreenIdleTimer();
      viewerPanel.classList.remove("is-ui-hidden");
      clearSurface();
      emptyState.classList.add("is-visible");
      viewport.classList.add("is-empty");
      viewport.classList.remove("is-fit");
      setMeta(snapshot.message || "Ready");
      setZoomReadout(100);
      updateFullscreenToolbarName();
      return;
    }

    const nextSurfaceKey = getImageSurfaceKey(nextImage);
    const changed = !activeImage || activeImage.id !== nextImage.id;
    const surfaceChanged = !changed && activeSurfaceKey !== nextSurfaceKey;
    activeImage = nextImage;
    activeSurfaceKey = nextSurfaceKey;
    emptyState.classList.remove("is-visible");
    viewport.classList.remove("is-empty");

    if (changed || surfaceChanged) {
      resetInteraction();
      loadActiveImage();
      defaultViewForActiveImage();
    }

    updateMeta();
    updateFullscreenToolbarName();
  }

  function loadActiveImage() {
    viewerImage.classList.remove("is-visible");
    viewerCanvas.classList.remove("is-visible");
    if (viewerSvg) {
      viewerSvg.classList.remove("is-visible");
    }

    if (activeImage.displayMode === "tiff-canvas") {
      viewerCanvas.width = activeImage.width;
      viewerCanvas.height = activeImage.height;
      viewerCanvas.style.width = activeImage.width + "px";
      viewerCanvas.style.height = activeImage.height + "px";

      const context = viewerCanvas.getContext("2d", { alpha: true });
      if (!context) {
        window.ImageViewer.State.setMessage("Canvas rendering is not available");
        return;
      }
      context.clearRect(0, 0, activeImage.width, activeImage.height);
      context.drawImage(activeImage.canvas, 0, 0);
      viewerCanvas.classList.add("is-visible");
      return;
    }

    if (activeImage.displayMode === "svg-vector") {
      // Recently viewed SVGs keep their own <object> (see ensureSvgSurface), so
      // common back-and-forth switching does not reload the vector document.
      const surface = ensureSvgSurface(activeImage);
      viewerSvg = surface;

      // Apply the fit synchronously so a reused (already loaded) surface paints in
      // the right place on the very first frame, with no size or position flash.
      const fit = getFitScale(viewport.getBoundingClientRect());
      const fitWidth = Math.max(1, Math.round(activeImage.width * fit));
      const fitHeight = Math.max(1, Math.round(activeImage.height * fit));
      surface.style.width = fitWidth + "px";
      surface.style.height = fitHeight + "px";
      surface.style.transform = "translate3d(-50%, -50%, 0)";
      renderedVectorWidth = fitWidth;
      renderedVectorHeight = fitHeight;
      renderedVectorScale = fit;
      surface.classList.add("is-visible");
      pruneSvgSurfaceCache(getSvgSurfaceId(activeImage));
      return;
    }

    viewerImage.src = activeImage.objectUrl;
    viewerImage.alt = activeImage.displayName;
    viewerImage.style.width = activeImage.width + "px";
    viewerImage.style.height = activeImage.height + "px";
    viewerImage.classList.add("is-visible");
  }

  // Reassigning a single <object>'s `data` is both unreliable (stale/duplicate
  // render) and slow (reloads, blank flash), so recent SVGs keep their own
  // surfaces. The cache is capped so hidden SVG documents do not pile up.
  function ensureSvgSurface(image) {
    const surfaceId = getSvgSurfaceId(image);
    let surface = svgSurfaces.get(surfaceId);
    if (!surface) {
      surface = document.createElement("object");
      surface.className = "svg-surface";
      surface.type = "image/svg+xml";
      surface.tabIndex = -1;
      surface.draggable = false;
      surface.setAttribute("aria-label", image.displayName);
      surface.style.width = image.width + "px";
      surface.style.height = image.height + "px";
      viewport.appendChild(surface);
      surface.data = image.objectUrl;
      svgSurfaces.set(surfaceId, surface);
    }
    surface.setAttribute("aria-label", image.displayName);
    touchSvgSurface(surface);
    return surface;
  }

  // Drop SVG surfaces whose image was removed and cap the live <object> cache.
  // The State store revokes object URLs separately.
  function syncSvgSurfaces(images, nextImage) {
    const present = new Set();
    images.forEach((image) => {
      if (image.displayMode === "svg-vector") {
        present.add(getSvgSurfaceId(image));
      }
    });

    svgSurfaces.forEach((surface, surfaceId) => {
      if (!present.has(surfaceId)) {
        removeSvgSurface(surfaceId, surface);
      }
    });

    pruneSvgSurfaceCache(
      nextImage && nextImage.displayMode === "svg-vector"
        ? getSvgSurfaceId(nextImage)
        : ""
    );
  }

  function pruneSvgSurfaceCache(activeSurfaceId) {
    if (svgSurfaces.size <= MAX_SVG_SURFACE_CACHE_SIZE) {
      return;
    }

    const inactiveSurfaces = Array.from(svgSurfaces.entries())
      .filter(([surfaceId]) => surfaceId !== activeSurfaceId)
      .sort((a, b) => getSvgSurfaceUseTick(a[1]) - getSvgSurfaceUseTick(b[1]));

    inactiveSurfaces.some(([surfaceId, surface]) => {
      removeSvgSurface(surfaceId, surface);
      return svgSurfaces.size <= MAX_SVG_SURFACE_CACHE_SIZE;
    });
  }

  function removeSvgSurface(surfaceId, surface) {
    if (viewerSvg === surface) {
      viewerSvg = null;
    }
    surface.remove();
    svgSurfaces.delete(surfaceId);
  }

  function touchSvgSurface(surface) {
    surface.dataset.svgSurfaceUseTick = String(++svgSurfaceUseCounter);
  }

  function getSvgSurfaceUseTick(surface) {
    const tick = Number(surface.dataset.svgSurfaceUseTick);
    return Number.isFinite(tick) ? tick : 0;
  }

  function handleWheel(event) {
    if (!activeImage) {
      return;
    }

    event.preventDefault();
    noteFullscreenActivity(event);
    const factor = Math.exp(-getWheelZoomDelta(event) * WHEEL_ZOOM_INTENSITY);
    zoomBy(factor, event.clientX, event.clientY);
  }

  function zoomBy(factor, clientX, clientY) {
    if (!activeImage || !Number.isFinite(factor) || factor <= 0) {
      return;
    }

    const nextScale = clamp(scale * factor, MIN_SCALE, getMaxScale());
    if (nearlyEqual(nextScale, scale)) {
      return;
    }
    if (activeImage.displayMode === "svg-vector") {
      noteVectorZoomActivity();
    }
    setScale(nextScale, clientX, clientY, false);
  }

  function getWheelZoomDelta(event) {
    let delta = event.deltaY;
    if (event.deltaMode === 1) {
      delta *= 16;
    } else if (event.deltaMode === 2) {
      delta *= Math.max(1, viewport.clientHeight || 800);
    }
    return clamp(delta, -WHEEL_DELTA_LIMIT, WHEEL_DELTA_LIMIT);
  }

  function setScale(nextScale, clientX, clientY, forceVectorRender) {
    const rect = viewport.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const anchorX = typeof clientX === "number" ? clientX : centerX;
    const anchorY = typeof clientY === "number" ? clientY : centerY;
    const imagePointX = (anchorX - centerX - panX) / scale;
    const imagePointY = (anchorY - centerY - panY) / scale;

    scale = nextScale;
    panX = anchorX - centerX - imagePointX * scale;
    panY = anchorY - centerY - imagePointY * scale;
    isFitMode = nearlyEqual(scale, fitScale);
    isActualSizeMode = false;
    clampPan();
    scheduleTransform(forceVectorRender);
  }

  function fitToImage() {
    if (!activeImage) {
      return;
    }

    const rect = viewport.getBoundingClientRect();
    fitScale = getFitScale(rect);
    scale = fitScale;
    panX = 0;
    panY = 0;
    isFitMode = true;
    isActualSizeMode = false;
    scheduleTransform(true);
  }

  function actualSize() {
    if (!activeImage) {
      return;
    }
    calculateFitScale();
    scale = getActualSizeScale();
    panX = 0;
    panY = 0;
    isFitMode = nearlyEqual(scale, fitScale);
    isActualSizeMode = true;
    clampPan();
    scheduleTransform(true);
  }

  function defaultViewForActiveImage() {
    if (isIcoImage(activeImage)) {
      actualSize();
    } else {
      fitToImage();
    }
  }

  function toggleFullscreen() {
    if (isFullscreen()) {
      exitFullscreen();
      return;
    }

    if (!activeImage || !canFullscreen()) {
      return;
    }

    const fullscreenRequest = viewerPanel.requestFullscreen({
      navigationUI: "hide"
    });
    if (fullscreenRequest && typeof fullscreenRequest.catch === "function") {
      fullscreenRequest.catch(() => {
        window.ImageViewer.State.setMessage("Full screen could not be started");
      });
    }
  }

  function exitFullscreen() {
    if (!document.fullscreenElement || !document.exitFullscreen) {
      return;
    }

    const fullscreenExit = document.exitFullscreen();
    if (fullscreenExit && typeof fullscreenExit.catch === "function") {
      fullscreenExit.catch(() => {
        window.ImageViewer.State.setMessage("Full screen could not be closed");
      });
    }
  }

  function handleFullscreenChange() {
    const fullscreenActive = isFullscreen();
    viewerPanel.classList.toggle("is-fullscreen", fullscreenActive);

    if (fullscreenActive) {
      centerFullscreenCursor();
      noteFullscreenActivity();
      applyFullscreenToolbarPlacementFromSettings();
      requestAnimationFrame(clampFullscreenToolbarPlacement);
    } else {
      stopToolbarDrag();
      deactivateFullscreenUiAutoHide();
    }

    if (!activeImage) {
      return;
    }

    requestAnimationFrame(() => {
      if (fullscreenActive) {
        defaultViewForActiveImage();
      } else {
        handleResize();
      }
    });
  }

  function isFullscreen() {
    return document.fullscreenElement === viewerPanel;
  }

  function canFullscreen() {
    return Boolean(
      viewerPanel &&
      viewerPanel.requestFullscreen &&
      document.exitFullscreen &&
      document.fullscreenEnabled !== false
    );
  }

  function handleFullscreenPointerActivity(event) {
    if (!isFullscreen()) {
      return;
    }

    updateFullscreenCursor(event);
    noteFullscreenActivity();
  }

  function noteFullscreenActivity(event) {
    if (!isFullscreen()) {
      return;
    }

    if (event) {
      updateFullscreenCursor(event);
    }
    viewerPanel.classList.remove("is-ui-hidden");
    scheduleFullscreenUiHide();
  }

  function scheduleFullscreenUiHide() {
    clearFullscreenIdleTimer();

    if (!activeImage || !isFullscreen()) {
      return;
    }

    fullscreenIdleTimer = window.setTimeout(hideFullscreenUi, FULLSCREEN_IDLE_DELAY);
  }

  function hideFullscreenUi() {
    fullscreenIdleTimer = 0;

    if (!activeImage || !isFullscreen()) {
      return;
    }

    if (isPanning || toolbarDragStart) {
      scheduleFullscreenUiHide();
      return;
    }

    viewerPanel.classList.add("is-ui-hidden");
  }

  function deactivateFullscreenUiAutoHide() {
    clearFullscreenIdleTimer();
    viewerPanel.classList.remove("is-ui-hidden");
  }

  function clearFullscreenIdleTimer() {
    if (fullscreenIdleTimer) {
      window.clearTimeout(fullscreenIdleTimer);
      fullscreenIdleTimer = 0;
    }
  }

  function updateFullscreenCursor(event) {
    if (
      !fullscreenCursor ||
      typeof event.clientX !== "number" ||
      typeof event.clientY !== "number"
    ) {
      return;
    }

    const rect = viewerPanel.getBoundingClientRect();
    const cursorX = clamp(event.clientX - rect.left, 0, rect.width);
    const cursorY = clamp(event.clientY - rect.top, 0, rect.height);
    setFullscreenCursorPosition(cursorX, cursorY);
  }

  function centerFullscreenCursor() {
    if (!fullscreenCursor) {
      return;
    }

    const rect = viewerPanel.getBoundingClientRect();
    setFullscreenCursorPosition(rect.width / 2, rect.height / 2);
  }

  function setFullscreenCursorPosition(cursorX, cursorY) {
    fullscreenCursor.style.setProperty("--fullscreen-cursor-x", cursorX + "px");
    fullscreenCursor.style.setProperty("--fullscreen-cursor-y", cursorY + "px");
  }

  function startToolbarDrag(event) {
    if (!isFullscreen() || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    updateFullscreenCursor(event);
    viewerPanel.classList.remove("is-ui-hidden");
    clearFullscreenIdleTimer();
    const panelRect = viewerPanel.getBoundingClientRect();
    const footerRect = viewerFooter.getBoundingClientRect();

    toolbarDragStart = {
      pointerId: event.pointerId,
      offsetX: event.clientX - footerRect.left,
      offsetY: event.clientY - footerRect.top
    };
    viewerPanel.classList.add("is-toolbar-dragging");
    setFullscreenToolbarPosition(
      footerRect.left - panelRect.left,
      footerRect.top - panelRect.top
    );

    try {
      toolbarDragHandle.setPointerCapture(event.pointerId);
    } catch (error) {
      // Pointer capture can fail if the pointer is already cancelled.
    }
  }

  function moveToolbarDrag(event) {
    if (!toolbarDragStart || event.pointerId !== toolbarDragStart.pointerId) {
      return;
    }

    event.preventDefault();
    updateFullscreenCursor(event);
    const panelRect = viewerPanel.getBoundingClientRect();
    setFullscreenToolbarPosition(
      event.clientX - panelRect.left - toolbarDragStart.offsetX,
      event.clientY - panelRect.top - toolbarDragStart.offsetY
    );
  }

  function stopToolbarDrag(event) {
    if (!toolbarDragStart) {
      return;
    }

    if (event && event.pointerId !== toolbarDragStart.pointerId) {
      return;
    }

    const pointerId = toolbarDragStart.pointerId;
    toolbarDragStart = null;
    viewerPanel.classList.remove("is-toolbar-dragging");

    try {
      toolbarDragHandle.releasePointerCapture(pointerId);
    } catch (error) {
      // Pointer capture may already be released by the browser.
    }

    noteFullscreenActivity(event);
  }

  function resetFullscreenToolbarPlacement(event) {
    if (!isFullscreen()) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    updateFullscreenCursor(event);
    clearFullscreenToolbarPlacement();
    applyDefaultFullscreenToolbarPlacement();
    noteFullscreenActivity(event);
  }

  function setFullscreenToolbarPosition(left, top) {
    const placement = getClampedFullscreenToolbarPlacement(left, top);
    toolbarHasCustomPosition = true;
    toolbarPlacement = getSerializableFullscreenToolbarPlacement(placement);
    applyFullscreenToolbarPlacement(placement);
  }

  function clampFullscreenToolbarPlacement() {
    if (!toolbarHasCustomPosition || !isFullscreen()) {
      return;
    }

    applyStoredFullscreenToolbarPlacement();
  }

  function applyStoredFullscreenToolbarPlacement() {
    if (!toolbarHasCustomPosition || !toolbarPlacement || !isFullscreen()) {
      return;
    }

    applyFullscreenToolbarPlacement(getPlacementFromStoredFullscreenToolbarPlacement());
  }

  function applyFullscreenToolbarPlacementFromSettings() {
    if (toolbarHasCustomPosition) {
      applyStoredFullscreenToolbarPlacement();
    } else {
      applyDefaultFullscreenToolbarPlacement();
    }
  }

  function clearFullscreenToolbarPlacement() {
    toolbarHasCustomPosition = false;
    toolbarPlacement = null;
    viewerFooter.style.removeProperty("--fullscreen-toolbar-left");
    viewerFooter.style.removeProperty("--fullscreen-toolbar-top");
    viewerFooter.style.removeProperty("--fullscreen-toolbar-bottom");
    viewerFooter.style.removeProperty("--fullscreen-toolbar-translate-x");
    viewerFooter.style.removeProperty("--fullscreen-toolbar-translate-y");
  }

  function applyDefaultFullscreenToolbarPlacement() {
    if (!viewerFooter || toolbarHasCustomPosition) {
      return;
    }

    const placement = getDefaultFullscreenToolbarPlacement(viewerSettings.fullscreenToolbarPosition);
    viewerFooter.style.setProperty("--fullscreen-toolbar-left", placement.left);
    viewerFooter.style.setProperty("--fullscreen-toolbar-top", placement.top);
    viewerFooter.style.setProperty("--fullscreen-toolbar-bottom", placement.bottom);
    viewerFooter.style.setProperty("--fullscreen-toolbar-translate-x", placement.translateX);
    viewerFooter.style.setProperty("--fullscreen-toolbar-translate-y", placement.translateY);
  }

  function getDefaultFullscreenToolbarPlacement(position) {
    const edge = "var(--fullscreen-toolbar-edge)";
    const farEdge = "calc(100% - var(--fullscreen-toolbar-edge))";

    if (position === "top-left") {
      return getPlacementCss(edge, edge, "auto", "0px", "0px");
    }
    if (position === "top-center") {
      return getPlacementCss("50%", edge, "auto", "-50%", "0px");
    }
    if (position === "top-right") {
      return getPlacementCss(farEdge, edge, "auto", "-100%", "0px");
    }
    if (position === "left") {
      return getPlacementCss(edge, "50%", "auto", "0px", "-50%");
    }
    if (position === "bottom-left") {
      return getPlacementCss(edge, "auto", edge, "0px", "0px");
    }
    if (position === "bottom-right") {
      return getPlacementCss(farEdge, "auto", edge, "-100%", "0px");
    }

    return getPlacementCss("50%", "auto", edge, "-50%", "0px");
  }

  function getPlacementCss(left, top, bottom, translateX, translateY) {
    return {
      left,
      top,
      bottom,
      translateX,
      translateY
    };
  }

  function getClampedFullscreenToolbarPlacement(left, top) {
    const bounds = getFullscreenToolbarPlacementBounds();

    return {
      left: clamp(left, bounds.minLeft, bounds.maxLeft),
      top: clamp(top, bounds.minTop, bounds.maxTop)
    };
  }

  function getSerializableFullscreenToolbarPlacement(placement) {
    const bounds = getFullscreenToolbarPlacementBounds();
    const widthRange = bounds.maxLeft - bounds.minLeft;
    const heightRange = bounds.maxTop - bounds.minTop;

    return {
      leftRatio: widthRange > 0 ? (placement.left - bounds.minLeft) / widthRange : 0,
      topRatio: heightRange > 0 ? (placement.top - bounds.minTop) / heightRange : 0
    };
  }

  function getPlacementFromStoredFullscreenToolbarPlacement() {
    const bounds = getFullscreenToolbarPlacementBounds();

    return {
      left: bounds.minLeft + (bounds.maxLeft - bounds.minLeft) * clamp(toolbarPlacement.leftRatio, 0, 1),
      top: bounds.minTop + (bounds.maxTop - bounds.minTop) * clamp(toolbarPlacement.topRatio, 0, 1)
    };
  }

  function getFullscreenToolbarPlacementBounds() {
    const panelRect = viewerPanel.getBoundingClientRect();
    const footerRect = viewerFooter.getBoundingClientRect();
    const minLeft = FULLSCREEN_TOOLBAR_MARGIN;
    const minTop = FULLSCREEN_TOOLBAR_MARGIN;

    return {
      minLeft,
      minTop,
      maxLeft: Math.max(minLeft, panelRect.width - footerRect.width - FULLSCREEN_TOOLBAR_MARGIN),
      maxTop: Math.max(minTop, panelRect.height - footerRect.height - FULLSCREEN_TOOLBAR_MARGIN)
    };
  }

  function applyFullscreenToolbarPlacement(placement) {
    viewerFooter.style.setProperty("--fullscreen-toolbar-left", placement.left + "px");
    viewerFooter.style.setProperty("--fullscreen-toolbar-top", placement.top + "px");
    viewerFooter.style.setProperty("--fullscreen-toolbar-bottom", "auto");
    viewerFooter.style.setProperty("--fullscreen-toolbar-translate-x", "0px");
    viewerFooter.style.setProperty("--fullscreen-toolbar-translate-y", "0px");
  }

  function handleResize() {
    if (!activeImage) {
      return;
    }

    if (isFullscreen()) {
      clampFullscreenToolbarPlacement();
    }

    const wasFitMode = isFitMode;
    const wasActualSizeMode = isActualSizeMode;
    calculateFitScale();
    if (wasActualSizeMode) {
      scale = getActualSizeScale();
      isFitMode = nearlyEqual(scale, fitScale);
      isActualSizeMode = true;
      clampPan();
      scheduleTransform();
    } else if (wasFitMode) {
      fitToImage();
    } else {
      clampPan();
      scheduleTransform();
    }
  }

  function calculateFitScale() {
    if (!activeImage) {
      fitScale = 1;
      return;
    }

    const rect = viewport.getBoundingClientRect();
    fitScale = getFitScale(rect);
  }

  function startPan(event) {
    if (!activeImage || event.button !== 0) {
      return;
    }

    const scaledWidth = activeImage.width * scale;
    const scaledHeight = activeImage.height * scale;
    const rect = viewport.getBoundingClientRect();
    if (scaledWidth <= rect.width && scaledHeight <= rect.height) {
      return;
    }

    event.preventDefault();
    isPanning = true;
    viewport.classList.add("is-panning");
    panStart = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      panX,
      panY
    };
    try {
      viewport.setPointerCapture(event.pointerId);
    } catch (error) {
      // Some browsers skip capture for already-cancelled pointers.
    }
  }

  function movePan(event) {
    if (!isPanning || !panStart || event.pointerId !== panStart.pointerId) {
      return;
    }

    panX = panStart.panX + event.clientX - panStart.clientX;
    panY = panStart.panY + event.clientY - panStart.clientY;
    isFitMode = false;
    clampPan();
    scheduleTransform();
  }

  function stopPan(event) {
    if (!isPanning || !panStart || event.pointerId !== panStart.pointerId) {
      return;
    }

    isPanning = false;
    viewport.classList.remove("is-panning");
    try {
      viewport.releasePointerCapture(event.pointerId);
    } catch (error) {
      // Pointer capture may already be released by the browser.
    }
    panStart = null;
  }

  function clampPan() {
    if (!activeImage) {
      return;
    }

    const rect = viewport.getBoundingClientRect();
    const scaledWidth = activeImage.width * scale;
    const scaledHeight = activeImage.height * scale;
    const maxX = Math.max(0, (scaledWidth - rect.width) / 2);
    const maxY = Math.max(0, (scaledHeight - rect.height) / 2);

    panX = scaledWidth <= rect.width ? 0 : clamp(panX, -maxX, maxX);
    panY = scaledHeight <= rect.height ? 0 : clamp(panY, -maxY, maxY);
  }

  function clearSurface() {
    viewerImage.removeAttribute("src");
    viewerImage.alt = "";
    viewerImage.classList.remove("is-visible");
    viewerImage.style.removeProperty("width");
    viewerImage.style.removeProperty("height");
    viewerImage.style.removeProperty("transform");

    viewerCanvas.classList.remove("is-visible");
    viewerCanvas.width = 0;
    viewerCanvas.height = 0;
    viewerCanvas.style.removeProperty("width");
    viewerCanvas.style.removeProperty("height");
    viewerCanvas.style.removeProperty("transform");

    if (viewerSvg) {
      viewerSvg.classList.remove("is-visible");
    }
    clearVectorSettle();
    finishVectorZoomActivity();
    renderedVectorWidth = 0;
    renderedVectorHeight = 0;
    renderedVectorScale = 1;

    scale = 1;
    fitScale = 1;
    panX = 0;
    panY = 0;
    isFitMode = true;
    isActualSizeMode = false;
  }

  function resetInteraction() {
    isPanning = false;
    panStart = null;
    if (transformFrame) {
      cancelAnimationFrame(transformFrame);
      transformFrame = 0;
    }
    forceVectorRenderOnNextFrame = false;
    clearVectorSettle();
    finishVectorZoomActivity();
    if (viewport) {
      viewport.classList.remove("is-panning");
    }
  }

  function scheduleTransform(forceVectorRender) {
    if (forceVectorRender && activeImage && activeImage.displayMode === "svg-vector") {
      forceVectorRenderOnNextFrame = true;
    }
    if (transformFrame) {
      return;
    }

    transformFrame = requestAnimationFrame(() => {
      transformFrame = 0;
      const shouldForceVectorRender = forceVectorRenderOnNextFrame;
      forceVectorRenderOnNextFrame = false;
      applyTransform(shouldForceVectorRender);
    });
  }

  function applyTransform(forceVectorRender) {
    if (!activeImage) {
      return;
    }

    const visibleElement = getActiveSurface();
    if (!visibleElement) {
      return;
    }

    if (activeImage.displayMode === "svg-vector") {
      applyVectorTransform(visibleElement, forceVectorRender);
    } else {
      visibleElement.style.transform = "translate3d(calc(-50% + " + panX + "px), calc(-50% + " + panY + "px), 0) scale(" + scale + ")";
    }

    viewport.classList.toggle("is-fit", isFitMode);
    setZoomReadout(getZoomPercent());
  }

  // Resizing the live <object> relayouts and repaints the whole vector (drop
  // shadow included), so SVG wheel zoom keeps the document box stable and moves
  // with a GPU scale. After input settles, the document is resized once for a
  // crisp redraw, capped to avoid huge live SVG layout boxes at extreme zoom.
  function applyVectorTransform(surface, forceVectorRender) {
    if (forceVectorRender || !renderedVectorWidth || !renderedVectorHeight) {
      renderVectorAtScale(surface, scale);
    }

    surface.style.transform = vectorTransform(getVectorResidualScale());
    if (forceVectorRender || nearlyEqual(renderedVectorScale, getVectorRenderScale(scale))) {
      clearVectorSettle();
      return;
    }

    scheduleVectorSettle();
  }

  function vectorTransform(residual) {
    const translate = "translate3d(calc(-50% + " + panX + "px), calc(-50% + " + panY + "px), 0)";
    return nearlyEqual(residual, 1) ? translate : translate + " scale(" + residual + ")";
  }

  function renderVectorAtScale(surface, targetScale) {
    clearVectorSettle();
    const renderScale = getVectorRenderScale(targetScale);
    const vectorWidth = Math.max(1, Math.round(activeImage.width * renderScale));
    const vectorHeight = Math.max(1, Math.round(activeImage.height * renderScale));
    if (vectorWidth !== renderedVectorWidth) {
      surface.style.width = vectorWidth + "px";
      renderedVectorWidth = vectorWidth;
    }
    if (vectorHeight !== renderedVectorHeight) {
      surface.style.height = vectorHeight + "px";
      renderedVectorHeight = vectorHeight;
    }
    renderedVectorScale = renderScale;
  }

  function getVectorRenderScale(targetScale) {
    const width = Math.max(1, activeImage.width || 1);
    const height = Math.max(1, activeImage.height || 1);
    const maxScaleByEdge = Math.min(VECTOR_RENDER_MAX_EDGE / width, VECTOR_RENDER_MAX_EDGE / height);
    const maxScaleByArea = Math.sqrt(VECTOR_RENDER_MAX_AREA / (width * height));
    const maxRenderScale = Math.max(
      VECTOR_RENDER_MIN_SCALE,
      Math.min(getMaxScale(), maxScaleByEdge, maxScaleByArea)
    );
    return clamp(targetScale, VECTOR_RENDER_MIN_SCALE, maxRenderScale);
  }

  function getVectorResidualScale() {
    return renderedVectorScale > 0 ? scale / renderedVectorScale : 1;
  }

  function scheduleVectorSettle() {
    clearVectorSettle();
    vectorSettleTimer = window.setTimeout(settleVector, VECTOR_SETTLE_DELAY);
  }

  function clearVectorSettle() {
    if (vectorSettleTimer) {
      window.clearTimeout(vectorSettleTimer);
      vectorSettleTimer = 0;
    }
  }

  function noteVectorZoomActivity() {
    if (!viewport) {
      return;
    }
    viewport.classList.add("is-vector-zooming");
    clearVectorZoomClassTimer();
    vectorZoomClassTimer = window.setTimeout(finishVectorZoomActivity, VECTOR_ZOOM_CLASS_DELAY);
  }

  function finishVectorZoomActivity() {
    clearVectorZoomClassTimer();
    if (viewport) {
      viewport.classList.remove("is-vector-zooming");
    }
  }

  function clearVectorZoomClassTimer() {
    if (vectorZoomClassTimer) {
      window.clearTimeout(vectorZoomClassTimer);
      vectorZoomClassTimer = 0;
    }
  }

  function settleVector() {
    vectorSettleTimer = 0;
    if (!activeImage || activeImage.displayMode !== "svg-vector" || !viewerSvg) {
      return;
    }
    renderVectorAtScale(viewerSvg, scale);
    viewerSvg.style.transform = vectorTransform(getVectorResidualScale());
    finishVectorZoomActivity();
  }

  function getMaxScale() {
    return activeImage && activeImage.displayMode === "svg-vector"
      ? MAX_VECTOR_SCALE
      : MAX_SCALE;
  }

  function getActiveSurface() {
    if (activeImage.displayMode === "tiff-canvas") {
      return viewerCanvas;
    }
    if (activeImage.displayMode === "svg-vector") {
      return viewerSvg;
    }
    return viewerImage;
  }

  function getFitScale(rect) {
    const availableWidth = Math.max(1, rect.width);
    const availableHeight = Math.max(1, rect.height);
    const rawFitScale = Math.min(availableWidth / activeImage.width, availableHeight / activeImage.height);
    return clamp(rawFitScale, MIN_SCALE, getMaxScale());
  }

  function getActualSizeScale() {
    return clamp(1 / getDevicePixelRatio(), MIN_SCALE, getMaxScale());
  }

  function getZoomPercent() {
    return scale * getDevicePixelRatio() * 100;
  }

  function getDevicePixelRatio() {
    const ratio = window.devicePixelRatio;
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  }

  function getImageSurfaceKey(image) {
    return [
      image.id,
      image.objectUrl || "",
      image.width,
      image.height,
      image.icoSelectedFrameId || "",
      image.svgSelectedSpriteEntryId || ""
    ].join("|");
  }

  function getSvgSurfaceId(image) {
    return [
      image.id,
      image.objectUrl || "",
      image.svgSelectedSpriteEntryId || ""
    ].join("|");
  }

  function isIcoImage(image) {
    return Boolean(image && Array.isArray(image.icoFrames) && image.icoFrames.length);
  }

  function updateMeta() {
    setMeta(activeImage.displayName);
  }

  function handleSettingsChange(nextSettings) {
    const previousFullscreenToolbarPosition = viewerSettings.fullscreenToolbarPosition;
    viewerSettings = Object.assign({}, DEFAULT_VIEWER_SETTINGS, nextSettings);

    if (previousFullscreenToolbarPosition !== viewerSettings.fullscreenToolbarPosition) {
      toolbarHasCustomPosition = false;
      toolbarPlacement = null;
    }

    applyViewerSettings();
  }

  function applyViewerSettings() {
    if (!viewerPanel) {
      return;
    }

    viewerPanel.dataset.toolbarPosition = viewerSettings.toolbarPosition;
    viewerPanel.classList.toggle("is-fullscreen-name-hidden", !viewerSettings.fullscreenShowImageName);
    applyTransparencyBackdrop();
    updateFullscreenToolbarName();

    if (isFullscreen()) {
      applyFullscreenToolbarPlacementFromSettings();
    }

    requestAnimationFrame(handleResize);
  }

  // The surfaces fill exactly the image box, so painting their background paints
  // the image's transparent pixels. In windowed mode the checkerboard around the
  // image lives on .viewer-frame and is unaffected; in fullscreen the frame reads
  // this same var to flood the whole background with the backdrop color (no
  // letterbox). The var is set on .viewer-panel so it cascades to both the frame
  // and every surface beneath it.
  function applyTransparencyBackdrop() {
    if (!viewerPanel) {
      return;
    }

    const color = TRANSPARENCY_BACKDROP_COLORS[viewerSettings.transparencyBackdrop] ||
      TRANSPARENCY_BACKDROP_COLORS.black;
    viewerPanel.style.setProperty("--image-backdrop", color);
  }

  function updateFullscreenToolbarName() {
    if (!fullscreenToolbarName) {
      return;
    }

    const displayName = activeImage ? activeImage.displayName : "";
    fullscreenToolbarName.textContent = displayName;
    fullscreenToolbarName.title = displayName;
  }

  function setMeta(text) {
    imageMeta.textContent = text;
  }

  function setZoomReadout(percent) {
    zoomReadout.textContent = Math.round(percent) + "%";
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function nearlyEqual(a, b) {
    return Math.abs(a - b) < 0.001;
  }

  window.ImageViewer = window.ImageViewer || {};
  window.ImageViewer.Viewer = {
    init,
    render,
    zoomBy,
    fitToImage,
    actualSize,
    toggleFullscreen,
    isFullscreen,
    canFullscreen
  };
}());
