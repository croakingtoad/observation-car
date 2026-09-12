/**
 * F2.1 open-path measurement (PRD §7: reader open <= 1.5 s for a
 * typical 2-5 MB EPUB on desktop).
 *
 * Measures the same code path the view runs, as far as a headless Node
 * process can get:
 *
 *   bytes -> ePub(bytes) -> book.ready (ZIP + container/manifest/spine
 *   parse, resource URL replacement) -> spine.get() ->
 *   section.render(request) (chapter HTML: unzip, parse, asset-URL
 *   rewriting — the internal work of the first rendition.display()).
 *
 * Fidelity notes:
 * - epub.js serves archived assets through blob: URLs in a browser;
 *   jsdom cannot fetch them, so the blob URL pair is stubbed with an
 *   in-memory store. Asset fetches only happen at display time (outside
 *   the measured path); the chapter itself is read via `book.load`,
 *   exactly like the Manager does.
 * - The DOM is jsdom and it has no iframe subframes or layout engine:
 *   the view's final step (injection into the iframe, layout, fonts,
 *   the "rendered" event) cannot run headless, so the total is a FLOOR
 *   on the in-app open time. The in-app figure itself requires the
 *   Obsidian GUI and is reported separately as unverified where not
 *   measured.
 *
 * Usage: node scripts/measure-epub-open.mjs /path/to/book.epub
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const [path] = process.argv.slice(2);
if (path === undefined) {
  console.error("usage: node scripts/measure-epub-open.mjs /path/to/book.epub");
  process.exit(2);
}

// pretendToBeVisual: epub.js captures window.requestAnimationFrame at
// import time; jsdom only provides it in visual mode.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
});

// In-memory stand-in for the browser blob store (see fidelity notes).
const blobStore = new Map();
let blobCounter = 0;
dom.window.URL.createObjectURL = (blob) => {
  const url = `blob:jsdom-${++blobCounter}`;
  blobStore.set(url, blob);
  return url;
};
dom.window.URL.revokeObjectURL = () => {};

for (const [name, value] of [
  ["window", dom.window],
  ["document", dom.window.document],
  ["navigator", dom.window.navigator],
  ["location", dom.window.location],
  ["HTMLElement", dom.window.HTMLElement],
  ["MutationObserver", dom.window.MutationObserver],
  ["XMLHttpRequest", dom.window.XMLHttpRequest],
  ["XMLSerializer", dom.window.XMLSerializer],
  ["DOMParser", dom.window.DOMParser],
]) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const epubModule = await import("epubjs");
// The 0.3.x CJS build is Babel-shaped: the factory is
// module.exports.default (mirrors what esbuild resolves in the bundle).
const ePub = epubModule.default?.default ?? epubModule.default;
const fileBytes = readFileSync(path);
// readFileSync returns a Buffer (a view over a pooled ArrayBuffer);
// epub.js branches on `instanceof ArrayBuffer`, as does Obsidian's
// `vault.readBinary`, so hand it a standalone ArrayBuffer.
const bytes = fileBytes.buffer.slice(
  fileBytes.byteOffset,
  fileBytes.byteOffset + fileBytes.byteLength,
);
const sizeMb = bytes.byteLength / (1024 * 1024);

const t0 = performance.now();
const book = ePub(bytes);
await book.ready;
const tReady = performance.now();

// The first `rendition.display()` runs (internally, via the Manager)
// `book.spine.get(target)` and then `section.render(request)` to produce
// the chapter HTML, before any browser work. The Manager's request is
// `book.load` (rendition.js:248), which for an archived book reads the
// chapter straight out of the ZIP and parses it with the bundled xmldom
// parser — the same path the in-app view takes, so it needs no DOM.
// jsdom has no iframe subframes, so the final injection + layout +
// "rendered" event cannot run headless; measure up to and including the
// section render, which is where epub.js's work ends.
const section = book.spine.get();
await section.render(book.load.bind(book));
const tSection = performance.now();

const title = (await book.loaded.metadata).title;
console.log(JSON.stringify({
  book: path,
  title,
  sizeMB: Number(sizeMb.toFixed(2)),
  parseToReadyMs: Number((tReady - t0).toFixed(0)),
  firstSectionRenderMs: Number((tSection - tReady).toFixed(0)),
  totalMs: Number((tSection - t0).toFixed(0)),
  caveat:
    "measured through chapter-HTML render (epub.js's last step); the " +
    "iframe injection, layout, fonts and the 'rendered' event are not " +
    "measurable under jsdom (no subframes) — in-app open time is " +
    "unverified pending GUI, and totalMs is a floor on it",
}, null, 2));
process.exit(0);
