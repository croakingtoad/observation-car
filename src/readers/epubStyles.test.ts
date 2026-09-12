// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  EpubStyles,
  type EpubStylesBook,
  type EpubStylesContents,
  type EpubStylesHook,
  type EpubStylesRendition,
  type EpubStylesSection,
} from "./epubStyles";

type HookHandler = (...args: never[]) => unknown;

class FakeHook implements EpubStylesHook {
  private readonly handlers = new Set<HookHandler>();

  register(handler: HookHandler): void {
    this.handlers.add(handler);
  }

  deregister(handler: HookHandler): void {
    this.handlers.delete(handler);
  }

  async trigger(...args: unknown[]): Promise<void> {
    await Promise.all(
      [...this.handlers].map((handler) =>
        Reflect.apply(handler, undefined, args) as unknown,
      ),
    );
  }

  size(): number {
    return this.handlers.size;
  }
}

class FakeContents implements EpubStylesContents {
  readonly addStylesheetCss = vi.fn((css: string, key: string): boolean => {
    const id = `epubjs-inserted-css-${key}`;
    let style = this.document.getElementById(id);
    if (style === null) {
      style = this.document.createElement("style");
      style.id = id;
      this.document.head.append(style);
    }
    style.textContent = css;
    return true;
  });

  constructor(
    readonly document: Document,
    readonly sectionIndex = 0,
  ) {}
}

interface FakeReader {
  archiveGetText: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>;
  book: EpubStylesBook;
  rendition: EpubStylesRendition;
  renditionContent: FakeHook;
  spineContent: FakeHook;
  substitute: ReturnType<typeof vi.fn<(css: string, path: string) => string>>;
}

function fakeReader(css = ".chapter { color: rgb(12, 34, 56); }"): FakeReader {
  const spineContent = new FakeHook();
  const renditionContent = new FakeHook();
  const archiveGetText = vi.fn(async (_path: string): Promise<string> => css);
  const substitute = vi.fn((text: string, _path: string): string => text);
  const section: EpubStylesSection = { url: "/OEBPS/Text/chapter.xhtml" };
  return {
    archiveGetText,
    book: {
      archive: { getText: archiveGetText },
      resources: { substitute },
      spine: {
        get: vi.fn(() => section),
        hooks: { content: spineContent },
      },
    },
    rendition: { hooks: { content: renditionContent } },
    renditionContent,
    spineContent,
    substitute,
  };
}

function bookDocument(hrefs: string[]): Document {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const bookDocument = frame.contentDocument;
  if (bookDocument === null) {
    throw new Error("test iframe has no document");
  }
  for (const href of hrefs) {
    const link = bookDocument.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    bookDocument.head.append(link);
  }
  const paragraph = bookDocument.createElement("p");
  paragraph.className = "chapter";
  paragraph.textContent = "Unmistakably styled book text";
  bookDocument.body.append(paragraph);
  return bookDocument;
}

describe("EpubStyles", () => {
  it("neutralizes a book stylesheet before serialization, then inlines it", async () => {
    const reader = fakeReader();
    const styles = new EpubStyles(reader.book, reader.rendition);
    const document = bookDocument(["../Styles/book.css"]);
    const sourceLink = document.querySelector("link");

    await reader.spineContent.trigger(document, {
      url: "/OEBPS/Text/chapter.xhtml",
    });

    expect(sourceLink?.getAttribute("href")).toBeNull();
    expect(sourceLink?.getAttribute("data-observation-car-stylesheet-href")).toBe(
      "../Styles/book.css",
    );

    const contents = new FakeContents(document);
    await reader.renditionContent.trigger(contents);

    expect(reader.archiveGetText).toHaveBeenCalledWith("/OEBPS/Styles/book.css");
    expect(reader.substitute).toHaveBeenCalledWith(
      ".chapter { color: rgb(12, 34, 56); }",
      "/OEBPS/Styles/book.css",
    );
    expect(document.querySelector("link[rel~='stylesheet']")).toBeNull();
    expect(document.querySelector("style")?.textContent).toContain("rgb(12, 34, 56)");
    expect(document.defaultView?.getComputedStyle(document.querySelector("p")!).color).toBe(
      "rgb(12, 34, 56)",
    );
    styles.destroy();
  });

  it("uses one stable style key for duplicate links and section re-entry", async () => {
    const reader = fakeReader();
    const styles = new EpubStyles(reader.book, reader.rendition);
    const firstDocument = bookDocument([
      "../Styles/book.css",
      "../Styles/book.css",
    ]);
    const firstContents = new FakeContents(firstDocument);
    await reader.spineContent.trigger(firstDocument, {
      url: "/OEBPS/Text/chapter.xhtml",
    });
    await reader.renditionContent.trigger(firstContents);
    await reader.renditionContent.trigger(firstContents);

    const returnedDocument = bookDocument(["../Styles/book.css"]);
    const returnedContents = new FakeContents(returnedDocument);
    await reader.spineContent.trigger(returnedDocument, {
      url: "/OEBPS/Text/chapter.xhtml",
    });
    await reader.renditionContent.trigger(returnedContents);

    expect(firstContents.addStylesheetCss).toHaveBeenCalledOnce();
    expect(returnedContents.addStylesheetCss).toHaveBeenCalledOnce();
    expect(firstContents.addStylesheetCss.mock.calls[0][1]).toBe(
      returnedContents.addStylesheetCss.mock.calls[0][1],
    );
    expect(firstDocument.querySelectorAll("style")).toHaveLength(1);
    expect(returnedDocument.querySelectorAll("style")).toHaveLength(1);
    styles.destroy();
  });

  it("retains replaced image and font URLs while the theme remains alongside book CSS", async () => {
    const bookCss = [
      "@font-face { font-family: BookFont; src: url('../Fonts/book.woff2'); }",
      "body { color: rgb(255, 0, 0); background-image: url('../Images/paper.png'); }",
    ].join("\n");
    const reader = fakeReader(bookCss);
    reader.substitute.mockReturnValue(
      bookCss
        .replace("../Fonts/book.woff2", "blob:app://obsidian.md/font")
        .replace("../Images/paper.png", "blob:app://obsidian.md/image"),
    );
    const styles = new EpubStyles(reader.book, reader.rendition);
    const document = bookDocument(["../Styles/book.css"]);
    const theme = document.createElement("style");
    theme.id = "epubjs-inserted-css-obsidian";
    theme.textContent = "body { color: rgb(0, 0, 255) !important; }";
    document.head.append(theme);
    const contents = new FakeContents(document);

    await reader.spineContent.trigger(document, {
      url: "/OEBPS/Text/chapter.xhtml",
    });
    await reader.renditionContent.trigger(contents);

    const injectedCss = contents.addStylesheetCss.mock.calls[0][0];
    expect(injectedCss).toContain("blob:app://obsidian.md/font");
    expect(injectedCss).toContain("blob:app://obsidian.md/image");
    expect(document.getElementById("epubjs-inserted-css-obsidian")).toBe(theme);
    expect(document.defaultView?.getComputedStyle(document.body).color).toBe(
      "rgb(0, 0, 255)",
    );
    styles.destroy();
  });

  it("deregisters both hooks and ignores work after teardown", async () => {
    const reader = fakeReader();
    const styles = new EpubStyles(reader.book, reader.rendition);
    expect(reader.spineContent.size()).toBe(1);
    expect(reader.renditionContent.size()).toBe(1);

    styles.destroy();
    styles.destroy();

    expect(reader.spineContent.size()).toBe(0);
    expect(reader.renditionContent.size()).toBe(0);
    const document = bookDocument(["../Styles/book.css"]);
    await reader.spineContent.trigger(document, {
      url: "/OEBPS/Text/chapter.xhtml",
    });
    await reader.renditionContent.trigger(new FakeContents(document));
    expect(reader.archiveGetText).not.toHaveBeenCalled();
  });
});
