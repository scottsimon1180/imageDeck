(function () {
  "use strict";

  const STORAGE_KEY = "imageViewer.settings.v1";
  const DEFAULT_SETTINGS = {
    themeMode: "light",
    toolbarPosition: "bottom",
    fullscreenToolbarPosition: "bottom-center",
    fullscreenShowImageName: true,
    transparencyBackdrop: "black",
    loopImages: false,
    titlebarCollapsed: true
  };
  const VALID_VALUES = {
    themeMode: new Set(["light", "dark", "auto"]),
    toolbarPosition: new Set(["top", "bottom"]),
    fullscreenToolbarPosition: new Set([
      "top-left",
      "top-center",
      "top-right",
      "left",
      "bottom-left",
      "bottom-center",
      "bottom-right"
    ]),
    transparencyBackdrop: new Set(["black", "white"])
  };
  const THEME_COLORS = {
    light: "#fbfbfd",
    dark: "#1a1a1e"
  };

  let settings = loadSettings();
  let settingsButton;
  let settingsPopover;
  let settingsCloseButton;
  let themeColorMeta;
  let colorSchemeQuery;
  let previousFocus = null;
  const listeners = new Set();

  function init() {
    settingsButton = document.getElementById("settingsButton");
    settingsPopover = document.getElementById("settingsPopover");
    settingsCloseButton = document.getElementById("settingsCloseButton");
    themeColorMeta = document.getElementById("themeColorMeta") || document.querySelector("meta[name='theme-color']");
    colorSchemeQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

    applyDocumentSettings();
    bindColorSchemeListener();

    if (!settingsButton || !settingsPopover || !settingsCloseButton) {
      return;
    }

    syncControls();
    settingsButton.addEventListener("click", toggleSettings);
    settingsCloseButton.addEventListener("click", closeSettings);
    settingsPopover.addEventListener("change", handleControlChange);
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(getSettings());
    return function unsubscribe() {
      listeners.delete(listener);
    };
  }

  function getSettings() {
    return Object.assign({}, settings);
  }

  function setSetting(name, value) {
    if (!isValidSetting(name, value)) {
      return;
    }

    if (settings[name] === value) {
      return;
    }

    settings = Object.assign({}, settings, {
      [name]: value
    });
    saveSettings();
    applyDocumentSettings();
    syncControls();
    notify();
  }

  function toggleSettings() {
    if (!settingsPopover.hidden) {
      closeSettings();
      return;
    }

    openSettings();
  }

  function openSettings() {
    previousFocus = document.activeElement;
    settingsPopover.hidden = false;
    settingsButton.setAttribute("aria-expanded", "true");
    settingsPopover.focus({ preventScroll: true });
  }

  function closeSettings() {
    if (settingsPopover.hidden) {
      return;
    }

    settingsPopover.hidden = true;
    settingsButton.setAttribute("aria-expanded", "false");

    if (previousFocus && typeof previousFocus.focus === "function") {
      previousFocus.focus({ preventScroll: true });
    }
    previousFocus = null;
  }

  function handleControlChange(event) {
    const control = event.target.closest("[data-setting]");
    if (!control) {
      return;
    }

    if (control.type === "radio" && !control.checked) {
      return;
    }

    setSetting(
      control.dataset.setting,
      control.type === "checkbox" ? control.checked : control.value
    );
  }

  function handleDocumentPointerDown(event) {
    if (
      !settingsPopover ||
      settingsPopover.hidden ||
      settingsPopover.contains(event.target) ||
      settingsButton.contains(event.target)
    ) {
      return;
    }

    closeSettings();
  }

  function handleDocumentKeyDown(event) {
    if (event.key === "Escape" && settingsPopover && !settingsPopover.hidden) {
      event.preventDefault();
      closeSettings();
    }
  }

  function syncControls() {
    if (!settingsPopover) {
      return;
    }

    settingsPopover.querySelectorAll("[data-setting]").forEach((control) => {
      const name = control.dataset.setting;
      if (control.type === "checkbox") {
        control.checked = Boolean(settings[name]);
      } else {
        control.checked = control.value === settings[name];
      }
    });
  }

  function notify() {
    const snapshot = getSettings();
    listeners.forEach((listener) => listener(snapshot));
  }

  function applyDocumentSettings() {
    document.documentElement.dataset.themeMode = settings.themeMode;
    applyThemeColor();
  }

  function bindColorSchemeListener() {
    if (!colorSchemeQuery) {
      return;
    }

    if (typeof colorSchemeQuery.addEventListener === "function") {
      colorSchemeQuery.addEventListener("change", applyThemeColor);
    } else if (typeof colorSchemeQuery.addListener === "function") {
      colorSchemeQuery.addListener(applyThemeColor);
    }
  }

  function applyThemeColor() {
    if (!themeColorMeta) {
      return;
    }

    themeColorMeta.setAttribute("content", THEME_COLORS[getResolvedThemeMode()]);
  }

  function getResolvedThemeMode() {
    if (settings.themeMode === "dark") {
      return "dark";
    }
    if (settings.themeMode === "auto" && colorSchemeQuery && colorSchemeQuery.matches) {
      return "dark";
    }
    return "light";
  }

  function loadSettings() {
    try {
      const rawSettings = window.localStorage.getItem(STORAGE_KEY);
      if (!rawSettings) {
        return Object.assign({}, DEFAULT_SETTINGS);
      }

      return normalizeSettings(JSON.parse(rawSettings));
    } catch (error) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function saveSettings() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      // Settings remain usable for the current session if storage is unavailable.
    }
  }

  function normalizeSettings(rawSettings) {
    const nextSettings = Object.assign({}, DEFAULT_SETTINGS, rawSettings || {});

    if (!VALID_VALUES.themeMode.has(nextSettings.themeMode)) {
      nextSettings.themeMode = DEFAULT_SETTINGS.themeMode;
    }
    if (!VALID_VALUES.toolbarPosition.has(nextSettings.toolbarPosition)) {
      nextSettings.toolbarPosition = DEFAULT_SETTINGS.toolbarPosition;
    }
    if (!VALID_VALUES.fullscreenToolbarPosition.has(nextSettings.fullscreenToolbarPosition)) {
      nextSettings.fullscreenToolbarPosition = DEFAULT_SETTINGS.fullscreenToolbarPosition;
    }
    if (!VALID_VALUES.transparencyBackdrop.has(nextSettings.transparencyBackdrop)) {
      nextSettings.transparencyBackdrop = DEFAULT_SETTINGS.transparencyBackdrop;
    }
    nextSettings.fullscreenShowImageName = nextSettings.fullscreenShowImageName !== false;
    nextSettings.loopImages = nextSettings.loopImages === true;
    nextSettings.titlebarCollapsed = nextSettings.titlebarCollapsed !== false;

    return nextSettings;
  }

  function isValidSetting(name, value) {
    if (name === "fullscreenShowImageName" || name === "loopImages" || name === "titlebarCollapsed") {
      return typeof value === "boolean";
    }

    return Boolean(VALID_VALUES[name] && VALID_VALUES[name].has(value));
  }

  window.ImageViewer = window.ImageViewer || {};
  window.ImageViewer.Settings = {
    init,
    subscribe,
    getSettings,
    setSetting
  };
}());
