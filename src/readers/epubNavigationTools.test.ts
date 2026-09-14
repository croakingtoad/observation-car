// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Book, Rendition } from "epubjs";
import {
  EpubKeyBridge,
  EpubNavigationTools,
  EpubSelectionTracker,
  type EpubKeyBridgeRendition,
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
    themes: { register: vi.fn(), select: vi.fn(), override: vi.fn() },
    location: null,
    handlers,
  };
}

type RenderedHandler = Parameters<EpubKeyBridgeRendition["on"]>[1];

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
} = {}) {
  const viewerEl = document.createElement("div");
  const book = makeBook(overrides);
  const rendition = makeRendition();
  const tools = new EpubNavigationTools(
    viewerEl,
    "library/book.epub",
    book as unknown as Book,
    rendition as unknown as Rendition,
    new EpubSelectionTracker(),
  );
  return { viewerEl, book, rendition, tools };
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
  rendition.fire("selected", SELECTION_CFI, {
    window: { getSelection: () => selection },
    document: { defaultView: null },
  });
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
    await vi.waitFor(() => {
      expect(rendition.handlers.get("selected")).toBeDefined();
    });
    fireSelection(rendition);

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
    await vi.waitFor(() => {
      expect(rendition.handlers.get("selected")).toBeDefined();
    });
    fireSelection(rendition);

    const cfiBtn = viewerEl.querySelector(".epub-cfi-copy") as HTMLButtonElement;
    cfiBtn.click();
    await vi.waitFor(() => expect(cfiBtn.textContent).toBe("✖"));
    expect(cfiBtn.title).toMatch(/^Copy failed: /);
    expect(cfiBtn.title).toContain("denied");
  });

  it("copies the quote plus link from the popup", async () => {
    const { viewerEl, rendition } = makeTools();
    await vi.waitFor(() => {
      expect(rendition.handlers.get("selected")).toBeDefined();
    });
    fireSelection(rendition);

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
