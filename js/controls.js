(function () {
  "use strict";

  let clearImagesBtn;
  let downloadDeckBtn;
  let toolbar;
  let fullscreenButton;
  let backdropButton;
  let backdropMode = "black";
  let backdropEnabled = false;
  let variantControl;
  let variantButton;
  let variantValue;
  let variantMenu;
  let variantOptionsKey = "";
  let currentVariantData = null;

  function init() {
    clearImagesBtn = document.getElementById("clearImagesBtn");
    downloadDeckBtn = document.getElementById("downloadDeckBtn");
    toolbar = document.querySelector(".viewer-toolbar");
    fullscreenButton = toolbar.querySelector("[data-action='fullscreen']");
    backdropButton = toolbar.querySelector("[data-action='toggle-backdrop']");
    variantControl = document.getElementById("variantControl");
    variantButton = document.getElementById("variantButton");
    variantValue = document.getElementById("variantValue");
    variantMenu = document.getElementById("variantMenu");

    clearImagesBtn.addEventListener("click", window.ImageViewer.State.clearImages);
    toolbar.addEventListener("click", handleToolbarClick);
    variantButton.addEventListener("click", toggleVariantMenu);
    variantButton.addEventListener("keydown", handleVariantButtonKeyDown);
    variantMenu.addEventListener("click", handleVariantMenuClick);
    variantMenu.addEventListener("keydown", handleVariantMenuKeyDown);
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("fullscreenchange", updateFullscreenButton);

    if (window.ImageViewer.Settings) {
      window.ImageViewer.Settings.subscribe(handleSettingsChange);
    }
  }

  function handleSettingsChange(nextSettings) {
    backdropMode = nextSettings.transparencyBackdrop === "white" ? "white" : "black";
    updateBackdropButton();
  }

  function render(snapshot) {
    const hasImages = snapshot.images.length > 0;
    const hasMultiple = snapshot.images.length > 1;
    const fullscreenActive = window.ImageViewer.Viewer.isFullscreen();
    const activeImage = snapshot.images.find((image) => image.id === snapshot.activeId) || null;
    clearImagesBtn.disabled = !hasImages;
    downloadDeckBtn.disabled = !hasImages;

    renderVariantControl(activeImage);
    setButtonDisabled("previous", !hasMultiple);
    setButtonDisabled("next", !hasMultiple);
    setButtonDisabled("zoom-out", !hasImages);
    setButtonDisabled("zoom-in", !hasImages);
    setButtonDisabled("fit", !hasImages);
    setButtonDisabled("actual-size", !hasImages);
    setButtonDisabled("fullscreen", (!hasImages && !fullscreenActive) || !window.ImageViewer.Viewer.canFullscreen());
    updateFullscreenButton();

    backdropEnabled = Boolean(activeImage && activeImage.hasTransparency);
    updateBackdropButton();
  }

  function handleToolbarClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) {
      return;
    }

    runAction(button.dataset.action);
  }

  function handleKeyDown(event) {
    const tagName = (event.target && event.target.tagName || "").toLowerCase();
    if (
      tagName === "input" ||
      tagName === "select" ||
      tagName === "textarea" ||
      event.target.isContentEditable ||
      (event.target.closest && event.target.closest(".variant-control"))
    ) {
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      window.ImageViewer.State.nextImage();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      window.ImageViewer.State.previousImage();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      window.ImageViewer.Viewer.zoomBy(1.12);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      window.ImageViewer.Viewer.zoomBy(1 / 1.12);
    }
  }

  function runAction(action) {
    if (action === "previous") {
      window.ImageViewer.State.previousImage();
    } else if (action === "next") {
      window.ImageViewer.State.nextImage();
    } else if (action === "zoom-out") {
      window.ImageViewer.Viewer.zoomBy(1 / 1.12);
    } else if (action === "zoom-in") {
      window.ImageViewer.Viewer.zoomBy(1.12);
    } else if (action === "fit") {
      window.ImageViewer.Viewer.fitToImage();
    } else if (action === "actual-size") {
      window.ImageViewer.Viewer.actualSize();
    } else if (action === "fullscreen") {
      window.ImageViewer.Viewer.toggleFullscreen();
    } else if (action === "toggle-backdrop") {
      toggleBackdrop();
    }
  }

  function toggleBackdrop() {
    if (!window.ImageViewer.Settings) {
      return;
    }
    window.ImageViewer.Settings.setSetting(
      "transparencyBackdrop",
      backdropMode === "white" ? "black" : "white"
    );
  }

  // Reflects both the current backdrop color (from Settings) and whether the
  // active image actually has transparent pixels (from State). The button is
  // greyed out when there is nothing for the backdrop to show through.
  function updateBackdropButton() {
    if (!backdropButton) {
      return;
    }

    backdropButton.disabled = !backdropEnabled;

    const isWhite = backdropMode === "white";
    backdropButton.setAttribute("aria-pressed", isWhite ? "true" : "false");

    if (!backdropEnabled) {
      backdropButton.setAttribute("aria-label", "Transparency backdrop");
      backdropButton.title = "No transparent pixels in this image";
      return;
    }

    const current = isWhite ? "white" : "black";
    const next = isWhite ? "black" : "white";
    backdropButton.setAttribute("aria-label", "Transparency backdrop: " + current);
    backdropButton.title = "Transparency backdrop: " + current + ". Click for " + next + ".";
  }

  function renderVariantControl(activeImage) {
    const variantData = getVariantData(activeImage);
    currentVariantData = variantData;
    variantControl.hidden = !variantData;

    if (!variantData) {
      variantOptionsKey = "";
      variantValue.textContent = "";
      variantMenu.replaceChildren();
      closeVariantMenu();
      return;
    }

    if (variantData.optionsKey !== variantOptionsKey) {
      variantMenu.textContent = "";
      variantData.entries.forEach((entry) => {
        const option = document.createElement("li");
        option.className = "variant-option";
        option.id = getVariantOptionId(entry.id);
        option.dataset.entryId = entry.id;
        option.setAttribute("role", "option");
        option.tabIndex = -1;
        option.innerHTML = '<span class="variant-option-mark" aria-hidden="true"></span><span class="variant-option-label"></span>';
        option.querySelector(".variant-option-label").textContent = entry.label;
        variantMenu.appendChild(option);
      });
      variantOptionsKey = variantData.optionsKey;
    }

    updateVariantSelection(variantData);
    variantButton.disabled = variantData.entries.length < 2;
    variantControl.classList.toggle("is-disabled", variantData.entries.length < 2);
    variantButton.setAttribute("aria-label", variantData.ariaLabel);
    variantButton.title = variantData.title;
    variantMenu.setAttribute("aria-label", variantData.title);
  }

  function getVariantData(image) {
    if (!image) {
      return null;
    }

    if (Array.isArray(image.icoFrames) && image.icoFrames.length) {
      return {
        kind: "ico",
        entries: image.icoFrames,
        selectedId: image.icoSelectedFrameId || "",
        optionsKey: image.id + "|ico|" + image.icoFrames.map(getEntryKey).join(","),
        title: "ICO size",
        ariaLabel: "ICO size for " + image.displayName
      };
    }

    if (Array.isArray(image.svgSpriteEntries) && image.svgSpriteEntries.length) {
      return {
        kind: "svg-sprite",
        entries: image.svgSpriteEntries,
        selectedId: image.svgSelectedSpriteEntryId || "",
        optionsKey: image.id + "|svg-sprite|" + image.svgSpriteEntries.map(getEntryKey).join(","),
        title: "SVG sprite",
        ariaLabel: "SVG sprite item for " + image.displayName
      };
    }

    return null;
  }

  function getEntryKey(entry) {
    return entry.id + ":" + entry.label;
  }

  function updateVariantSelection(variantData) {
    const selectedEntry = variantData.entries.find((entry) => entry.id === variantData.selectedId) || variantData.entries[0];

    variantValue.textContent = selectedEntry ? selectedEntry.label : "";

    Array.from(variantMenu.children).forEach((option) => {
      const selected = option.dataset.entryId === variantData.selectedId;
      option.setAttribute("aria-selected", selected ? "true" : "false");
      option.classList.toggle("is-selected", selected);
    });
  }

  function selectVariant(entryId) {
    const activeImage = window.ImageViewer.State.getActive();
    if (!activeImage || !currentVariantData || !entryId) {
      return;
    }

    if (currentVariantData.kind === "ico") {
      window.ImageViewer.State.selectIcoFrame(activeImage.id, entryId);
    } else if (currentVariantData.kind === "svg-sprite") {
      window.ImageViewer.State.selectSvgSpriteEntry(activeImage.id, entryId);
    }
  }

  function toggleVariantMenu() {
    if (variantButton.disabled) {
      return;
    }

    if (isVariantMenuOpen()) {
      closeVariantMenu();
    } else {
      openVariantMenu();
    }
  }

  function openVariantMenu() {
    variantControl.classList.add("is-open");
    variantButton.setAttribute("aria-expanded", "true");
    variantMenu.hidden = false;

    requestAnimationFrame(() => {
      const selectedOption = getSelectedVariantOption() || variantMenu.querySelector(".variant-option");
      if (selectedOption) {
        selectedOption.focus();
      }
    });
  }

  function closeVariantMenu(restoreFocus) {
    variantControl.classList.remove("is-open");
    variantButton.setAttribute("aria-expanded", "false");
    variantMenu.hidden = true;

    if (restoreFocus) {
      variantButton.focus();
    }
  }

  function handleVariantButtonKeyDown(event) {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!isVariantMenuOpen()) {
        openVariantMenu();
      }
    }
  }

  function handleVariantMenuClick(event) {
    const option = event.target.closest(".variant-option");
    if (!option) {
      return;
    }

    selectVariant(option.dataset.entryId);
    closeVariantMenu(true);
  }

  function handleVariantMenuKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeVariantMenu(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusVariantOption(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusVariantOption(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusVariantEdgeOption("first");
    } else if (event.key === "End") {
      event.preventDefault();
      focusVariantEdgeOption("last");
    } else if (event.key === "Enter" || event.key === " ") {
      const option = event.target.closest(".variant-option");
      if (!option) {
        return;
      }
      event.preventDefault();
      selectVariant(option.dataset.entryId);
      closeVariantMenu(true);
    }
  }

  function handleDocumentPointerDown(event) {
    if (!isVariantMenuOpen() || variantControl.contains(event.target)) {
      return;
    }

    closeVariantMenu();
  }

  function focusVariantOption(direction) {
    const options = getVariantOptions();
    if (!options.length) {
      return;
    }

    const currentIndex = Math.max(0, options.indexOf(document.activeElement));
    const nextIndex = (currentIndex + direction + options.length) % options.length;
    options[nextIndex].focus();
  }

  function focusVariantEdgeOption(edge) {
    const options = getVariantOptions();
    const option = edge === "last" ? options[options.length - 1] : options[0];
    if (option) {
      option.focus();
    }
  }

  function getVariantOptions() {
    return Array.from(variantMenu.querySelectorAll(".variant-option"));
  }

  function getSelectedVariantOption() {
    return variantMenu.querySelector(".variant-option.is-selected");
  }

  function isVariantMenuOpen() {
    return !variantMenu.hidden;
  }

  function getVariantOptionId(entryId) {
    return "variant-option-" + entryId;
  }

  function setButtonDisabled(action, disabled) {
    const button = toolbar.querySelector("[data-action='" + action + "']");
    if (button) {
      button.disabled = disabled;
    }
  }

  function updateFullscreenButton() {
    if (!fullscreenButton) {
      return;
    }

    const fullscreenActive = window.ImageViewer.Viewer.isFullscreen();
    const label = fullscreenActive ? "Exit full screen" : "Enter full screen";
    const icon = fullscreenButton.querySelector("use");

    fullscreenButton.setAttribute("aria-pressed", fullscreenActive ? "true" : "false");
    fullscreenButton.setAttribute("aria-label", label);
    fullscreenButton.title = label;
    if (icon) {
      icon.setAttribute("href", fullscreenActive ? "#fullscreen-exit" : "#fullscreen");
    }
  }

  window.ImageViewer = window.ImageViewer || {};
  window.ImageViewer.Controls = {
    init,
    render
  };
}());
