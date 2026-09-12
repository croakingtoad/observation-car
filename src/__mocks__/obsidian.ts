/**
 * Runtime stand-in for the `obsidian` package in tests.
 *
 * The npm package is type-only (`"main": ""` — the Obsidian app
 * provides the real runtime in production), so vitest cannot resolve
 * it; `vitest.config.ts` aliases `obsidian` to this file. Only the
 * surface the tests exercise is implemented — extend it as tests grow.
 */

export class TFile {
  path = "";
  basename = "";
}

export class ItemView {
  app: { vault: unknown };
  leaf: unknown;
  containerEl: HTMLElement;
  contentEl: HTMLElement;

  constructor(leaf: { app: { vault: unknown } }) {
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = document.createElement("div");
    this.contentEl = document.createElement("div");
    this.containerEl.appendChild(this.contentEl);
  }
}

/** Obsidian's FileView is an ItemView that receives `onLoadFile`. */
export class FileView extends ItemView {}
