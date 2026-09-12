// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Book, Rendition } from "epubjs";
import type { NavItem } from "epubjs/types/navigation";
import { EpubNavigationTools, flattenToc } from "./epubNavigationTools";

let idCounter = 0;
function tocItem(href: string, label: string, subitems?: NavItem[]): NavItem {
  idCounter += 1;
  return { id: `item-${idCounter}`, href, label, subitems };
}

interface ViewerHarness {
  viewerEl: HTMLDivElement;
  displayCalls: string[];
}

/**
 * Build an EpubNavigationTools over stub book/rendition objects and wait for
 * the fire-and-forget TOC panel to finish rendering. The rendition records
 * every `display()` argument so tests can assert on the exact href.
 */
async function buildViewer(
  toc: NavItem[],
  displayImpl?: (target: string) => Promise<void>,
): Promise<ViewerHarness> {
  const viewerEl = document.createElement("div");
  viewerEl.className = "epub-viewer";
  document.body.appendChild(viewerEl);

  const displayCalls: string[] = [];
  const rendition = {
    location: undefined,
    on: () => {},
    prev: () => Promise.resolve(),
    next: () => Promise.resolve(),
    display: (target?: unknown) => {
      const href = typeof target === "string" ? target : "";
      displayCalls.push(href);
      return displayImpl ? displayImpl(href) : Promise.resolve();
    },
  } as unknown as Rendition;

  const book = {
    loaded: {
      navigation: Promise.resolve({ toc }),
      metadata: Promise.resolve({ title: "Test Book" }),
    },
  } as unknown as Book;

  new EpubNavigationTools(viewerEl, "test-book.epub", book, rendition);

  await vi.waitFor(() => {
    expect(viewerEl.querySelector(".epub-toc-panel")).not.toBeNull();
  });

  return { viewerEl, displayCalls };
}

/** Let the fire-and-forget jump promise (and its drawer close) settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const entryLabels = (viewerEl: HTMLElement): HTMLElement[] =>
  Array.from(viewerEl.querySelectorAll<HTMLElement>(".epub-toc-label"));

const openDrawer = (viewerEl: HTMLElement): void => {
  (viewerEl.querySelector(".epub-toc-button") as HTMLButtonElement).click();
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("flattenToc", () => {
  it("flattens multi-level nesting in document order with per-entry depth", () => {
    const toc = [
      tocItem("part1.xhtml", "Part I", [
        tocItem("ch1.xhtml", "Chapter 1"),
        tocItem("ch2.xhtml", "Chapter 2", [
          tocItem("ch2.xhtml#section-a", "Section A"),
          tocItem("ch2.xhtml#section-b", "Section B"),
        ]),
      ]),
      tocItem("part2.xhtml", "Part II"),
    ];

    expect(flattenToc(toc)).toEqual([
      { href: "part1.xhtml", label: "Part I", depth: 0 },
      { href: "ch1.xhtml", label: "Chapter 1", depth: 1 },
      { href: "ch2.xhtml", label: "Chapter 2", depth: 1 },
      { href: "ch2.xhtml#section-a", label: "Section A", depth: 2 },
      { href: "ch2.xhtml#section-b", label: "Section B", depth: 2 },
      { href: "part2.xhtml", label: "Part II", depth: 0 },
    ]);
  });

  it("handles items with no subitems", () => {
    const toc = [tocItem("a.xhtml", "A"), tocItem("b.xhtml", "B")];

    expect(flattenToc(toc)).toEqual([
      { href: "a.xhtml", label: "A", depth: 0 },
      { href: "b.xhtml", label: "B", depth: 0 },
    ]);
  });

  it("treats an empty subitems array as a leaf", () => {
    const toc = [tocItem("a.xhtml", "A", [])];

    expect(flattenToc(toc)).toEqual([{ href: "a.xhtml", label: "A", depth: 0 }]);
  });

  it("returns an empty list for an empty TOC", () => {
    expect(flattenToc([])).toEqual([]);
  });

  it("passes accented and CJK labels through unchanged", () => {
    const toc = [tocItem("cafe.xhtml", "Café Terrace — 第一章 naïve")];

    expect(flattenToc(toc)[0].label).toBe("Café Terrace — 第一章 naïve");
  });

  it("passes hrefs through unchanged, including non-ASCII paths and fragments", () => {
    const toc = [tocItem("chapitres/été.xhtml#résumé", "Été")];

    expect(flattenToc(toc)[0].href).toBe("chapitres/été.xhtml#résumé");
  });
});

describe("TOC drawer", () => {
  it("a top-level click calls rendition.display with the entry href as authored", async () => {
    const { viewerEl, displayCalls } = await buildViewer([
      tocItem("chapter-1.xhtml", "Chapter One"),
      tocItem("chapter-2.xhtml", "Chapter Two"),
    ]);

    entryLabels(viewerEl)[0].click();
    await flush();

    expect(displayCalls).toEqual(["chapter-1.xhtml"]);
  });

  it("a nested click calls rendition.display with the nested href, fragment included", async () => {
    const { viewerEl, displayCalls } = await buildViewer([
      tocItem("chapter-1.xhtml", "Chapter One", [
        tocItem("chapter-1.xhtml#section-a", "Section A"),
      ]),
    ]);

    const entries = entryLabels(viewerEl);
    expect(entries).toHaveLength(2);
    entries[1].click();
    await flush();

    expect(displayCalls).toEqual(["chapter-1.xhtml#section-a"]);
  });

  it("renders non-ASCII labels as authored and passes their hrefs unstripped", async () => {
    const { viewerEl, displayCalls } = await buildViewer([
      tocItem("chapitres/été.xhtml", "Café Terrace 第一章"),
    ]);

    const entry = entryLabels(viewerEl)[0];
    expect(entry.textContent).toBe("Café Terrace 第一章");
    expect(entry.getAttribute("aria-label")).toBe("Café Terrace 第一章");

    entry.click();
    await flush();

    expect(displayCalls).toEqual(["chapitres/été.xhtml"]);
  });

  it("closes the drawer after a successful jump", async () => {
    const { viewerEl } = await buildViewer([tocItem("a.xhtml", "A")]);
    const panel = viewerEl.querySelector(".epub-toc-panel") as HTMLElement;

    openDrawer(viewerEl);
    expect(panel.classList.contains("open")).toBe(true);

    entryLabels(viewerEl)[0].click();
    await flush();

    expect(panel.classList.contains("open")).toBe(false);
  });

  it("handles a rejected rendition.display: warns, keeps the drawer open, no unhandled rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { viewerEl } = await buildViewer(
        [tocItem("missing.xhtml", "Missing Chapter")],
        () => Promise.reject(new Error("malformed or missing href")),
      );
      const panel = viewerEl.querySelector(".epub-toc-panel") as HTMLElement;

      openDrawer(viewerEl);
      expect(panel.classList.contains("open")).toBe(true);

      entryLabels(viewerEl)[0].click();
      await flush();

      expect(warn).toHaveBeenCalled();
      expect(panel.classList.contains("open")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("entries are keyboard-focusable links and the panel has an accessible name", async () => {
    const { viewerEl } = await buildViewer([tocItem("a.xhtml", "Chapter A")]);

    const panel = viewerEl.querySelector(".epub-toc-panel") as HTMLElement;
    expect(panel.getAttribute("aria-label")).toBe("Table of contents");

    const entry = entryLabels(viewerEl)[0];
    expect(entry.getAttribute("role")).toBe("link");
    expect(entry.tabIndex).toBe(0);

    const copyBtn = viewerEl.querySelector(".epub-toc-copy") as HTMLButtonElement;
    expect(copyBtn.getAttribute("aria-label")).toBe("Copy link to Chapter A");
  });

  it("Enter and Space activate the jump on a focused entry", async () => {
    const { viewerEl, displayCalls } = await buildViewer([
      tocItem("a.xhtml", "A"),
      tocItem("b.xhtml", "B"),
    ]);
    const [first, second] = entryLabels(viewerEl);

    first.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await flush();

    second.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
    );
    await flush();

    expect(displayCalls).toEqual(["a.xhtml", "b.xhtml"]);
  });

  it("Escape closes the drawer", async () => {
    const { viewerEl } = await buildViewer([tocItem("a.xhtml", "A")]);
    const panel = viewerEl.querySelector(".epub-toc-panel") as HTMLElement;

    openDrawer(viewerEl);
    expect(panel.classList.contains("open")).toBe(true);

    viewerEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    expect(panel.classList.contains("open")).toBe(false);
  });
});
