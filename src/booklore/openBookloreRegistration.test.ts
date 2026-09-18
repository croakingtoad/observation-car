// @vitest-environment jsdom
import type { Command, Plugin } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";

const runtime = vi.hoisted(() => ({
  downloader: { download: vi.fn() } as object | undefined,
  modalOpen: vi.fn(),
  notices: [] as string[],
  runOnOpen: false,
  lastContentEl: undefined as HTMLElement | undefined,
  closeModal: undefined as (() => void) | undefined,
  openPromise: undefined as Promise<void> | undefined,
}));

vi.mock("obsidian", () => ({
  Modal: class {
    contentEl!: HTMLElement & { empty(): void; setText(value: string): void };

    constructor(_app: unknown) {}

    setTitle(_title: string): void {}

    open(): void {
      const contentEl = document.createElement("div") as typeof this.contentEl;
      contentEl.empty = () => contentEl.replaceChildren();
      contentEl.setText = (value: string) => { contentEl.textContent = value; };
      this.contentEl = contentEl;
      runtime.lastContentEl = contentEl;
      runtime.closeModal = () => this.close();
      runtime.modalOpen();
      if (runtime.runOnOpen) runtime.openPromise = this.onOpen();
    }

    close(): void { this.onClose(); }

    onOpen(): Promise<void> { return Promise.resolve(); }

    onClose(): void {}
  },
  Notice: class {
    constructor(message: string) { runtime.notices.push(message); }
  },
}));

vi.mock("./bookDownloadRegistration", () => ({
  getBookloreDownloader: vi.fn(() => runtime.downloader),
}));

import { registerOpenFromBooklore } from "./openBookloreRegistration";

describe("registerOpenFromBooklore", () => {
  beforeEach(() => {
    runtime.downloader = { download: vi.fn() };
    runtime.modalOpen.mockClear();
    runtime.notices.length = 0;
    runtime.runOnOpen = false;
    runtime.lastContentEl = undefined;
    runtime.closeModal = undefined;
    runtime.openPromise = undefined;
  });

  afterEach(() => {
    vi.doUnmock("./openBookloreModal");
    vi.resetModules();
  });

  it("registers matching command and touch-reachable ribbon actions", () => {
    let command: Command | undefined;
    let ribbonAction: (() => void) | undefined;
    const ribbon = document.createElement("button");
    Object.assign(ribbon, { addClass: (name: string) => ribbon.classList.add(name) });
    const host = {
      app: {},
      settings: { ...DEFAULT_SETTINGS },
      addCommand(value: Command): Command { command = value; return value; },
      addRibbonIcon: vi.fn((_icon, _title, callback: () => void) => {
        ribbonAction = callback;
        return ribbon;
      }),
    } as unknown as Plugin & { settings: typeof DEFAULT_SETTINGS };

    registerOpenFromBooklore(host);

    expect(command).toMatchObject({
      id: "open-from-booklore",
      name: "Open from Booklore",
      icon: "book-open",
    });
    expect(host.addRibbonIcon).toHaveBeenCalledWith(
      "book-open",
      "Open from Booklore",
      expect.any(Function),
    );
    expect(ribbon.getAttribute("aria-label")).toBe("Open from Booklore");
    command?.callback?.();
    ribbonAction?.();
    expect(runtime.modalOpen).toHaveBeenCalledTimes(2);
  });

  it("reports when the downloader is not ready instead of opening a broken modal", () => {
    runtime.downloader = undefined;
    let command: Command | undefined;
    const ribbon = document.createElement("button");
    Object.assign(ribbon, { addClass: vi.fn() });
    const host = {
      app: {},
      settings: { ...DEFAULT_SETTINGS },
      addCommand(value: Command): Command { command = value; return value; },
      addRibbonIcon: vi.fn(() => ribbon),
    } as unknown as Plugin & { settings: typeof DEFAULT_SETTINGS };

    registerOpenFromBooklore(host);
    command?.callback?.();

    expect(runtime.notices).toEqual(["Booklore downloads are not ready yet."]);
    expect(runtime.modalOpen).not.toHaveBeenCalled();
  });

  it("shows a readable error when the lazy modal load rejects", async () => {
    vi.doMock("./openBookloreModal", () => {
      throw new Error("lazy module failed");
    });
    runtime.runOnOpen = true;
    let command: Command | undefined;
    const ribbon = document.createElement("button");
    Object.assign(ribbon, { addClass: vi.fn() });
    const host = {
      app: {},
      settings: { ...DEFAULT_SETTINGS },
      addCommand(value: Command): Command { command = value; return value; },
      addRibbonIcon: vi.fn(() => ribbon),
    } as unknown as Plugin & { settings: typeof DEFAULT_SETTINGS };

    registerOpenFromBooklore(host);
    command?.callback?.();

    await vi.waitFor(() => {
      expect(runtime.lastContentEl?.textContent).toContain(
        "Could not open Booklore:",
      );
      // A throwing async mock factory is wrapped by Vitest before the
      // dynamic import rejects. The authored error is unreachable through
      // this seam, making the wrapper the only observable rejection detail.
      expect(runtime.lastContentEl?.textContent).toContain(
        "There was an error when mocking a module",
      );
    });
  });

  // This leak guard intentionally follows the vi.doMock rejection test.
  // Vitest runs tests in declaration order, so it verifies that afterEach
  // removes that test's module override before the next dynamic import.
  it("restores the real lazy modal module after a rejected load", async () => {
    const { OpenBookloreModalContent } = await import("./openBookloreModal");

    expect(OpenBookloreModalContent).toBeTypeOf("function");
  });

  it("does not construct lazy modal content after a successful load finishes late", async () => {
    let resolveImport: ((value: unknown) => void) | undefined;
    const constructContent = vi.fn();
    const openContent = vi.fn();
    vi.doMock(
      "./openBookloreModal",
      () =>
        new Promise<unknown>((resolve) => {
          resolveImport = resolve;
        }),
    );
    runtime.runOnOpen = true;
    let command: Command | undefined;
    const ribbon = document.createElement("button");
    Object.assign(ribbon, { addClass: vi.fn() });
    const host = {
      app: {},
      settings: { ...DEFAULT_SETTINGS },
      addCommand(value: Command): Command { command = value; return value; },
      addRibbonIcon: vi.fn(() => ribbon),
    } as unknown as Plugin & { settings: typeof DEFAULT_SETTINGS };

    registerOpenFromBooklore(host);
    command?.callback?.();
    const contentEl = runtime.lastContentEl;
    await vi.waitFor(() => expect(resolveImport).toBeTypeOf("function"));

    runtime.closeModal?.();
    resolveImport?.({
      OpenBookloreModalContent: class {
        constructor() { constructContent(); }
        open(): void { openContent(); }
        destroy(): void {}
      },
    });

    await runtime.openPromise;
    expect(constructContent).not.toHaveBeenCalled();
    expect(openContent).not.toHaveBeenCalled();
    expect(contentEl?.textContent).toBe("");
  });

  it("keeps closed modal content empty when the lazy load rejects", async () => {
    let rejectImport: ((reason?: unknown) => void) | undefined;
    vi.doMock("./openBookloreModal", () => new Promise((_resolve, reject) => {
      rejectImport = reject;
    }));
    runtime.runOnOpen = true;
    let command: Command | undefined;
    const ribbon = document.createElement("button");
    Object.assign(ribbon, { addClass: vi.fn() });
    const host = {
      app: {},
      settings: { ...DEFAULT_SETTINGS },
      addCommand(value: Command): Command { command = value; return value; },
      addRibbonIcon: vi.fn(() => ribbon),
    } as unknown as Plugin & { settings: typeof DEFAULT_SETTINGS };

    registerOpenFromBooklore(host);
    command?.callback?.();
    const contentEl = runtime.lastContentEl;
    await vi.waitFor(() => expect(rejectImport).toBeTypeOf("function"));

    runtime.closeModal?.();
    rejectImport?.(new Error("lazy module failed after close"));

    await runtime.openPromise;
    expect(contentEl?.textContent).toBe("");
  });
});
