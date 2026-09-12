// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS } from "../settings";
import {
  EpubView,
  type EpubLocationEvent,
  type EpubViewHost,
} from "./EpubView";

/**
 * F2.5 wiring contract: EpubView listens for `relocated` on the
 * rendition (never document/window), debounces it, and emits
 * LocationChanged events carrying `{file, fragment, chapter, label}`
 * to every `on("location")` subscriber.
 *
 * `obsidian` resolves to the test stub (see `vitest.config.ts`);
 * `epubjs` is mocked below: the view under test is the wiring and
 * lifetime, not epub.js's rendering or Obsidian's view framework. The
 * fake rendition keeps its listeners per event. Like epub.js 0.3.x,
 * `destroy()` does not clear the rendition emitter's listeners, making
 * explicit `off()` calls observable here.
 */

const epub = vi.hoisted(() => {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  const rendition = {
    themes: { register: () => {}, select: () => {} },
    location: null as unknown,
    on: (event: string, callback: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(callback);
    },
    off: (event: string, callback: (...args: unknown[]) => void) => {
      listeners[event] = (listeners[event] ?? []).filter(
        (fn) => fn !== callback,
      );
    },
    display: async () => {},
    destroy: () => {},
  };

  const book = {
    renderTo: () => rendition,
    loaded: {
      navigation: Promise.resolve({
        toc: [
          {
            id: "toc-ch1",
            label: "The Opening Image",
            href: "chapters/ch1.xhtml",
          },
        ],
      }),
      metadata: Promise.resolve({ title: "A Test Book" }),
    },
    destroy: () => {},
  };

  return {
    book,
    reset() {
      for (const key of Object.keys(listeners)) delete listeners[key];
    },
    emit(event: string, ...args: unknown[]) {
      if (event === "relocated") {
        rendition.location = args[0];
      }
      const callbacks = [...(listeners[event] ?? [])];
      for (const callback of callbacks) {
        callback(...args);
      }
      return callbacks.length;
    },
  };
});

vi.mock("epubjs", () => ({
  default: () => epub.book,
  Book: class {},
  EpubCFI: class {},
  Rendition: class {},
}));

vi.mock("./epubNavigationTools", () => ({
  EpubNavigationTools: class {},
  EpubSelectionTracker: class {},
}));

/** A relocated payload shaped like epub.js's `Location`. */
const relocatedAt = (cfi: string, href: string) => ({
  start: { index: 3, href, cfi, displayed: { page: 1, total: 1 } },
  end: { index: 3, href, cfi, displayed: { page: 1, total: 1 } },
  atStart: true,
  atEnd: false,
});

const makeLeaf = () =>
  ({
    app: { vault: { readBinary: async () => new Uint8Array([1, 2, 3]) } },
  }) as unknown as WorkspaceLeaf;

const makeFile = (path: string) =>
  ({ path, basename: path.split("/").pop() ?? path }) as TFile;

const makeHost = (overrides: Partial<EpubViewHost> = {}): EpubViewHost => ({
  settings: { ...DEFAULT_SETTINGS },
  updateSettings: async () => undefined,
  getLastEpubLocation: () => null,
  rememberEpubLocation: async () => undefined,
  ...overrides,
});

beforeEach(() => {
  epub.reset();
  // Obsidian extends HTMLElement with createDiv/empty; jsdom does not.
  const proto = HTMLElement.prototype as unknown as {
    createDiv?: ((info?: { cls?: string }) => HTMLDivElement) | undefined;
    empty?: (() => void) | undefined;
  };
  if (proto.createDiv === undefined) {
    proto.createDiv = function (
      this: HTMLElement,
      info?: { cls?: string },
    ) {
      const el = document.createElement("div");
      if (info?.cls !== undefined) el.className = info.cls;
      this.appendChild(el);
      return el;
    };
  }
  if (proto.empty === undefined) {
    proto.empty = function (this: HTMLElement) {
      this.replaceChildren();
    };
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EpubView location events (F2.5)", () => {
  it("records the last CFI under the current book's vault path", async () => {
    vi.useFakeTimers();
    const rememberEpubLocation = vi.fn(async () => undefined);
    const view = new EpubView(makeLeaf(), makeHost({ rememberEpubLocation }));
    const file = makeFile("Books/Test.epub");
    await view.onLoadFile(file);

    epub.emit(
      "relocated",
      relocatedAt("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(150);

    expect(rememberEpubLocation).toHaveBeenCalledOnce();
    expect(rememberEpubLocation).toHaveBeenCalledWith(
      file.path,
      "#epubcfi(/6/8!/4/2/1:0)",
    );
    await view.onClose();
  });

  it("records the rendition's current CFI when closed inside the debounce window", async () => {
    vi.useFakeTimers();
    const rememberEpubLocation = vi.fn(async () => undefined);
    const view = new EpubView(makeLeaf(), makeHost({ rememberEpubLocation }));
    const file = makeFile("Books/Test.epub");
    await view.onLoadFile(file);

    epub.emit(
      "relocated",
      relocatedAt("epubcfi(/6/14!/4/2/12:0)", "chapters/ch3.xhtml"),
    );
    await view.onClose();

    expect(rememberEpubLocation).toHaveBeenCalledOnce();
    expect(rememberEpubLocation).toHaveBeenCalledWith(
      file.path,
      "#epubcfi(/6/14!/4/2/12:0)",
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(rememberEpubLocation).toHaveBeenCalledOnce();
  });

  it("logs a rendition CFI that the anchor grammar rejects on close", async () => {
    vi.useFakeTimers();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const view = new EpubView(makeLeaf(), makeHost());
    await view.onLoadFile(makeFile("Books/Test.epub"));

    epub.emit(
      "relocated",
      relocatedAt("not-a-cfi", "chapters/ch1.xhtml"),
    );
    await view.onClose();

    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "Observation Car: could not save EPUB location",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("emits a debounced LocationChanged with {file, fragment, chapter, label}", async () => {
    vi.useFakeTimers();
    const view = new EpubView(makeLeaf(), makeHost());
    const events: EpubLocationEvent[] = [];
    view.on("location", (loc) => events.push(loc));

    const file = makeFile("Books/Test.epub");
    await view.onLoadFile(file);
    await vi.advanceTimersByTimeAsync(0); // navigation promise resolves

    epub.emit(
      "relocated",
      relocatedAt("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(149);
    expect(events).toHaveLength(0); // still inside the debounce window
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toHaveLength(1);
    expect(events[0].file).toBe(file);
    expect(events[0].fragment).toBe("#epubcfi(/6/8!/4/2/1:0)");
    expect(events[0].chapter).toBe(3);
    expect(events[0].label).toBe("The Opening Image");
    await view.onClose();
  });

  it("delivers the first relocation to subscribers attached before the book loads", async () => {
    vi.useFakeTimers();
    const view = new EpubView(makeLeaf(), makeHost());
    const events: EpubLocationEvent[] = [];
    const unsubscribe = view.on("location", (loc) => events.push(loc));

    // The sync layer subscribes when the leaf opens a file — before the
    // book has displayed — so the pre-load subscription must survive.
    await view.onLoadFile(makeFile("Books/Test.epub"));
    await vi.advanceTimersByTimeAsync(0);
    epub.emit(
      "relocated",
      relocatedAt("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(events).toHaveLength(1);

    unsubscribe();
    epub.emit(
      "relocated",
      relocatedAt("epubcfi(/6/14!/4/2/12:0)", "chapters/ch3.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(events).toHaveLength(1); // unsubscribed: no further events
    await view.onClose();
  });

  it("keeps the subscription alive across a book swap in the same leaf", async () => {
    vi.useFakeTimers();
    const view = new EpubView(makeLeaf(), makeHost());
    const events: EpubLocationEvent[] = [];
    view.on("location", (loc) => events.push(loc));

    const first = makeFile("Books/One.epub");
    await view.onLoadFile(first);
    await vi.advanceTimersByTimeAsync(0);
    epub.emit(
      "relocated",
      relocatedAt("epubcfi(/2/2!/4/2/1:0)", "chapters/ch1.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(events).toHaveLength(1);
    expect(events[0].file).toBe(first);
    expect(events[0].chapter).toBe(0);

    // Opening a second .epub in this leaf re-enters onLoadFile (F2.1);
    // the old reader is disposed first, and its locations can no longer
    // drive this view's events.
    const second = makeFile("Books/Two.epub");
    await view.onLoadFile(second);
    await vi.advanceTimersByTimeAsync(0);
    epub.emit(
      "relocated",
      relocatedAt("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(events).toHaveLength(2);
    expect(events[1].file).toBe(second);
    expect(events[1].chapter).toBe(3);
    await view.onClose();
  });

  it("cancels a pending event on close", async () => {
    vi.useFakeTimers();
    const view = new EpubView(makeLeaf(), makeHost());
    await view.onLoadFile(makeFile("Books/Test.epub"));
    await vi.advanceTimersByTimeAsync(0);

    const events: EpubLocationEvent[] = [];
    view.on("location", (loc) => events.push(loc));
    epub.emit(
      "relocated",
      relocatedAt("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"),
    );

    // The event is pending in its 150 ms window when the leaf closes.
    await view.onClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toHaveLength(0);
  });

  it("detaches the rendition listener on close", async () => {
    vi.useFakeTimers();
    const view = new EpubView(makeLeaf(), makeHost());
    const events: EpubLocationEvent[] = [];
    view.on("location", (loc) => events.push(loc));
    await view.onLoadFile(makeFile("Books/Test.epub"));
    await vi.advanceTimersByTimeAsync(0);
    await view.onClose();

    // The relocated listener is detached, so a late event from a dying
    // book never reaches the view.
    expect(
      epub.emit(
        "relocated",
        relocatedAt("epubcfi(/6/14!/4/2/12:0)", "chapters/ch3.xhtml"),
      ),
    ).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toHaveLength(0);
  });

  it("adds no listeners to document or window", async () => {
    vi.useFakeTimers();
    const windowSpy = vi.spyOn(window, "addEventListener");
    const documentSpy = vi.spyOn(document, "addEventListener");

    const view = new EpubView(makeLeaf(), makeHost());
    await view.onLoadFile(makeFile("Books/Test.epub"));
    await vi.advanceTimersByTimeAsync(150);
    epub.emit(
      "relocated",
      relocatedAt("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"),
    );
    await vi.advanceTimersByTimeAsync(150);
    await view.onClose();

    expect(windowSpy).not.toHaveBeenCalled();
    expect(documentSpy).not.toHaveBeenCalled();
    windowSpy.mockRestore();
    documentSpy.mockRestore();
  });
});
