// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Book, Rendition } from "epubjs";
import { EpubNavigationTools, EpubSelectionTracker } from "./epubNavigationTools";

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
