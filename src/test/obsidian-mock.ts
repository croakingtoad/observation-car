/**
 * Runtime stand-in for the `obsidian` module in unit tests.
 *
 * The npm package is types-only (`main: ""` — the API comes from the
 * Obsidian app at runtime), so Vite cannot resolve the bare import;
 * `vitest.config.ts` aliases it here. Only what the tested code touches
 * is modelled. The real workspace injects the `App` into a view after
 * construction; tests mirror that with `Object.assign(view, { app })`.
 */
export class FileView {
  contentEl: HTMLElement = document.createElement("div");
  app: unknown = null;

  constructor(leaf: unknown) {
    void leaf;
  }
}
