/**
 * Runtime stand-in for the `obsidian` module in unit tests.
 *
 * The npm package is types-only (`main: ""` — the API comes from the
 * Obsidian app at runtime), so Vite cannot resolve the bare import;
 * `vitest.config.ts` aliases it here. Only what the tested code touches
 * is modelled. The real workspace injects the `App` into a view after
 * construction; tests mirror that with `Object.assign(view, { app })`.
 */
export class TFile {
  path = "";
  basename = "";
}

export class ItemView {
  app: unknown;
  leaf: unknown;
  containerEl: HTMLElement = document.createElement("div");
  contentEl: HTMLElement = document.createElement("div");

  constructor(leaf: unknown) {
    this.leaf = leaf;
    this.app =
      typeof leaf === "object" && leaf !== null && "app" in leaf
        ? leaf.app
        : null;
    this.containerEl.appendChild(this.contentEl);
  }
}

/**
 * Obsidian assigns `FileView.file` before delegating to `onLoadFile`.
 * `EpubView.onLoadFile` relies on that contract at EpubView.ts:126-128.
 */
export class FileView extends ItemView {
  file: TFile | null = null;

  async loadFile(file: TFile): Promise<void> {
    this.file = file;
    await this.onLoadFile(file);
  }

  async onLoadFile(_file: TFile): Promise<void> {}
}

export class Notice {
  constructor(message: string, timeout?: number) {
    void message;
    void timeout;
  }
}
