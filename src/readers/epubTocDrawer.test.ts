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
  PAGE_KEY_RELOCATION_WAIT_MS,
  PAGE_KEY_DISPLAY_DEADLINE_MS,
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

async function buildNavigationFixture(
  fixtureName: string,
  navigationFile: "toc.ncx" | "nav.xhtml",
): Promise<ArrayBuffer> {
  const fixtureRoot = resolve("src/model/fixtures", fixtureName);
  const fixtureFiles = [
    "mimetype",
    "META-INF/container.xml",
    "EPUB/package.opf",
    `EPUB/${navigationFile}`,
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

const buildEpub2MissingNcxHrefFixture = (): Promise<ArrayBuffer> =>
  buildNavigationFixture("minimal-epub2-empty-ncx", "toc.ncx");

const EMPTY_HREF_FIXTURES = [
  {
    format: "EPUB 2 NCX",
    build: () => buildNavigationFixture("minimal-epub2-blank-ncx", "toc.ncx"),
  },
  {
    format: "EPUB 3 nav",
    build: () => buildNavigationFixture("minimal-epub3-span-nav", "nav.xhtml"),
  },
] as const;

interface ViewerHarness {
  viewerEl: HTMLDivElement;
  displayCalls: string[];
  tools: EpubNavigationTools;
  /** Simulate epub.js reporting the current position's starting href. */
  setLocation: (href: string | undefined) => void;
  /** Simulate an independent rendition relocation. */
  relocate: (href: string) => void;
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
  displayImpl?: (
    target: string,
    relocate: (href: string) => void,
  ) => Promise<void>,
): Promise<ViewerHarness> {
  const viewerEl = document.createElement("div");
  viewerEl.className = "epub-viewer";
  document.body.appendChild(viewerEl);

  const displayCalls: string[] = [];
  const eventHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const locationState: { start?: { href?: string } } = {};
  const relocate = (href: string): void => {
    locationState.start = { href };
    for (const handler of eventHandlers["relocated"] ?? []) {
      handler({ start: { href, cfi: `epubcfi(${href})` } });
    }
  };
  const rendition = {
    get location() {
      return locationState.start === undefined ? undefined : { start: locationState.start };
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      (eventHandlers[event] ??= []).push(handler);
    },
    off: (event: string, handler: (...args: unknown[]) => void) => {
      eventHandlers[event] = (eventHandlers[event] ?? []).filter(
        (candidate) => candidate !== handler,
      );
    },
    prev: () => Promise.resolve(),
    next: () => Promise.resolve(),
    themes: { override: () => undefined },
    currentLocation: () => Promise.resolve(
      locationState.start === undefined ? undefined : { start: locationState.start },
    ),
    display: (target?: unknown) => {
      const href = typeof target === "string" ? target : "";
      displayCalls.push(href);
      if (displayImpl !== undefined) {
        return displayImpl(href, relocate);
      }
      window.setTimeout(() => relocate(href.split("#", 1)[0] ?? href), 0);
      return Promise.resolve();
    },
  } as unknown as Rendition;

  const book = {
    loaded: {
      navigation: Promise.resolve({ toc }),
      metadata: Promise.resolve({ title: "Test Book" }),
    },
  } as unknown as Book;

  const tools = new EpubNavigationTools(
    viewerEl,
    "test-book.epub",
    book,
    rendition,
    new EpubSelectionTracker(),
    undefined,
    undefined,
    vi.fn(),
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
    tools,
    setLocation: (href: string | undefined) => {
      locationState.start = href === undefined ? undefined : { href };
    },
    relocate,
    renderContents,
  };
}

/** Let the display promise and its later production-order relocation settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

const entryLabels = (viewerEl: HTMLElement): HTMLElement[] =>
  Array.from(viewerEl.querySelectorAll<HTMLElement>(".epub-toc-label"));

const openDrawer = (viewerEl: HTMLElement): void => {
  (viewerEl.querySelector(".epub-toc-button") as HTMLButtonElement).click();
};

afterEach(() => {
  vi.useRealTimers();
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
  it("keeps the relocation wait inside its provisional device budget", () => {
    expect(PAGE_KEY_RELOCATION_WAIT_MS).toBeGreaterThanOrEqual(50);
    expect(PAGE_KEY_RELOCATION_WAIT_MS).toBeLessThanOrEqual(200);
  });

  it("PageUp passes the raw target href to display(), byte-identical", async () => {
    const rawHref = "chapitres/%C3%A9t%C3%A9.xhtml#r%C3%A9sum%C3%A9";
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
    expect(displayCalls).toEqual(["chapter-3.xhtml", "chapter-2.xhtml"]);

    setLocation("chapter-3.xhtml");
    press("PageUp");
    await flush();
    expect(displayCalls).toEqual(["chapter-3.xhtml", "chapter-2.xhtml"]);

    setLocation("chapter-1.xhtml");
    press("PageDown");
    await flush();
    expect(displayCalls).toEqual(["chapter-3.xhtml", "chapter-2.xhtml"]);
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

    expect(displayCalls).toEqual(["part2.xhtml", "ch2.xhtml"]);
  });

  it("skips unusable headings while walking flattened entries", async () => {
    const { displayCalls, setLocation, renderContents } = await buildViewer([
      tocItem("ch1.xhtml", "Chapter One"),
      hreflessTocItem("Part heading"),
      tocItem("ch2.xhtml", "Chapter Two"),
    ]);
    const contentsDocument = renderContents();
    setLocation("ch1.xhtml");

    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
    );
    await flush();

    expect(displayCalls).toEqual(["ch2.xhtml"]);
  });

  it("keeps fallback and target indexes aligned when a heading precedes the current entry", async () => {
    const { displayCalls, setLocation, renderContents } = await buildViewer([
      hreflessTocItem("Part heading"),
      tocItem("ch1.xhtml", "Chapter One"),
      tocItem("ch2.xhtml", "Chapter Two"),
    ]);
    const contentsDocument = renderContents();
    setLocation("ch1.xhtml");

    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
    );
    await flush();

    expect(displayCalls).toEqual(["ch2.xhtml"]);
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

  it("repeated PageUp presses visit an in-file anchor and then reach the next chapter", async () => {
    // Starting from the file-level location, the remembered cursor lets each
    // successful Page-key jump advance one usable flattened entry.
    const { displayCalls, setLocation, renderContents } = await buildViewer(
      [
        tocItem("ch1.xhtml", "Chapter One"),
        tocItem("ch1.xhtml#section-a", "Section A"),
        tocItem("ch2.xhtml", "Chapter Two"),
      ],
      async (target, relocate) => {
        window.setTimeout(() => relocate(target.split("#", 1)[0] ?? target), 0);
      },
    );
    const contentsDocument = renderContents();
    const pressPageUp = (): void => {
      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
      );
    };

    setLocation("ch1.xhtml");
    pressPageUp();
    await flush();
    await flush();
    pressPageUp();
    await flush();
    await flush();

    expect(displayCalls).toEqual(["ch1.xhtml#section-a", "ch2.xhtml"]);
  });

  it("serializes rapid PageUp presses through production-order relocations", async () => {
    const { displayCalls, setLocation, renderContents } = await buildViewer(
      [
        tocItem("ch1.xhtml", "Chapter One"),
        tocItem("ch1.xhtml#section-a", "Section A"),
        tocItem("ch1.xhtml#section-b", "Section B"),
      ],
      async (target, relocate) => {
        window.setTimeout(() => relocate(target.split("#", 1)[0] ?? target), 0);
      },
    );
    const contentsDocument = renderContents();
    setLocation("ch1.xhtml");

    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
    );
    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => {
      expect(displayCalls).toEqual([
        "ch1.xhtml#section-a",
        "ch1.xhtml#section-b",
      ]);
    });
  });

  it("releases the Page-key queue when display succeeds without a relocation", async () => {
    const { displayCalls, setLocation, renderContents } = await buildViewer(
      [
        tocItem("ch1.xhtml", "Chapter One"),
        tocItem("ch1.xhtml#section-a", "Section A"),
        tocItem("ch1.xhtml#section-b", "Section B"),
      ],
      () => Promise.resolve(),
    );
    const contentsDocument = renderContents();
    const pressPageUp = (): void => {
      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
      );
    };

    setLocation("ch1.xhtml");
    pressPageUp();
    await vi.waitFor(() => expect(displayCalls).toEqual(["ch1.xhtml#section-a"]));
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    pressPageUp();

    await vi.waitFor(() => {
      expect(displayCalls).toEqual([
        "ch1.xhtml#section-a",
        "ch1.xhtml#section-b",
      ]);
    });
  });

  it("does not advance the fallback cursor when display stays at the previous location", async () => {
    const { tools, displayCalls, setLocation, renderContents } = await buildViewer(
      [tocItem("ch1.xhtml", "Chapter One"), tocItem("ch2.xhtml", "Chapter Two")],
      () => Promise.resolve(),
    );
    const contentsDocument = renderContents();
    const internals = tools as unknown as {
      pageKeyPosition: number | null;
      pendingPageKeyNavigation: unknown;
    };
    const pressPageUp = (): void => {
      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
      );
    };
    vi.useFakeTimers();

    setLocation("ch1.xhtml");
    pressPageUp();
    await vi.advanceTimersByTimeAsync(PAGE_KEY_RELOCATION_WAIT_MS);

    expect(internals.pageKeyPosition).toBeNull();
    expect(internals.pendingPageKeyNavigation).toBeNull();

    pressPageUp();
    await vi.advanceTimersByTimeAsync(PAGE_KEY_RELOCATION_WAIT_MS);

    expect(displayCalls).toEqual(["ch2.xhtml", "ch2.xhtml"]);
  });

  it("preserves the fallback cursor when its relocation arrives late", async () => {
    const { displayCalls, setLocation, renderContents } = await buildViewer(
      [
        tocItem("ch1.xhtml", "Chapter One"),
        tocItem("ch1.xhtml#section-a", "Section A"),
        tocItem("ch1.xhtml#section-b", "Section B"),
      ],
      async (target, relocate) => {
        window.setTimeout(() => relocate(target.split("#", 1)[0] ?? target), 150);
      },
    );
    const contentsDocument = renderContents();
    const pressPageUp = (): void => {
      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
      );
    };

    setLocation("ch1.xhtml");
    pressPageUp();
    await new Promise((resolve) => window.setTimeout(resolve, 200));
    pressPageUp();

    await vi.waitFor(() => {
      expect(displayCalls).toEqual([
        "ch1.xhtml#section-a",
        "ch1.xhtml#section-b",
      ]);
    });
  });

  it("expires a missing late relocation before an independent relocation", async () => {
    const { displayCalls, setLocation, relocate, renderContents } = await buildViewer(
      [
        tocItem("ch1.xhtml", "Chapter One"),
        tocItem("ch1.xhtml#section-a", "Section A"),
        tocItem("ch1.xhtml#section-b", "Section B"),
      ],
      () => Promise.resolve(),
    );
    const contentsDocument = renderContents();
    vi.useFakeTimers();
    const pressPageUp = (): void => {
      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
      );
    };

    setLocation("ch1.xhtml");
    pressPageUp();
    await vi.advanceTimersByTimeAsync(PAGE_KEY_RELOCATION_WAIT_MS * 2);
    relocate("ch1.xhtml");
    pressPageUp();
    await vi.advanceTimersByTimeAsync(0);

    expect(displayCalls).toEqual([
      "ch1.xhtml#section-a",
      "ch1.xhtml#section-a",
    ]);
  });

  it("lets a live same-location navigation claim its own relocation", async () => {
    let resolveSecondDisplay = (): void => undefined;
    const secondDisplay = new Promise<void>((resolve) => {
      resolveSecondDisplay = resolve;
    });
    let displayCount = 0;
    const { tools, displayCalls, setLocation, relocate, renderContents } =
      await buildViewer(
        [
          tocItem("ch1.xhtml", "Chapter One"),
          tocItem("ch1.xhtml#section-a", "Section A"),
          tocItem("ch1.xhtml#section-b", "Section B"),
        ],
        () => {
          displayCount += 1;
          return displayCount === 1 ? Promise.resolve() : secondDisplay;
        },
      );
    const contentsDocument = renderContents();
    vi.useFakeTimers();
    const press = (key: "PageUp" | "PageDown"): void => {
      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    };
    const internals = tools as unknown as {
      pageKeyPosition: number | null;
      pendingPageKeyNavigation: unknown;
    };

    setLocation("ch1.xhtml");
    press("PageUp");
    await vi.advanceTimersByTimeAsync(PAGE_KEY_RELOCATION_WAIT_MS);
    press("PageDown");
    await vi.advanceTimersByTimeAsync(0);
    expect(displayCalls).toEqual(["ch1.xhtml#section-a", "ch1.xhtml"]);

    relocate("ch1.xhtml");
    resolveSecondDisplay();
    await vi.advanceTimersByTimeAsync(0);

    expect(internals.pageKeyPosition).toBe(0);
    expect(internals.pendingPageKeyNavigation).toBeNull();
  });

  it("PageDown symmetrically retreats one anchored flattened entry per press", async () => {
    const { displayCalls, setLocation, renderContents } = await buildViewer([
      tocItem("ch1.xhtml", "Chapter One"),
      tocItem("ch1.xhtml#section-a", "Section A"),
      tocItem("ch1.xhtml#section-b", "Section B"),
    ]);
    const contentsDocument = renderContents();
    const press = (key: "PageUp" | "PageDown"): void => {
      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    };

    setLocation("ch1.xhtml");
    press("PageUp");
    await flush();
    press("PageUp");
    await flush();
    press("PageDown");
    await flush();
    press("PageDown");
    await flush();

    expect(displayCalls).toEqual([
      "ch1.xhtml#section-a",
      "ch1.xhtml#section-b",
      "ch1.xhtml#section-a",
      "ch1.xhtml",
    ]);
  });

  it("invalidates the remembered entry after a drawer jump", async () => {
    let releaseDrawerDisplay = (): void => undefined;
    const drawerDisplay = new Promise<void>((resolve) => {
      releaseDrawerDisplay = resolve;
    });
    const { viewerEl, displayCalls, tools, setLocation, renderContents } =
      await buildViewer(
        [
          tocItem("ch1.xhtml", "Chapter One"),
          tocItem("ch1.xhtml#section-a", "Section A"),
          tocItem("ch2.xhtml", "Chapter Two"),
        ],
        async (target, relocate) => {
          if (target === "ch1.xhtml") {
            await drawerDisplay;
          }
          window.setTimeout(() => relocate(target.split("#", 1)[0] ?? target), 0);
        },
      );
    const contentsDocument = renderContents();
    const internals = tools as unknown as { pageKeyPosition: number | null };
    const pressPageUp = (): void => {
      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
      );
    };

    setLocation("ch1.xhtml");
    pressPageUp();
    await flush();
    entryLabels(viewerEl)[0]?.click();
    expect(internals.pageKeyPosition).toBeNull();
    releaseDrawerDisplay();
    await flush();
    setLocation("ch1.xhtml");
    pressPageUp();
    await flush();

    expect(displayCalls).toEqual([
      "ch1.xhtml#section-a",
      "ch1.xhtml",
      "ch1.xhtml#section-a",
    ]);
  });

  it("invalidates the remembered entry after an explicit cursor reset", async () => {
    const { tools, displayCalls, setLocation, renderContents } = await buildViewer([
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
    tools.invalidatePageKeyPosition();
    setLocation("ch1.xhtml");
    pressPageUp();
    await flush();

    expect(displayCalls).toEqual([
      "ch1.xhtml#section-a",
      "ch1.xhtml#section-a",
    ]);
  });

  it("invalidates the remembered entry after an independent relocation", async () => {
    const { displayCalls, setLocation, relocate, renderContents } = await buildViewer([
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
    relocate("ch1.xhtml");
    pressPageUp();
    await flush();

    expect(displayCalls).toEqual([
      "ch1.xhtml#section-a",
      "ch1.xhtml#section-a",
    ]);
  });

  it("clears the remembered entry during reader teardown", async () => {
    const { tools, setLocation, renderContents } = await buildViewer([
      tocItem("ch1.xhtml", "Chapter One"),
      tocItem("ch1.xhtml#section-a", "Section A"),
    ]);
    const contentsDocument = renderContents();
    const internals = tools as unknown as { pageKeyPosition: number | null };

    setLocation("ch1.xhtml");
    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
    );
    await flush();
    expect(internals.pageKeyPosition).toBe(1);

    tools.destroy();

    expect(internals.pageKeyPosition).toBeNull();
  });

  it("releases a jammed Page-key queue during reader teardown", async () => {
    const { tools, displayCalls, setLocation, renderContents } = await buildViewer(
      [tocItem("ch1.xhtml", "Chapter One"), tocItem("ch2.xhtml", "Chapter Two")],
      () => new Promise<void>(() => undefined),
    );
    const contentsDocument = renderContents();
    setLocation("ch1.xhtml");

    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(displayCalls).toHaveLength(1));

    const queueReleased = vi.fn();
    const queue = (tools as unknown as { pageKeyQueue: Promise<void> }).pageKeyQueue;
    void queue.then(queueReleased);
    tools.destroy();
    await flushMicrotasks();

    expect(queueReleased).toHaveBeenCalledOnce();
  });

  it("rejects a remembered entry when the current rendered file no longer matches", async () => {
    const { displayCalls, setLocation, renderContents } = await buildViewer([
      tocItem("ch1.xhtml", "Chapter One"),
      tocItem("ch1.xhtml#section-a", "Section A"),
      tocItem("ch2.xhtml", "Chapter Two"),
    ]);
    const contentsDocument = renderContents();

    setLocation("ch1.xhtml");
    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
    );
    await flush();
    setLocation("ch2.xhtml");
    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }),
    );
    await flush();

    expect(displayCalls).toEqual([
      "ch1.xhtml#section-a",
      "ch1.xhtml#section-a",
    ]);
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
    const book = ePub(await buildEpub2MissingNcxHrefFixture());

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

  it.each(EMPTY_HREF_FIXTURES)(
    "never displays an empty href from a live $format heading",
    async ({ build }) => {
      const book = ePub(await build());

      try {
        await book.opened;
        const navigation = await book.loaded.navigation;
        expect(navigation.toc[0]?.href).toBe("");
        const { viewerEl, displayCalls, setLocation, renderContents } =
          await buildViewer(navigation.toc);

        entryLabels(viewerEl)[0].click();
        await flush();

        const contentsDocument = renderContents();
        setLocation("chapter-1.xhtml");
        contentsDocument.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "PageDown",
            bubbles: true,
            cancelable: true,
          }),
        );
        await flush();

        expect(displayCalls).toEqual([]);
      } finally {
        await book.destroy();
      }
    },
  );

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
      const { tools, displayCalls, setLocation, renderContents } = await buildViewer(
        [tocItem("ch1.xhtml", "Chapter One"), tocItem("ch2.xhtml", "Chapter Two")],
        () => Promise.reject(new Error("display failed")),
      );
      const contentsDocument = renderContents();
      setLocation("ch1.xhtml");

      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
      );
      await flush();
      expect(
        (tools as unknown as { pageKeyPosition: number | null }).pageKeyPosition,
      ).toBeNull();
      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
      );
      await flush();

      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenLastCalledWith(
        "[Observation Car] Page-key navigation failed:",
        expect.any(Error),
      );
      expect(displayCalls).toEqual(["ch2.xhtml", "ch2.xhtml"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("recovers after a Page-key display never settles", async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const { tools, displayCalls, setLocation, renderContents } = await buildViewer(
        [
          tocItem("ch1.xhtml", "Chapter One"),
          tocItem("ch1.xhtml#section-a", "Section A"),
          tocItem("ch2.xhtml", "Chapter Two"),
        ],
        async (target, relocate) => {
          attempt += 1;
          if (attempt === 1) {
            await new Promise<void>(() => undefined);
            return;
          }
          window.setTimeout(() => relocate(target.split("#", 1)[0] ?? target), 0);
        },
      );
      const contentsDocument = renderContents();
      const pressPageUp = (): void => {
        contentsDocument.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "PageUp",
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      setLocation("ch1.xhtml");

      pressPageUp();
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(PAGE_KEY_DISPLAY_DEADLINE_MS);
      expect(
        (tools as unknown as { pendingPageKeyNavigation: unknown })
          .pendingPageKeyNavigation,
      ).toBeNull();
      pressPageUp();
      await vi.advanceTimersByTimeAsync(0);
      pressPageUp();
      await vi.advanceTimersByTimeAsync(0);

      expect(displayCalls).toEqual([
        "ch1.xhtml#section-a",
        "ch1.xhtml#section-a",
        "ch2.xhtml",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not commit a timed-out target when its relocation arrives late", async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      let resolveSecondDisplay = (): void => undefined;
      const secondDisplay = new Promise<void>((resolve) => {
        resolveSecondDisplay = resolve;
      });
      const { tools, displayCalls, setLocation, relocate, renderContents } =
        await buildViewer(
          [
            tocItem("ch1.xhtml", "Chapter One"),
            tocItem("ch1.xhtml#section-a", "Section A"),
            tocItem("ch2.xhtml", "Chapter Two"),
          ],
          async () => {
            attempt += 1;
            if (attempt === 1) {
              await new Promise<void>(() => undefined);
            }
            if (attempt === 2) {
              await secondDisplay;
            }
          },
        );
      const contentsDocument = renderContents();
      const internals = tools as unknown as {
        pageKeyPosition: number | null;
        pendingPageKeyNavigation: unknown;
      };
      const pressPageUp = (): void => {
        contentsDocument.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "PageUp",
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      setLocation("ch1.xhtml");

      pressPageUp();
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(PAGE_KEY_DISPLAY_DEADLINE_MS);
      expect(internals.pageKeyPosition).toBeNull();

      pressPageUp();
      await flushMicrotasks();
      expect(displayCalls).toHaveLength(2);
      relocate("ch1.xhtml");
      expect(internals.pageKeyPosition).toBeNull();
      expect(internals.pendingPageKeyNavigation).not.toBeNull();

      resolveSecondDisplay();
      await flushMicrotasks();
      expect(internals.pageKeyPosition).toBeNull();
      expect(internals.pendingPageKeyNavigation).not.toBeNull();
      relocate("ch1.xhtml");
      await flushMicrotasks();

      expect(internals.pageKeyPosition).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not commit a pending Page-key target after a mismatching relocation", async () => {
    let resolveDisplay = (): void => undefined;
    const displayGate = new Promise<void>((resolve) => {
      resolveDisplay = resolve;
    });
    const { tools, displayCalls, setLocation, relocate, renderContents } = await buildViewer(
      [
        tocItem("ch1.xhtml", "Chapter One"),
        tocItem("ch1.xhtml#section-a", "Section A"),
        tocItem("ch2.xhtml", "Chapter Two"),
      ],
      () => displayGate,
    );
    const contentsDocument = renderContents();

    setLocation("ch1.xhtml");
    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(displayCalls).toHaveLength(1));
    relocate("ch2.xhtml");
    resolveDisplay();
    await flush();
    expect(
      (tools as unknown as { pageKeyPosition: number | null }).pageKeyPosition,
    ).toBeNull();
    contentsDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }),
    );
    await flush();

    expect(displayCalls).toEqual([
      "ch1.xhtml#section-a",
      "ch1.xhtml#section-a",
    ]);
  });

  it("clears pending Page-key state when display rejects after a relocation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { tools, setLocation, renderContents } = await buildViewer(
        [
          tocItem("ch1.xhtml", "Chapter One"),
          tocItem("ch1.xhtml#section-a", "Section A"),
          tocItem("ch2.xhtml", "Chapter Two"),
        ],
        async (_target, relocate) => {
          relocate("ch2.xhtml");
          throw new Error("display failed after relocation");
        },
      );
      const contentsDocument = renderContents();
      setLocation("ch1.xhtml");

      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
      );
      await flush();

      const internals = tools as unknown as {
        pageKeyPosition: number | null;
        pendingPageKeyNavigation: unknown;
      };
      expect(internals.pageKeyPosition).toBeNull();
      expect(internals.pendingPageKeyNavigation).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not commit when a matching relocation precedes display rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { tools, setLocation, renderContents } = await buildViewer(
        [
          tocItem("ch1.xhtml", "Chapter One"),
          tocItem("ch1.xhtml#section-a", "Section A"),
          tocItem("ch2.xhtml", "Chapter Two"),
        ],
        async (target, relocate) => {
          relocate(target.split("#", 1)[0] ?? target);
          throw new Error("display failed after matching relocation");
        },
      );
      const contentsDocument = renderContents();
      setLocation("ch1.xhtml");

      contentsDocument.dispatchEvent(
        new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
      );
      await flush();

      expect(
        (tools as unknown as { pageKeyPosition: number | null }).pageKeyPosition,
      ).toBeNull();
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
