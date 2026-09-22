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
import {
  EpubView,
  EPUB_DISPLAY_TIMEOUT_MS,
  type EpubLocationEvent,
  type EpubViewHost,
} from "./EpubView";

/**
 * Fake epubjs: counts every Book/Rendition built and whether it was
 * destroyed, so the re-entrancy criteria ("exactly one live
 * Book/Rendition/MutationObserver and one viewerEl") are asserted
 * directly instead of inferred.
 */
const epubMock = vi.hoisted(() => {
  const state: {
    failDisplay: boolean;
    currentDisplayGate: Promise<void> | null;
    navigationFailure: unknown;
    navigationHref: unknown;
  } = {
    failDisplay: false,
    currentDisplayGate: null,
    navigationFailure: null,
    navigationHref: "chapters/ch1.xhtml",
  };

  class FakeHook {
    private readonly handlers = new Set<(...args: never[]) => unknown>();
    register = vi.fn((handler: (...args: never[]) => unknown) => {
      this.handlers.add(handler);
    });
    deregister = vi.fn((handler: (...args: never[]) => unknown) => {
      this.handlers.delete(handler);
    });
  }

  class FakeRendition {
    static instances: FakeRendition[] = [];
    private readonly listeners = new Map<
      string,
      Set<(...args: unknown[]) => void>
    >();
    destroyed = false;
    location: { start: { cfi: string } } | null = null;
    displayImpl: (target?: string) => Promise<void> = () =>
    {
      if (state.failDisplay) {
        return Promise.reject(new Error("display blew up"));
      }
      return state.currentDisplayGate !== null
        ? state.currentDisplayGate
        : Promise.resolve();
    };
    display = vi.fn((target?: string) => this.displayImpl(target));
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
    themes = { register: vi.fn(), select: vi.fn(), override: vi.fn() };
    hooks = { content: new FakeHook() };
    epubcfi = { compare: vi.fn(() => 0) };

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
      get navigation(): Promise<{
        toc: Array<{ id: string; label: string; href: unknown }>;
      }> {
        return state.navigationFailure === null
          ? Promise.resolve({
              toc: [
                {
                  id: "toc-ch1",
                  label: "The Opening Image",
                  href: state.navigationHref,
                },
              ],
            })
          : Promise.reject(state.navigationFailure);
      },
      metadata: Promise.resolve({ title: "Fake Book" }),
    };
    readonly spine = {
      get: (target: string) => ({ href: target }),
      hooks: { content: new FakeHook() },
    };
    readonly archive = { getText: vi.fn(async () => "") };
    readonly resources = { substitute: vi.fn((css: string) => css) };
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
  const stylesheetModes: Record<string, "theme" | "book"> = {};
  const host: EpubViewHost = {
    settings: { ...DEFAULT_SETTINGS },
    updateSettings: async (patch) => {
      host.settings = { ...host.settings, ...patch };
    },
    getLastEpubLocation: () => null,
    rememberEpubLocation: async () => undefined,
    getEpubStylesheetMode: (path) => stylesheetModes[path] ?? "theme",
    setEpubStylesheetMode: async (path, mode) => {
      if (mode === "theme") {
        delete stylesheetModes[path];
      } else {
        stylesheetModes[path] = mode;
      }
    },
  };
  return host;
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
  state.navigationFailure = null;
  state.navigationHref = "chapters/ch1.xhtml";
  FakeBook.instances.length = 0;
  FakeRendition.instances.length = 0;
  FakeMutationObserver.instances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EpubView re-entrancy (Tier 2 finding 1)", () => {
  it("re-renders a stylesheet toggle at the current CFI", async () => {
    const host = makeHost();
    const view = makeView(
      vi.fn().mockResolvedValue(new Uint8Array([1])),
      host,
    );
    const openedFile = file("Books/Styled.epub");
    const cfi = "epubcfi(/6/14!/4/2/12:0)";
    await view.onLoadFile(openedFile);
    FakeRendition.instances[0].location = { start: { cfi } };

    await view.toggleBookStylesheet();

    expect(host.getEpubStylesheetMode(openedFile.path)).toBe("book");
    expect(FakeRendition.instances).toHaveLength(2);
    expect(FakeRendition.instances[1].display).toHaveBeenNthCalledWith(1);
    expect(FakeRendition.instances[1].display).toHaveBeenNthCalledWith(2, cfi);
    expect(
      (view as unknown as { renderedStylesheetMode: string }).renderedStylesheetMode,
    ).toBe("book");
    await view.onClose();
  });

  it("lets two open books render with independent stylesheet modes", async () => {
    const modes: Record<string, "theme" | "book"> = {
      "Books/Book-Css.epub": "book",
    };
    const host: EpubViewHost = {
      ...makeHost(),
      getEpubStylesheetMode: (path) => modes[path] ?? "theme",
      setEpubStylesheetMode: async (path, mode) => {
        if (mode === "theme") delete modes[path];
        else modes[path] = mode;
      },
    };
    const themedView = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])), host);
    const bookView = makeView(vi.fn().mockResolvedValue(new Uint8Array([2])), host);

    await themedView.onLoadFile(file("Books/Themed.epub"));
    await bookView.onLoadFile(file("Books/Book-Css.epub"));

    expect(
      (themedView as unknown as { renderedStylesheetMode: string }).renderedStylesheetMode,
    ).toBe("theme");
    expect(
      (bookView as unknown as { renderedStylesheetMode: string }).renderedStylesheetMode,
    ).toBe("book");
    expect(
      FakeBook.instances[1].rendition.hooks.content.register.mock.calls.length,
    ).toBe(
      FakeBook.instances[0].rendition.hooks.content.register.mock.calls.length + 1,
    );
    await themedView.onClose();
    await bookView.onClose();
  });

  it("deregisters stylesheet hooks before destroying their book", async () => {
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));
    await view.onLoadFile(file("Books/Teardown.epub"));
    const book = FakeBook.instances[0];

    await view.onClose();

    const deregisterOrders = book.spine.hooks.content.deregister.mock
      .invocationCallOrder;
    expect(deregisterOrders.length).toBeGreaterThan(0);
    expect(Math.max(...deregisterOrders)).toBeLessThan(
      book.destroy.mock.invocationCallOrder[0],
    );
  });

  // LOCO-490 W3: serialises two back-to-back toggles (lost-update guard).
  // Without readerChange, both toggles read the same previousMode and both flip to
  // "book" — the second press does not return the book to theme mode.  Replacement-
  // book safety on this path is owned by renderGeneration (not readerChange) and is
  // already pinned by the "does not redisplay book A's CFI" and "keeps book B's saved
  // CFI when a superseded flow toggle settles" tests above.
  it("serialises two back-to-back stylesheet toggles so the second sees the first's mode", async () => {
    const host = makeHost();
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])), host);
    await view.onLoadFile(file("Books/Styled.epub"));

    const first = view.toggleBookStylesheet();
    const second = view.toggleBookStylesheet();

    await first;
    await second;

    // With the guard the second toggle serialises behind the first,
    // sees "book", and flips back to "theme" — the correct result of
    // two back-to-back toggles.  Without the guard both see "theme"
    // and both flip to "book", leaving the net mode wrongly "book".
    expect(
      (view as unknown as { renderedStylesheetMode: string }).renderedStylesheetMode,
    ).toBe("theme");
    // Three renditions: initial load, first toggle's render, second toggle's render.
    expect(FakeRendition.instances).toHaveLength(3);
  });

  it("serializes stylesheet and flow changes behind an in-flight change", async () => {
    const host = makeHost();
    const setStylesheetMode = vi.spyOn(host, "setEpubStylesheetMode");
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])), host);
    await view.onLoadFile(file("Books/Queued.epub"));

    const firstDisplay = deferred();
    state.currentDisplayGate = firstDisplay.promise;
    const firstFlowChange = view.setFlowMode("scrolled");
    await vi.waitFor(() => {
      expect(FakeRendition.instances[1].display).toHaveBeenCalledOnce();
    });

    const firstStylesheetChange = view.toggleBookStylesheet();
    const secondStylesheetChange = view.toggleBookStylesheet();
    const secondFlowChange = view.setFlowMode("paginated");
    state.currentDisplayGate = null;
    firstDisplay.resolve();
    await Promise.all([
      firstFlowChange,
      firstStylesheetChange,
      secondStylesheetChange,
      secondFlowChange,
    ]);

    expect(setStylesheetMode.mock.calls.map(([, mode]) => mode)).toStrictEqual([
      "book",
      "theme",
    ]);
    const { renderedFlowMode } = view as unknown as {
      renderedFlowMode: "paginated" | "scrolled";
    };
    expect(host.settings.epubFlowMode).toBe(renderedFlowMode);
    expect(renderedFlowMode).toBe("paginated");
    await view.onClose();
  });

  it("routes the reader toolbar action through the exact reader leaf", async () => {
    const leafA = { probe: "A" } as unknown as WorkspaceLeaf;
    const leafB = { probe: "B" } as unknown as WorkspaceLeaf;
    const newNoteHereFromReader = vi.fn();
    const host: EpubViewHost = {
      ...makeHost(),
      newNoteHereFromReader,
    };
    const viewA = new EpubView(leafA, host);
    Object.assign(viewA, {
      app: { vault: { readBinary: vi.fn().mockResolvedValue(new Uint8Array([1])) } },
    });
    const viewB = new EpubView(leafB, host);
    Object.assign(viewB, {
      app: { vault: { readBinary: vi.fn().mockResolvedValue(new Uint8Array([2])) } },
    });
    await viewA.onLoadFile(file("library/a.epub"));
    await viewB.onLoadFile(file("library/b.epub"));

    viewA.contentEl
      .querySelector<HTMLButtonElement>(".epub-new-note-button")
      ?.click();

    expect(newNoteHereFromReader).toHaveBeenCalledTimes(1);
    expect(newNoteHereFromReader).toHaveBeenCalledWith(leafA);
    await viewA.onClose();
    await viewB.onClose();
  });

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

  it("keeps each book's CFI under its owner when Obsidian preassigns a swap", async () => {
    const fileA = file("Books/A.epub");
    const fileB = file("Books/B.epub");
    const cfiA = "#epubcfi(/6/8!/4/2/1:0)";
    const cfiB = "#epubcfi(/6/22!/4/2/9:0)";
    const locations: Record<string, string> = { [fileB.path]: cfiB };
    const host: EpubViewHost = {
      ...makeHost(),
      getLastEpubLocation: (path) => locations[path] ?? null,
      rememberEpubLocation: async (path, fragment) => {
        locations[path] = fragment;
      },
    };
    const view = makeView(
      vi.fn().mockResolvedValue(new Uint8Array([1])),
      host,
    );
    await view.onLoadFile(fileA);
    FakeRendition.instances[0].location = {
      start: { cfi: cfiA.slice(1) },
    };

    // FileView.loadFile assigns the incoming file before onLoadFile runs.
    view.file = fileB;
    const openAtFragment = vi
      .spyOn(view, "openAtFragment")
      .mockResolvedValue(undefined);
    await view.onLoadFile(fileB);

    expect(locations).toEqual({
      [fileA.path]: cfiA,
      [fileB.path]: cfiB,
    });
    expect(openAtFragment).toHaveBeenCalledOnce();
    expect(openAtFragment).toHaveBeenCalledWith(cfiB);
    await view.onClose();
  });

  it("absorbs and logs a rejected location write during a preassigned swap", async () => {
    const fileA = file("Books/A.epub");
    const fileB = file("Books/B.epub");
    const saveError = new Error("disk full");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const host: EpubViewHost = {
      ...makeHost(),
      rememberEpubLocation: vi.fn().mockRejectedValue(saveError),
    };
    const view = makeView(
      vi.fn().mockResolvedValue(new Uint8Array([1])),
      host,
    );

    try {
      await view.onLoadFile(fileA);
      FakeRendition.instances[0].location = {
        start: { cfi: "epubcfi(/6/8!/4/2/1:0)" },
      };

      // FileView.loadFile assigns the incoming file before onLoadFile runs.
      view.file = fileB;
      await expect(view.onLoadFile(fileB)).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(
        "Observation Car: could not save EPUB location",
        saveError,
      );
    } finally {
      await view.onClose();
      consoleError.mockRestore();
    }
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

  it("does not let a superseded relocation re-arm persistence during a book swap", async () => {
    const fileA = file("library/a.epub");
    const fileB = file("library/b.epub");
    const savedCfiB = "#epubcfi(/6/22!/4/2/9:0)";
    const renderStartCfi = "epubcfi(/6/2!/4/2/1:0)";
    const locations: Record<string, string> = { [fileB.path]: savedCfiB };
    const rememberEpubLocation = vi.fn(async (path: string, fragment: string) => {
      locations[path] = fragment;
    });
    const host: EpubViewHost = {
      ...makeHost(),
      getLastEpubLocation: (path) => locations[path] ?? null,
      rememberEpubLocation,
    };
    const displayGate = deferred();
    state.currentDisplayGate = displayGate.promise;
    const view = makeView(
      vi.fn().mockResolvedValue(new Uint8Array([1])),
      host,
    );

    const openA = view.onLoadFile(fileA);
    await vi.waitFor(() => {
      expect(FakeRendition.instances[0].display).toHaveBeenCalledOnce();
    });
    const renditionA = FakeRendition.instances[0];

    const restoreGate = deferred();
    const openAtFragment = vi
      .spyOn(view, "openAtFragment")
      .mockImplementation(() => restoreGate.promise);
    state.currentDisplayGate = null;
    const openB = view.onLoadFile(fileB);
    await vi.waitFor(() => {
      expect(openAtFragment).toHaveBeenCalledWith(savedCfiB);
    });
    FakeRendition.instances[1].location = {
      start: { cfi: renderStartCfi },
    };

    renditionA.emit("relocated", {
      start: {
        cfi: "epubcfi(/6/8!/4/2/1:0)",
        href: "chapters/ch1.xhtml",
      },
    });
    restoreGate.resolve();
    await openB;
    displayGate.resolve();
    await openA;
    await view.onClose();

    expect(locations[fileB.path]).toBe(savedCfiB);
    expect(rememberEpubLocation).not.toHaveBeenCalledWith(
      fileB.path,
      `#${renderStartCfi}`,
    );
  });

  it("does not redisplay book A's CFI on book B after a flow toggle is superseded", async () => {
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));
    const fileA = file("library/a.epub");
    const fileB = file("library/b.epub");
    const cfiA = "epubcfi(/6/8!/4/2/1:0)";
    await view.onLoadFile(fileA);
    FakeRendition.instances[0].location = { start: { cfi: cfiA } };

    const toggleDisplay = deferred();
    state.currentDisplayGate = toggleDisplay.promise;
    const toggle = view.setFlowMode("scrolled");
    await vi.waitFor(() => {
      expect(FakeRendition.instances[1].display).toHaveBeenCalledOnce();
    });

    state.currentDisplayGate = null;
    await view.onLoadFile(fileB);
    const renditionB = FakeRendition.instances[2];
    expect(renditionB.display).toHaveBeenCalledOnce();

    toggleDisplay.resolve();
    await toggle;

    expect(renditionB.display).toHaveBeenCalledOnce();
    expect(renditionB.display).not.toHaveBeenCalledWith(cfiA);
  });

  it("keeps book B's saved CFI when a superseded flow toggle settles", async () => {
    const fileA = file("library/a.epub");
    const fileB = file("library/b.epub");
    const cfiA = "epubcfi(/6/8!/4/2/1:0)";
    const cfiB = "#epubcfi(/6/22!/4/2/9:0)";
    const locations: Record<string, string> = { [fileB.path]: cfiB };
    const host: EpubViewHost = {
      ...makeHost(),
      rememberEpubLocation: async (path, fragment) => {
        locations[path] = fragment;
      },
    };
    const view = makeView(
      vi.fn().mockResolvedValue(new Uint8Array([1])),
      host,
    );
    await view.onLoadFile(fileA);
    FakeRendition.instances[0].location = { start: { cfi: cfiA } };

    const toggleDisplay = deferred();
    state.currentDisplayGate = toggleDisplay.promise;
    const toggle = view.setFlowMode("scrolled");
    await vi.waitFor(() => {
      expect(FakeRendition.instances[1].display).toHaveBeenCalledOnce();
    });

    state.currentDisplayGate = null;
    await view.onLoadFile(fileB);
    const renditionB = FakeRendition.instances[2];
    renditionB.location = { start: { cfi: cfiB.slice(1) } };
    renditionB.displayImpl = async (target) => {
      if (target !== undefined) {
        renditionB.location = { start: { cfi: target } };
        renditionB.emit("relocated", {
          start: { cfi: target, href: "chapters/wrong.xhtml" },
        });
      }
    };

    vi.useFakeTimers();
    toggleDisplay.resolve();
    await toggle;
    await vi.advanceTimersByTimeAsync(150);

    expect(locations[fileB.path]).toBe(cfiB);
  });

  it("leaves book B's reader installed when book A's CFI cannot resolve", async () => {
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));
    const fileA = file("library/a.epub");
    const fileB = file("library/b.epub");
    const cfiA = "epubcfi(/6/8!/4/2/1:0)";
    await view.onLoadFile(fileA);
    FakeRendition.instances[0].location = { start: { cfi: cfiA } };

    const toggleDisplay = deferred();
    state.currentDisplayGate = toggleDisplay.promise;
    const toggle = view.setFlowMode("scrolled");
    await vi.waitFor(() => {
      expect(FakeRendition.instances[1].display).toHaveBeenCalledOnce();
    });

    state.currentDisplayGate = null;
    await view.onLoadFile(fileB);
    const bookB = FakeBook.instances[2];
    bookB.rendition.displayImpl = async (target) => {
      if (target !== undefined) {
        throw new Error("CFI does not resolve in book B");
      }
    };

    toggleDisplay.resolve();
    await toggle.catch(() => undefined);

    const internals = view as unknown as {
      renderedFile: TFile | null;
      rendition: InstanceType<typeof FakeRendition> | null;
    };
    expect(FakeBook.instances).toHaveLength(3);
    expect(bookB.destroyed).toBe(false);
    expect(internals.renderedFile).toBe(fileB);
    expect(internals.rendition).toBe(bookB.rendition);
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

    expect(renditionA.listenerCount("relocated")).toBe(0);
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
    expect(view.contentEl.querySelector(".epub-load-error")?.textContent)
      .toContain("display blew up");
  });

  it("keeps the newer book mounted when a superseded render's timeout rejects", async () => {
    vi.useFakeTimers();
    const staleDisplay = deferred();
    state.currentDisplayGate = staleDisplay.promise;
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));

    const openStale = view.onLoadFile(file("library/a.epub"));
    await vi.waitFor(() => {
      expect(FakeRendition.instances[0].display).toHaveBeenCalledOnce();
    });

    state.currentDisplayGate = null;
    await view.onLoadFile(file("library/b.epub"));
    expect(view.contentEl.querySelectorAll(".epub-viewer")).toHaveLength(1);

    const rejection = openStale.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(EPUB_DISPLAY_TIMEOUT_MS);
    expect(await rejection).toMatchObject({
      message: `the EPUB did not finish loading within ${
        EPUB_DISPLAY_TIMEOUT_MS / 1000
      } seconds`,
    });
    expect(view.contentEl.querySelectorAll(".epub-viewer")).toHaveLength(1);
    expect(view.contentEl.querySelectorAll(".epub-load-error")).toHaveLength(0);

    await view.onClose();
    vi.useRealTimers();
  });

  it("a render whose display never settles times out, disposes, and rethrows", async () => {
    vi.useFakeTimers();
    const displayGate = deferred();
    state.currentDisplayGate = displayGate.promise;
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));
    let rejection: unknown;

    void view.onLoadFile(file("library/corrupt.epub")).catch((error: unknown) => {
      rejection = error;
    });
    await vi.advanceTimersByTimeAsync(EPUB_DISPLAY_TIMEOUT_MS);

    expect(rejection).toEqual(
      new Error(
        `the EPUB did not finish loading within ${
          EPUB_DISPLAY_TIMEOUT_MS / 1000
        } seconds`,
      ),
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

  it("reopens a good book in the same view after a failed load", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    state.failDisplay = true;
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));

    await expect(view.onLoadFile(file("library/bad.epub"))).rejects.toThrow(
      "display blew up",
    );
    expect(view.contentEl.querySelectorAll(".epub-load-error")).toHaveLength(1);
    expect(view.contentEl.querySelectorAll(".epub-viewer")).toHaveLength(0);
    expect(FakeBook.instances[0].destroyed).toBe(true);

    state.failDisplay = false;
    await view.onLoadFile(file("library/good.epub"));

    expect(view.contentEl.querySelectorAll(".epub-load-error")).toHaveLength(0);
    expect(view.contentEl.querySelectorAll(".epub-viewer")).toHaveLength(1);
    expect(FakeBook.instances).toHaveLength(2);
    expect(FakeBook.instances[0].destroyed).toBe(true);
    expect(FakeBook.instances[1].destroyed).toBe(false);

    await view.onClose();
    consoleError.mockRestore();
  });

  it("completes display inside the timeout boundary without an error", async () => {
    vi.useFakeTimers();
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));
    const displayGate = deferred();
    state.currentDisplayGate = displayGate.promise;

    const open = view.onLoadFile(file("Books/Test.epub"));
    await vi.waitFor(() => {
      expect(FakeRendition.instances[0].display).toHaveBeenCalledOnce();
    });

    // Advance to just under the timeout
    await vi.advanceTimersByTimeAsync(EPUB_DISPLAY_TIMEOUT_MS - 100);
    expect(view.contentEl.querySelectorAll(".epub-viewer")).toHaveLength(1);
    expect(view.contentEl.querySelectorAll(".epub-load-error")).toHaveLength(0);
    expect(FakeBook.instances[0].destroyed).toBe(false);
    expect(FakeRendition.instances[0].destroyed).toBe(false);

    state.currentDisplayGate = null;
    displayGate.resolve();
    await open;
    await view.onClose();
    vi.useRealTimers();
  });

});

describe("EpubView forwarded-keystroke leaf attribution", () => {
  it("activates the leaf that owns a chord forwarded from its iframe", async () => {
    const bookA = file("Books/A.epub");
    const bookB = file("Books/B.epub");
    const leafA = { probe: "A" } as unknown as WorkspaceLeaf;
    const leafB = { probe: "B" } as unknown as WorkspaceLeaf;
    const setActiveLeaf = vi.fn();
    const viewA = makeView(
      vi.fn().mockResolvedValue(new Uint8Array([1])),
    );
    Object.assign(viewA, {
      app: {
        vault: { readBinary: vi.fn().mockResolvedValue(new Uint8Array([1])) },
        workspace: { setActiveLeaf },
      },
    });
    Object.defineProperty(viewA, "leaf", {
      configurable: true,
      get: () => leafA,
    });
    const viewB = makeView(
      vi.fn().mockResolvedValue(new Uint8Array([2])),
    );
    Object.assign(viewB, {
      app: {
        vault: { readBinary: vi.fn().mockResolvedValue(new Uint8Array([2])) },
        workspace: { setActiveLeaf },
      },
    });
    Object.defineProperty(viewB, "leaf", {
      configurable: true,
      get: () => leafB,
    });

    await viewA.onLoadFile(bookA);
    await viewB.onLoadFile(bookB);
    expect(viewA.file).toBe(bookA);
    expect(viewB.file).toBe(bookB);

    const hostFrame = document.createElement("iframe");
    document.body.append(hostFrame);
    const hostDocument = hostFrame.contentDocument;
    if (hostDocument === null) throw new Error("test host frame has no document");
    const readerFrame = hostDocument.createElement("iframe");
    hostDocument.body.append(readerFrame);
    const bookADocument = readerFrame.contentDocument;
    if (bookADocument === null) throw new Error("test book frame has no document");
    const renderedA = FakeRendition.instances[0];
    const contentsA = {
      contents: {},
      document: bookADocument,
      iframe: readerFrame,
      window: readerFrame.contentWindow,
    };
    renderedA.emit("rendered", {}, contentsA);
    const event = new KeyboardEvent("keydown", {
      key: "j",
      code: "KeyJ",
      bubbles: true,
      cancelable: true,
    });
    bookADocument.dispatchEvent(event);

    expect(setActiveLeaf).toHaveBeenCalledTimes(1);
    expect(setActiveLeaf).toHaveBeenCalledWith(leafA, { focus: false });

    await viewA.onClose();
    await viewB.onClose();
  });
});

function relocatedAt(cfi: string, href: string) {
  return {
    start: { index: 3, href, cfi, displayed: { page: 1, total: 1 } },
    end: { index: 3, href, cfi, displayed: { page: 1, total: 1 } },
    atStart: true,
    atEnd: false,
  };
}

describe("EpubView location events (F2.5)", () => {
  it("returns null before the first relocation and after close", async () => {
    vi.useFakeTimers();
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));

    expect(view.getLocation()).toBeNull();
    await view.onLoadFile(file("Books/Test.epub"));
    await vi.advanceTimersByTimeAsync(0);
    expect(view.getLocation()).toBeNull();

    FakeRendition.instances[0].emit(
      "relocated",
      relocatedAt("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"),
    );
    expect(view.getLocation()).not.toBeNull();

    await view.onClose();
    expect(view.getLocation()).toBeNull();
  });

  it.each([
    ["page turn", "epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"],
    ["TOC jump", "epubcfi(/6/10!/4/2/3:0)", "chapters/ch2.xhtml"],
    ["scroll", "epubcfi(/6/12!/4/2/7:0)", "chapters/ch2.xhtml"],
    ["restored location", "epubcfi(/6/14!/4/2/12:0)", "chapters/ch3.xhtml"],
  ])(
    "agrees with the emitted event after a %s relocation",
    async (_kind, cfi, href) => {
      vi.useFakeTimers();
      const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));
      const events: EpubLocationEvent[] = [];
      view.on("location", (location) => events.push(location));
      await view.onLoadFile(file("Books/Test.epub"));
      await vi.advanceTimersByTimeAsync(0);

      const rendition = FakeRendition.instances[0];
      rendition.emit("relocated", relocatedAt(cfi, href));

      // Mutation evidence: the pull read sees this relocation before the
      // debounced event exists, so returning only the last event is stale.
      const pulledBeforeEvent = view.getLocation();
      expect(events).toHaveLength(0);
      expect(pulledBeforeEvent?.fragment).toBe(`#${cfi}`);

      await vi.advanceTimersByTimeAsync(150);
      const [{ file: _file, ...emitted }] = events;
      expect(pulledBeforeEvent).toEqual(emitted);
      expect(view.getLocation()).toEqual(emitted);
      await view.onClose();
    },
  );

  it("does not emit or mutate the current location when read", async () => {
    vi.useFakeTimers();
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));
    const listener = vi.fn();
    view.on("location", listener);
    await view.onLoadFile(file("Books/Test.epub"));
    await vi.advanceTimersByTimeAsync(0);
    FakeRendition.instances[0].emit(
      "relocated",
      relocatedAt("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(150);
    listener.mockClear();

    const first = view.getLocation();
    const second = view.getLocation();

    expect(second).toEqual(first);
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await view.onClose();
  });

  it("logs navigation load failures and keeps chapter-label fallback", async () => {
    vi.useFakeTimers();
    const failure = new Error("malformed navigation document");
    state.navigationFailure = failure;
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));
    const events: EpubLocationEvent[] = [];
    view.on("location", (location) => events.push(location));

    await view.onLoadFile(file("Books/Test.epub"));
    await vi.advanceTimersByTimeAsync(0);
    FakeRendition.instances[0].emit(
      "relocated",
      relocatedAt("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(150);

    expect(consoleWarn).toHaveBeenCalledWith(
      "[observation-car] could not load or apply EPUB navigation labels",
      failure,
    );
    expect(events[0]?.label).toBe("Ch. 3");
    await view.onClose();
    consoleWarn.mockRestore();
  });

  it("logs invalid loaded navigation and keeps chapter-label fallback", async () => {
    vi.useFakeTimers();
    state.navigationHref = 42;
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));
    const events: EpubLocationEvent[] = [];
    view.on("location", (location) => events.push(location));

    await view.onLoadFile(file("Books/Test.epub"));
    await vi.advanceTimersByTimeAsync(0);
    FakeRendition.instances[0].emit(
      "relocated",
      relocatedAt("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(150);

    expect(consoleWarn).toHaveBeenCalledWith(
      "[observation-car] could not load or apply EPUB navigation labels",
      expect.any(Error),
    );
    expect(events[0]?.label).toBe("Ch. 3");
    await view.onClose();
    consoleWarn.mockRestore();
  });

  it("emits a debounced LocationChanged with {file, fragment, chapter, label}", async () => {
    vi.useFakeTimers();
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));
    const events: EpubLocationEvent[] = [];
    view.on("location", (location) => events.push(location));
    const openedFile = file("Books/Test.epub");

    await view.onLoadFile(openedFile);
    await vi.advanceTimersByTimeAsync(0);
    FakeRendition.instances[0].emit(
      "relocated",
      relocatedAt("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(149);
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      file: openedFile,
      fragment: "#epubcfi(/6/8!/4/2/1:0)",
      chapter: 3,
      label: "The Opening Image",
    });
    await view.onClose();
  });

  it("delivers the first relocation to subscribers attached before the book loads", async () => {
    vi.useFakeTimers();
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));
    const events: EpubLocationEvent[] = [];
    const unsubscribe = view.on("location", (location) => events.push(location));

    await view.onLoadFile(file("Books/Test.epub"));
    await vi.advanceTimersByTimeAsync(0);
    const rendition = FakeRendition.instances[0];
    rendition.emit(
      "relocated",
      relocatedAt("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(events).toHaveLength(1);

    unsubscribe();
    rendition.emit(
      "relocated",
      relocatedAt("epubcfi(/6/14!/4/2/12:0)", "chapters/ch3.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(events).toHaveLength(1);
    await view.onClose();
  });

  it("keeps the subscription alive across a book swap in the same leaf", async () => {
    vi.useFakeTimers();
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));
    const events: EpubLocationEvent[] = [];
    view.on("location", (location) => events.push(location));

    const first = file("Books/One.epub");
    await view.onLoadFile(first);
    await vi.advanceTimersByTimeAsync(0);
    FakeRendition.instances[0].emit(
      "relocated",
      relocatedAt("epubcfi(/2/2!/4/2/1:0)", "chapters/ch1.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(events[0]).toMatchObject({ file: first, chapter: 0 });

    const second = file("Books/Two.epub");
    await view.onLoadFile(second);
    await vi.advanceTimersByTimeAsync(0);
    FakeRendition.instances[1].emit(
      "relocated",
      relocatedAt("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ file: second, chapter: 3 });
    await view.onClose();
  });

  it("cancels a pending event on close", async () => {
    vi.useFakeTimers();
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));
    await view.onLoadFile(file("Books/Test.epub"));
    await vi.advanceTimersByTimeAsync(0);
    const events: EpubLocationEvent[] = [];
    view.on("location", (location) => events.push(location));
    FakeRendition.instances[0].emit(
      "relocated",
      relocatedAt("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"),
    );

    await view.onClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toHaveLength(0);
  });

  it("detaches the rendition listener on close", async () => {
    vi.useFakeTimers();
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));
    await view.onLoadFile(file("Books/Test.epub"));
    await vi.advanceTimersByTimeAsync(0);
    const rendition = FakeRendition.instances[0];
    await view.onClose();

    expect(rendition.listenerCount("relocated")).toBe(0);
  });

  it("adds no listeners to document or window", async () => {
    vi.useFakeTimers();
    const windowSpy = vi.spyOn(window, "addEventListener");
    const documentSpy = vi.spyOn(document, "addEventListener");
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));

    await view.onLoadFile(file("Books/Test.epub"));
    await vi.advanceTimersByTimeAsync(150);
    FakeRendition.instances[0].emit(
      "relocated",
      relocatedAt("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(150);
    await view.onClose();

    expect(windowSpy).not.toHaveBeenCalled();
    expect(documentSpy).not.toHaveBeenCalled();
  });

  it("a throwing listener is logged and does not starve well-behaved subscribers (defect 4)", async () => {
    vi.useFakeTimers();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = makeView(vi.fn().mockResolvedValue(new Uint8Array([1])));
    const events: EpubLocationEvent[] = [];

    view.on("location", () => { throw new Error("listener fail"); });
    view.on("location", (loc) => events.push(loc));

    await view.onLoadFile(file("Books/Test.epub"));
    await vi.advanceTimersByTimeAsync(0);
    FakeRendition.instances[0].emit(
      "relocated",
      relocatedAt("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(150);

    // Good subscriber received the event
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fragment: "#epubcfi(/6/8!/4/2/1:0)",
      chapter: 3,
    });

    // Throwing subscriber was logged
    expect(consoleWarn).toHaveBeenCalledWith(
      "[Observation Car] Location subscriber threw",
      expect.any(Error),
    );
    consoleWarn.mockRestore();
    await view.onClose();
  });
});
