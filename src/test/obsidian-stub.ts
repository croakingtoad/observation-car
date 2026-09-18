/**
 * Test-time resolution target for the `obsidian` module, which ships no
 * runtime code in the npm package (the app provides the real module; the
 * production bundle externalizes it and never includes this file). Vite
 * cannot resolve the bare `obsidian` specifier without an entry point, so
 * the vitest config aliases it here.
 *
 * Anything performing I/O or reaching the host app — `requestUrl`, vault
 * or adapter reads, network — throws loudly: tests must inject their own
 * fakes (e.g. `OpdsClient`'s `transport` option) instead of relying on
 * stub behavior. Only inert structural stand-ins may answer: classes the
 * code constructs or extends, carrying no behaviour of their own. This
 * keeps loud-failure intent load-bearing while letting E004's views
 * instantiate.
 */

function notAvailable(member: string): never {
  throw new Error(
    `obsidian.${member} is not available in tests; inject a fake instead.`,
  );
}

export function requestUrl(_options: unknown): never {
  throw notAvailable("requestUrl");
}

export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\//, "")
    .replace(/\/$/, "");
}

export class TFolder {
  constructor(readonly path: string) {}
}

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
  navigation = false;

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
  static readonly messages: string[] = [];
  readonly message: string;

  constructor(message: string, timeout?: number) {
    this.message = message;
    Notice.messages.push(message);
    void timeout;
  }
}
