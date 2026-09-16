import { describe, expect, it } from "vitest";
import {
  AnchorError,
  buildEpubCfiFragment,
  buildEpubSpineFragment,
  buildFragment,
  buildPdfFragment,
  comparePositions,
  parseFragment,
  spineIndexFromCfi,
  type SelectionRect,
} from "./anchor";

const cfiPosition = (cfi: string) => ({ kind: "epub-cfi" as const, cfi });
const pagePosition = (page: number, selection?: SelectionRect) =>
  selection === undefined
    ? { kind: "pdf-page" as const, page }
    : { kind: "pdf-page" as const, page, selection };

describe("parseFragment — EPUB CFI", () => {
  it("parses the PRD canonical form with a leading #", () => {
    expect(parseFragment("#epubcfi(/6/8!/4/2/1:0)")).toEqual(
      cfiPosition("/6/8!/4/2/1:0"),
    );
    expect(parseFragment("#epubcfi(/6/14!/4/2/12:0)")).toEqual(
      cfiPosition("/6/14!/4/2/12:0"),
    );
  });

  it("parses the same fragment without the leading #", () => {
    expect(parseFragment("epubcfi(/6/8!/4/2/1:0)")).toEqual(
      cfiPosition("/6/8!/4/2/1:0"),
    );
  });

  it("parses a range CFI from a selection (base!path, start, end)", () => {
    expect(
      parseFragment("#epubcfi(/6/4!/4/2/6:32,/2/1:1,/2/1:80)"),
    ).toEqual(cfiPosition("/6/4!/4/2/6:32,/2/1:1,/2/1:80"));
  });

  it("parses node-id assertions", () => {
    expect(
      parseFragment("#epubcfi(/6/4[chap01ref]!/4[body01]/10[para05]/2/1:3)"),
    ).toEqual(cfiPosition("/6/4[chap01ref]!/4[body01]/10[para05]/2/1:3"));
  });

  it("normalizes a double-wrapped raw epub.js location", () => {
    expect(parseFragment("#epubcfi(epubcfi(/6/8!/4/2/1:0))")).toEqual(
      cfiPosition("/6/8!/4/2/1:0"),
    );
  });

  it.each([
    "epubcfi()",
    "epubcfi(/6/8!/4/2/1:0", // unterminated
    "epubcfi(nonsense)",
    "epubcfi(/6/8!)", // empty path; epub.js throws on compare
    "epubcfi(/7/8!/4/2/1:0)", // odd spine index
    "epubcfi(/6/8!/x/2/1:0)", // non-numeric step
    "epubcfi(/6/8!/4/2/1:0)trailing",
    "epubcfi(/6/4!/4/2/6:32,/6/4!/4/2/6:80)", // range without end
    "epubcfi(/6/4!/4/2/6:01.5)", // bad offset
    "epubcfi(/6/4!/4/2/6:32,/6/4!/4/2/6:80,/6/4!/4/2/6:90)/extra",
  ])("rejects malformed CFI fragment %s", (fragment) => {
    expect(() => parseFragment(fragment)).toThrowError(AnchorError);
  });
});

describe("parseFragment — spine item href", () => {
  it("parses a bare href as a chapter-level EPUB anchor", () => {
    expect(parseFragment("#chapters/ch3.xhtml")).toEqual({
      kind: "epub-spine",
      href: "chapters/ch3.xhtml",
    });
    expect(parseFragment("intro.xhtml")).toEqual({
      kind: "epub-spine",
      href: "intro.xhtml",
    });
  });

  it("keeps query strings intact", () => {
    expect(parseFragment("#part1.xhtml?version=2&x=1")).toEqual({
      kind: "epub-spine",
      href: "part1.xhtml?version=2&x=1",
    });
  });

  it.each(["chapter 3.xhtml", "ch#3.xhtml", "ch\u00003.xhtml"])(
    "rejects invalid href %s",
    (href) => {
      expect(() => parseFragment(`#${href}`)).toThrowError(AnchorError);
    },
  );
});

describe("parseFragment — PDF page", () => {
  it("parses a bare page link", () => {
    expect(parseFragment("#page=7")).toEqual(pagePosition(7));
  });

  it("parses the PRD selection form", () => {
    expect(parseFragment("#page=7&selection=12,0,14,40")).toEqual(
      pagePosition(7, [12, 0, 14, 40]),
    );
  });

  it("parses and ignores &height= without selection", () => {
    expect(parseFragment("#page=12&height=1.5")).toEqual(pagePosition(12));
  });

  it("parses &height= alongside a selection", () => {
    expect(
      parseFragment("#page=3&selection=1.5,2,3.25,4&height=0.75"),
    ).toEqual(pagePosition(3, [1.5, 2, 3.25, 4]));
  });

  it("accepts height and selection in either order", () => {
    expect(
      parseFragment("#page=3&height=0&selection=1,2,3,4"),
    ).toEqual(pagePosition(3, [1, 2, 3, 4]));
  });

  it.each([
    "page=0",
    "page=",
    "page=3.5",
    "page=abc",
    "page=+3",
    "page=3&selection=1,2,3",
    "page=3&selection=1,2,3,4,5",
    "page=3&selection=1,2,three,4",
    "page=3&selection=1e2,2,3,4",
    "page=3&height=",
    "page=3&height=high",
    "page=3&foo=1",
    "page=3&selection=1,2,3,4&selection=5,6,7,8",
    "page=3&height=1&height=2",
    "page=3&page=4",
    "page=99999999999999999999",
  ])("rejects invalid PDF fragment %s", (fragment) => {
    expect(() => parseFragment(`#${fragment}`)).toThrowError(AnchorError);
  });

  it("rejects an empty fragment", () => {
    expect(() => parseFragment("")).toThrowError(AnchorError);
    expect(() => parseFragment("#")).toThrowError(AnchorError);
  });
});

describe("buildFragment", () => {
  it("builds the PRD canonical EPUB CFI form", () => {
    expect(buildEpubCfiFragment("/6/8!/4/2/1:0")).toBe(
      "#epubcfi(/6/8!/4/2/1:0)",
    );
    expect(buildEpubCfiFragment("epubcfi(/6/8!/4/2/1:0)")).toBe(
      "#epubcfi(/6/8!/4/2/1:0)",
    );
    expect(() => buildEpubCfiFragment("garbage")).toThrowError(AnchorError);
  });

  it("builds spine href fragments", () => {
    expect(buildEpubSpineFragment("ch3.xhtml")).toBe("#ch3.xhtml");
    expect(() => buildEpubSpineFragment("a b")).toThrowError(AnchorError);
  });

  it("rejects an empty spine href at both build and parse boundaries", () => {
    expect(() =>
      buildFragment({ kind: "epub-spine", href: "" }),
    ).toThrowError(new AnchorError("spine href must not be empty"));
    expect(() => parseFragment("#")).toThrowError(
      new AnchorError("fragment is empty"),
    );
  });

  it("rejects a missing spine href with AnchorError", () => {
    expect(() => buildEpubSpineFragment(undefined)).toThrowError(
      new AnchorError("spine href must be a string"),
    );
  });

  it("builds PDF fragments in PDF++-compatible syntax", () => {
    expect(buildPdfFragment(7)).toBe("#page=7");
    expect(buildPdfFragment(7, [12, 0, 14, 40])).toBe(
      "#page=7&selection=12,0,14,40",
    );
    expect(() => buildPdfFragment(0)).toThrowError(AnchorError);
    expect(() => buildPdfFragment(3.5)).toThrowError(AnchorError);
    expect(() => buildPdfFragment(1, [1, 2, 3, Number.NaN])).toThrowError(
      AnchorError,
    );
  });

  it("round-trips every position kind through build + parse", () => {
    const positions = [
      cfiPosition("/6/8!/4/2/1:0"),
      cfiPosition("/6/4[chap]!/4[body]/10/2/1:3"),
      cfiPosition("/6/4!/4/2/6:32,/2/1:1,/2/1:80"),
      { kind: "epub-spine" as const, href: "chapters/ch3.xhtml" },
      pagePosition(7),
      pagePosition(7, [12, 0, 14, 40]),
    ];
    for (const position of positions) {
      expect(parseFragment(buildFragment(position))).toEqual(position);
    }
  });
});

describe("comparePositions — EPUB", () => {
  const ch1 = cfiPosition("/6/8!/4/2/1:0");
  const ch3 = cfiPosition("/6/14!/4/2/12:0");

  it("orders CFI positions via EpubCFI.compare", () => {
    expect(comparePositions(ch1, ch3)).toBe(-1);
    expect(comparePositions(ch3, ch1)).toBe(1);
    expect(comparePositions(ch1, ch1)).toBe(0);
  });

  it("orders by character offset within the same spine position", () => {
    const early = cfiPosition("/6/8!/4/2/1:0");
    const later = cfiPosition("/6/8!/4/2/1:5");
    expect(comparePositions(early, later)).toBe(-1);
    expect(comparePositions(later, early)).toBe(1);
  });

  it("orders a shallower path before the deeper one (epub.js semantics)", () => {
    const shallow = cfiPosition("/6/8!/4/2/1:0");
    const deep = cfiPosition("/6/8!/4/2/1/0:0");
    expect(comparePositions(shallow, deep)).toBe(-1);
  });

  it("compares range CFIs by their start position", () => {
    const range = cfiPosition("/6/4!/4/2/6:32,/2/1:1,/2/1:80");
    const laterStart = cfiPosition("/6/4!/4/2/6:32,/2/1:50,/2/1:80");
    const earlierChapter = cfiPosition("/6/2!/4/2/1:0");
    expect(comparePositions(range, range)).toBe(0);
    expect(comparePositions(range, laterStart)).toBe(-1);
    expect(comparePositions(laterStart, range)).toBe(1);
    expect(comparePositions(earlierChapter, range)).toBe(-1);
  });

  it("orders a range after the point at its anchor (epub.js semantics)", () => {
    const range = cfiPosition("/6/4!/4/2/6:32,/2/1:1,/2/1:80");
    const anchor = cfiPosition("/6/4!/4/2/6:32");
    // The range's start sub-path is more specific than the bare path, so
    // EpubCFI.compare places it after the point at that path.
    expect(comparePositions(anchor, range)).toBe(-1);
    expect(comparePositions(range, anchor)).toBe(1);
  });
});

describe("comparePositions — PDF", () => {
  it("orders by page", () => {
    expect(comparePositions(pagePosition(7), pagePosition(8))).toBe(-1);
    expect(comparePositions(pagePosition(8), pagePosition(7))).toBe(1);
    expect(comparePositions(pagePosition(7), pagePosition(7))).toBe(0);
  });

  it("then by selection start (a,b,c,d)", () => {
    const a = pagePosition(7, [12, 0, 14, 40]);
    const b = pagePosition(7, [14, 0, 16, 40]);
    expect(comparePositions(a, b)).toBe(-1);
    expect(comparePositions(b, a)).toBe(1);
  });

  it("then by the remaining selection coordinates", () => {
    const a = pagePosition(7, [12, 0, 14, 40]);
    const b = pagePosition(7, [12, 5, 14, 40]);
    const c = pagePosition(7, [12, 0, 15, 40]);
    expect(comparePositions(a, b)).toBe(-1);
    expect(comparePositions(a, c)).toBe(-1);
    expect(comparePositions(a, pagePosition(7, [12, 0, 14, 40]))).toBe(0);
  });

  it("sorts a bare page anchor before selections on that page", () => {
    expect(
      comparePositions(pagePosition(7), pagePosition(7, [1, 2, 3, 4])),
    ).toBe(-1);
    expect(
      comparePositions(pagePosition(7, [1, 2, 3, 4]), pagePosition(7)),
    ).toBe(1);
  });
});

describe("comparePositions — kinds and consistency", () => {
  it("keeps a fixed order across kinds", () => {
    const epub = cfiPosition("/6/8!/4/2/1:0");
    const spine = { kind: "epub-spine" as const, href: "ch3.xhtml" };
    const pdf = pagePosition(1);
    expect(comparePositions(epub, spine)).toBe(-1);
    expect(comparePositions(spine, pdf)).toBe(-1);
    expect(comparePositions(pdf, epub)).toBe(1);
  });

  it("orders spine hrefs deterministically by code units", () => {
    const a = { kind: "epub-spine" as const, href: "a/10.xhtml" };
    const b = { kind: "epub-spine" as const, href: "a/2.xhtml" };
    const c = { kind: "epub-spine" as const, href: "a/2.xhtml" };
    expect(comparePositions(a, b)).toBe(-1); // "1" < "2", not numeric
    expect(comparePositions(b, c)).toBe(0);
  });

  it("is antisymmetric for same-kind pairs", () => {
    const positions = [
      cfiPosition("/6/8!/4/2/1:0"),
      cfiPosition("/6/14!/4/2/12:0"),
      pagePosition(7),
      pagePosition(7, [12, 0, 14, 40]),
      pagePosition(3, [1, 2, 3, 4]),
    ];
    for (const left of positions) {
      for (const right of positions) {
        if (left.kind !== right.kind) {
          continue;
        }
        const forward = Math.sign(comparePositions(left, right));
        const backward = Math.sign(comparePositions(right, left));
        expect(forward + backward).toBe(0);
      }
    }
  });

  it("sorts a mixed section list the way Array.sort expects", () => {
    const shuffled = [
      pagePosition(9),
      cfiPosition("/6/14!/4/2/12:0"),
      pagePosition(7, [14, 0, 16, 40]),
      cfiPosition("/6/8!/4/2/1:0"),
      pagePosition(7),
    ];
    const sorted = [...shuffled].sort(comparePositions);
    expect(sorted).toEqual([
      cfiPosition("/6/8!/4/2/1:0"),
      cfiPosition("/6/14!/4/2/12:0"),
      pagePosition(7),
      pagePosition(7, [14, 0, 16, 40]),
      pagePosition(9),
    ]);
  });
});

describe("spineIndexFromCfi", () => {
  it("derives the 0-based spine item index from the chapter component", () => {
    // Same convention as the BookNote model: N/2 − 1 of the second step.
    expect(spineIndexFromCfi("/6/8!/4/2/1:0")).toBe(3);
    expect(spineIndexFromCfi("/6/14!/4/2/12:0")).toBe(6);
    expect(spineIndexFromCfi("/2/2!/4/2/1:0")).toBe(0);
  });

  it("takes the chapter from the base component of a range CFI", () => {
    expect(spineIndexFromCfi("/6/4!/4/2/6:32,/2/1:1,/2/1:80")).toBe(1);
  });

  it("accepts node-id assertions on either step", () => {
    expect(spineIndexFromCfi("/6[chap01ref]/8[body01]!/4/2/1:3")).toBe(3);
  });

  it("accepts the epubcfi(...) wrapper relocated events carry", () => {
    expect(spineIndexFromCfi("epubcfi(/6/8!/4/2/1:0)")).toBe(3);
  });

  it("returns null for non-canonical chapter components", () => {
    expect(spineIndexFromCfi("/6/8")).toBeNull(); // missing "!"
    expect(spineIndexFromCfi("/6!")).toBeNull(); // missing second step
    expect(spineIndexFromCfi("/6/0!/4/2/1:0")).toBeNull(); // zero offset
    expect(spineIndexFromCfi("/6/7!")).toBeNull(); // odd offset
    expect(spineIndexFromCfi("")).toBeNull();
  });
});
