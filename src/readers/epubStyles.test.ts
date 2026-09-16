// @vitest-environment jsdom

import ePub from "epubjs";
import JSZip from "jszip";
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
  const section: EpubStylesSection = {
    index: 0,
    url: "/OEBPS/Text/chapter.xhtml",
  };
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

async function archivedBook(): Promise<ArrayBuffer> {
  const archive = new JSZip();
  archive.file("mimetype", "application/epub+zip", { compression: "STORE" });
  archive.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
      <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles>
          <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
        </rootfiles>
      </container>`,
  );
  archive.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
      <package version="3.0" unique-identifier="book-id" xmlns="http://www.idpf.org/2007/opf">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:identifier id="book-id">observation-car-styles-test</dc:identifier>
          <dc:title>Styles test</dc:title>
          <dc:language>en</dc:language>
          <meta property="dcterms:modified">2026-09-12T00:00:00Z</meta>
        </metadata>
        <manifest>
          <item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml"/>
          <item id="styles" href="Styles/book.css" media-type="text/css"/>
          <item id="image" href="Images/marker.png" media-type="image/png"/>
          <item id="font" href="Fonts/book.woff2" media-type="font/woff2"/>
        </manifest>
        <spine><itemref idref="chapter"/></spine>
      </package>`,
  );
  archive.file(
    "OEBPS/Text/chapter.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
      <html xmlns="http://www.w3.org/1999/xhtml">
        <head><link rel="stylesheet" type="text/css" href="../Styles/book.css"/></head>
        <body>
          <p class="chapter">Unmistakably styled book text</p>
          <img src="../Images/marker.png" alt="Marker"/>
        </body>
      </html>`,
  );
  archive.file(
    "OEBPS/Styles/book.css",
    [
      "@font-face { font-family: BookFont; src: url('../Fonts/book.woff2'); }",
      ".chapter { color: rgb(12, 34, 56); font-family: BookFont; }",
    ].join("\n"),
  );
  archive.file("OEBPS/Images/marker.png", new Uint8Array([137, 80, 78, 71]));
  archive.file("OEBPS/Fonts/book.woff2", new Uint8Array([119, 79, 70, 50]));
  return archive.generateAsync({ type: "arraybuffer" });
}

function renderedDocument(output: string): Document {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const rendered = frame.contentDocument;
  if (rendered === null) {
    throw new Error("test iframe has no document");
  }
  rendered.open();
  rendered.write(output);
  rendered.close();
  return rendered;
}

describe("EpubStyles", () => {
  it("applies archived book CSS after the real Section.render replacement pass", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    let nextBlobId = 0;
    URL.createObjectURL = vi.fn(
      () => `blob:app://obsidian.md/styles-test-${nextBlobId++}`,
    );
    URL.revokeObjectURL = vi.fn();

    const book = ePub(await archivedBook());
    const renditionContent = new FakeHook();
    const styles = new EpubStyles(book, {
      hooks: { content: renditionContent },
    });

    try {
      await book.opened;
      const section = book.section(0);
      const output = await section.render(book.load.bind(book));
      expect(output).toContain("blob:app://obsidian.md/");

      const rendered = renderedDocument(output);
      await renditionContent.trigger(new FakeContents(rendered));

      const paragraph = rendered.querySelector("p.chapter");
      expect(paragraph).not.toBeNull();
      expect(rendered.defaultView?.getComputedStyle(paragraph!).color).toBe(
        "rgb(12, 34, 56)",
      );
      expect(rendered.querySelector("img")?.getAttribute("src")).toMatch(
        /^blob:app:\/\/obsidian\.md\//,
      );
      expect(rendered.querySelector("style")?.textContent).toMatch(
        /src: url\(['"]?blob:app:\/\/obsidian\.md\//,
      );
    } finally {
      styles.destroy();
      book.destroy();
      URL.createObjectURL = originalCreateObjectUrl;
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });

  it("neutralizes a book stylesheet before serialization, then inlines it", async () => {
    const reader = fakeReader();
    const styles = new EpubStyles(reader.book, reader.rendition);
    const document = bookDocument(["../Styles/book.css"]);
    const sourceLink = document.querySelector("link");

    await reader.spineContent.trigger(document, {
      index: 0,
      url: "/OEBPS/Text/chapter.xhtml",
    });

    expect(sourceLink?.getAttribute("href")).toBeNull();
    expect(
      sourceLink?.getAttribute("data-observation-car-stylesheet-index"),
    ).toBe("0");

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
      index: 0,
      url: "/OEBPS/Text/chapter.xhtml",
    });
    await reader.renditionContent.trigger(firstContents);
    await reader.renditionContent.trigger(firstContents);

    const returnedDocument = bookDocument(["../Styles/book.css"]);
    const returnedContents = new FakeContents(returnedDocument);
    await reader.spineContent.trigger(returnedDocument, {
      index: 0,
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
      index: 0,
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

  it("reports unresolvable stylesheet hrefs with their section", async () => {
    const reader = fakeReader();
    const styles = new EpubStyles(reader.book, reader.rendition);
    const document = bookDocument(["https://example.com/book.css", "http://["]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await reader.spineContent.trigger(document, {
        index: 0,
        url: "/OEBPS/Text/chapter.xhtml",
      });
      await reader.renditionContent.trigger(new FakeContents(document));

      expect(consoleError).toHaveBeenCalledWith(
        "Failed to resolve EPUB stylesheet in section /OEBPS/Text/chapter.xhtml: https://example.com/book.css",
      );
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to resolve EPUB stylesheet in section /OEBPS/Text/chapter.xhtml: http://[",
        expect.anything(),
      );
      expect(reader.archiveGetText).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      styles.destroy();
    }
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
      index: 0,
      url: "/OEBPS/Text/chapter.xhtml",
    });
    await reader.renditionContent.trigger(new FakeContents(document));
    expect(reader.archiveGetText).not.toHaveBeenCalled();
  });
});
