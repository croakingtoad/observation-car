// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS } from "../settings";
import { EpubView, type EpubViewHost } from "./EpubView";
import JSZip from "jszip";

const OBSIDIAN_DOM_SHIM_KEY = "__observationCarObsidianDomShimsInstalled";

function installObsidianDomShims(): void {
  const globalWindow = window as typeof window & {
    [OBSIDIAN_DOM_SHIM_KEY]?: boolean;
  };
  if (globalWindow[OBSIDIAN_DOM_SHIM_KEY] === true) {
    return;
  }
  const prototype = HTMLElement.prototype as unknown as {
    createDiv: (
      this: HTMLElement,
      options?: { cls?: string; text?: string },
    ) => HTMLDivElement;
    empty: (this: HTMLElement) => void;
  };
  prototype.createDiv = function createDiv(options) {
    const div = document.createElement("div");
    if (options?.cls) {
      div.className = options.cls;
    }
    if (options?.text !== undefined) {
      div.textContent = options.text;
    }
    this.appendChild(div);
    return div;
  };
  prototype.empty = function empty() {
    this.replaceChildren();
  };
  globalWindow[OBSIDIAN_DOM_SHIM_KEY] = true;
}

beforeAll(() => {
  installObsidianDomShims();
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    return setTimeout(
      () => callback(performance.now()),
      16,
    ) as unknown as number;
  };
});

const fixedZipDate = new Date("2026-01-01T00:00:00.000Z");
const containerPath = "META-INF/container.xml";
const opfPath = "EPUB/package.opf";
const navPath = "EPUB/nav.xhtml";
const chapterPath = "EPUB/chapter-1.xhtml";

const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

const packageOpf = `<?xml version="1.0"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:broken</dc:identifier>
    <dc:title>Broken</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="nav"/>
    <itemref idref="chapter-1"/>
  </spine>
</package>
`;

const navXhtml = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Table of contents</title></head>
  <body>
    <nav epub:type="toc">
      <ol><li><a href="chapter-1.xhtml">Chapter one</a></li></ol>
    </nav>
  </body>
</html>
`;

const chapterXhtml = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Chapter one</title></head>
  <body><p>Chapter one.</p></body>
</html>
`;

async function buildZip(files: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [path, contents] of Object.entries(files)) {
    zip.file(path, contents, { createFolders: false, date: fixedZipDate });
  }
  return zip.generateAsync({
    compression: "STORE",
    platform: "UNIX",
    type: "arraybuffer",
  });
}

async function truncatedOpf(): Promise<ArrayBuffer> {
  return buildZip({
    [containerPath]: containerXml,
    [opfPath]: packageOpf.slice(0, Math.floor(packageOpf.length / 2)),
    [navPath]: navXhtml,
    [chapterPath]: chapterXhtml,
  });
}

async function missingContainer(): Promise<ArrayBuffer> {
  return buildZip({
    [opfPath]: packageOpf,
    [navPath]: navXhtml,
    [chapterPath]: chapterXhtml,
  });
}

async function danglingRootfile(): Promise<ArrayBuffer> {
  return buildZip({
    [containerPath]: containerXml.replace(
      "EPUB/package.opf",
      "EPUB/missing.opf",
    ),
    [opfPath]: packageOpf,
    [navPath]: navXhtml,
    [chapterPath]: chapterXhtml,
  });
}

async function notZip(): Promise<ArrayBuffer> {
  const bytes = new TextEncoder().encode("this is not a zip archive");
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

const malformedBooks: Array<[string, () => Promise<ArrayBuffer>]> = [
  ["a truncated OPF", truncatedOpf],
  ["a missing META-INF/container.xml", missingContainer],
  ["a rootfile that resolves to nothing", danglingRootfile],
  ["input that is not a zip", notZip],
];

function file(path: string): TFile {
  return {
    path,
    basename: path.split("/").pop() ?? path,
  } as unknown as TFile;
}

function makeHost(): EpubViewHost {
  const host: EpubViewHost = {
    settings: { ...DEFAULT_SETTINGS },
    updateSettings: async (patch) => {
      host.settings = { ...host.settings, ...patch };
    },
    getLastEpubLocation: () => null,
    rememberEpubLocation: async () => undefined,
  };
  return host;
}

function leafWithContent(): WorkspaceLeaf {
  const contentEl = document.createElement("div");
  const containerEl = document.createElement("div");
  containerEl.appendChild(contentEl);
  const leaf = {
    containerEl,
    contentEl,
    app: null,
  } as unknown as WorkspaceLeaf;
  document.body.appendChild(containerEl);
  return leaf;
}

async function loadEpub(
  bytes: ArrayBuffer,
): Promise<{ view: EpubView; error: unknown }> {
  const view = new EpubView(leafWithContent(), makeHost());
  Object.assign(view, {
    app: { vault: { readBinary: async () => bytes } },
  });
  try {
    await view.onLoadFile(file("library/broken.epub"));
    throw new Error("the malformed EPUB load unexpectedly resolved");
  } catch (error) {
    return { view, error };
  }
}

async function closeView(view: EpubView): Promise<void> {
  await view.onClose();
}

describe("EpubView malformed-book failure path", () => {
  it("confirms the test drives the production native parser", () => {
    expect(typeof window.DOMParser).toBe("function");
    const parsed = new window.DOMParser().parseFromString(
      "<root><child/></root>",
      "text/xml",
    );
    expect(parsed.querySelector("child")).not.toBeNull();
  });

  it.each(malformedBooks)(
    "bounds %s with a readable in-leaf error",
    async (_description, buildBytes) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const loaded = await loadEpub(await buildBytes());
      const view = loaded.view;
      expect(loaded.error).toBeInstanceOf(Error);
      expect((loaded.error as Error).message).toMatch(
        /EPUB did not finish loading/i,
      );

      expect(view.contentEl.querySelectorAll(".epub-load-error")).toHaveLength(
        1,
      );
      expect(view.contentEl.querySelectorAll(".epub-viewer")).toHaveLength(0);
      expect(
        [...view.contentEl.children].filter(
          (element) => element.className !== "epub-load-error",
        ),
      ).toHaveLength(0);
      expect(
        view.contentEl.querySelector(".epub-load-error")?.textContent,
      ).toBe(
        `This EPUB could not be opened: ${(loaded.error as Error).message}`,
      );

      await closeView(view);
      expect(view.contentEl.children).toHaveLength(0);
      consoleError.mockRestore();
    },
    9000,
  );
});
