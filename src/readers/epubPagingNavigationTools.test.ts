import type { Book, Rendition } from "epubjs";
import { createRequire } from "node:module";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const showNotice = vi.hoisted(() => vi.fn());

vi.mock("obsidian", () => ({
  Notice: showNotice,
}));

interface TestDom {
  readonly window: {
    readonly document: Document;
    readonly navigator: Navigator;
    close(): void;
  };
}

const testRequire = createRequire(import.meta.url);
const { JSDOM } = testRequire("jsdom") as {
  JSDOM: new (html: string) => TestDom;
};
const dom = new JSDOM("<!doctype html><html><body></body></html>");
vi.stubGlobal("document", dom.window.document);
vi.stubGlobal("navigator", dom.window.navigator);

afterAll(() => {
  vi.unstubAllGlobals();
  dom.window.close();
});

const { addPagingListeners, EpubNavigationTools, EpubSelectionTracker } =
  await import("./epubNavigationTools");

interface PointerOptions {
  clientX: number;
  clientY?: number;
  timeStamp: number;
}

function dispatchPointer(
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup",
  options: PointerOptions,
): void {
  const view = (target as Node).ownerDocument?.defaultView;
  if (view === null || view === undefined) {
    throw new Error("Pointer target must belong to a document");
  }
  const event = new view.MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientX: options.clientX,
    clientY: options.clientY ?? 0,
  });
  Object.defineProperty(event, "timeStamp", { value: options.timeStamp });
  target.dispatchEvent(event);
}

function renderedDocument(bodyWidth: number, documentWidth: number): Document {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (doc === null) {
    throw new Error("Test iframe has no document");
  }
  doc.body.innerHTML = '<a href="chapter-2.xhtml">Next chapter</a>';
  Object.defineProperty(doc.body, "clientWidth", { configurable: true, value: bodyWidth });
  Object.defineProperty(doc.documentElement, "clientWidth", {
    configurable: true,
    value: documentWidth,
  });
  return doc;
}

function epubBookWithToc(href: string, label: string): Book {
  return {
    loaded: {
      metadata: Promise.resolve({ title: "Test Book" }),
      navigation: Promise.resolve({ toc: [{ href, label }] }),
    },
  } as unknown as Book;
}

function inertRendition(): Rendition {
  return {
    next: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    prev: vi.fn().mockResolvedValue(undefined),
    themes: { override: vi.fn() },
  } as unknown as Rendition;
}

async function clickTocCopy(href: string, label: string): Promise<void> {
  new EpubNavigationTools(
    document.body,
    "Books/Test Book.epub",
    epubBookWithToc(href, label),
    inertRendition(),
    new EpubSelectionTracker(),
    undefined,
  );
  await vi.waitFor(() => {
    expect(document.querySelector(".epub-toc-copy")).not.toBeNull();
  });
  const copyButton = document.querySelector<HTMLButtonElement>(".epub-toc-copy");
  if (copyButton === null) {
    throw new Error("Test TOC copy button was not rendered");
  }
  copyButton.click();
}

describe("F2.2 paging event wiring", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps scrolled-mode documents untouched", () => {
    const doc = renderedDocument(300, 900);
    const page = vi.fn();

    addPagingListeners(doc, "scrolled", page);

    expect(page).not.toHaveBeenCalled();
    expect(doc.documentElement.style.touchAction).toBe("");
  });

  it("uses the visible page width for a tap in a multi-page section", () => {
    const doc = renderedDocument(300, 900);
    const page = vi.fn();
    addPagingListeners(doc, "paginated", page);

    dispatchPointer(doc.body, "pointerdown", { clientX: 290, timeStamp: 100 });
    dispatchPointer(doc.body, "pointerup", { clientX: 290, timeStamp: 150 });

    expect(page).toHaveBeenCalledOnce();
    expect(page).toHaveBeenCalledWith("next");
  });

  it("maps a later-page left-third tap into the visible page", () => {
    const doc = renderedDocument(300, 900);
    const page = vi.fn();
    addPagingListeners(doc, "paginated", page);

    dispatchPointer(doc.body, "pointerdown", { clientX: 620, timeStamp: 100 });
    dispatchPointer(doc.body, "pointerup", { clientX: 620, timeStamp: 150 });

    expect(page).toHaveBeenCalledOnce();
    expect(page).toHaveBeenCalledWith("prev");
  });

  it("uses the scaled viewport width for fixed-layout EPUB tap zones", () => {
    const doc = renderedDocument(1_200, 500);
    const page = vi.fn();
    addPagingListeners(doc, "paginated", page);

    dispatchPointer(doc.body, "pointerdown", { clientX: 40, timeStamp: 100 });
    dispatchPointer(doc.body, "pointerup", { clientX: 40, timeStamp: 150 });
    dispatchPointer(doc.body, "pointerdown", { clientX: 250, timeStamp: 200 });
    dispatchPointer(doc.body, "pointerup", { clientX: 250, timeStamp: 250 });
    dispatchPointer(doc.body, "pointerdown", { clientX: 460, timeStamp: 300 });
    dispatchPointer(doc.body, "pointerup", { clientX: 460, timeStamp: 350 });

    expect(page).toHaveBeenCalledTimes(2);
    expect(page).toHaveBeenNthCalledWith(1, "prev");
    expect(page).toHaveBeenNthCalledWith(2, "next");
  });

  it("pages when a horizontal swipe ends on an in-content link", () => {
    const doc = renderedDocument(300, 900);
    const page = vi.fn();
    const link = doc.querySelector("a");
    if (link === null) {
      throw new Error("Test fixture is missing its link");
    }
    addPagingListeners(doc, "paginated", page);

    dispatchPointer(doc.body, "pointerdown", { clientX: 120, timeStamp: 100 });
    dispatchPointer(doc.body, "pointermove", { clientX: 50, timeStamp: 180 });
    dispatchPointer(link, "pointerup", { clientX: 40, timeStamp: 220 });

    expect(page).toHaveBeenCalledOnce();
    expect(page).toHaveBeenCalledWith("next");
  });

  it("still leaves a tap on an in-content link to epub.js", () => {
    const doc = renderedDocument(300, 900);
    const page = vi.fn();
    const link = doc.querySelector("a");
    if (link === null) {
      throw new Error("Test fixture is missing its link");
    }
    addPagingListeners(doc, "paginated", page);

    dispatchPointer(link, "pointerdown", { clientX: 290, timeStamp: 100 });
    dispatchPointer(link, "pointerup", { clientX: 290, timeStamp: 150 });

    expect(page).not.toHaveBeenCalled();
  });
});

describe("TOC link copying", () => {
  afterEach(() => {
    document.body.replaceChildren();
    showNotice.mockReset();
    vi.restoreAllMocks();
  });

  it("shows a readable failure instead of copying an href outside the spine grammar", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await clickTocCopy("text/chapter.xhtml#section-2", "Section 2");

    expect(writeText).not.toHaveBeenCalled();
    expect(showNotice).toHaveBeenCalledWith(
      "Could not copy link: this table-of-contents entry uses a subchapter fragment that reading-note links do not support.",
    );
  });

  it("keeps wikilink metacharacters in a TOC label inside the alias", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await clickTocCopy("text/chapter.xhtml", "Part | 1 ]] Notes");

    expect(writeText).toHaveBeenCalledWith(
      "[[Books/Test Book.epub#text/chapter.xhtml|Test Book, Part ｜ 1 ］］ Notes]]",
    );
    expect(showNotice).not.toHaveBeenCalled();
  });
});
