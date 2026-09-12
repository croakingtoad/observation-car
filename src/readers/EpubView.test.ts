// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS } from "../settings";
import { EpubView, type EpubViewHost } from "./EpubView";

/**
 * Fake epubjs: counts every Book/Rendition built and whether it was
 * destroyed, so the re-entrancy criteria ("exactly one live
 * Book/Rendition/MutationObserver and one viewerEl") are asserted
 * directly instead of inferred.
 */
const epubMock = vi.hoisted(() => {
  const state = {
    failDisplay: false,
    currentDisplayGate: null as Promise<void> | null,
  };

  class FakeRendition {
    static instances: FakeRendition[] = [];
    private readonly listeners = new Map<
      string,
      Set<(...args: unknown[]) => void>
    >();
    destroyed = false;
    displayImpl: () => Promise<void> = () =>
    {
      if (state.failDisplay) {
        return Promise.reject(new Error("display blew up"));
      }
      return state.currentDisplayGate !== null
        ? state.currentDisplayGate
        : Promise.resolve();
    };
    display = vi.fn(() => this.displayImpl());
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
    });
    off = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      this.listeners.get(event)?.delete(listener);
    });
    prev = vi.fn();
    next = vi.fn();
    themes = { register: vi.fn(), select: vi.fn() };

    constructor() {
      FakeRendition.instances.push(this);
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args);
      }
    }

    listenerCount(event: string): number {
      return this.listeners.get(event)?.size ?? 0;
    }
  }

  class FakeBook {
    static instances: FakeBook[] = [];
    destroyed = false;
    readonly rendition: FakeRendition;
    readonly loaded = {
      navigation: Promise.resolve({ toc: [] }),
      metadata: Promise.resolve({ title: "Fake Book" }),
    };
    renderTo = vi.fn((_el: HTMLElement, _options: unknown) => this.rendition);
    destroy = vi.fn(() => {
      this.destroyed = true;
    });

    constructor(_bytes: Uint8Array) {
      this.rendition = new FakeRendition();
      FakeBook.instances.push(this);
    }
  }

  return {
    epub: vi.fn((bytes: Uint8Array) => new FakeBook(bytes)),
    FakeBook,
    FakeRendition,
    state,
  };
});

// Replace only the default `ePub` entry point; `src/model/anchor.ts`
// (pulled in via the navigation tools) uses the real `EpubCFI` export
// at runtime, so the rest of the module stays original.
vi.mock("epubjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("epubjs")>();
  return { ...actual, default: epubMock.epub };
});

const { FakeBook, FakeRendition, state } = epubMock;

/**
 * Counting stand-in for the global MutationObserver EpubThemes builds,
 * so "exactly one live MutationObserver" is an assertion, not a guess.
 */
class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  disconnected = false;
  observe = vi.fn();
  disconnect = vi.fn(() => {
    this.disconnected = true;
  });

  constructor(callback: MutationCallback) {
    void callback;
    FakeMutationObserver.instances.push(this);
  }
}

/**
 * jsdom lacks Obsidian's DOM extensions; the tested code calls
 * `contentEl.createDiv` / `contentEl.empty`, so shim the minimum.
 */
function installObsidianDomShims(): void {
  const proto = HTMLElement.prototype as unknown as {
    createDiv: (
      this: HTMLElement,
      options?: { cls?: string; text?: string },
    ) => HTMLDivElement;
    empty: (this: HTMLElement) => void;
  };
  proto.createDiv = function (this: HTMLElement, options?: { cls?: string; text?: string }) {
    const div = document.createElement("div");
    if (options?.cls) {
      div.className = options.cls;
    }
    if (options?.text !== undefined) {
      div.textContent = options.text;
    }
    this.appendChild(div);
    return div;
  };
  proto.empty = function (this: HTMLElement) {
    this.replaceChildren();
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolveFn: () => void = () => {};
  let rejectFn: (error: unknown) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

function file(path: string): TFile {
  return { path, basename: path.split("/").pop() ?? path } as unknown as TFile;
}

function makeHost(): EpubViewHost {
  return {
    settings: { ...DEFAULT_SETTINGS },
    updateSettings: async () => undefined,
    getLastEpubLocation: () => null,
    rememberEpubLocation: async () => undefined,
  };
}

function makeView(
  readBinary: (file: TFile) => Promise<Uint8Array>,
  host: EpubViewHost = makeHost(),
): EpubView {
  const view = new EpubView(null as unknown as WorkspaceLeaf, host);
  // Mirrors the workspace injecting the App into a real view.
  Object.assign(view, { app: { vault: { readBinary } } });
  return view;
}

function liveObservers(): FakeMutationObserver[] {
  return FakeMutationObserver.instances.filter((observer) => !observer.disconnected);
}

beforeAll(() => {
  vi.stubGlobal("MutationObserver", FakeMutationObserver);
  installObsidianDomShims();
});

beforeEach(() => {
  epubMock.epub.mockReset();
  state.failDisplay = false;
  state.currentDisplayGate = null;
  FakeBook.instances.length = 0;
  FakeRendition.instances.length = 0;
  FakeMutationObserver.instances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EpubView re-entrancy (Tier 2 finding 1)", () => {
  it("reopens a book at its recorded CFI through openAtFragment", async () => {
    vi.useFakeTimers();
    const locations: Record<string, string> = {};
    const host: EpubViewHost = {
      ...makeHost(),
      getLastEpubLocation: (path) => locations[path] ?? null,
      rememberEpubLocation: async (path, fragment) => {
        locations[path] = fragment;
      },
    };
    const openedFile = file("library/a.epub");
    const firstView = makeView(
      vi.fn().mockResolvedValue(new Uint8Array([1])),
      host,
    );
    await firstView.onLoadFile(openedFile);
    FakeRendition.instances[0].emit("relocated", {
      start: {
        cfi: "epubcfi(/6/8!/4/2/1:0)",
        href: "chapters/ch1.xhtml",
      },
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(locations[openedFile.path]).toBe("#epubcfi(/6/8!/4/2/1:0)");
    await firstView.onClose();

    const secondView = makeView(
      vi.fn().mockResolvedValue(new Uint8Array([1])),
      host,
    );
    const openAtFragment = vi
      .spyOn(secondView, "openAtFragment")
      .mockResolvedValue(undefined);
    await secondView.onLoadFile(openedFile);

    expect(openAtFragment).toHaveBeenCalledOnce();
    expect(openAtFragment).toHaveBeenCalledWith(
      "#epubcfi(/6/8!/4/2/1:0)",
    );
    expect(FakeRendition.instances[1].display).toHaveBeenCalledOnce();
    await secondView.onClose();
  });

  it("a second open inside the readBinary window leaves exactly one live reader", async () => {
    const firstRead = deferred();
    const readBinary = vi
      .fn()
      .mockImplementationOnce(() => firstRead.promise)
      .mockResolvedValueOnce(new Uint8Array([2]));
    const view = makeView(readBinary);
    const fileB = file("library/b.epub");

    const openA = view.onLoadFile(file("library/a.epub"));
    const openB = view.onLoadFile(fileB);

    // A is suspended in readBinary, so B's entry disposed nothing and no
    // book exists yet — the race window the finding describes.
    expect(readBinary).toHaveBeenCalledTimes(2);
    expect(FakeBook.instances).toHaveLength(0);

    firstRead.resolve();
    await openA; // the losing render bails without building anything
    await openB;

    expect(FakeBook.instances).toHaveLength(1);
    expect(FakeBook.instances.every((book) => !book.destroyed)).toBe(true);
    expect(FakeRendition.instances).toHaveLength(1);
    expect(FakeRendition.instances.every((rendition) => !rendition.destroyed)).toBe(true);
    expect(liveObservers()).toHaveLength(1);
    expect(view.contentEl.querySelectorAll(".epub-viewer")).toHaveLength(1);
    expect(view.file).toBe(fileB);
  });

  it("a second open while display is in flight disposes the losing render's reader", async () => {
    const firstRead = deferred();
    const readBinary = vi
      .fn()
      .mockImplementationOnce(() => firstRead.promise)
      .mockResolvedValue(new Uint8Array([2]));
    const view = makeView(readBinary);
    const openA = view.onLoadFile(file("library/a.epub"));

    const displayGate = deferred();
    state.currentDisplayGate = displayGate.promise;
    firstRead.resolve();

    // Wait until A has called display() and is suspended on the gate.
    await vi.waitFor(() => {
      expect(FakeRendition.instances[0].display).toHaveBeenCalledTimes(1);
    });
    const bookA = FakeBook.instances[0];
    state.currentDisplayGate = null;

    const openB = view.onLoadFile(file("library/b.epub"));
    await openB;
    // B's entry emptied the content element; A's viewerEl is gone, B's is
    // the only one left, and A's objects are still live until it wakes.
    expect(view.contentEl.querySelectorAll(".epub-viewer")).toHaveLength(1);
    expect(FakeBook.instances).toHaveLength(2);

    displayGate.resolve();
    await openA; // the losing render disposes everything it created

    expect(bookA.destroyed).toBe(true);
    expect(bookA.rendition.destroyed).toBe(true);
    expect(FakeBook.instances.filter((book) => !book.destroyed)).toHaveLength(1);
    expect(FakeRendition.instances.filter((rendition) => !rendition.destroyed)).toHaveLength(1);
    expect(liveObservers()).toHaveLength(1);
    expect(view.contentEl.querySelectorAll(".epub-viewer")).toHaveLength(1);
  });

  it("does not attribute a superseded rendition's relocation to the new file", async () => {
    const displayGate = deferred();
    state.currentDisplayGate = displayGate.promise;
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));
    const locations: Array<{ file: TFile; fragment: string }> = [];
    view.on("location", (location) => locations.push(location));

    const openA = view.onLoadFile(file("library/a.epub"));
    await vi.waitFor(() => {
      expect(FakeRendition.instances[0].display).toHaveBeenCalledTimes(1);
    });
    const renditionA = FakeRendition.instances[0];

    state.currentDisplayGate = null;
    const fileB = file("library/b.epub");
    await view.onLoadFile(fileB);

    vi.useFakeTimers();
    renditionA.emit("relocated", {
      start: {
        cfi: "epubcfi(/6/8!/4/2/1:0)",
        href: "chapters/ch1.xhtml",
      },
    });
    await vi.advanceTimersByTimeAsync(150);

    expect(locations).toEqual([]);

    displayGate.resolve();
    await openA;
  });

  it("detaches location events when a superseded render finally settles", async () => {
    const displayGate = deferred();
    state.currentDisplayGate = displayGate.promise;
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));

    const openA = view.onLoadFile(file("library/a.epub"));
    await vi.waitFor(() => {
      expect(FakeRendition.instances[0].display).toHaveBeenCalledTimes(1);
    });
    const renditionA = FakeRendition.instances[0];
    const listenersBeforeTeardown = renditionA.listenerCount("relocated");
    expect(listenersBeforeTeardown).toBeGreaterThan(0);

    state.currentDisplayGate = null;
    await view.onLoadFile(file("library/b.epub"));
    expect(renditionA.listenerCount("relocated")).toBe(
      listenersBeforeTeardown,
    );

    displayGate.resolve();
    await openA;

    expect(renditionA.listenerCount("relocated")).toBe(
      listenersBeforeTeardown - 1,
    );
  });

  it("onClose during an in-flight render retires the render", async () => {
    const firstRead = deferred();
    const readBinary = vi.fn().mockImplementationOnce(() => firstRead.promise);
    const view = makeView(readBinary);
    const openA = view.onLoadFile(file("library/a.epub"));
    expect(readBinary).toHaveBeenCalledTimes(1);

    await view.onClose();
    firstRead.resolve();
    await openA;

    expect(FakeBook.instances).toHaveLength(0);
    expect(view.contentEl.querySelectorAll(".epub-viewer")).toHaveLength(0);
  });

  it("a render whose display fails disposes what it created and rethrows", async () => {
    state.failDisplay = true;
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));

    await expect(view.onLoadFile(file("library/bad.epub"))).rejects.toThrow(
      "display blew up",
    );

    expect(FakeBook.instances).toHaveLength(1);
    expect(FakeBook.instances[0].destroyed).toBe(true);
    expect(FakeBook.instances[0].rendition.destroyed).toBe(true);
    expect(view.contentEl.querySelectorAll(".epub-viewer")).toHaveLength(0);
  });

  it("a failed readBinary propagates without leaving a reader", async () => {
    const readBinary = vi.fn().mockRejectedValue(new Error("io failure"));
    const view = makeView(readBinary);

    await expect(view.onLoadFile(file("library/bad.epub"))).rejects.toThrow(
      "io failure",
    );

    expect(FakeBook.instances).toHaveLength(0);
    expect(view.contentEl.querySelectorAll(".epub-viewer")).toHaveLength(0);
  });
});
