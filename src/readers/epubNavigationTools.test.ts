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
        (handlers.get(event) ?? []).filter((registered) => registered !== handler),
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
  implForWrapper: (
    wrapper: unknown,
  ) => { _eventListeners?: Record<string, Array<{ callback: unknown }>> },
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
      handler({}, { document });
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
      if ((event.ctrlKey || event.metaKey) && event.key === "c" && !event.defaultPrevented) {
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
    const consumeInBook = (event: KeyboardEvent): void => event.preventDefault();
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
    const replacementBridge = new EpubKeyBridge(replacementRendition, host, vi.fn());
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
});

function makeBook(overrides: {
  navigation?: Promise<unknown>;
  metadata?: Promise<unknown>;
} = {}) {
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

function makeTools(overrides: {
  navigation?: Promise<unknown>;
  metadata?: Promise<unknown>;
  flow?: EpubFlowControls;
} = {}) {
  const viewerEl = document.createElement("div");
  const book = makeBook(overrides);
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
  );
  return { viewerEl, book, rendition, tools, beforeRendition };
}

async function waitForSelectionListener(
  rendition: ReturnType<typeof makeRendition>,
): Promise<void> {
  await vi.waitFor(() => {
    expect(rendition.handlers.get("selected")).toHaveLength(1);
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Fire the rendition's "selected" event the way epubjs does for a
 * two-character-range selection, wiring the popup copy handlers.
 */
function fireSelection(rendition: ReturnType<typeof makeRendition>): void {
  const selection = {
    rangeCount: 1,
    getRangeAt: () => ({
      getBoundingClientRect: () => ({ left: 5, top: 5, bottom: 15 }),
    }),
    toString: () => SELECTION_TEXT,
  };
  const contents = {
    window: { getSelection: () => selection },
    document: {
      defaultView: {
        frameElement: {
          getBoundingClientRect: () => ({
            left: 10,
            top: 10,
          }),
        },
      },
    },
  } as unknown as Contents;
  rendition.fire("selected", SELECTION_CFI, contents);
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

async function waitForTocCopyButton(viewerEl: HTMLElement): Promise<HTMLButtonElement> {
  await vi.waitFor(() => {
    expect(viewerEl.querySelector(".epub-toc-copy")).toBeInstanceOf(HTMLButtonElement);
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

    const cfiBtn = viewerEl.querySelector(".epub-cfi-copy") as HTMLButtonElement;
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

    const cfiBtn = viewerEl.querySelector(".epub-cfi-copy") as HTMLButtonElement;
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

    const quoteBtn = viewerEl.querySelector(".epub-cfi-quote") as HTMLButtonElement;
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
    expect(messages).toContain("Table of contents unavailable: unparseable metadata");
    expect(messages).toContain("Selection copying unavailable: unparseable metadata");
    // The selection listener never attached when its setup rejected.
    expect(rendition.handlers.get("selected")).toBeUndefined();
  });
});


describe("EpubNavigationTools teardown", () => {
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
    const first = document.implementation.createHTMLDocument("first");
    const second = document.implementation.createHTMLDocument("second");
    first.documentElement.append(first.createElement("body"));
    second.documentElement.append(second.createElement("body"));
    const before = [first, second].map((document) => ({
      selectionchange: countListeners(document, "selectionchange", implForWrapper),
      mousedown: countListeners(document, "mousedown", implForWrapper),
    }));

    rendition.fire("rendered", {}, { document: first } as unknown as Contents);
    rendition.fire("rendered", {}, { document: second } as unknown as Contents);
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
    const first = document.implementation.createHTMLDocument("first");
    const second = document.implementation.createHTMLDocument("second");
    first.documentElement.append(first.createElement("body"));
    second.documentElement.append(second.createElement("body"));

    rendition.fire(
      "rendered",
      {},
      { document: first } as unknown as Contents,
    );
    rendition.fire(
      "rendered",
      {},
      { document: second } as unknown as Contents,
    );
    tools.destroy();

    for (const renderedDocument of [first, second]) {
      expect(
        countListeners(renderedDocument, "selectionchange", implForWrapper),
      ).toBe(0);
      expect(countListeners(renderedDocument, "mousedown", implForWrapper)).toBe(
        0,
      );
    }
  });

  it("is idempotent", () => {
    const { rendition, tools } = makeTools();
    tools.destroy();
    const afterFirst = new Map(
      [...rendition.handlers].map(([event, handlers]) => [event, [...handlers]]),
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
    const first = document.implementation.createHTMLDocument("paging-first");
    const second = document.implementation.createHTMLDocument("paging-second");
    first.documentElement.append(first.createElement("body"));
    second.documentElement.append(second.createElement("body"));
    const before = [first, second].map((renderedDocument) =>
      PAGING_EVENT_TYPES.map((type) => ({
        type,
        count: countListeners(renderedDocument, type, implForWrapper),
      })),
    );

    rendition.fire("rendered", {}, { document: first } as unknown as Contents);
    rendition.fire("rendered", {}, { document: second } as unknown as Contents);
    tools.destroy();

    [first, second].forEach((renderedDocument, documentIndex) => {
      for (const { type, count } of before[documentIndex]) {
        expect(countListeners(renderedDocument, type, implForWrapper)).toBe(count);
      }
    });
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
    const selectionTrackerClear = vi.spyOn(EpubSelectionTracker.prototype, "clear");
    const { rendition, tools, viewerEl } = makeTools();
    tools.destroy();

    fireSelection(rendition);
    const firstDocument = document.implementation.createHTMLDocument("late-1");
    firstDocument.documentElement.append(firstDocument.createElement("body"));
    (tools as unknown as {
      onRendered: (section: unknown, contents: { document: Document }) => void;
    }).onRendered({}, { document: firstDocument });
    await new Promise((resolve) => setTimeout(resolve, 0));

    fireSelection(rendition);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await vi.waitFor(() => {
      expect(viewerEl.querySelector(".epub-cfi-popup")?.classList.contains("open")).toBe(false);
    });
    expect(selectionTrackerClear).not.toHaveBeenCalled();
  });

  it("drives direct onTocRendered after destroy", () => {
    const { tools } = makeTools();
    tools.destroy();

    const firstDocument = document.implementation.createHTMLDocument("late-1");
    const addEventListenerSpy = vi.spyOn(firstDocument, "addEventListener");
    (tools as unknown as {
      onTocRendered: (section: unknown, contents: { document: Document }) => void;
    }).onTocRendered({}, { document: firstDocument });

    expect(addEventListenerSpy).not.toHaveBeenCalled();
  });

  it("closes the TOC through the host keydown listener", async () => {
    const { viewerEl } = makeTools();

    await vi.waitFor(() => {
      expect(viewerEl.querySelector(".epub-toc-button")).not.toBeNull();
    });

    const tocButton = viewerEl.querySelector<HTMLButtonElement>(".epub-toc-button");
    const tocPanel = viewerEl.querySelector<HTMLDivElement>(".epub-toc-panel");
    if (!tocButton || !tocPanel) {
      throw new Error("Expected TOC chrome to be rendered");
    }

    tocButton.onclick?.(new MouseEvent("click", { bubbles: true }) as PointerEvent);
    expect(tocPanel.classList.contains("open")).toBe(true);

    viewerEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(tocPanel.classList.contains("open")).toBe(false);

    viewerEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(tocPanel.classList.contains("open")).toBe(false);

    viewerEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(tocPanel.classList.contains("open")).toBe(false);
  });
});

type JsdDocumentImpl = {
  _eventListeners?: Record<string, Array<{ callback: unknown }>>;
};

async function loadImplForWrapper(): Promise<(wrapper: unknown) => JsdDocumentImpl> {
  const utilsModule = await import("jsdom/lib/generated/idl/utils.js" as string);
  const utils = (utilsModule.default ?? utilsModule) as unknown as {
    implForWrapper: (wrapper: unknown) => JsdDocumentImpl;
  };
  return utils.implForWrapper;
}
