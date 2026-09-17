// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book, Rendition } from "epubjs";
import type { Location } from "epubjs/types/rendition";
import type { WorkspaceLeaf } from "obsidian";

const notices: string[] = [];

vi.mock("obsidian", () => ({
  FileView: class {
    constructor(_leaf: unknown) {}
  },
  Notice: class {
    constructor(message: string) {
      notices.push(message);
    }
  },
}));

import { DEFAULT_SETTINGS } from "../settings";
import { EpubView, type EpubViewHost } from "./EpubView";

const host = (): EpubViewHost => {
  const viewHost: EpubViewHost = {
    settings: { ...DEFAULT_SETTINGS },
    updateSettings: async (patch) => {
      viewHost.settings = { ...viewHost.settings, ...patch };
    },
    getLastEpubLocation: () => null,
    rememberEpubLocation: async () => undefined,
    getEpubStylesheetMode: () => "theme",
    setEpubStylesheetMode: async () => undefined,
  };
  return viewHost;
};

const CHAPTER_ONE = "chapter-1.xhtml";
const CHAPTER_TWO = "chapter-2.xhtml";
const CHAPTER_TWO_CFI = "epubcfi(/6/4!/4/2/1:0)";

function location(href: string, cfi: string): Location {
  const point = {
    index: href === CHAPTER_ONE ? 0 : 1,
    href,
    cfi,
    location: 0,
    percentage: 0,
    displayed: { page: 1, total: 1 },
  };
  return { start: point, end: point, atStart: false, atEnd: false };
}

const FIRST_LOCATION = location(
  CHAPTER_ONE,
  "epubcfi(/6/2!/4/2/1:0)",
);
const SECOND_LOCATION = location(CHAPTER_TWO, CHAPTER_TWO_CFI);

class MockRendition {
  location = FIRST_LOCATION;
  readonly displayedTargets: string[] = [];
  holdRelocations = false;
  suppressNoopRelocations = false;
  private readonly pendingRelocations: Location[] = [];
  private readonly listeners = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();

  readonly epubcfi = {
    compare: (left: string, right: string): number =>
      left === right ? 0 : left < right ? -1 : 1,
  };

  on(type: string, listener: (...args: never[]) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as (...args: unknown[]) => void);
    this.listeners.set(type, listeners);
  }

  off(type: string, listener: (...args: never[]) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener),
    );
  }

  emit(type: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(...args);
    }
  }

  async display(target: string): Promise<void> {
    this.displayedTargets.push(target);
    const next = target.includes("/6/4") || target === CHAPTER_TWO
      ? SECOND_LOCATION
      : FIRST_LOCATION;
    await Promise.resolve();
    if (this.holdRelocations) {
      this.pendingRelocations.push(next);
      return;
    }
    if (this.suppressNoopRelocations && this.location === next) {
      return;
    }
    this.relocate(next);
  }

  currentLocation(): Location {
    return this.location;
  }

  releaseRelocation(): void {
    const next = this.pendingRelocations.shift();
    if (next !== undefined) {
      this.relocate(next);
    }
  }

  private relocate(next: Location): void {
    this.location = next;
    this.emit("relocated", next);
  }
}

function harness(): { view: EpubView; rendition: MockRendition } {
  const rendition = new MockRendition();
  const spineHrefs = [CHAPTER_ONE, CHAPTER_TWO];
  const book = {
    spine: {
      get: (target: string) => {
        if (target.startsWith("epubcfi(/6/4")) {
          return { href: CHAPTER_TWO };
        }
        return spineHrefs.includes(target) ? { href: target } : null;
      },
    },
  } as unknown as Book;
  const view = new EpubView({} as WorkspaceLeaf, host());
  const internals = view as unknown as {
    book: Book | null;
    rendition: Rendition | null;
  };
  internals.book = book;
  internals.rendition = rendition as unknown as Rendition;
  return { view, rendition };
}

describe("EpubView.openAtFragment", () => {
  beforeEach(() => {
    notices.length = 0;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a CFI and waits for the stabilizing relocation", async () => {
    const { view, rendition } = harness();

    await expect(
      view.openAtFragment(`#${CHAPTER_TWO_CFI}`),
    ).resolves.toBeUndefined();

    expect(rendition.displayedTargets).toEqual([
      CHAPTER_TWO_CFI,
      CHAPTER_TWO_CFI,
    ]);
    expect(rendition.location).toBe(SECOND_LOCATION);
  });

  it("resolves when the stabilizing display is already at the target", async () => {
    vi.useFakeTimers();
    const { view, rendition } = harness();
    rendition.suppressNoopRelocations = true;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const pending = view.openAtFragment(`#${CHAPTER_TWO_CFI}`);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBeUndefined();

    expect(rendition.displayedTargets).toEqual([
      CHAPTER_TWO_CFI,
      CHAPTER_TWO_CFI,
    ]);
    expect(rendition.location).toBe(SECOND_LOCATION);
    expect(notices).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not settle before the rendition reports relocation", async () => {
    const { view, rendition } = harness();
    rendition.holdRelocations = true;
    let settled = false;

    const pending = view.openAtFragment(CHAPTER_TWO_CFI).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    rendition.releaseRelocation();
    await Promise.resolve();
    expect(settled).toBe(false);

    rendition.releaseRelocation();
    await pending;
    expect(settled).toBe(true);
  });

  it("opens a spine href with or without a leading hash", async () => {
    const { view, rendition } = harness();

    await view.openAtFragment(`#${CHAPTER_TWO}`);
    await view.openAtFragment(CHAPTER_ONE);

    expect(rendition.location).toBe(FIRST_LOCATION);
    expect(rendition.displayedTargets).toEqual([
      CHAPTER_TWO,
      CHAPTER_TWO,
      CHAPTER_ONE,
      CHAPTER_ONE,
    ]);
  });

  it("shows a notice and resolves for a malformed fragment", async () => {
    const { view, rendition } = harness();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      view.openAtFragment("epubcfi(nonsense)"),
    ).resolves.toBeUndefined();

    expect(rendition.displayedTargets).toEqual([]);
    expect(notices[0]).toContain('CFI is missing the "!" spine separator');
    expect(consoleError).toHaveBeenCalledWith(
      "Unable to open EPUB fragment",
      "epubcfi(nonsense)",
      expect.any(Error),
    );
  });

  it("shows a notice and resolves for an href absent from the spine", async () => {
    const { view, rendition } = harness();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(view.openAtFragment("missing.xhtml")).resolves.toBeUndefined();

    expect(rendition.displayedTargets).toEqual([]);
    expect(notices[0]).toContain("the EPUB spine does not contain");
  });

  it("shows a notice and resolves when no book is loaded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = new EpubView({} as WorkspaceLeaf, host());

    await expect(view.openAtFragment(CHAPTER_TWO)).resolves.toBeUndefined();

    expect(notices[0]).toContain("no book is loaded");
  });

  it("shows a notice and resolves when display rejects", async () => {
    const { view, rendition } = harness();
    const displayError = new Error("display failed");
    vi.spyOn(rendition, "display").mockRejectedValue(displayError);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(view.openAtFragment(CHAPTER_TWO)).resolves.toBeUndefined();

    expect(notices[0]).toContain("display failed");
    expect(consoleError).toHaveBeenCalledWith(
      "Unable to open EPUB fragment",
      CHAPTER_TWO,
      displayError,
    );
  });

  it("keeps the fragment jump after a pending resize correction", async () => {
    const { view, rendition } = harness();
    rendition.holdRelocations = true;
    let settled = false;
    let needsCorrection = false;
    let currentLocation = FIRST_LOCATION;
    rendition.on("resized", () => {
      needsCorrection = true;
    });
    rendition.on("relocated", (next: Location) => {
      if (needsCorrection) {
        needsCorrection = false;
        void rendition.display(currentLocation.start.cfi);
      } else {
        currentLocation = next;
      }
    });

    rendition.emit("resized");
    const pending = view.openAtFragment(CHAPTER_TWO).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    rendition.emit("relocated", SECOND_LOCATION);
    await Promise.resolve();

    rendition.emit("relocated", FIRST_LOCATION);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    rendition.releaseRelocation();
    await Promise.resolve();
    rendition.releaseRelocation();
    await Promise.resolve();
    rendition.releaseRelocation();
    await pending;

    expect(rendition.location).toBe(SECOND_LOCATION);
    expect(rendition.displayedTargets.at(-1)).toBe(CHAPTER_TWO);
  });

  it("resolves with a notice when the rendition never reports the new location", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { view, rendition } = harness();
    rendition.holdRelocations = true;

    const pending = view.openAtFragment(CHAPTER_TWO);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toBeUndefined();
    expect(notices[0]).toContain("the reader did not report the new location");
  });
  it("does not resolve when the stabilizing re-display lands off target", async () => {
    vi.useFakeTimers();
    const { view, rendition } = harness();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    // The re-display is a no-op at the rendition level, but the reader is not
    // actually on the target: a queued resize correction won.
    rendition.suppressNoopRelocations = true;
    rendition.currentLocation = (): Location => FIRST_LOCATION;

    const pending = view.openAtFragment(`#${CHAPTER_TWO_CFI}`);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toBeUndefined();
    expect(notices[0]).toContain("the reader did not report the new location");
    expect(consoleError).toHaveBeenCalled();
  });

});
