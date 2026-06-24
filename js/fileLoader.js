(function () {
  "use strict";

  const NATIVE_EXTENSIONS = new Set([
    "png", "apng", "jpg", "jpeg", "jpe", "gif", "bmp", "dib",
    "ico", "cur", "svg", "webp", "avif"
  ]);
  const LOAD_BATCH_SIZE = 8;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const XLINK_NS = "http://www.w3.org/1999/xlink";
  const INHERITED_SVG_ATTRIBUTES = [
    "class", "style", "color", "fill", "fill-rule", "clip-rule",
    "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
    "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
    "opacity", "shape-rendering", "vector-effect"
  ];
  const NON_RENDERING_SVG_ELEMENTS = new Set([
    "defs", "desc", "metadata", "script", "style", "symbol", "title"
  ]);

  let imageInput;
  let addImagesBtn;
  let emptyState;
  let imagesPanel;
  let dropOverlay;
  let dragDepth = 0;

  function init() {
    imageInput = document.getElementById("imageInput");
    addImagesBtn = document.getElementById("addImagesBtn");
    emptyState = document.getElementById("emptyState");
    imagesPanel = document.querySelector(".images-panel");
    dropOverlay = document.getElementById("dropOverlay");

    addImagesBtn.addEventListener("click", openPicker);
    emptyState.addEventListener("click", openPicker);
    imageInput.addEventListener("change", handlePickerChange);

    imagesPanel.addEventListener("dragenter", handlePanelDragEnter);
    imagesPanel.addEventListener("dragover", handlePanelDragOver);
    imagesPanel.addEventListener("dragleave", handlePanelDragLeave);
    imagesPanel.addEventListener("drop", handlePanelDrop);
    document.addEventListener("dragover", handleDocumentDragOver);
    document.addEventListener("drop", handleDocumentDrop);
  }

  function openPicker() {
    imageInput.click();
  }

  async function handlePickerChange(event) {
    const files = Array.from(event.target.files || []);
    imageInput.value = "";
    await loadFiles(files);
  }

  function handlePanelDragEnter(event) {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepth += 1;
    showDropOverlay();
  }

  function handlePanelDragOver(event) {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  }

  function handlePanelDragLeave(event) {
    if (!hasFiles(event)) {
      return;
    }
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      hideDropOverlay();
    }
  }

  async function handlePanelDrop(event) {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    hideDropOverlay();
    const files = Array.from(event.dataTransfer.files || []);
    await loadFiles(files);
  }

  function handleDocumentDragOver(event) {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = imagesPanel.contains(event.target) ? "copy" : "none";
  }

  function handleDocumentDrop(event) {
    if (!hasFiles(event) || imagesPanel.contains(event.target)) {
      return;
    }
    event.preventDefault();
    dragDepth = 0;
    hideDropOverlay();
  }

  function showDropOverlay() {
    dropOverlay.classList.add("is-visible");
    imagesPanel.classList.add("is-drop-target");
  }

  function hideDropOverlay() {
    dropOverlay.classList.remove("is-visible");
    imagesPanel.classList.remove("is-drop-target");
  }

  async function loadFiles(files) {
    const fileArray = Array.from(files || []);

    // A .deck is an "open document" action: it replaces the current deck, then
    // appends any other files dropped/picked alongside it. Route to the deck
    // flow if the batch contains one; otherwise load as normal images.
    if (fileArray.some(isDeckFile)) {
      await openDeckBatch(fileArray);
      return;
    }

    await loadImageFiles(fileArray);
  }

  async function loadImageFiles(files) {
    const imageFiles = files.filter(isSupportedCandidate);

    if (!imageFiles.length) {
      window.ImageViewer.State.setMessage("No supported image files selected");
      return;
    }

    window.ImageViewer.State.setMessage("Loading " + imageFiles.length + " image" + (imageFiles.length === 1 ? "" : "s") + "...");

    let loadedBatch = [];
    let loadedCount = 0;
    let processedFileCount = 0;
    const skipped = [];

    for (const file of imageFiles) {
      try {
        const produced = await decodeOneFile(file);
        loadedBatch.push.apply(loadedBatch, produced);
        loadedCount += produced.length;
      } catch (error) {
        skipped.push(file.name);
      }
      processedFileCount += 1;

      if (loadedBatch.length >= LOAD_BATCH_SIZE) {
        window.ImageViewer.State.addImages(loadedBatch);
        loadedBatch = [];
        window.ImageViewer.State.setMessage("Processed " + processedFileCount + " of " + imageFiles.length + " selected files");
        await yieldToBrowser();
      }
    }

    if (loadedBatch.length) {
      window.ImageViewer.State.addImages(loadedBatch);
    }

    if (skipped.length) {
      window.ImageViewer.State.setMessage("Skipped " + skipped.length + " unsupported or unreadable file" + (skipped.length === 1 ? "" : "s"));
    } else if (loadedCount) {
      window.ImageViewer.State.setMessage("Loaded " + loadedCount + " image" + (loadedCount === 1 ? "" : "s"));
    }
  }

  // Decode a single file into one or more image objects (a multi-page TIFF
  // expands to one per page). Shared by normal loading and .deck import so both
  // paths produce identical image objects through the same decoders.
  async function decodeOneFile(file) {
    if (window.ImageViewer.TiffAdapter.isTiffFile(file)) {
      return await window.ImageViewer.TiffAdapter.decodeFile(file);
    }
    if (window.ImageViewer.IcoAdapter.isIcoFile(file)) {
      return [await decodeIcoFile(file)];
    }
    if (isSvgFile(file)) {
      return [await decodeSvgFile(file)];
    }
    return [await decodeNativeImage(file)];
  }

  // Open-then-append: the first .deck in the batch replaces the current deck
  // (clear + load); every other file (loose images or additional decks) is
  // appended after it in drop order. Everything is decoded BEFORE state is
  // touched, so a corrupt/invalid deck never wipes the current images.
  async function openDeckBatch(files) {
    const firstDeckIndex = files.findIndex(isDeckFile);
    const primaryDeck = files[firstDeckIndex];

    window.ImageViewer.State.setMessage("Opening " + primaryDeck.name + "...");

    let primary;
    try {
      primary = await window.ImageViewer.DeckFile.readDeck(primaryDeck);
    } catch (error) {
      window.ImageViewer.State.setMessage(primaryDeck.name + " is not a valid .deck file");
      return;
    }

    const images = primary.images.slice();
    const selections = primary.selections.slice();
    const skipped = [];

    for (let index = 0; index < files.length; index += 1) {
      if (index === firstDeckIndex) {
        continue;
      }
      const file = files[index];
      try {
        if (isDeckFile(file)) {
          const deck = await window.ImageViewer.DeckFile.readDeck(file);
          images.push.apply(images, deck.images);
          selections.push.apply(selections, deck.selections);
        } else if (isSupportedCandidate(file)) {
          images.push.apply(images, await decodeOneFile(file));
        } else {
          skipped.push(file.name);
        }
      } catch (error) {
        skipped.push(file.name);
      }
    }

    window.ImageViewer.State.clearImages();
    window.ImageViewer.State.addImages(images);
    applyDeckSelections(selections);

    if (skipped.length) {
      window.ImageViewer.State.setMessage("Opened " + primaryDeck.name + ", skipped " + skipped.length + " file" + (skipped.length === 1 ? "" : "s"));
    } else {
      window.ImageViewer.State.setMessage("Opened " + primaryDeck.name + " (" + images.length + " image" + (images.length === 1 ? "" : "s") + ")");
    }
  }

  // Restore which ICO frame / SVG sprite entry was being viewed, applied after
  // the images are in state (these helpers look the image up by id). Both no-op
  // when the value already matches the default, so passing every entry is safe.
  function applyDeckSelections(selections) {
    selections.forEach((selection) => {
      if (selection.ico) {
        window.ImageViewer.State.selectIcoFrame(selection.id, selection.ico);
      }
      if (selection.svg) {
        window.ImageViewer.State.selectSvgSpriteEntry(selection.id, selection.svg);
      }
    });
  }

  function isDeckFile(file) {
    return getExtension(file.name) === "deck";
  }

  function decodeNativeImage(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();

      img.onload = async function () {
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        if (!width || !height) {
          URL.revokeObjectURL(objectUrl);
          reject(new Error("Image has no readable dimensions."));
          return;
        }

        const format = getFormatLabel(file);
        const thumbnail = await window.ImageViewer.Thumbnail.fromImage(img, {
          format,
          mimeType: file.type || ""
        }).catch(() => ({
          url: objectUrl,
          objectUrl: false
        }));

        resolve({
          id: createId(),
          fileName: file.name,
          displayName: file.name,
          format,
          mimeType: file.type || "",
          size: file.size,
          width,
          height,
          objectUrl,
          thumbnailUrl: thumbnail.url || objectUrl,
          thumbnailObjectUrl: thumbnail.objectUrl,
          displayMode: "native",
          animated: false,
          hasTransparency: formatSupportsAlpha(format) && window.ImageViewer.Thumbnail.detectTransparency(img, width, height),
          sourceMode: "Native browser display",
          sourceFile: file
        });
      };

      img.onerror = function () {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Browser could not decode image."));
      };

      img.decoding = "async";
      img.src = objectUrl;
    });
  }

  async function decodeIcoFile(file) {
    try {
      return await window.ImageViewer.IcoAdapter.decodeFile(file);
    } catch (error) {
      return decodeNativeImage(file);
    }
  }

  // SVGs get a dedicated path: dimensions come from the parsed document (not a
  // fragile <img> probe that returns 0 for viewBox-only files), and the markup
  // is normalized so resizing the live <object> actually scales the vector.
  async function decodeSvgFile(file) {
    let info;
    try {
      info = parseSvgDocument(await file.text());
    } catch (error) {
      info = { width: 300, height: 150, animated: false, fillMarkup: "", ok: false, spriteEntries: [] };
    }

    if (info.ok && info.spriteEntries.length) {
      return createSvgSpriteImage(file, info);
    }

    // The fill variant (width/height 100% + a guaranteed viewBox) repaints
    // sharply as the <object> is resized. If parsing failed, fall back to the
    // raw file so the document still loads.
    const vectorBlob = info.ok
      ? new Blob([info.fillMarkup], { type: "image/svg+xml" })
      : file;
    const objectUrl = URL.createObjectURL(vectorBlob);
    // A static raster keeps the live (often animated) SVG document out of the
    // list. Otherwise every visible SVG row keeps animating and starves the
    // main viewer, which is why non-fullscreen playback stutters.
    const thumbnail = info.ok
      ? await createSvgThumbnail(info.rasterMarkup || info.fillMarkup, info.width, info.height, objectUrl)
      : { url: objectUrl, objectUrl: false };
    return {
      id: createId(),
      fileName: file.name,
      displayName: file.name,
      format: "SVG",
      mimeType: file.type || "image/svg+xml",
      size: file.size,
      width: info.width,
      height: info.height,
      objectUrl,
      thumbnailUrl: thumbnail.url,
      thumbnailObjectUrl: thumbnail.objectUrl,
      displayMode: "svg-vector",
      animated: info.animated,
      // Vector documents render on a transparent canvas, so the backdrop applies.
      hasTransparency: true,
      sourceMode: info.animated ? "Live animated SVG document" : "Live SVG document",
      sourceFile: file
    };
  }

  async function createSvgSpriteImage(file, info) {
    const spriteEntries = info.spriteEntries.map((entry) => {
      const objectUrl = URL.createObjectURL(new Blob([entry.fillMarkup], { type: "image/svg+xml" }));
      return Object.assign({}, entry, { objectUrl });
    });
    const selectedEntry = spriteEntries[0];
    // Match the single-SVG path: a static thumbnail so a sprite that happens to
    // animate does not keep painting in the list.
    const thumbnail = await createSvgThumbnail(
      selectedEntry.rasterMarkup || selectedEntry.fillMarkup,
      selectedEntry.width,
      selectedEntry.height,
      selectedEntry.objectUrl
    );

    return {
      id: createId(),
      fileName: file.name,
      displayName: file.name,
      format: "SVG-Sprite",
      mimeType: file.type || "image/svg+xml",
      size: file.size,
      width: selectedEntry.width,
      height: selectedEntry.height,
      objectUrl: selectedEntry.objectUrl,
      thumbnailUrl: thumbnail.url,
      thumbnailObjectUrl: thumbnail.objectUrl,
      displayMode: "svg-vector",
      animated: info.animated,
      hasTransparency: true,
      sourceMode: "SVG sprite: " + selectedEntry.label,
      svgSpriteEntries: spriteEntries,
      svgSelectedSpriteEntryId: selectedEntry.id,
      sourceFile: file
    };
  }

  // Rasterize a static thumbnail for an SVG, falling back to the live document
  // URL if rasterization fails (e.g. a tainted canvas from external refs) so the
  // list row still shows the image.
  async function createSvgThumbnail(markup, width, height, fallbackUrl) {
    try {
      const thumbnail = await window.ImageViewer.Thumbnail.fromSvgMarkup(markup, width, height, {
        format: "SVG",
        mimeType: "image/svg+xml"
      });
      if (thumbnail && thumbnail.url) {
        return thumbnail;
      }
    } catch (error) {
      // Fall through to the live document below.
    }
    return { url: fallbackUrl, objectUrl: false };
  }

  function yieldToBrowser() {
    return new Promise((resolve) => {
      if (window.requestIdleCallback) {
        window.requestIdleCallback(resolve, { timeout: 80 });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  function isSupportedCandidate(file) {
    const extension = getExtension(file.name);
    return window.ImageViewer.TiffAdapter.isTiffFile(file) ||
      NATIVE_EXTENSIONS.has(extension) ||
      String(file.type || "").startsWith("image/");
  }

  function parseSvgDocument(svgText) {
    const failure = { width: 300, height: 150, animated: false, fillMarkup: "", ok: false };
    const parser = new DOMParser();
    const documentNode = parser.parseFromString(svgText, "image/svg+xml");
    const svg = documentNode.documentElement;

    if (!svg || svg.nodeName.toLowerCase() !== "svg" || documentNode.querySelector("parsererror")) {
      return failure;
    }

    const viewBox = parseViewBox(svg.getAttribute("viewBox"));
    let width = parseSvgLength(svg.getAttribute("width"));
    let height = parseSvgLength(svg.getAttribute("height"));

    if ((!width || !height) && viewBox) {
      const ratio = viewBox.width / viewBox.height;
      if (!width && !height) {
        width = viewBox.width;
        height = viewBox.height;
      } else if (width && !height) {
        height = width / ratio;
      } else if (!width && height) {
        width = height * ratio;
      }
    }

    width = sanitizeDimension(width, viewBox ? viewBox.width : 300);
    height = sanitizeDimension(height, viewBox ? viewBox.height : 150);

    const animated = isAnimatedSvg(svg, svgText);
    const fallbackSize = { width, height, viewBox: viewBox || { x: 0, y: 0, width, height } };
    const spriteEntries = getSvgSpriteEntries(documentNode, svg, fallbackSize, animated);

    if (spriteEntries.length) {
      return {
        width: spriteEntries[0].width,
        height: spriteEntries[0].height,
        animated,
        fillMarkup: spriteEntries[0].fillMarkup,
        spriteEntries,
        ok: true
      };
    }

    // Normalize so the live vector scales with its container: a fixed-size SVG
    // (width/height in px) otherwise ignores the <object>'s size. Guarantee a
    // coordinate system and namespace, then emit a fill variant.
    if (!svg.getAttribute("xmlns")) {
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    }
    if (!viewBox) {
      svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    }
    if (!svg.getAttribute("preserveAspectRatio")) {
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    }

    const serializer = new XMLSerializer();

    // Explicit-pixel variant for rasterizing a static list thumbnail (reliable
    // across engines); the live <object> still gets the percentage-sized fill
    // variant below so it scales with its frame.
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    const rasterMarkup = serializer.serializeToString(svg);

    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    const fillMarkup = serializer.serializeToString(svg);

    return { width, height, animated, fillMarkup, rasterMarkup, spriteEntries: [], ok: true };
  }

  function getSvgSpriteEntries(documentNode, svg, fallbackSize, animated) {
    const symbols = Array.from(svg.querySelectorAll("symbol"));
    if (symbols.length && !hasRenderableSvgContentOutside(svg, "symbol")) {
      return symbols.map((symbol, index) => createSymbolSpriteEntry(documentNode, svg, symbol, index, fallbackSize, animated));
    }

    const nestedSvgs = Array.from(svg.children).filter((child) => getElementName(child) === "svg");
    if (nestedSvgs.length > 1 && !hasRenderableSvgContentOutside(svg, "svg")) {
      return nestedSvgs.map((nestedSvg, index) => createNestedSvgSpriteEntry(documentNode, svg, nestedSvg, index, fallbackSize, animated));
    }

    return [];
  }

  function hasRenderableSvgContentOutside(svg, spriteElementName) {
    return Array.from(svg.children).some((child) => {
      const name = getElementName(child);
      if (name === spriteElementName || NON_RENDERING_SVG_ELEMENTS.has(name)) {
        return false;
      }
      return !isDisplayNone(child);
    });
  }

  function isDisplayNone(element) {
    const style = element.getAttribute("style") || "";
    const display = String(element.getAttribute("display") || "").trim().toLowerCase();
    return display === "none" ||
      /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i.test(style);
  }

  function createSymbolSpriteEntry(documentNode, svg, symbol, index, fallbackSize, animated) {
    const useId = symbol.getAttribute("id") || "generated-symbol-" + (index + 1);
    const metrics = getSvgElementMetrics(symbol, fallbackSize);

    return {
      id: "sprite-entry-" + index,
      sourceId: symbol.getAttribute("id") || "",
      label: getSpriteEntryLabel(symbol, "symbol", index),
      width: metrics.width,
      height: metrics.height,
      fillMarkup: createSymbolSpriteMarkup(documentNode, svg, symbol, useId, metrics),
      animated
    };
  }

  function createNestedSvgSpriteEntry(documentNode, svg, nestedSvg, index, fallbackSize, animated) {
    const metrics = getSvgElementMetrics(nestedSvg, fallbackSize);
    const clone = nestedSvg.cloneNode(true);
    const serializer = new XMLSerializer();

    if (!clone.getAttribute("xmlns")) {
      clone.setAttribute("xmlns", SVG_NS);
    }
    if (!clone.getAttribute("xmlns:xlink")) {
      clone.setAttribute("xmlns:xlink", XLINK_NS);
    }
    copyInheritedSpriteAttributes(svg, clone);
    if (!clone.getAttribute("viewBox")) {
      clone.setAttribute("viewBox", viewBoxToString(metrics.viewBox));
    }
    if (!clone.getAttribute("preserveAspectRatio")) {
      clone.setAttribute("preserveAspectRatio", "xMidYMid meet");
    }
    clone.setAttribute("width", "100%");
    clone.setAttribute("height", "100%");
    injectSharedSvgDefinitions(documentNode, svg, clone);

    return {
      id: "sprite-entry-" + index,
      sourceId: nestedSvg.getAttribute("id") || "",
      label: getSpriteEntryLabel(nestedSvg, "svg", index),
      width: metrics.width,
      height: metrics.height,
      fillMarkup: serializer.serializeToString(clone),
      animated
    };
  }

  function createSymbolSpriteMarkup(documentNode, svg, symbol, useId, metrics) {
    const serializer = new XMLSerializer();
    const defs = documentNode.createElementNS(SVG_NS, "defs");
    const selectedSymbol = symbol.cloneNode(true);

    selectedSymbol.setAttribute("id", useId);
    defs.appendChild(selectedSymbol);

    Array.from(svg.querySelectorAll("symbol")).forEach((candidate) => {
      if (candidate === symbol || !candidate.getAttribute("id")) {
        return;
      }
      defs.appendChild(candidate.cloneNode(true));
    });
    appendSharedSvgDefinitionChildren(svg, defs);

    return [
      '<svg xmlns="' + SVG_NS + '" xmlns:xlink="' + XLINK_NS + '" width="100%" height="100%" viewBox="' + viewBoxToString(metrics.viewBox) + '" preserveAspectRatio="xMidYMid meet"' + getInheritedSpriteAttributeText(svg) + '>',
      serializer.serializeToString(defs),
      '<use href="#' + escapeAttribute(useId) + '" xlink:href="#' + escapeAttribute(useId) + '" width="100%" height="100%"></use>',
      '</svg>'
    ].join("");
  }

  function injectSharedSvgDefinitions(documentNode, svg, targetSvg) {
    const defs = documentNode.createElementNS(SVG_NS, "defs");
    appendSharedSvgDefinitionChildren(svg, defs);

    if (!defs.childNodes.length) {
      return;
    }

    targetSvg.insertBefore(defs, targetSvg.firstChild);
  }

  function appendSharedSvgDefinitionChildren(svg, targetDefs) {
    Array.from(svg.children).forEach((defs) => {
      if (getElementName(defs) !== "defs") {
        return;
      }
      Array.from(defs.children).forEach((child) => {
        if (getElementName(child) !== "symbol") {
          targetDefs.appendChild(child.cloneNode(true));
        }
      });
    });

    Array.from(svg.children).forEach((child) => {
      if (getElementName(child) === "style") {
        targetDefs.appendChild(child.cloneNode(true));
      }
    });
  }

  function copyInheritedSpriteAttributes(sourceSvg, targetSvg) {
    INHERITED_SVG_ATTRIBUTES.forEach((name) => {
      if (sourceSvg.hasAttribute(name) && !targetSvg.hasAttribute(name)) {
        targetSvg.setAttribute(name, sourceSvg.getAttribute(name));
      }
    });
  }

  function getInheritedSpriteAttributeText(sourceSvg) {
    return INHERITED_SVG_ATTRIBUTES
      .filter((name) => sourceSvg.hasAttribute(name))
      .map((name) => " " + name + '="' + escapeAttribute(sourceSvg.getAttribute(name)) + '"')
      .join("");
  }

  function getSvgElementMetrics(element, fallbackSize) {
    const viewBox = parseViewBox(element.getAttribute("viewBox"));
    let width = parseSvgLength(element.getAttribute("width"));
    let height = parseSvgLength(element.getAttribute("height"));

    if ((!width || !height) && viewBox) {
      const ratio = viewBox.width / viewBox.height;
      if (!width && !height) {
        width = viewBox.width;
        height = viewBox.height;
      } else if (width && !height) {
        height = width / ratio;
      } else if (!width && height) {
        width = height * ratio;
      }
    }

    width = sanitizeDimension(width, viewBox ? viewBox.width : fallbackSize.width);
    height = sanitizeDimension(height, viewBox ? viewBox.height : fallbackSize.height);

    return {
      width,
      height,
      viewBox: viewBox || { x: 0, y: 0, width, height }
    };
  }

  function getSpriteEntryLabel(element, fallbackPrefix, index) {
    return element.getAttribute("data-name") ||
      element.getAttribute("aria-label") ||
      element.getAttribute("id") ||
      fallbackPrefix + " " + (index + 1);
  }

  function isAnimatedSvg(svg, svgText) {
    return Boolean(svg.querySelector("animate, animateMotion, animateTransform, set")) ||
      /@keyframes|\banimation(?:-[a-z-]+)?\s*:|<script[\s>]/i.test(svgText);
  }

  function parseViewBox(value) {
    if (!value) {
      return null;
    }

    const parts = value.trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)) || parts[2] <= 0 || parts[3] <= 0) {
      return null;
    }

    return {
      x: parts[0],
      y: parts[1],
      width: parts[2],
      height: parts[3]
    };
  }

  function viewBoxToString(viewBox) {
    return [
      formatSvgNumber(viewBox.x || 0),
      formatSvgNumber(viewBox.y || 0),
      formatSvgNumber(viewBox.width),
      formatSvgNumber(viewBox.height)
    ].join(" ");
  }

  function formatSvgNumber(value) {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  }

  function getElementName(element) {
    return String(element.localName || element.nodeName || "").toLowerCase();
  }

  function escapeAttribute(value) {
    return String(value).replace(/[&<>"']/g, (character) => {
      if (character === "&") {
        return "&amp;";
      }
      if (character === "<") {
        return "&lt;";
      }
      if (character === ">") {
        return "&gt;";
      }
      if (character === '"') {
        return "&quot;";
      }
      return "&apos;";
    });
  }

  function parseSvgLength(value) {
    if (!value || String(value).includes("%")) {
      return null;
    }

    const match = String(value).trim().match(/^([+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in)?$/i);
    if (!match) {
      return null;
    }

    const amount = Number(match[1]);
    const unit = (match[2] || "px").toLowerCase();
    const multipliers = {
      px: 1,
      pt: 96 / 72,
      pc: 16,
      mm: 96 / 25.4,
      cm: 96 / 2.54,
      in: 96
    };

    return amount * multipliers[unit];
  }

  function sanitizeDimension(value, fallback) {
    if (!Number.isFinite(value) || value <= 0) {
      return Math.max(1, Math.round(fallback || 1));
    }

    return Math.max(1, Math.round(value));
  }

  function isSvgFile(file) {
    return getExtension(file.name) === "svg" || /svg/i.test(file.type || "");
  }

  function hasFiles(event) {
    return event.dataTransfer && Array.from(event.dataTransfer.types || []).includes("Files");
  }

  // JPEG and BMP have no alpha channel, so skip the pixel scan for them. Every
  // other supported raster format can carry transparency.
  function formatSupportsAlpha(format) {
    const normalized = String(format || "").toUpperCase();
    return normalized !== "JPEG" && normalized !== "BMP";
  }

  function getFormatLabel(file) {
    const extension = getExtension(file.name);
    if (extension === "jpg" || extension === "jpeg" || extension === "jpe") {
      return "JPEG";
    }
    if (extension === "svg") {
      return "SVG";
    }
    if (extension === "ico" || extension === "cur") {
      return "ICO";
    }
    if (extension === "bmp" || extension === "dib") {
      return "BMP";
    }
    if (extension) {
      return extension.toUpperCase();
    }
    return file.type ? file.type.replace("image/", "").toUpperCase() : "IMAGE";
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
  window.ImageViewer.FileLoader = {
    init,
    loadFiles,
    decodeOneFile
  };
}());
