// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";
import ePub from "epubjs";
import type { Book, Rendition } from "epubjs";
import type { NavItem } from "epubjs/types/navigation";
import {
  EpubNavigationTools,
  EpubSelectionTracker,
  flattenToc,
} from "./epubNavigationTools";

let idCounter = 0;
function tocItem(href: string, label: string, subitems?: NavItem[]): NavItem {
  idCounter += 1;
  return { id: `item-${idCounter}`, href, label, subitems };
}

function hreflessTocItem(label: string): NavItem {
  idCounter += 1;
  return { id: `item-${idCounter}`, href: null, label } as unknown as NavItem;
}

async function buildEpub2EmptyNcxFixture(): Promise<ArrayBuffer> {
  const fixtureRoot = resolve("src/model/fixtures/minimal-epub2-empty-ncx");
  const fixtureFiles = [
    "mimetype",
    "META-INF/container.xml",
    "EPUB/package.opf",
    "EPUB/toc.ncx",
    "EPUB/chapter-1.xhtml",
  ] as const;
  const zip = new JSZip();

  for (const fixturePath of fixtureFiles) {
    let contents = await readFile(resolve(fixtureRoot, fixturePath), "utf8");
    if (fixturePath === "mimetype") {
      contents = contents.trimEnd();
    }
    zip.file(fixturePath, contents, { createFolders: false });
  }

  return zip.generateAsync({
    compression: "STORE",
    platform: "UNIX",
    type: "arraybuffer",
  });
}

interface ViewerHarness {
  viewerEl: HTMLDivElement;
  displayCalls: string[];
  /** Simulate epub.js reporting the current position's starting href. */
  setLocation: (href: string | undefined) => void;
  /** Fire the rendition "rendered" event with a fresh contents document. */
  renderContents: () => HTMLDocument;
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
  const eventHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const locationState: { start?: { href?: string } } = {};
  const rendition = {
    get location() {
      return locationState.start === undefined ? undefined : { start: locationState.start };
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      (eventHandlers[event] ??= []).push(handler);
    },
    prev: () => Promise.resolve(),
    next: () => Promise.resolve(),
    themes: { override: () => undefined },
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

  new EpubNavigationTools(
    viewerEl,
    "test-book.epub",
    book,
    rendition,
    new EpubSelectionTracker(),
  );

  await vi.waitFor(() => {
    expect(viewerEl.querySelector(".epub-toc-panel")).not.toBeNull();
  });

  const renderContents = (): HTMLDocument => {
    const iframe = document.createElement("iframe");
    viewerEl.appendChild(iframe);
    const contentsDocument = iframe.contentDocument;
    const contentsWindow = iframe.contentWindow;
    if (contentsDocument === null || contentsWindow === null) {
      throw new Error("jsdom did not create an iframe browsing context");
    }
    for (const handler of eventHandlers["rendered"] ?? []) {
      handler({}, { document: contentsDocument, window: contentsWindow });
    }
    return contentsDocument;
  };

  return {
    viewerEl,
    displayCalls,
    setLocation: (href: string | undefined) => {
      locationState.start = href === undefined ? undefined : { href };
    },
    renderContents,
  };
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

  it("indents nested TOC rows by depth via the --toc-depth CSS variable", async () => {
    const { viewerEl } = await buildViewer([
      tocItem("part1.xhtml", "Part I", [
        tocItem("ch1.xhtml", "Chapter 1", [
          tocItem("ch1.xhtml#section-a", "Section A"),
        ]),
      ]),
      tocItem("part2.xhtml", "Part II"),
    ]);

    const rows = Array.from(viewerEl.querySelectorAll<HTMLElement>(".epub-toc-link"));
    expect(rows).toHaveLength(4);
    expect(rows[0].style.getPropertyValue("--toc-depth")).toBe("0");
    expect(rows[1].style.getPropertyValue("--toc-depth")).toBe("1");
    expect(rows[2].style.getPropertyValue("--toc-depth")).toBe("2");
    expect(rows[3].style.getPropertyValue("--toc-depth")).toBe("0");
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

  it("a closed drawer is inert so no entry is keyboard-reachable; opening restores it", async () => {
    const { viewerEl } = await buildViewer([
      tocItem("a.xhtml", "A", [tocItem("a.xhtml#sub", "Sub")]),
    ]);
    const panel = viewerEl.querySelector(".epub-toc-panel") as HTMLElement;

    expect(panel.classList.contains("open")).toBe(false);
    expect(panel.inert).toBe(true);

    openDrawer(viewerEl);
    expect(panel.classList.contains("open")).toBe(true);
    expect(panel.inert).toBe(false);

    viewerEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(panel.classList.contains("open")).toBe(false);
    expect(panel.inert).toBe(true);
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

describe("chapter navigation", () => {
  it("PageUp passes the raw target href to display(), byte-identical", async () => {
    const rawHref = "chapitres/été.xhtml#résumé";
    const { displayCalls, setLocation, renderContents } = await buildViewer([
      tocItem("chapter-1.xhtml", "Chapter One"),
      tocItem(rawHref, "Été — Résumé"),
    ]);
    const contentsDocument = renderContents();
    setLocation("chapter-1.xhtml");

    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
    );
    await flush();

    expect(displayCalls).toEqual([rawHref]);
  });

  it("PageUp/Down move one chapter and stop at the TOC edges", async () => {
    const { displayCalls, setLocation, renderContents } = await buildViewer([
      tocItem("chapter-1.xhtml", "Chapter One"),
      tocItem("chapter-2.xhtml", "Chapter Two"),
      tocItem("chapter-3.xhtml", "Chapter Three"),
    ]);
    const contentsDocument = renderContents();
    const press = (key: string): void => {
      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    };

    setLocation("chapter-2.xhtml");
    press("PageUp");
    await flush();
    press("PageDown");
    await flush();
    expect(displayCalls).toEqual(["chapter-3.xhtml", "chapter-1.xhtml"]);

    setLocation("chapter-3.xhtml");
    press("PageUp");
    await flush();
    expect(displayCalls).toEqual(["chapter-3.xhtml", "chapter-1.xhtml"]);

    setLocation("chapter-1.xhtml");
    press("PageDown");
    await flush();
    expect(displayCalls).toEqual(["chapter-3.xhtml", "chapter-1.xhtml"]);
  });

  it("moves through nested chapters in flattened order", async () => {
    const { displayCalls, setLocation, renderContents } = await buildViewer([
      tocItem("part1.xhtml", "Part I", [
        tocItem("ch1.xhtml", "Chapter One"),
        tocItem("ch2.xhtml", "Chapter Two"),
      ]),
      tocItem("part2.xhtml", "Part II"),
    ]);
    const contentsDocument = renderContents();
    const press = (key: string): void => {
      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    };

    setLocation("ch2.xhtml");
    press("PageUp");
    await flush();
    press("PageDown");
    await flush();

    expect(displayCalls).toEqual(["part2.xhtml", "ch1.xhtml"]);
  });

  it("does not display from a location absent from the TOC", async () => {
    const { displayCalls, setLocation, renderContents } = await buildViewer([
      tocItem("part1.xhtml", "Part I", [tocItem("ch1.xhtml", "Chapter One")]),
    ]);
    const contentsDocument = renderContents();
    setLocation("unlisted.xhtml");

    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
    );
    await flush();
    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }),
    );
    await flush();

    expect(displayCalls).toEqual([]);
  });

  it("matches a TOC fragment to its unfragmented rendered location", async () => {
    const { displayCalls, setLocation, renderContents } = await buildViewer([
      tocItem("part1.xhtml", "Part I", [
        tocItem("ch1.xhtml#section-a", "Section A"),
        tocItem("ch2.xhtml", "Chapter Two"),
      ]),
    ]);
    const contentsDocument = renderContents();
    setLocation("ch1.xhtml");

    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
    );
    await flush();

    expect(displayCalls).toEqual(["ch2.xhtml"]);
  });

  it("repeated PageUp presses stay on an in-file anchor", async () => {
    // Accepted by marty on 2026-09-16; state-tracking is filed separately.
    const { displayCalls, setLocation, renderContents } = await buildViewer([
      tocItem("ch1.xhtml", "Chapter One"),
      tocItem("ch1.xhtml#section-a", "Section A"),
      tocItem("ch2.xhtml", "Chapter Two"),
    ]);
    const contentsDocument = renderContents();
    const pressPageUp = (): void => {
      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
      );
    };

    setLocation("ch1.xhtml");
    pressPageUp();
    await flush();
    pressPageUp();
    await flush();

    expect(displayCalls).toEqual(["ch1.xhtml#section-a", "ch1.xhtml#section-a"]);
  });

  it("matches a malformed-escape href without decoding it", async () => {
    // decodeURI can only fail on this malformed href itself, so comparing
    // both sides undecoded preserves the intended symmetric path match.
    const { displayCalls, setLocation, renderContents } = await buildViewer([
      tocItem("ch%zz.xhtml", "Malformed"),
      tocItem("ch2.xhtml", "Chapter Two"),
    ]);
    const contentsDocument = renderContents();
    setLocation("ch%zz.xhtml");

    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
    );
    await flush();

    expect(displayCalls).toEqual(["ch2.xhtml"]);
  });

  it("excludes live EPUB hrefless entries without crashing a page turn", async () => {
    const book = ePub(await buildEpub2EmptyNcxFixture());

    try {
      await book.opened;
      const { displayCalls, setLocation, renderContents } = await buildViewer(
        (await book.loaded.navigation).toc,
      );
      const contentsDocument = renderContents();
      setLocation("chapter-1.xhtml");

      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
      );
      await flush();

      expect(displayCalls).toEqual([]);
    } finally {
      await book.destroy();
    }
  });

  it("bails without navigating when no current location exists", async () => {
    const { displayCalls, renderContents } = await buildViewer([
      tocItem("ch1.xhtml", "Chapter One"),
      tocItem("ch2.xhtml", "Chapter Two"),
    ]);
    const contentsDocument = renderContents();

    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
    );
    await flush();
    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }),
    );
    await flush();

    expect(displayCalls).toEqual([]);
  });

  it("does not match an empty rendered href to a hrefless TOC entry", async () => {
    const { displayCalls, setLocation, renderContents } = await buildViewer([
      hreflessTocItem("Group heading"),
      tocItem("ch1.xhtml", "Chapter One"),
      tocItem("ch2.xhtml", "Chapter Two"),
    ]);
    const contentsDocument = renderContents();
    setLocation("");

    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
    );
    await flush();

    expect(displayCalls).toEqual([]);
  });

  it("reports and contains a failed page-key display", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { displayCalls, setLocation, renderContents } = await buildViewer(
        [tocItem("ch1.xhtml", "Chapter One"), tocItem("ch2.xhtml", "Chapter Two")],
        () => Promise.reject(new Error("display failed")),
      );
      const contentsDocument = renderContents();
      setLocation("ch1.xhtml");

      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
      );
      await flush();

      expect(warn).toHaveBeenCalledWith(
        "[Observation Car] Page-key navigation failed:",
        expect.any(Error),
      );
      expect(displayCalls).toEqual(["ch2.xhtml"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("asserts no destination when no current location exists (post-F3)", async () => {
    const { displayCalls, setLocation, renderContents } = await buildViewer([
      hreflessTocItem("Group heading"),
      tocItem("ch1.xhtml", "Chapter One"),
      tocItem("ch2.xhtml", "Chapter Two"),
    ]);
    const contentsDocument = renderContents();
    setLocation(undefined);

    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
    );
    await flush();

    expect(displayCalls).toEqual([]);
  });
});
