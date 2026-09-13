// @vitest-environment jsdom
import type { Command, Plugin } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";

const runtime = vi.hoisted(() => ({
  downloader: { download: vi.fn() } as object | undefined,
  modalOpen: vi.fn(),
  notices: [] as string[],
  runOnOpen: false,
  lastContentEl: undefined as HTMLElement | undefined,
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
      runtime.modalOpen();
      if (runtime.runOnOpen) void this.onOpen();
    }

    onOpen(): Promise<void> { return Promise.resolve(); }
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
    });
  });
});
