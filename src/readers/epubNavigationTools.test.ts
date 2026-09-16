// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Book, Rendition } from "epubjs";
import type { Contents } from "epubjs";
import {
  EpubKeyBridge,
  EpubNavigationTools,
  EpubSelectionTracker,
  type EpubKeyBridgeRendition,
  type EpubFlowControls,
} from "./epubNavigationTools";

const SELECTION_CFI = "epubcfi(/6/4!/4/2/6:32,/2/1:1,/2/1:80)";
const SELECTION_TEXT = "quoted words";

type AnyHandler = (...args: unknown[]) => void;

/**
 * Structural fake of the epubjs Book/Rendition surface the navigation
 * tools consume. The casts at the `makeTools` seam stand in for the real
 * library; the assertions target the tools' own behavior, not epubjs'.
 */
function makeRendition() {
  const handlers = new Map<string, AnyHandler[]>();
  return {
    on: vi.fn((event: string, handler: AnyHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    fire: (event: string, ...args: unknown[]) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(...args);
      }
    },
    prev: vi.fn(),
    next: vi.fn(),
    display: vi.fn(),
    destroy: vi.fn(),
    off: vi.fn((event: string, handler: AnyHandler) => {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter(
          (registered) => registered !== handler,
        ),
      );
    }),
    themes: { register: vi.fn(), select: vi.fn(), override: vi.fn() },
    location: null,
    handlers,
  };
}

type RenderedHandler = Parameters<EpubKeyBridgeRendition["on"]>[1];

const PAGING_EVENT_TYPES = [
  "pointerdown",
  "pointermove",
  "pointercancel",
  "pointerup",
] as const;

function countListeners(
  document: Document,
  type: string,
  implForWrapper: (wrapper: unknown) => {
    _eventListeners?: Record<string, Array<{ callback: unknown }>>;
  },
): number {
  const documentImpl = implForWrapper(document);
  return documentImpl._eventListeners?.[type]?.length ?? 0;
}

class FakeRendition implements EpubKeyBridgeRendition {
  readonly prev = vi.fn(async (): Promise<void> => undefined);
  readonly next = vi.fn(async (): Promise<void> => undefined);
  private readonly renderedHandlers = new Set<RenderedHandler>();

  on(event: "rendered", handler: RenderedHandler): void {
    expect(event).toBe("rendered");
    this.renderedHandlers.add(handler);
  }

  off(event: "rendered", handler: RenderedHandler): void {
    expect(event).toBe("rendered");
    this.renderedHandlers.delete(handler);
  }

  render(document: Document): void {
    for (const handler of this.renderedHandlers) {
      handler({}, renderedContents(document));
    }
  }
}

function keyboardEvent(
  document: Document,
  key: string,
  init: KeyboardEventInit & { keyCode: number },
): KeyboardEvent {
  const KeyboardEventConstructor = document.defaultView?.KeyboardEvent;
  if (KeyboardEventConstructor === undefined) {
    throw new Error("test document has no KeyboardEvent constructor");
  }
  const event = new KeyboardEventConstructor("keydown", { key, ...init });
  Object.defineProperty(event, "keyCode", { value: init.keyCode });
  return event;
}

function documents(): { host: Document; iframe: Document } {
  const hostFrame = document.createElement("iframe");
  document.body.append(hostFrame);
  const host = hostFrame.contentDocument;
  if (host === null) {
    throw new Error("test host iframe has no document");
  }
  const readerFrame = host.createElement("iframe");
  host.body.append(readerFrame);
  const iframe = readerFrame.contentDocument;
  if (iframe === null) {
    throw new Error("test reader iframe has no document");
  }
  return {
    host,
    iframe,
  };
}

function childDocument(parent: Document): Document {
  const frame = parent.createElement("iframe");
  parent.body.append(frame);
  if (frame.contentDocument === null) {
    throw new Error("test iframe has no document");
  }
  return frame.contentDocument;
}

type RenderedView = Pick<Contents, "document" | "window"> & {
  contents: object;
  iframe: Element;
};

function destroyedView(
  document: Document,
): Pick<Contents, "document" | "window"> {
  const renderedWindow = document.defaultView;
  if (renderedWindow === null) {
    throw new Error("test destroyed document has no window");
  }
  Object.defineProperty(renderedWindow, "frameElement", {
    configurable: true,
    value: null,
  });
  return {
    contents: undefined,
    document,
    iframe: undefined,
    window: renderedWindow,
  } as Pick<Contents, "document" | "window">;
}

function renderedContents(document: Document): RenderedView {
  const renderedWindow = document.defaultView;
  if (renderedWindow === null) {
    throw new Error("test rendered document has no window");
  }
  const frameElement = renderedWindow.frameElement;
  if (frameElement === null) {
    throw new Error("test rendered document has no frame element");
  }
  return {
    contents: {},
    document,
    iframe: frameElement,
    window: renderedWindow,
  };
}

describe("EpubKeyBridge", () => {
  it("forwards an equivalent non-paging key event to the host document", () => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());
    rendition.render(iframe);

    const forwarded: KeyboardEvent[] = [];
    host.addEventListener("keydown", (event) => forwarded.push(event));
    iframe.dispatchEvent(
      keyboardEvent(iframe, "p", {
        code: "KeyP",
        keyCode: 80,
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
        altKey: true,
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      key: "p",
      code: "KeyP",
      keyCode: 80,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: true,
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    bridge.destroy();
  });

  it.each([
    ["ArrowLeft", "prev"],
    ["ArrowRight", "next"],
  ] as const)("consumes %s for reader paging", (key, method) => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());
    rendition.render(iframe);
    const hostHandler = vi.fn();
    host.addEventListener("keydown", hostHandler);

    const event = keyboardEvent(iframe, key, {
      code: key,
      keyCode: key === "ArrowLeft" ? 37 : 39,
      bubbles: true,
      cancelable: true,
    });
    iframe.dispatchEvent(event);

    expect(rendition[method]).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(hostHandler).not.toHaveBeenCalled();
    bridge.destroy();
  });

  it("leaves the iframe copy default active exactly once", () => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());
    rendition.render(iframe);
    const hostHandler = vi.fn();
    host.addEventListener("keydown", hostHandler);

    let nativeCopyDefaults = 0;
    iframe.addEventListener("keydown", (event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key === "c" &&
        !event.defaultPrevented
      ) {
        nativeCopyDefaults += 1;
      }
    });
    const event = keyboardEvent(iframe, "c", {
      code: "KeyC",
      keyCode: 67,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    iframe.dispatchEvent(event);

    expect(hostHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(nativeCopyDefaults).toBe(1);
    bridge.destroy();
  });

  it("does not forward a key already handled by the EPUB document", () => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());
    const consumeInBook = (event: KeyboardEvent): void =>
      event.preventDefault();
    iframe.addEventListener("keydown", consumeInBook);
    rendition.render(iframe);
    const hostHandler = vi.fn();
    host.addEventListener("keydown", hostHandler);

    iframe.dispatchEvent(
      keyboardEvent(iframe, "x", {
        code: "KeyX",
        keyCode: 88,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(hostHandler).not.toHaveBeenCalled();
    bridge.destroy();
  });

  it("does not forward its own synthetic event if it returns to the iframe", () => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());
    rendition.render(iframe);
    const forwarded: KeyboardEvent[] = [];
    host.addEventListener("keydown", (event) => forwarded.push(event));

    iframe.dispatchEvent(
      keyboardEvent(iframe, "p", {
        code: "KeyP",
        keyCode: 80,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    iframe.dispatchEvent(forwarded[0]);

    expect(forwarded).toHaveLength(1);
    bridge.destroy();
  });

  it("removes the disposed rendition's document handler before a replacement pages", () => {
    const { host, iframe: oldDocument } = documents();
    const replacementDocument = childDocument(host);
    const oldRendition = new FakeRendition();
    const oldBridge = new EpubKeyBridge(oldRendition, host, vi.fn());
    oldRendition.render(oldDocument);
    oldBridge.destroy();

    const replacementRendition = new FakeRendition();
    const replacementBridge = new EpubKeyBridge(
      replacementRendition,
      host,
      vi.fn(),
    );
    replacementRendition.render(replacementDocument);
    oldDocument.dispatchEvent(
      keyboardEvent(oldDocument, "ArrowRight", {
        code: "ArrowRight",
        keyCode: 39,
        bubbles: true,
        cancelable: true,
      }),
    );
    replacementDocument.dispatchEvent(
      keyboardEvent(replacementDocument, "ArrowRight", {
        code: "ArrowRight",
        keyCode: 39,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(oldRendition.next).not.toHaveBeenCalled();
    expect(replacementRendition.next).toHaveBeenCalledOnce();
    replacementBridge.destroy();
  });

  it("detaches its rendered handler only once across double destroy", () => {
    const rendition = makeRendition();
    const bridge = new EpubKeyBridge(rendition, document, vi.fn());
    const renderedHandler = rendition.handlers.get("rendered")?.[0];
    if (renderedHandler === undefined) {
      throw new Error("test rendition has no rendered handler");
    }

    bridge.destroy();
    bridge.destroy();

    expect(rendition.off).toHaveBeenCalledExactlyOnceWith(
      "rendered",
      renderedHandler,
    );
  });
});

function makeBook(
  overrides: {
    navigation?: Promise<unknown>;
    metadata?: Promise<unknown>;
  } = {},
) {
  return {
    loaded: {
      navigation:
        overrides.navigation ??
        Promise.resolve({ toc: [{ href: "chap1.xhtml", label: "Chapter 1" }] }),
      metadata: overrides.metadata ?? Promise.resolve({ title: "Test Book" }),
    },
    ready: Promise.resolve(),
    locations: {
      generate: vi.fn(async () => undefined),
      locationFromCfi: vi.fn(() => 42),
    },
    destroy: vi.fn(),
  };
}

function makeTools(
  overrides: {
    navigation?: Promise<unknown>;
    metadata?: Promise<unknown>;
    flow?: EpubFlowControls;
    hostDocument?: Document;
  } = {},
  onNewNote?: () => void,
  existingBook?: ReturnType<typeof makeBook>,
) {
  const viewerEl = (overrides.hostDocument ?? document).createElement("div");
  const book = existingBook ?? makeBook(overrides);
  const rendition = makeRendition();
  const beforeRendition = Object.fromEntries(
    ["relocated", "resized", "rendered", "selected"].map((event) => [
      event,
      rendition.handlers.get(event)?.length ?? 0,
    ]),
  );
  const tools = new EpubNavigationTools(
    viewerEl,
    "library/book.epub",
    book as unknown as Book,
    rendition as unknown as Rendition,
    new EpubSelectionTracker(),
    overrides.flow,
    onNewNote === undefined ? undefined : { onNewNote },
  );
  return { viewerEl, book, rendition, tools, beforeRendition };
}

function pointerEvent(
  document: Document,
  type: "pointerdown" | "pointermove" | "pointercancel" | "pointerup",
  init: { bubbles?: boolean; clientX?: number; timeStamp?: number },
): PointerEvent {
  const PointerEventConstructor = document.defaultView?.PointerEvent;
  if (PointerEventConstructor === undefined) {
    throw new Error("test rendered document has no PointerEvent constructor");
  }
  const event = new PointerEventConstructor(type, {
    bubbles: init.bubbles,
    clientX: init.clientX,
  });
  if (init.timeStamp !== undefined) {
    Object.defineProperty(event, "timeStamp", { value: init.timeStamp });
  }
  return event;
}

function selectionContents(): Contents {
  return {
    window: {
      getSelection: () => ({
        rangeCount: 1,
        getRangeAt: () => ({
          getBoundingClientRect: () => ({ left: 5, top: 5, bottom: 15 }),
        }),
        toString: () => SELECTION_TEXT,
      }),
    },
    document: {
      defaultView: {
        frameElement: {
          getBoundingClientRect: () => ({ left: 10, top: 10 }),
        },
      },
    },
  } as unknown as Contents;
}

async function waitForSelectionListener(
  rendition: ReturnType<typeof makeRendition>,
): Promise<void> {
  await vi.waitFor(() => {
    expect(rendition.handlers.get("selected")).toHaveLength(1);
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("reader action toolbar", () => {
  it("offers New note here and invokes the supplied action", () => {
    const onNewNote = vi.fn();
    const { viewerEl } = makeTools({}, onNewNote);
    const button = viewerEl.querySelector<HTMLButtonElement>(
      ".epub-new-note-button",
    );

    expect(button?.title).toBe("New note here");
    expect(button?.getAttribute("aria-label")).toBe("New note here");
    button?.click();
    expect(onNewNote).toHaveBeenCalledOnce();
  });
});

/**
 * Fire the rendition's "selected" event the way epubjs does for a
 * two-character-range selection, wiring the popup copy handlers.
 */
function fireSelection(rendition: ReturnType<typeof makeRendition>): void {
  rendition.fire("selected", SELECTION_CFI, selectionContents());
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // jsdom has no async Clipboard API; stub it per test.
  writeText = vi.fn();
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

async function waitForTocCopyButton(
  viewerEl: HTMLElement,
): Promise<HTMLButtonElement> {
  await vi.waitFor(() => {
    expect(viewerEl.querySelector(".epub-toc-copy")).toBeInstanceOf(
      HTMLButtonElement,
    );
  });
  return viewerEl.querySelector(".epub-toc-copy") as HTMLButtonElement;
}

describe("EpubNavigationTools clipboard copy (Tier 2 finding 3)", () => {
  it("flashes the TOC copy button only after the write settles", async () => {
    let resolveWrite: () => void = () => {};
    writeText.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const { viewerEl } = makeTools();
    const btn = await waitForTocCopyButton(viewerEl);

    btn.click();
    expect(writeText).toHaveBeenCalledWith(
      "[[library/book.epub#chap1.xhtml|Test Book, Chapter 1]]",
    );
    // The write is still pending — no ✔ yet.
    expect(btn.textContent).toBe("🔗");

    resolveWrite();
    await vi.waitFor(() => expect(btn.textContent).toBe("✔"));
  });

  it("shows a readable failure state when the clipboard write is rejected", async () => {
    writeText.mockRejectedValue(
      new DOMException("Clipboard access denied", "NotAllowedError"),
    );
    const { viewerEl } = makeTools();
    const btn = await waitForTocCopyButton(viewerEl);

    btn.click();
    await vi.waitFor(() => expect(btn.textContent).toBe("✖"));
    // The exact DOMException message shape varies by environment
    // (jsdom prefixes the name); the contract is a readable reason.
    expect(btn.title).toMatch(/^Copy failed: /);
    expect(btn.title).toContain("Clipboard access denied");
  });

  it("copies the selection link and flashes the popup button on success", async () => {
    const { viewerEl, rendition } = makeTools();
    await waitForSelectionListener(rendition);
    fireSelection(rendition);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cfiBtn = viewerEl.querySelector(
      ".epub-cfi-copy",
    ) as HTMLButtonElement;
    cfiBtn.click();
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `[[library/book.epub#${SELECTION_CFI}|Test Book, loc. 42]]`,
      ),
    );
    await vi.waitFor(() => expect(cfiBtn.textContent).toBe("✔"));
  });

  it("shows the failure state on the popup button when the write is rejected", async () => {
    writeText.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const { viewerEl, rendition } = makeTools();
    await waitForSelectionListener(rendition);
    fireSelection(rendition);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cfiBtn = viewerEl.querySelector(
      ".epub-cfi-copy",
    ) as HTMLButtonElement;
    cfiBtn.click();
    await vi.waitFor(() => expect(cfiBtn.textContent).toBe("✖"));
    expect(cfiBtn.title).toMatch(/^Copy failed: /);
    expect(cfiBtn.title).toContain("denied");
  });

  it("copies the quote plus link from the popup", async () => {
    const { viewerEl, rendition } = makeTools();
    await waitForSelectionListener(rendition);
    fireSelection(rendition);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const quoteBtn = viewerEl.querySelector(
      ".epub-cfi-quote",
    ) as HTMLButtonElement;
    quoteBtn.click();
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `> ${SELECTION_TEXT}\n-- [[library/book.epub#${SELECTION_CFI}|Test Book, loc. 42]]`,
      ),
    );
    await vi.waitFor(() => expect(quoteBtn.textContent).toBe("✔"));
  });
});

describe("EpubNavigationTools setup failures (Tier 2 finding 3)", () => {
  it("reports a readable error when the book has no navigation", async () => {
    const { viewerEl } = makeTools({
      navigation: Promise.reject(new Error("no navigation in this book")),
    });

    await vi.waitFor(() => {
      expect(viewerEl.querySelectorAll(".epub-setup-error")).toHaveLength(1);
    });
    expect(viewerEl.querySelector(".epub-setup-error")?.textContent).toBe(
      "Table of contents unavailable: no navigation in this book",
    );
    expect(viewerEl.querySelector(".epub-toc-button")).toBeNull();
  });

  it("reports both setup failures when metadata cannot be loaded", async () => {
    const { viewerEl, rendition } = makeTools({
      metadata: Promise.reject(new Error("unparseable metadata")),
    });

    await vi.waitFor(() => {
      expect(viewerEl.querySelectorAll(".epub-setup-error")).toHaveLength(2);
    });
    const messages = [...viewerEl.querySelectorAll(".epub-setup-error")].map(
      (el) => el.textContent,
    );
    expect(messages).toContain(
      "Table of contents unavailable: unparseable metadata",
    );
    expect(messages).toContain(
      "Selection copying unavailable: unparseable metadata",
    );
    // The selection listener never attached when its setup rejected.
    expect(rendition.handlers.get("selected")).toBeUndefined();
  });
});

describe("EpubNavigationTools teardown", () => {
  it("ignores a rendered event from an already-destroyed view", async () => {
    const { rendition } = makeTools({
      flow: { mode: "paginated", onToggle: vi.fn() },
    });
    await vi.waitFor(() => {
      expect(rendition.handlers.get("rendered")).toHaveLength(4);
    });
    const destroyedDocument = childDocument(document);
    const addListener = vi.spyOn(destroyedDocument, "addEventListener");
    expect(() =>
      rendition.fire("rendered", {}, destroyedView(destroyedDocument)),
    ).not.toThrow();
    expect(addListener).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["non-iframe", document.createElement("div")],
  ])(
    "rejects a live rendered view with a %s frame handle",
    async (_name, handle) => {
      const { rendition } = makeTools();
      await vi.waitFor(() => {
        expect(rendition.handlers.get("rendered")).toHaveLength(4);
      });
      const liveDocument = childDocument(document);
      const liveView = renderedContents(liveDocument);
      Object.defineProperty(liveView.window, "frameElement", {
        configurable: true,
        value: handle,
      });

      expect(() => rendition.fire("rendered", {}, liveView)).toThrow(
        "epub.js rendered contents without an iframe frame element",
      );
    },
  );

  it("prunes discarded iframe listeners while the book stays open", async () => {
    const { rendition, tools } = makeTools({
      flow: { mode: "paginated", onToggle: vi.fn() },
    });
    const implForWrapper = await loadImplForWrapper();
    await waitForSelectionListener(rendition);
    await vi.waitFor(() => {
      expect(rendition.handlers.get("rendered")).toHaveLength(4);
    });

    const readCounts = () => {
      const state = tools as unknown as {
        documentListeners: Map<Document, unknown>;
        keyBridge: { documents: Map<Document, unknown> };
        pagingListeners: Set<{ document: Document; remove: () => void }>;
      };
      return {
        documentListeners: state.documentListeners.size,
        keyBridgeDocuments: state.keyBridge.documents.size,
        pagingListeners: state.pagingListeners.size,
      };
    };

    const registeredTypes = [
      "keydown",
      "selectionchange",
      "mousedown",
      ...PAGING_EVENT_TYPES,
    ];
    let lastDocument: Document | null = null;
    let previousRemovedTypes: string[] | null = null;
    for (let viewIndex = 0; viewIndex < 40; viewIndex += 1) {
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const frameDocument = frame.contentDocument;
      if (frameDocument === null) {
        throw new Error("test iframe has no document");
      }
      Object.defineProperty(frameDocument.body, "clientWidth", {
        configurable: true,
        value: 300,
      });
      Object.defineProperty(frameDocument.documentElement, "clientWidth", {
        configurable: true,
        value: 300,
      });

      rendition.fire("rendered", {}, renderedContents(frameDocument));
      if (previousRemovedTypes !== null) {
        expect(new Set(previousRemovedTypes)).toEqual(new Set(registeredTypes));
      }
      const counts = readCounts();
      expect(counts.documentListeners).toBeLessThanOrEqual(1);
      expect(counts.keyBridgeDocuments).toBeLessThanOrEqual(1);
      expect(counts.pagingListeners).toBeLessThanOrEqual(1);
      expect(countListeners(frameDocument, "keydown", implForWrapper)).toBe(1);
      expect(
        countListeners(frameDocument, "selectionchange", implForWrapper),
      ).toBe(1);
      expect(countListeners(frameDocument, "mousedown", implForWrapper)).toBe(
        1,
      );
      for (const type of PAGING_EVENT_TYPES) {
        expect(countListeners(frameDocument, type, implForWrapper)).toBe(1);
      }
      const removedTypes: string[] = [];
      const removeEventListener =
        frameDocument.removeEventListener.bind(frameDocument);
      vi.spyOn(frameDocument, "removeEventListener").mockImplementation(
        (type, listener, options) => {
          removedTypes.push(type);
          removeEventListener(type, listener, options);
        },
      );
      previousRemovedTypes = removedTypes;
      lastDocument = frameDocument;
      frame.remove();
    }
    tools.destroy();

    expect(new Set(previousRemovedTypes)).toEqual(new Set(registeredTypes));
    expect(readCounts()).toEqual({
      documentListeners: 0,
      keyBridgeDocuments: 0,
      pagingListeners: 0,
    });
    expect(lastDocument?.documentElement.style.touchAction).toBe("");
  });

  it.each([
    {
      flow: {
        mode: "scrolled",
        onToggle: vi.fn(),
      },
      name: "scrolled flow",
    },
    { flow: undefined, name: "omitted flow" },
  ] satisfies Array<{ flow: EpubFlowControls | undefined; name: string }>)(
    "prunes discarded document listeners with $name",
    async ({ flow }) => {
      const { rendition, tools } = makeTools({ flow });
      await vi.waitFor(() => {
        expect(rendition.handlers.get("rendered")).toHaveLength(4);
      });
      const discardedFrame = document.createElement("iframe");
      const replacementFrame = document.createElement("iframe");
      document.body.append(discardedFrame, replacementFrame);
      const discardedDocument = discardedFrame.contentDocument;
      const replacementDocument = replacementFrame.contentDocument;
      if (discardedDocument === null || replacementDocument === null) {
        throw new Error("test iframe has no document");
      }

      rendition.fire("rendered", {}, renderedContents(discardedDocument));
      const removedTypes: string[] = [];
      const removeEventListener =
        discardedDocument.removeEventListener.bind(discardedDocument);
      vi.spyOn(discardedDocument, "removeEventListener").mockImplementation(
        (type, listener, options) => {
          removedTypes.push(type);
          removeEventListener(type, listener, options);
        },
      );
      discardedFrame.remove();
      rendition.fire("rendered", {}, renderedContents(replacementDocument));

      expect(new Set(removedTypes)).toEqual(new Set(["keydown", "selectionchange", "mousedown"]));
      tools.destroy();
    },
  );

  it("removes discarded paging listeners on the next rendered view", async () => {
    const { rendition, tools } = makeTools({
      flow: { mode: "paginated", onToggle: vi.fn() },
    });

    await vi.waitFor(() => {
      expect(rendition.handlers.get("rendered")).toHaveLength(4);
    });
    const state = tools as unknown as {
      pagingListeners: Set<{ document: Document; remove: () => void }>;
    };

    const { oldDocument, newDocument, discardOldView } = (() => {
      const oldFrame = document.createElement("iframe");
      const newFrame = document.createElement("iframe");
      document.body.append(oldFrame, newFrame);
      const oldFrameDocument = oldFrame.contentDocument;
      const newFrameDocument = newFrame.contentDocument;
      if (oldFrameDocument === null || newFrameDocument === null) {
        throw new Error("test iframe has no document");
      }
      oldFrameDocument.documentElement.append(
        oldFrameDocument.createElement("body"),
      );
      newFrameDocument.documentElement.append(
        newFrameDocument.createElement("body"),
      );
      Object.defineProperty(newFrameDocument.body, "clientWidth", {
        configurable: true,
        value: 300,
      });
      Object.defineProperty(newFrameDocument.documentElement, "clientWidth", {
        configurable: true,
        value: 300,
      });
      Object.defineProperty(oldFrameDocument.body, "clientWidth", {
        configurable: true,
        value: 300,
      });
      Object.defineProperty(oldFrameDocument.documentElement, "clientWidth", {
        configurable: true,
        value: 300,
      });
      return {
        oldDocument: oldFrameDocument,
        newDocument: newFrameDocument,
        discardOldView: () => oldFrame.remove(),
      };
    })();

    oldDocument.documentElement.append(oldDocument.createElement("body"));

    rendition.fire("rendered", {}, renderedContents(oldDocument));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.pagingListeners.size).toBe(1);

    oldDocument.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
    oldDocument.dispatchEvent(new PointerEvent("pointerup", { clientX: 0 }));

    discardOldView();
    rendition.fire("rendered", {}, renderedContents(newDocument));

    expect(
      oldDocument.documentElement.style.getPropertyValue("touch-action"),
    ).toBe("");

    expect(state.pagingListeners.size).toBe(1);
    newDocument.dispatchEvent(
      pointerEvent(newDocument, "pointerdown", { clientX: 250 }),
    );
    newDocument.dispatchEvent(
      pointerEvent(newDocument, "pointerup", { clientX: 250 }),
    );
    expect(rendition.next).toHaveBeenCalledTimes(1);
  });

  it("ignores a repeated pointerup after a completed paging press", () => {
    const { rendition, tools } = makeTools({
      flow: { mode: "paginated", onToggle: vi.fn() },
    });
    const doc = childDocument(document);
    Object.defineProperty(doc.body, "clientWidth", {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(doc.documentElement, "clientWidth", {
      configurable: true,
      value: 300,
    });

    rendition.fire("rendered", {}, renderedContents(doc));
    doc.dispatchEvent(
      pointerEvent(doc, "pointerdown", { clientX: 10, timeStamp: 100 }),
    );
    doc.dispatchEvent(
      pointerEvent(doc, "pointerup", { clientX: 10, timeStamp: 150 }),
    );
    doc.dispatchEvent(
      pointerEvent(doc, "pointerup", { clientX: 10, timeStamp: 200 }),
    );

    expect(rendition.prev).toHaveBeenCalledTimes(1);
    tools.destroy();
  });

  it("cancels paging when pointercancel ends a press", () => {
    const { rendition, tools } = makeTools({
      flow: { mode: "paginated", onToggle: vi.fn() },
    });
    const doc = childDocument(document);
    Object.defineProperty(doc.body, "clientWidth", {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(doc.documentElement, "clientWidth", {
      configurable: true,
      value: 300,
    });

    rendition.fire("rendered", {}, renderedContents(doc));
    doc.dispatchEvent(
      pointerEvent(doc, "pointerdown", { clientX: 10, timeStamp: 100 }),
    );
    doc.dispatchEvent(pointerEvent(doc, "pointercancel", { timeStamp: 120 }));
    doc.dispatchEvent(
      pointerEvent(doc, "pointerup", { clientX: 10, timeStamp: 150 }),
    );

    expect(rendition.prev).not.toHaveBeenCalled();
    tools.destroy();
  });

  it("uses maximum pointer travel, not release position, for tap slop", () => {
    const { rendition, tools } = makeTools({
      flow: { mode: "paginated", onToggle: vi.fn() },
    });
    const doc = childDocument(document);
    Object.defineProperty(doc.body, "clientWidth", {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(doc.documentElement, "clientWidth", {
      configurable: true,
      value: 300,
    });

    rendition.fire("rendered", {}, renderedContents(doc));
    doc.dispatchEvent(
      pointerEvent(doc, "pointerdown", { clientX: 10, timeStamp: 100 }),
    );
    doc.dispatchEvent(
      pointerEvent(doc, "pointermove", { clientX: 50, timeStamp: 120 }),
    );
    doc.dispatchEvent(
      pointerEvent(doc, "pointermove", { clientX: 10, timeStamp: 140 }),
    );
    doc.dispatchEvent(
      pointerEvent(doc, "pointerup", { clientX: 10, timeStamp: 150 }),
    );

    expect(rendition.prev).not.toHaveBeenCalled();
    tools.destroy();
  });

  it("treats a link tap at exactly the slop as a link, not a page turn", () => {
    const { rendition, tools } = makeTools({
      flow: { mode: "paginated", onToggle: vi.fn() },
    });
    const doc = childDocument(document);
    const link = doc.createElement("a");
    link.href = "https://example.test/chapter";
    doc.body.append(link);
    Object.defineProperty(doc.body, "clientWidth", {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(doc.documentElement, "clientWidth", {
      configurable: true,
      value: 300,
    });

    rendition.fire("rendered", {}, renderedContents(doc));
    link.dispatchEvent(
      pointerEvent(doc, "pointerdown", {
        bubbles: true,
        clientX: 20,
        timeStamp: 100,
      }),
    );
    link.dispatchEvent(
      pointerEvent(doc, "pointerup", {
        bubbles: true,
        clientX: 10,
        timeStamp: 150,
      }),
    );

    expect(rendition.prev).not.toHaveBeenCalled();
    tools.destroy();
  });

  it("removes every rendition listener the class registered", async () => {
    const { rendition, tools, beforeRendition } = makeTools();

    await waitForSelectionListener(rendition);

    tools.destroy();

    for (const [event, count] of Object.entries(beforeRendition)) {
      expect(rendition.handlers.get(event)?.length).toBe(count);
    }
  });

  it("removes per-iframe listeners from every rendered document", async () => {
    const implForWrapper = await loadImplForWrapper();
    const { rendition, tools } = makeTools();
    await waitForSelectionListener(rendition);
    const first = childDocument(document);
    const second = childDocument(document);
    const before = [first, second].map((document) => ({
      selectionchange: countListeners(
        document,
        "selectionchange",
        implForWrapper,
      ),
      mousedown: countListeners(document, "mousedown", implForWrapper),
    }));

    rendition.fire("rendered", {}, renderedContents(first));
    rendition.fire("rendered", {}, renderedContents(second));
    tools.destroy();

    [first, second].forEach((document, index) => {
      expect(countListeners(document, "selectionchange", implForWrapper)).toBe(
        before[index].selectionchange,
      );
      expect(countListeners(document, "mousedown", implForWrapper)).toBe(
        before[index].mousedown,
      );
    });
  });

  it("removes pre-rendered iframe listeners when destroyed", async () => {
    const implForWrapper = await loadImplForWrapper();
    const { rendition, tools } = makeTools();
    await waitForSelectionListener(rendition);
    const first = childDocument(document);
    const second = childDocument(document);

    rendition.fire("rendered", {}, renderedContents(first));
    rendition.fire("rendered", {}, renderedContents(second));
    tools.destroy();

    for (const renderedDocument of [first, second]) {
      expect(
        countListeners(renderedDocument, "selectionchange", implForWrapper),
      ).toBe(0);
      expect(
        countListeners(renderedDocument, "mousedown", implForWrapper),
      ).toBe(0);
    }
  });

  it("is idempotent", () => {
    const { rendition, tools } = makeTools();
    tools.destroy();
    const afterFirst = new Map(
      [...rendition.handlers].map(([event, handlers]) => [
        event,
        [...handlers],
      ]),
    );

    expect(() => tools.destroy()).not.toThrow();

    for (const [event, handlers] of afterFirst) {
      expect(rendition.handlers.get(event)).toEqual(handlers);
    }
  });

  it("removes paging listeners from every rendered document when destroyed", async () => {
    const implForWrapper = await loadImplForWrapper();
    const { rendition, tools } = makeTools({
      flow: { mode: "paginated", onToggle: vi.fn() },
    });
    await waitForSelectionListener(rendition);
    const first = childDocument(document);
    const second = childDocument(document);
    const before = [first, second].map((renderedDocument) =>
      PAGING_EVENT_TYPES.map((type) => ({
        type,
        count: countListeners(renderedDocument, type, implForWrapper),
      })),
    );

    rendition.fire("rendered", {}, renderedContents(first));
    rendition.fire("rendered", {}, renderedContents(second));
    tools.destroy();

    [first, second].forEach((renderedDocument, documentIndex) => {
      for (const { type, count } of before[documentIndex]) {
        expect(countListeners(renderedDocument, type, implForWrapper)).toBe(
          count,
        );
      }
    });
  });

  it("removes the viewerEl keydown listener when destroyed", async () => {
    const implForWrapper = await loadImplForWrapper();
    const { rendition, viewerEl, tools } = makeTools({
      flow: { mode: "paginated", onToggle: vi.fn() },
    });
    await waitForSelectionListener(rendition);

    await vi.waitFor(() => {
      expect(viewerEl.querySelector(".epub-toc-button")).not.toBeNull();
    });

    const countBefore = countListeners(
      viewerEl as unknown as Document,
      "keydown",
      implForWrapper,
    );
    expect(countBefore).toBe(1);

    tools.destroy();

    const countAfter = countListeners(
      viewerEl as unknown as Document,
      "keydown",
      implForWrapper,
    );
    expect(countAfter).toBe(0);
  });

  it("resets touch-action on every rendered document when destroyed", async () => {
    const { rendition, tools } = makeTools({
      flow: { mode: "paginated", onToggle: vi.fn() },
    });
    await waitForSelectionListener(rendition);
    const doc = childDocument(document);

    rendition.fire("rendered", {}, renderedContents(doc));
    expect(doc.documentElement.style.touchAction).toBe("pan-y");

    tools.destroy();
    expect(doc.documentElement.style.touchAction).toBe("");
  });

  it("does not register async setup listeners after destroy", async () => {
    let resolveMetadata: (metadata: { title: string }) => void = () => {};
    let resolveNavigation: (navigation: { toc: unknown[] }) => void = () => {};
    const { rendition, tools, viewerEl } = makeTools({
      metadata: new Promise((resolve) => {
        resolveMetadata = resolve;
      }),
      navigation: new Promise((resolve) => {
        resolveNavigation = resolve;
      }),
    });
    resolveMetadata({ title: "Late Book" });
    resolveNavigation({ toc: [] });
    tools.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rendition.handlers.get("selected")?.length ?? 0).toBe(0);
    expect(rendition.handlers.get("rendered")?.length ?? 0).toBe(0);
    expect(viewerEl.querySelector(".epub-toc-button")).toBeNull();
  });

  it("drives direct onRendered after destroy", async () => {
    const selectionTrackerClear = vi.spyOn(
      EpubSelectionTracker.prototype,
      "clear",
    );
    const { rendition, tools, viewerEl } = makeTools();
    tools.destroy();

    fireSelection(rendition);
    const firstDocument = childDocument(document);
    (
      tools as unknown as {
        onRendered: (
          section: unknown,
          contents: Pick<Contents, "document" | "window">,
        ) => void;
      }
    ).onRendered({}, renderedContents(firstDocument));
    await new Promise((resolve) => setTimeout(resolve, 0));

    fireSelection(rendition);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await vi.waitFor(() => {
      expect(
        viewerEl.querySelector(".epub-cfi-popup")?.classList.contains("open"),
      ).toBe(false);
    });
    expect(selectionTrackerClear).not.toHaveBeenCalled();
  });

  it("drives direct onTocRendered after destroy", () => {
    const { tools } = makeTools();
    tools.destroy();

    const firstDocument = childDocument(document);
    const addEventListenerSpy = vi.spyOn(firstDocument, "addEventListener");
    (
      tools as unknown as {
        onTocRendered: (
          section: unknown,
          contents: Pick<Contents, "document" | "window">,
        ) => void;
      }
    ).onTocRendered({}, renderedContents(firstDocument));

    expect(addEventListenerSpy).not.toHaveBeenCalled();
  });

  it("closes the TOC through the host keydown listener", async () => {
    const { viewerEl } = makeTools();

    await vi.waitFor(() => {
      expect(viewerEl.querySelector(".epub-toc-button")).not.toBeNull();
    });

    const tocButton =
      viewerEl.querySelector<HTMLButtonElement>(".epub-toc-button");
    const tocPanel = viewerEl.querySelector<HTMLDivElement>(".epub-toc-panel");
    if (!tocButton || !tocPanel) {
      throw new Error("Expected TOC chrome to be rendered");
    }

    tocButton.onclick?.(
      new MouseEvent("click", { bubbles: true }) as PointerEvent,
    );
    expect(tocPanel.classList.contains("open")).toBe(true);

    viewerEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(tocPanel.classList.contains("open")).toBe(false);

    viewerEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(tocPanel.classList.contains("open")).toBe(false);

    viewerEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(tocPanel.classList.contains("open")).toBe(false);
  });

  it("closes the TOC through a pop-out window's keydown listener", async () => {
    const hostDocument = childDocument(document);
    const { viewerEl } = makeTools({ hostDocument });

    await vi.waitFor(() => {
      expect(viewerEl.querySelector(".epub-toc-button")).not.toBeNull();
    });

    const tocButton =
      viewerEl.querySelector<HTMLButtonElement>(".epub-toc-button");
    const tocPanel = viewerEl.querySelector<HTMLDivElement>(".epub-toc-panel");
    if (!tocButton || !tocPanel) {
      throw new Error("Expected TOC chrome to be rendered");
    }

    tocButton.click();
    expect(tocPanel.classList.contains("open")).toBe(true);

    const event = keyboardEvent(hostDocument, "Escape", {
      keyCode: 27,
      bubbles: true,
      cancelable: true,
    });
    expect(event).not.toBeInstanceOf(KeyboardEvent);
    viewerEl.dispatchEvent(event);

    expect(tocPanel.classList.contains("open")).toBe(false);
  });
});

describe("EpubNavigationTools lifecycle coverage fences", () => {
  it("does not attach paging listeners in scrolled mode", async () => {
    const implForWrapper = await loadImplForWrapper();
    const { rendition, viewerEl, tools } = makeTools({
      flow: { mode: "scrolled", onToggle: vi.fn() },
    });
    vi.spyOn(viewerEl, "addEventListener");
    const renderedDocument = childDocument(document);

    rendition.fire("rendered", {}, renderedContents(renderedDocument));

    for (const type of PAGING_EVENT_TYPES) {
      expect(countListeners(renderedDocument, type, implForWrapper)).toBe(0);
    }
    const registeredPagingTypes = (
      viewerEl.addEventListener as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([type]) =>
      PAGING_EVENT_TYPES.includes(type as (typeof PAGING_EVENT_TYPES)[number]),
    );
    expect(registeredPagingTypes).toEqual([]);
    expect(renderedDocument.documentElement.style.touchAction).toBe("");
    tools.destroy();
  });

  it("does not run the selected handler detached by destroy", async () => {
    const selectionTrackerSetSelected = vi.spyOn(
      EpubSelectionTracker.prototype,
      "setSelected",
    );
    const { rendition, tools, viewerEl } = makeTools();
    await waitForSelectionListener(rendition);
    tools.destroy();

    fireSelection(rendition);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(selectionTrackerSetSelected).not.toHaveBeenCalled();
    expect(
      viewerEl.querySelector(".epub-cfi-popup")?.classList.contains("open"),
    ).toBe(false);
  });

  it(
    "does not show a selection from an in-flight event after destroy",
    async () => {
      const selectionTrackerSetSelected = vi.spyOn(
        EpubSelectionTracker.prototype,
        "setSelected",
      );
      const bookTitle = {
        then: vi.fn((resolve: (title: string) => void) => {
          resolve("Late Book");
        }),
      } as unknown as Promise<string>;
      const { rendition, tools, viewerEl } = makeTools();
      await waitForSelectionListener(rendition);
      Object.defineProperty(tools, "bookTitle", {
        configurable: true,
        value: bookTitle,
      });
      const selectedHandler = rendition.handlers.get("selected")?.[0];
      if (selectedHandler === undefined) {
        throw new Error("test rendition has no selected handler");
      }
      tools.destroy();

      selectedHandler(SELECTION_CFI, selectionContents());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(bookTitle.then).not.toHaveBeenCalled();
      expect(selectionTrackerSetSelected).not.toHaveBeenCalled();
      expect(
        viewerEl.querySelector(".epub-cfi-popup")?.classList.contains("open"),
      ).toBe(false);
    },
  );

  it("does not show a selection if destroyed while awaiting the book title", async () => {
    const selectionTrackerSetSelected = vi.spyOn(
      EpubSelectionTracker.prototype,
      "setSelected",
    );
    let resolveBookTitle: (title: string) => void = () => {};
    const { rendition, tools, viewerEl } = makeTools();
    await waitForSelectionListener(rendition);
    Object.defineProperty(tools, "bookTitle", {
      configurable: true,
      value: new Promise<string>((resolve) => {
        resolveBookTitle = resolve;
      }),
    });

    fireSelection(rendition);
    await new Promise((resolve) => setTimeout(resolve, 0));
    tools.destroy();
    resolveBookTitle("Late Book");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(selectionTrackerSetSelected).not.toHaveBeenCalled();
    expect(
      viewerEl.querySelector(".epub-cfi-popup")?.classList.contains("open"),
    ).toBe(false);
  });

  it("does not add paging listeners from direct onPageRendered after destroy", () => {
    const implForWrapper = loadImplForWrapper();
    const { tools } = makeTools({
      flow: { mode: "paginated", onToggle: vi.fn() },
    });
    tools.destroy();

    const renderedDocument = childDocument(document);
    (
      tools as unknown as {
        onPageRendered: (
          section: unknown,
          view: Pick<Contents, "document" | "window">,
        ) => void;
      }
    ).onPageRendered({}, renderedContents(renderedDocument));

    expect(renderedDocument.documentElement.style.touchAction).toBe("");
    return implForWrapper.then((impl) => {
      for (const type of PAGING_EVENT_TYPES) {
        expect(countListeners(renderedDocument, type, impl)).toBe(0);
      }
    });
  });

  it("removes each listener and touch-action exactly once across double destroy", async () => {
    const { rendition, tools } = makeTools({
      flow: { mode: "paginated", onToggle: vi.fn() },
    });
    await waitForSelectionListener(rendition);
    const renderedDocument = childDocument(document);
    const removeCalls: string[] = [];
    const removeEventListener =
      renderedDocument.removeEventListener.bind(renderedDocument);
    vi.spyOn(renderedDocument, "removeEventListener").mockImplementation(
      (type, listener, options) => {
        removeCalls.push(type);
        removeEventListener(type, listener, options);
      },
    );

    rendition.fire("rendered", {}, renderedContents(renderedDocument));
    tools.destroy();
    const callsAfterFirstDestroy = [...removeCalls];
    tools.destroy();

    expect(callsAfterFirstDestroy).toEqual([
      "keydown",
      "selectionchange",
      "mousedown",
      ...PAGING_EVENT_TYPES,
    ]);
    expect(removeCalls).toEqual(callsAfterFirstDestroy);
    expect(renderedDocument.documentElement.style.touchAction).toBe("");
  });

  it("does not repeat rendition detaches across double destroy", async () => {
    const { rendition, tools } = makeTools({
      flow: { mode: "paginated", onToggle: vi.fn() },
    });
    await waitForSelectionListener(rendition);
    tools.destroy();
    const detachCalls = [...rendition.off.mock.calls];
    tools.destroy();

    expect(rendition.off.mock.calls).toEqual(detachCalls);
  });

  it("retains one document while rendering distinct views before pruning", async () => {
    const { rendition, tools } = makeTools({
      flow: { mode: "paginated", onToggle: vi.fn() },
    });
    await waitForSelectionListener(rendition);
    const state = tools as unknown as {
      documentListeners: Map<Document, unknown>;
      keyBridge: { documents: Map<Document, unknown> };
      pagingListeners: Set<{ document: Document; remove: () => void }>;
    };
    const discardedFrame = document.createElement("iframe");
    document.body.append(discardedFrame);
    const discardedDocument = discardedFrame.contentDocument;
    if (discardedDocument === null) {
      throw new Error("test discarded iframe has no document");
    }
    const discardedView = renderedContents(discardedDocument);

    rendition.fire("rendered", {}, discardedView);
    expect(state.documentListeners.size).toBe(1);
    expect(state.keyBridge.documents.size).toBe(1);
    expect(state.pagingListeners.size).toBe(1);

    const removeEventListener = vi.spyOn(
      discardedDocument,
      "removeEventListener",
    );
    discardedFrame.remove();
    rendition.fire("rendered", {}, renderedContents(childDocument(document)));

    expect(state.documentListeners.size).toBe(1);
    expect(state.keyBridge.documents.size).toBe(1);
    expect(state.pagingListeners.size).toBe(1);
    expect(state.documentListeners.has(discardedDocument)).toBe(false);
    expect(state.keyBridge.documents.has(discardedDocument)).toBe(false);
    expect([...state.pagingListeners][0].document).not.toBe(discardedDocument);
    expect(new Set(removeEventListener.mock.calls.map(([type]) => type))).toEqual(
      new Set(["keydown", "selectionchange", "mousedown", ...PAGING_EVENT_TYPES]),
    );
    tools.destroy();
  });
});


describe("EpubNavigationTools defect 1: bookTitle escaped in wikilinks (LOCO-1031)", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("escapes bookTitle in TOC link copy when title contains pipes and closing brackets", async () => {
    const unusualBook = makeBook({
      metadata: Promise.resolve({ title: "A|B]] Title" }),
      navigation: Promise.resolve({
        toc: [{ href: "chap1.xhtml", label: "Chapter 1" }],
      }),
    });
    const { viewerEl, rendition } = makeTools({}, undefined, unusualBook);
    await waitForSelectionListener(rendition);
    // render the TOC
    rendition.fire("rendered", {}, renderedContents(childDocument(document)));
    await vi.waitFor(() => {
      expect(viewerEl.querySelector(".epub-toc-copy")).not.toBeNull();
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    (viewerEl.querySelector(".epub-toc-copy") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "[[library/book.epub#chap1.xhtml|A｜B］］ Title, Chapter 1]]",
      );
    });
  });

  it("escapes bookTitle in popup CFI link copy", async () => {
    const unusualBook = makeBook({
      metadata: Promise.resolve({ title: "A|B Title" }),
    });
    const { viewerEl, rendition } = makeTools({}, undefined, unusualBook);
    await waitForSelectionListener(rendition);
    rendition.fire("selected", SELECTION_CFI, selectionContents());
    await vi.waitFor(() => {
      expect(viewerEl.querySelector(".epub-cfi-copy")).not.toBeNull();
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const copyBtn = viewerEl.querySelector<HTMLButtonElement>(".epub-cfi-copy")!;
    copyBtn.click();
    await vi.waitFor(() => expect(copyBtn.textContent).toBe("✔"));
    expect(writeText).toHaveBeenCalledWith(
      `[[library/book.epub#${SELECTION_CFI}|A｜B Title, loc. 42]]`,
    );
  });

  it("escapes bookTitle in popup quote + link copy", async () => {
    const unusualBook = makeBook({
      metadata: Promise.resolve({ title: "]]]]" }),
    });
    const { viewerEl, rendition } = makeTools({}, undefined, unusualBook);
    await waitForSelectionListener(rendition);
    rendition.fire("selected", SELECTION_CFI, selectionContents());
    await vi.waitFor(() => {
      expect(viewerEl.querySelector(".epub-cfi-quote")).not.toBeNull();
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const quoteBtn = viewerEl.querySelector<HTMLButtonElement>(".epub-cfi-quote")!;
    quoteBtn.click();
    await vi.waitFor(() => expect(quoteBtn.textContent).toBe("✔"));
    expect(writeText).toHaveBeenCalledWith(
      `> ${SELECTION_TEXT}
-- [[library/book.epub#${SELECTION_CFI}|］］］］, loc. 42]]`,
    );
  });
});

describe("EpubNavigationTools defect 2: sanitize(undefined) does not throw (LOCO-1031)", () => {
  it("turns a page past an hrefless TOC entry without crashing", async () => {
    const tocWithHrefless: Promise<{ toc: Array<{ href?: string; label: string }> }> = Promise.resolve({
      toc: [
        { href: "chap1.xhtml", label: "Chapter 1" },
        { href: undefined, label: "Group heading" } as unknown as { href: string; label: string },
        { href: "chap2.xhtml", label: "Chapter 2" },
      ],
    });
    const book = makeBook({ navigation: tocWithHrefless as unknown as Promise<unknown> });
    const { rendition, tools } = makeTools({}, undefined, book);
    await waitForSelectionListener(rendition);
    // Render a document so the key bridge attaches
    const doc = childDocument(document);
    rendition.fire("rendered", {}, renderedContents(doc));
    // Now dispatch PageUp while the current location is chap1.xhtml
    // The key bridge routes PageUp to pageKeyJump, which calls
    // sanitize(undefined) on the hrefless entry.
    (tools as unknown as { pageKeyJump: (key: string) => Promise<void> }).pageKeyJump("PageUp");
    // After the jump, rendition.display should have been called with "chap2.xhtml"
    await vi.waitFor(() => {
      expect(rendition.display).toHaveBeenCalledWith("chap2.xhtml");
    });
    tools.destroy();
  });
});

type JsdDocumentImpl = {
  _eventListeners?: Record<string, Array<{ callback: unknown }>>;
};

async function loadImplForWrapper(): Promise<
  (wrapper: unknown) => JsdDocumentImpl
> {
  const utilsModule = await import(
    "jsdom/lib/generated/idl/utils.js" as string
  );
  const utils = (utilsModule.default ?? utilsModule) as unknown as {
    implForWrapper: (wrapper: unknown) => JsdDocumentImpl;
  };
  return utils.implForWrapper;
}
