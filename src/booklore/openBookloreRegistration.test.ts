// @vitest-environment jsdom
import type { Command, Plugin } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";

const runtime = vi.hoisted(() => ({
  downloader: { download: vi.fn() } as object | undefined,
  modalOpen: vi.fn(),
  notices: [] as string[],
}));

vi.mock("obsidian", () => ({
  Modal: class {
    constructor(_app: unknown) {}
    open(): void { runtime.modalOpen(); }
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
});
