"use strict";

const CACHE_NAME = "image-viewer-static-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",
  "./images/icon-32.png",
  "./images/icon-180.png",
  "./images/icon-192.png",
  "./images/icon-512.png",
  "./images/icon-1240.png",
  "./images/icon-maskable-192.png",
  "./images/icon-maskable-512.png",
  "./images/layers1.svg",
  "./images/layers2.svg",
  "./images/svgIcons.svg",
  "./js/vendor/pako.min.js",
  "./js/vendor/utif.min.js",
  "./js/state.js",
  "./js/settings.js",
  "./js/thumbnail.js",
  "./js/icoAdapter.js",
  "./js/tiffAdapter.js",
  "./js/viewer.js",
  "./js/imageList.js",
  "./js/fileLoader.js",
  "./js/deckFile.js",
  "./js/controls.js",
  "./js/pwa.js",
  "./js/main.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || !isSameOrigin(request)) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "./index.html"));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function networkFirst(request, fallbackUrl) {
  try {
    const response = await fetch(request);
    await cacheResponse(request, response);
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    return cached || caches.match(fallbackUrl);
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    refreshCache(request);
    return cached;
  }

  const response = await fetch(request);
  await cacheResponse(request, response);
  return response;
}

async function refreshCache(request) {
  try {
    const response = await fetch(request);
    await cacheResponse(request, response);
  } catch (error) {
    // Stay on the existing cached app shell while offline.
  }
}

async function cacheResponse(request, response) {
  if (!response || !response.ok || response.type === "opaque") {
    return;
  }
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
}

function isSameOrigin(request) {
  return new URL(request.url).origin === self.location.origin;
}
