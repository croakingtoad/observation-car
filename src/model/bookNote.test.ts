import { describe, expect, it } from "vitest";
import { comparePositions } from "./anchor";
import {
  isBookNote,
  isBookNoteCandidate,
  parseBookNote,
} from "./bookNote";

const SOURCE = "Books/Surprised by Grace.epub";

/** PRD §5.2 frontmatter; with it, body lines start at file line 5 (0-based). */
const FRONTMATTER = [
  "---",
  "type: book-note",
  `source: "[[${SOURCE}]]"`,
  "format: epub",
  "---",
];

function note(
  bodyLines: readonly string[],
  frontmatter: readonly string[] = FRONTMATTER,
): string {
  return [...frontmatter, ...bodyLines].join("\n");
}

describe("parseBookNote — anchor recognition (PRD §5.2)", () => {
  it("parses the PRD canonical example: H2 with a source wikilink + CFI fragment", () => {
    const text = note([
      "",
      `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|Ch. 1 — the opening image]]`,
      "Free markdown.",
      "",
      `## [[${SOURCE}#epubcfi(/6/14!/4/2/12:0)|Ch. 3 — "leaves the furniture"]]`,
      "> Grace does not announce itself…",
      "",
      "Commentary.",
    ]);
    const bookNote = parseBookNote(text);
    expect(bookNote.frontmatter.source).toBe(SOURCE);
    expect(bookNote.frontmatter.format).toBe("epub");
    expect(bookNote.sections).toHaveLength(2);

    const first = bookNote.sections[0];
    expect(first.headingLine).toBe(6);
    expect(first.bodyRange).toEqual({ start: 6, end: 8 });
    expect(first.fragment).toBe("epubcfi(/6/8!/4/2/1:0)");
    expect(first.position).toEqual({ kind: "epub-cfi", cfi: "/6/8!/4/2/1:0" });
    expect(first.chapter).toBe(3); // /6/8! → 8/2 − 1

    const second = bookNote.sections[1];
    expect(second.headingLine).toBe(9);
    expect(second.bodyRange).toEqual({ start: 9, end: 12 });
    expect(second.chapter).toBe(6); // /6/14! → 14/2 − 1
    expect(bookNote.diagnostics).toEqual([]);
  });

  it("accepts heading text before and after the link, and ignores other files' links", () => {
    const text = note([
      `## Ch. 1 — [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|the opening image]] (see [[Other/note.md]])`,
    ]);
    const bookNote = parseBookNote(text);
    expect(bookNote.sections).toHaveLength(1);
    expect(bookNote.sections[0].fragment).toBe("epubcfi(/6/8!/4/2/1:0)");
  });

  it("treats H3+ and other-level headings as body content at the default level", () => {
    const text = note([
      `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|Ch 1]]`,
      "intro",
      "### subheading — not an anchor",
      "## plain H2 — not an anchor",
      "more",
      `## [[${SOURCE}#epubcfi(/6/14!/4/2/12:0)|Ch 3]]`,
    ]);
    const bookNote = parseBookNote(text);
    expect(bookNote.sections.map((section) => section.headingLine)).toEqual([5, 10]);
    // The non-anchor headings stay inside the first section's body.
    expect(bookNote.sections[0].bodyRange).toEqual({ start: 5, end: 9 });
    expect(bookNote.sections[1].bodyRange).toEqual({ start: 10, end: 10 });
  });

  it("honors a configurable anchor heading level", () => {
    const text = note([
      "## plain H2 with a link [[not-a-book.epub#epubcfi(/6/8!/4/2/1:0)|no]]",
      `### [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|H3 anchor]]`,
    ]);
    expect(parseBookNote(text).sections).toHaveLength(0);
    const h3 = parseBookNote(text, { anchorHeadingLevel: 3 });
    expect(h3.sections).toHaveLength(1);
    expect(h3.sections[0].headingLine).toBe(6);
  });

  it("does not anchor an H2 that links another file", () => {
    const text = note([
      "## [[Other/Book.pdf#page=1|wrong book]]",
    ]);
    const bookNote = parseBookNote(text);
    expect(bookNote.sections).toHaveLength(0);
    expect(bookNote.diagnostics).toHaveLength(0);
  });

  it("does not anchor a source link without a fragment", () => {
    const text = note([
      `## [[${SOURCE}|just the file]]`,
    ]);
    const bookNote = parseBookNote(text);
    expect(bookNote.sections).toHaveLength(0);
    expect(bookNote.diagnostics).toHaveLength(0);
  });

  it("ignores heading-shaped lines inside fenced code blocks", () => {
    const backtick = note([
      "```markdown",
      `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|fenced, not an anchor]]`,
      "```",
      `## [[${SOURCE}#epubcfi(/6/14!/4/2/12:0)|real]]`,
    ]);
    expect(parseBookNote(backtick).sections.map((s) => s.headingLine)).toEqual([8]);

    const tilde = note([
      "~~~",
      `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|fenced]]`,
      "~~~",
    ]);
    expect(parseBookNote(tilde).sections).toHaveLength(0);
  });

  it("parses a CFI with node-id assertions inside the wikilink", () => {
    const text = note([
      `## [[${SOURCE}#epubcfi(/6/4[chap01ref]!/4[body01]/10[para05]/2/1:3)|Ch 2]]`,
    ]);
    const bookNote = parseBookNote(text);
    expect(bookNote.sections).toHaveLength(1);
    expect(bookNote.sections[0].position).toEqual({
      kind: "epub-cfi",
      cfi: "/6/4[chap01ref]!/4[body01]/10[para05]/2/1:3",
    });
    expect(bookNote.sections[0].chapter).toBe(1); // /6/4! → 4/2 − 1
  });

  it("matches the source path case-insensitively", () => {
    const text = note([
      `## [[${SOURCE.toLowerCase()}#epubcfi(/6/8!/4/2/1:0)|lowercase link]]`,
    ]);
    expect(parseBookNote(text).sections).toHaveLength(1);
  });

  it("takes the first source link with a fragment when a heading has several", () => {
    const text = note([
      `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|first]] and [[${SOURCE}#epubcfi(/6/14!/4/2/12:0)|second]]`,
    ]);
    const bookNote = parseBookNote(text);
    expect(bookNote.sections).toHaveLength(1);
    expect(bookNote.sections[0].fragment).toBe("epubcfi(/6/8!/4/2/1:0)");
  });
});

describe("parseBookNote — link resolution (injected resolver)", () => {
  const SHORT = "Surprised by Grace.epub";

  /** Resolver double: a lookup table of linkpath (case-insensitive) → dest. */
  function resolver(dest: Record<string, string | null>) {
    return (linkpath: string): string | null =>
      dest[linkpath.toLowerCase()] ?? null;
  }

  it("matches a shortest-path link against a full-path source (Obsidian's default link format)", () => {
    // The QC Tier 2 probe: source is the full vault path, the heading uses
    // Obsidian's "shortest path when possible" form. String equality
    // silently yields zero sections; file identity must not.
    const text = note([
      `## [[${SHORT}#epubcfi(/6/8!/4/2/1:0)|Ch. 1]]`,
      "body",
    ]);
    const bookNote = parseBookNote(text, {
      resolveLink: resolver({
        [SHORT.toLowerCase()]: SOURCE,
        [SOURCE.toLowerCase()]: SOURCE,
      }),
    });
    expect(bookNote.sections).toHaveLength(1);
    expect(bookNote.sections[0].fragment).toBe("epubcfi(/6/8!/4/2/1:0)");
    expect(bookNote.diagnostics).toEqual([]);
  });

  it("matches a full-path link against a shortest-path source (mirror case)", () => {
    const text = note(
      [`## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|Ch. 1]]`, "body"],
      ["---", `source: "[[${SHORT}]]"`, "format: epub", "---"],
    );
    const bookNote = parseBookNote(text, {
      resolveLink: resolver({
        [SHORT.toLowerCase()]: SOURCE,
        [SOURCE.toLowerCase()]: SOURCE,
      }),
    });
    expect(bookNote.sections).toHaveLength(1);
    expect(bookNote.diagnostics).toEqual([]);
  });

  it("diagnoses an anchor link that resolves to a different file than the source", () => {
    const text = note([
      "## [[Books/Other.epub#epubcfi(/6/8!/4/2/1:0)|wrong book]]",
      "body",
    ]);
    const bookNote = parseBookNote(text, {
      resolveLink: resolver({
        [SOURCE.toLowerCase()]: SOURCE,
        "books/other.epub": "Books/Other.epub",
      }),
    });
    expect(bookNote.sections).toHaveLength(0);
    expect(bookNote.diagnostics).toHaveLength(1);
    expect(bookNote.diagnostics[0].line).toBe(5);
    expect(bookNote.diagnostics[0].message).toContain("Books/Other.epub");
    expect(bookNote.diagnostics[0].message).toContain(SOURCE);
  });

  it("diagnoses an anchor link that does not resolve while the source does", () => {
    // e.g. an ambiguous shortest path: the book file exists (so the source
    // resolves) but the link cannot be resolved to one file.
    const text = note([
      `## [[${SHORT}#epubcfi(/6/8!/4/2/1:0)|Ch. 1]]`,
      "body",
    ]);
    const bookNote = parseBookNote(text, {
      resolveLink: resolver({ [SOURCE.toLowerCase()]: SOURCE }),
    });
    expect(bookNote.sections).toHaveLength(0);
    expect(bookNote.diagnostics).toHaveLength(1);
    expect(bookNote.diagnostics[0].message).toContain(`[[${SHORT}]]`);
  });

  it("diagnoses a note source that does not name a file in the vault", () => {
    const text = note([
      `## [[${SHORT}#epubcfi(/6/8!/4/2/1:0)|Ch. 1]]`,
      "body",
    ]);
    const bookNote = parseBookNote(text, { resolveLink: () => null });
    expect(bookNote.sections).toHaveLength(0);
    expect(bookNote.diagnostics).toHaveLength(1);
    expect(bookNote.diagnostics[0].line).toBe(5);
    expect(bookNote.diagnostics[0].message).toContain("note's source");
    expect(bookNote.diagnostics[0].message).toContain(SOURCE);
    expect(bookNote.diagnostics[0].message).toContain(
      "does not name a file in the vault",
    );
  });

  it("falls back to string comparison when no resolver is supplied", () => {
    // Without an Obsidian resolver (plain-Node parser use), the old
    // case-insensitive string equality remains the compatibility path.
    const shortLink = note([
      `## [[${SHORT}#epubcfi(/6/8!/4/2/1:0)|Ch. 1]]`,
      "body",
    ]);
    const miss = parseBookNote(shortLink);
    expect(miss.sections).toHaveLength(0);
    expect(miss.diagnostics).toEqual([]);

    const exact = note([
      `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|Ch. 1]]`,
      "body",
    ]);
    const hit = parseBookNote(exact);
    expect(hit.sections).toHaveLength(1);
  });

  it("compares resolved paths case-insensitively", () => {
    const text = note([
      `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|Ch. 1]]`,
      "body",
    ]);
    const bookNote = parseBookNote(text, {
      resolveLink: resolver({
        [SOURCE.toLowerCase()]: "books/surprised by grace.epub",
      }),
    });
    expect(bookNote.sections).toHaveLength(1);
  });

  it("keeps the string-comparison behavior when no resolver is supplied", () => {
    const text = note([
      `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|Ch. 1]]`,
      "body",
    ]);
    expect(parseBookNote(text).sections).toHaveLength(1);
  });
});

describe("parseBookNote — no anchors / absent frontmatter", () => {
  it("returns no sections for a note with no anchors", () => {
    const text = note(["", "Just prose.", "", "## An ordinary heading", "More prose."]);
    const bookNote = parseBookNote(text);
    expect(bookNote.sections).toEqual([]);
    expect(bookNote.diagnostics).toEqual([]);
  });

  it("returns no sections when the frontmatter is absent, even with anchor-looking headings", () => {
    const text = [
      `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|looks anchored]]`,
      "body",
    ].join("\n");
    const bookNote = parseBookNote(text);
    expect(bookNote.frontmatter.data).toEqual({});
    expect(bookNote.frontmatter.source).toBeNull();
    expect(bookNote.frontmatter.format).toBeNull();
    expect(bookNote.sections).toEqual([]);
    expect(bookNote.diagnostics).toEqual([]);
  });

  it("parses an empty file", () => {
    const bookNote = parseBookNote("");
    expect(bookNote.frontmatter.data).toEqual({});
    expect(bookNote.sections).toEqual([]);
  });

  it("treats an unclosed opening --- as body, not frontmatter", () => {
    const text = ["---", "source: something", "", "body"].join("\n");
    expect(parseBookNote(text).frontmatter.data).toEqual({});
  });
});

describe("parseBookNote — body ranges", () => {
  it("runs each section from its anchor to the line before the next anchor", () => {
    const text = note([
      `## [[${SOURCE}#epubcfi(/6/4!/4/2/1:0)|a]]`,
      "x",
      "y",
      `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|b]]`,
      "z",
      `## [[${SOURCE}#epubcfi(/6/12!/4/2/1:0)|c]]`,
      "",
      "end",
    ]);
    const bookNote = parseBookNote(text);
    // 8 body lines → file lines 5..12 (last index 12).
    expect(bookNote.sections.map((s) => s.bodyRange)).toEqual([
      { start: 5, end: 7 },
      { start: 8, end: 9 },
      { start: 10, end: 12 },
    ]);
  });

  it("gives a single-line body to consecutive anchor headings", () => {
    const text = note([
      `## [[${SOURCE}#epubcfi(/6/4!/4/2/1:0)|a]]`,
      `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|b]]`,
    ]);
    expect(parseBookNote(text).sections.map((s) => s.bodyRange)).toEqual([
      { start: 5, end: 5 },
      { start: 6, end: 6 },
    ]);
  });

  it("handles CRLF line endings identically to LF", () => {
    const body = [
      "",
      `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|Ch 1]]`,
      "body",
    ];
    const lf = parseBookNote(note(body));
    const crlf = parseBookNote([...FRONTMATTER, ...body].join("\r\n"));
    expect(crlf.sections).toEqual(lf.sections);
  });
});

describe("parseBookNote — malformed fragments", () => {
  it.each([
    "epubcfi()",
    "epubcfi(/6/8!/4/2/1:0", // unterminated
    "epubcfi(/6/8!)", // empty path
    "epubcfi(/7/8!/4/2/1:0)", // odd spine index
    "epubcfi(/6/8!/x/2/1:0)", // non-numeric step
    "page=0",
    "page=x",
    "page=7&bogus=1",
    "page=7&selection=1,2,3",
  ])("treats a heading with fragment %s as body content with a diagnostic", (fragment) => {
    const text = note([
      `## [[${SOURCE}#${fragment}|broken]]`,
      "body",
      `## [[${SOURCE}#epubcfi(/6/14!/4/2/12:0)|good]]`,
    ]);
    const bookNote = parseBookNote(text);
    expect(bookNote.diagnostics).toHaveLength(1);
    expect(bookNote.diagnostics[0].line).toBe(5);
    expect(bookNote.diagnostics[0].message).toContain("Malformed anchor fragment");
    // The broken heading is not an anchor; the later valid one still is.
    expect(bookNote.sections).toHaveLength(1);
    expect(bookNote.sections[0].headingLine).toBe(7);
  });

  it("diagnoses an EPUB fragment in a PDF-format note (and vice versa)", () => {
    const pdfText = note(
      [`## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|wrong kind]]`],
      ["---", `source: "[[${SOURCE}]]"`, "format: pdf", "---"],
    );
    const epubText = note([`## [[${SOURCE}#page=7|wrong kind]]`]);
    const pdf = parseBookNote(pdfText);
    const epub = parseBookNote(epubText);
    expect(pdf.diagnostics).toHaveLength(1);
    expect(pdf.diagnostics[0].message).toContain('kind "epub-cfi" does not match');
    expect(epub.diagnostics).toHaveLength(1);
    expect(epub.diagnostics[0].message).toContain('kind "pdf-page" does not match');
    expect(pdf.sections).toHaveLength(0);
    expect(epub.sections).toHaveLength(0);
  });

  it("accepts either fragment kind when the note has no format field", () => {
    const noFormat = [
      "---",
      `source: "[[${SOURCE}]]"`,
      "---",
      "",
      `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|cfi]]`,
      "",
      `## [[${SOURCE}#page=7|page]]`,
    ].join("\n");
    const bookNote = parseBookNote(noFormat);
    expect(bookNote.frontmatter.format).toBeNull();
    expect(bookNote.sections).toHaveLength(2);
    expect(bookNote.diagnostics).toHaveLength(0);
  });

  it("orders multiple diagnostics by line", () => {
    const text = note([
      `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|ok]]`,
      "",
      `## [[${SOURCE}#page=1|bad for epub]]`,
      "",
      `## [[${SOURCE}#epubcfi(/7/8!/4/2/1:0)|bad cfi]]`,
    ]);
    const bookNote = parseBookNote(text);
    expect(bookNote.diagnostics.map((d) => d.line)).toEqual([7, 9]);
    expect(bookNote.sections).toHaveLength(1);
  });
});

describe("parseBookNote — ordering (PRD §5.2: file order, not book order)", () => {
  it("keeps hand-reordered anchors in file order with intact positions", () => {
    const text = note([
      `## [[${SOURCE}#epubcfi(/6/14!/4/2/12:0)|later chapter first]]`,
      "body",
      `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|earlier chapter second]]`,
    ]);
    const bookNote = parseBookNote(text);
    expect(bookNote.sections.map((s) => s.fragment)).toEqual([
      "epubcfi(/6/14!/4/2/12:0)",
      "epubcfi(/6/8!/4/2/1:0)",
    ]);
    // The comparator proves the positions are out of book order, and sorting
    // by position recovers book order — the parser itself must not sort.
    const [first, second] = bookNote.sections;
    expect(comparePositions(first.position, second.position)).toBeGreaterThan(0);
    const byPosition = [...bookNote.sections].sort((a, b) =>
      comparePositions(a.position, b.position),
    );
    expect(byPosition.map((s) => s.headingLine)).toEqual([7, 5]);
  });
});

describe("parseBookNote — chapter", () => {
  it("derives the spine item index from the CFI chapter component", () => {
    const cases: Array<[string, number]> = [
      ["epubcfi(/6/8!/4/2/1:0)", 3],
      ["epubcfi(/6/14!/4/2/12:0)", 6],
      ["epubcfi(/6/4[chap01ref]!/4[body01]/2/1:3)", 1],
      // Range CFIs take the chapter from the base component.
      ["epubcfi(/6/10!/4/2/6:32,/2/1:1,/2/1:80)", 4],
    ];
    for (const [fragment, chapter] of cases) {
      const text = note([`## [[${SOURCE}#${fragment}|x]]`]);
      expect(parseBookNote(text).sections[0].chapter).toBe(chapter);
    }
  });

  it("leaves spine-href and PDF anchors' chapter null (resolved with the book)", () => {
    const text = note([
      `## [[${SOURCE}#chapters/ch3.xhtml|spine href]]`,
      "",
    ]);
    const bookNote = parseBookNote(text);
    expect(bookNote.sections[0].position).toEqual({
      kind: "epub-spine",
      href: "chapters/ch3.xhtml",
    });
    expect(bookNote.sections[0].chapter).toBeNull();

    const pdfText = note(
      [`## [[${SOURCE}#page=7&selection=12,0,14,40|p. 7]]`],
      ["---", `source: "[[${SOURCE}]]"`, "format: pdf", "---"],
    );
    expect(parseBookNote(pdfText).sections[0].chapter).toBeNull();
  });
});

describe("parseBookNote — frontmatter", () => {
  it("parses the full PRD §5.2 frontmatter with typed scalars", () => {
    const text = [
      "---",
      "type: book-note",
      `source: "[[${SOURCE}]]"`,
      "format: epub",
      "title: Surprised by Grace",
      "author: A. N. Author",
      "booklore_id: 142",
      "booklore_url: https://booklore.example/book/142",
      `cover: "[[Books/covers/142.jpg]]"`,
      "---",
      "",
    ].join("\n");
    const frontmatter = parseBookNote(text).frontmatter;
    expect(frontmatter.data).toEqual({
      type: "book-note",
      source: `[[${SOURCE}]]`,
      format: "epub",
      title: "Surprised by Grace",
      author: "A. N. Author",
      booklore_id: 142,
      booklore_url: "https://booklore.example/book/142",
      cover: "[[Books/covers/142.jpg]]",
    });
    expect(frontmatter.source).toBe(SOURCE);
    expect(frontmatter.format).toBe("epub");
  });

  it("accepts a bare (unbracketed) source path and strips fragments", () => {
    const bare = parseBookNote(["---", `source: ${SOURCE}`, "---", ""].join("\n")).frontmatter;
    expect(bare.source).toBe(SOURCE);

    const withFragment = parseBookNote(
      ["---", `source: "[[${SOURCE}#epubcfi(/6/8!/4/2/1:0)]]"`, "---", ""].join("\n"),
    ).frontmatter;
    expect(withFragment.source).toBe(SOURCE);
  });

  it("normalizes the format field and treats unknown values as null", () => {
    expect(
      parseBookNote(["---", "source: x", "format: PDF", "---", ""].join("\n")).frontmatter.format,
    ).toBe("pdf");
    expect(
      parseBookNote(["---", "source: x", "format: docx", "---", ""].join("\n")).frontmatter.format,
    ).toBeNull();
  });

  it("tolerates a BOM before the opening ---", () => {
    const text = "\uFEFF---\nsource: x\n---\n";
    expect(parseBookNote(text).frontmatter.source).toBe("x");
  });

  it("reports no source for an empty source value", () => {
    const bookNote = parseBookNote(["---", 'source: ""', "---", ""].join("\n"));
    expect(bookNote.frontmatter.source).toBeNull();
    expect(isBookNote(bookNote)).toBe(false);
  });
});

describe("parseBookNote — isBookNote / isBookNoteCandidate", () => {
  it("classifies a parsed note by its source", () => {
    expect(isBookNote(parseBookNote(note(["body"])))).toBe(true);
    expect(isBookNote(parseBookNote("## [[x.epub#page=1|y]]"))).toBe(false);
  });

  const cases: Array<[Record<string, unknown> | null | undefined, boolean]> = [
    [null, false],
    [undefined, false],
    [{}, false],
    [{ type: "book-note" }, true],
    [{ source: "Books/a.epub" }, true],
    [{ source: "  " }, false],
    [{ source: 42 }, false],
  ];
  it.each(cases)("isBookNoteCandidate(%o) → %o", (frontmatter, expected) => {
    expect(isBookNoteCandidate(frontmatter)).toBe(expected);
  });
});

describe("parseBookNote — purity", () => {
  const SAMPLE = note([
    "",
    `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|Ch 1]]`,
    "body",
  ]);

  it("retains the exact source text used to produce the parse", () => {
    expect(parseBookNote(SAMPLE).sourceText).toBe(SAMPLE);
  });

  it("returns equal results for the same input", () => {
    expect(parseBookNote(SAMPLE)).toEqual(parseBookNote(SAMPLE));
  });

  it("does not mutate its input", () => {
    const before = SAMPLE;
    parseBookNote(SAMPLE, { anchorHeadingLevel: 3 });
    expect(SAMPLE).toBe(before);
  });
});

describe("parseBookNote — CRLF normalisation (LOCO-924)", () => {
  const SOURCE = "Books/Surprised by Grace.epub";
  const FRONTMATTER = [
    "---",
    "type: book-note",
    `source: "[[${SOURCE}]]"`,
    "format: epub",
    "---",
  ];

  it("normalises CRLF to LF in sourceText and preserves section line indices", () => {
    const body = [
      "preamble",
      `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|Ch 1]]`,
      "first paragraph",
      "second paragraph",
      `## [[${SOURCE}#epubcfi(/6/14!/4/2/12:0)|Ch 3]]`,
      "more text",
    ];
    const crlfText = [...FRONTMATTER, ...body].join("\r\n");
    const lfText = [...FRONTMATTER, ...body].join("\n");

    const crlfNote = parseBookNote(crlfText);
    const lfNote = parseBookNote(lfText);

    expect(crlfNote.sourceText).toBe(lfText);
    expect(crlfNote.sourceText).not.toBe(crlfText);
    expect(crlfNote.sections).toEqual(lfNote.sections);
    expect(crlfNote.sections.map((s) => s.headingLine)).toEqual(
      lfNote.sections.map((s) => s.headingLine),
    );
    expect(crlfNote.sections.length).toBeGreaterThan(0);
  });
});

describe("parseBookNote — lone CR line indices (LOCO-936)", () => {
  const SOURCE = "Books/x.epub";
  const body = [
    "intro\rmore",
    `## [[${SOURCE}#epubcfi(/6/4!/4/2/1:0)|Later]]`,
    "body a",
    `## [[${SOURCE}#epubcfi(/6/2!/4/2/1:0)|Earlier]]`,
    "body b",
  ];
  const text = [
    "---",
    `source: "[[${SOURCE}]]"`,
    "format: epub",
    "---",
    ...body,
  ].join("\n");
  const parsed = parseBookNote(text);

  it("indexes lone CR as a line break for every section", () => {
    expect(parsed.sections).toHaveLength(2);
    expect(
      parsed.sections.map(
        (section) => parsed.sourceText.split("\n")[section.headingLine],
      ),
    ).toEqual([
      `## [[${SOURCE}#epubcfi(/6/4!/4/2/1:0)|Later]]`,
      `## [[${SOURCE}#epubcfi(/6/2!/4/2/1:0)|Earlier]]`,
    ]);
  });
});

describe("parseBookNote — performance (PRD §7: ~5,000 lines must not block the UI)", () => {
  function buildLargeNote(totalLines: number): { text: string; sections: number } {
    const lines: string[] = [
      "---",
      "type: book-note",
      `source: "[[${SOURCE}]]"`,
      "format: epub",
      "---",
      "",
    ];
    let section = 0;
    while (lines.length < totalLines) {
      if (lines.length % 20 === 0) {
        const spine = 4 + section * 2; // even, ascending — valid CFI spine
        lines.push(`## [[${SOURCE}#epubcfi(/6/${spine}!/4/2/${section}:0)|Note ${section}]]`);
        section += 1;
      } else {
        // Body lines carry an inline source link too, exercising the
        // wikilink scanner on every line.
        lines.push(
          `Body paragraph ${lines.length} with a [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|reference]] and prose.`,
        );
      }
    }
    return { text: lines.join("\n"), sections: section };
  }

  it("parses 5,000 lines well inside a UI-blocking budget", () => {
    const { text, sections: expectedSections } = buildLargeNote(5000);
    const startedAt = performance.now();
    const bookNote = parseBookNote(text);
    const elapsedMs = performance.now() - startedAt;
    expect(bookNote.sections.length).toBe(expectedSections);
    expect(bookNote.sections.length).toBeGreaterThan(100);
    expect(bookNote.diagnostics).toHaveLength(0);
    // PRD §7: parsing must not block the UI. 250 ms is ~15 frames; the real
    // parse is orders of magnitude below this (measured in the LOCO-22 report).
    expect(elapsedMs).toBeLessThan(250);
  });
});
