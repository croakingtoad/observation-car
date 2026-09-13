// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ePub, { EpubCFI } from "epubjs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildFragment, parseFragment } from "./anchor";

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/minimal-epub",
);
const fixtureFiles = [
  "mimetype",
  "META-INF/container.xml",
  "EPUB/package.opf",
  "EPUB/nav.xhtml",
  "EPUB/chapter-1.xhtml",
  "EPUB/chapter-2.xhtml",
] as const;
const crlfChapter = "EPUB/chapter-2.xhtml";
const fixedZipDate = new Date("2026-01-01T00:00:00.000Z");

async function buildFixture(): Promise<ArrayBuffer> {
  const zip = new JSZip();

  for (const path of fixtureFiles) {
    let contents = await readFile(resolve(fixtureRoot, path), "utf8");
    if (path === "mimetype") {
      contents = contents.trimEnd();
    } else if (path === crlfChapter) {
      contents = contents.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
    }
    zip.file(path, contents, { createFolders: false, date: fixedZipDate });
  }

  return zip.generateAsync({
    compression: "STORE",
    platform: "UNIX",
    type: "arraybuffer",
  });
}

describe("live EPUB CFI generation", () => {
  it("loads the fixture through epub.js and preserves generated anchors", async () => {
    const fixture = await buildFixture();
    const fixtureZip = await JSZip.loadAsync(fixture);
    const archivedCrlfChapter = await fixtureZip.file(crlfChapter)?.async("string");
    if (archivedCrlfChapter === undefined) {
      throw new Error(`${crlfChapter} is missing from the fixture`);
    }
    expect(archivedCrlfChapter).toContain("source line\r\nwhose archived");
    expect(archivedCrlfChapter.replace(/\r\n/g, "")).not.toContain("\n");

    const book = ePub(fixture);
    try {
      await book.opened;

      const cfiBases: string[] = [];
      book.spine.each((section: { cfiBase: string }) => {
        cfiBases.push(section.cfiBase);
      });
      expect(cfiBases).toEqual([
        "/6/2[chapter-1-ref]",
        "/6/4[chapter-2-ref]",
      ]);

      const liveLocations = await book.locations.generate(1000);
      // Chapter 2 is archived with CRLF line endings, but :90 is the correct
      // browser-normalized offset. With @xmldom/xmldom pinned to ^0.8.15 by
      // the package.json overrides, both parsers normalize CR, so :90 now
      // guards jsdom's own normalization rather than distinguishing a fallback.
      // If that pin is relaxed, a :91 (or other CR-retaining result) means the
      // XML parser stopped normalizing CR (LOCO-474); do not edit this
      // expectation to match. See LOCO-556 for the regression history.
      expect(liveLocations).toEqual([
        "epubcfi(/6/2[chapter-1-ref]!/4[chapter-one-body]/2[chapter-one-start],/1:0,/1:79)",
        "epubcfi(/6/4[chapter-2-ref]!/4[chapter-two-body]/2[chapter-two-start],/1:0,/1:90)",
      ]);

      // xmldom elements lack the native Element.id property, so this
      // assertion proves epub.js generated the live CFI through jsdom. Under
      // the pin above, it is the xmldom-fallback detector; do not delete it as
      // redundant with the logically subsuming toEqual assertion.
      expect(liveLocations[0]).toContain("[chapter-one-start]");

      for (const cfi of liveLocations) {
        expect(buildFragment(parseFragment(`#${cfi}`))).toBe(`#${cfi}`);
      }

      const epubCfi = new EpubCFI();
      for (const [leftIndex, left] of liveLocations.entries()) {
        for (const [rightIndex, right] of liveLocations.entries()) {
          expect(epubCfi.compare(left, right)).toBe(
            Math.sign(leftIndex - rightIndex),
          );
        }
      }
    } finally {
      book.destroy();
    }
  });
});
