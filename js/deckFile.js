(function () {
  "use strict";

  // A ".deck" is a single-file, lossless container for an entire image deck:
  // every loaded image's ORIGINAL bytes (no re-encode), plus their order and
  // labels. Layout (all integers little-endian):
  //
  //   bytes 0..3      magic "DECK"
  //   bytes 4..7      uint32 format version
  //   bytes 8..11     uint32 header length H (UTF-8 JSON byte count)
  //   bytes 12..12+H  JSON header (see buildDeckBlob/parseDeckHeader)
  //   bytes 12+H..    payload = concatenated raw source-file bytes (store mode)
  //
  // Sources are de-duplicated (a multi-page TIFF is stored once); the JSON
  // "images" list records the display order, labels, and which source/page each
  // image came from. Import reconstructs a File per source and re-feeds it
  // through the normal decode pipeline, so nothing about rendering changes.

  const MAGIC_BYTES = [0x44, 0x45, 0x43, 0x4B]; // "DECK"
  const FORMAT_VERSION = 1;
  const HEADER_OFFSET = 12; // magic(4) + version(4) + headerLength(4)
  const DECK_FORMAT_ID = "image-viewer-deck";

  // --- Export -------------------------------------------------------------

  async function download(images) {
    if (!images || !images.length) {
      return;
    }

    window.ImageViewer.State.setMessage("Preparing deck...");
    try {
      const blob = await buildDeckBlob(images);
      const suggestedName = defaultDeckName(images[0]);
      const saved = await saveBlob(blob, suggestedName);
      window.ImageViewer.State.setMessage(saved
        ? "Deck saved (" + images.length + " image" + (images.length === 1 ? "" : "s") + ")"
        : "Deck download canceled");
    } catch (error) {
      window.ImageViewer.State.setMessage("Couldn't create deck file");
    }
  }

  async function buildDeckBlob(images) {
    const sources = [];
    const sourceIndexByFile = new Map();
    const imageEntries = [];

    for (const image of images) {
      const sourceKey = image.sourceFile;
      let sourceIndex = sourceKey ? sourceIndexByFile.get(sourceKey) : undefined;

      if (sourceIndex === undefined) {
        sourceIndex = sources.length;
        sources.push({
          fileName: image.fileName || "image",
          mimeType: (sourceKey && sourceKey.type) || image.mimeType || "",
          blob: await resolveSourceBlob(image)
        });
        if (sourceKey) {
          sourceIndexByFile.set(sourceKey, sourceIndex);
        }
      }

      const entry = {
        sourceIndex,
        pageNumber: image.pageNumber || null,
        displayName: image.displayName || image.fileName || "",
        fileName: image.fileName || ""
      };
      // Capture which variant was being viewed so import can restore it.
      if (image.icoSelectedFrameId) {
        entry.icoSelectedFrameId = image.icoSelectedFrameId;
      }
      if (image.svgSelectedSpriteEntryId) {
        entry.svgSelectedSpriteEntryId = image.svgSelectedSpriteEntryId;
      }
      imageEntries.push(entry);
    }

    // Offsets/lengths are known only after every source blob is resolved.
    let offset = 0;
    const sourceManifest = sources.map((source) => {
      const record = {
        fileName: source.fileName,
        mimeType: source.mimeType,
        offset,
        length: source.blob.size
      };
      offset += source.blob.size;
      return record;
    });

    const header = {
      format: DECK_FORMAT_ID,
      version: FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      sources: sourceManifest,
      images: imageEntries
    };

    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const prefix = new Uint8Array(HEADER_OFFSET);
    const view = new DataView(prefix.buffer);
    view.setUint8(0, MAGIC_BYTES[0]);
    view.setUint8(1, MAGIC_BYTES[1]);
    view.setUint8(2, MAGIC_BYTES[2]);
    view.setUint8(3, MAGIC_BYTES[3]);
    view.setUint32(4, FORMAT_VERSION, true);
    view.setUint32(8, headerBytes.length, true);

    const parts = [prefix, headerBytes];
    sources.forEach((source) => parts.push(source.blob));
    return new Blob(parts, { type: "application/octet-stream" });
  }

  // Every producer attaches the original File as `sourceFile`, which is the
  // lossless source of truth. The objectUrl fallback is defensive only (it
  // recovers native bytes if a future code path forgets sourceFile; TIFF has no
  // objectUrl, so it relies on sourceFile).
  async function resolveSourceBlob(image) {
    if (image.sourceFile) {
      return image.sourceFile;
    }
    if (image.objectUrl) {
      const response = await fetch(image.objectUrl);
      return await response.blob();
    }
    throw new Error("Missing original bytes for \"" + (image.fileName || "image") + "\".");
  }

  function defaultDeckName(image) {
    const raw = (image && (image.displayName || image.fileName)) || "deck";
    const withoutExtension = raw.replace(/\.[A-Za-z0-9]{1,5}$/, "");
    const sanitized = withoutExtension.replace(/[\\/:*?"<>|]+/g, "").trim();
    return (sanitized || "deck") + ".deck";
  }

  // Prefer the native Save As dialog (prefilled, highlighted name, locked
  // extension) where available; otherwise fall back to a normal download.
  // Returns true if a file was written/started, false if the user canceled.
  async function saveBlob(blob, suggestedName) {
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{
            description: "Image Deck",
            accept: { "application/octet-stream": [".deck"] }
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
      } catch (error) {
        if (error && error.name === "AbortError") {
          return false; // user canceled — do not also trigger an auto-download
        }
        // API present but unusable here (e.g. file://) — fall through.
      }
    }

    downloadViaAnchor(blob, suggestedName);
    return true;
  }

  function downloadViaAnchor(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoke once the download has surely started.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // --- Import -------------------------------------------------------------

  // Parse a .deck file and rebuild its images through the normal pipeline.
  // Returns { images, selections }; the caller decides when to clear/add so a
  // corrupt deck (which throws here) never wipes the current images. Pure: no
  // state mutation.
  async function readDeck(file) {
    const buffer = await file.arrayBuffer();
    const parsed = parseDeckHeader(buffer);
    const json = parsed.json;
    const bytes = new Uint8Array(buffer);
    const payloadStart = HEADER_OFFSET + parsed.headerLength;

    // Decode each stored source once, grouped by its index.
    const producedBySource = [];
    for (let i = 0; i < json.sources.length; i += 1) {
      const source = json.sources[i];
      const start = payloadStart + source.offset;
      const slice = bytes.subarray(start, start + source.length);
      const sourceFile = new File([slice], source.fileName || "image", {
        type: source.mimeType || ""
      });
      try {
        producedBySource[i] = await window.ImageViewer.FileLoader.decodeOneFile(sourceFile);
      } catch (error) {
        producedBySource[i] = [];
      }
    }

    const images = [];
    const selections = [];
    json.images.forEach((entry) => {
      const produced = producedBySource[entry.sourceIndex] || [];
      const image = pickProducedImage(produced, entry);
      if (!image) {
        return; // source failed to decode, or the page is missing
      }
      if (entry.displayName) {
        image.displayName = entry.displayName;
      }
      images.push(image);

      if (entry.icoSelectedFrameId || entry.svgSelectedSpriteEntryId) {
        selections.push({
          id: image.id,
          ico: entry.icoSelectedFrameId || null,
          svg: entry.svgSelectedSpriteEntryId || null
        });
      }
    });

    return { images, selections };
  }

  function pickProducedImage(produced, entry) {
    if (!produced.length) {
      return null;
    }
    if (produced.length === 1) {
      return produced[0];
    }
    // Several images from one source means TIFF pages; match by page number.
    if (entry.pageNumber) {
      const match = produced.find((image) => image.pageNumber === entry.pageNumber);
      if (match) {
        return match;
      }
    }
    return produced[0];
  }

  function parseDeckHeader(buffer) {
    if (buffer.byteLength < HEADER_OFFSET) {
      throw new Error("File is too small to be a deck.");
    }

    const view = new DataView(buffer);
    for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
      if (view.getUint8(i) !== MAGIC_BYTES[i]) {
        throw new Error("Not a deck file.");
      }
    }

    const version = view.getUint32(4, true);
    if (version !== FORMAT_VERSION) {
      throw new Error("Unsupported deck version: " + version);
    }

    const headerLength = view.getUint32(8, true);
    if (HEADER_OFFSET + headerLength > buffer.byteLength) {
      throw new Error("Deck header is truncated.");
    }

    const headerBytes = new Uint8Array(buffer, HEADER_OFFSET, headerLength);
    const json = JSON.parse(new TextDecoder().decode(headerBytes));
    if (!json || json.format !== DECK_FORMAT_ID || !Array.isArray(json.sources) || !Array.isArray(json.images)) {
      throw new Error("Deck header is invalid.");
    }

    return { json, headerLength };
  }

  window.ImageViewer = window.ImageViewer || {};
  window.ImageViewer.DeckFile = {
    download,
    readDeck
  };
}());
