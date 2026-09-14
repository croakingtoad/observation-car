import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { parseBookNote } from "./bookNote";

const SOURCE = "Books/Surprised by Grace.epub";

function anchor(label: "one" | "two"): string {
  const spine = label === "one" ? 4 : 6;
  return `## [[${SOURCE}#epubcfi(/6/${spine}!/4/2/1:0)|${label}]]`;
}

type LineBreak = "\n" | "\r\n" | "\r";

const FRONTMATTER = [
  "---",
  "type: book-note",
  `source: "[[${SOURCE}]]"`,
  "format: epub",
  "---",
];

interface LineBreakRow {
  readonly name: string;
  readonly body: readonly string[];
  /** One break per gap between the document's frontmatter and body lines. */
  readonly breaks: readonly LineBreak[];
  readonly trailing?: LineBreak;
}

const LF: LineBreak[] = ["\n"];
const CRLF: LineBreak[] = ["\r\n"];
const CR: LineBreak[] = ["\r"];
const LF_ONLY = Array(9).fill("\n") as LineBreak[];
const CRLF_ONLY = Array(9).fill("\r\n") as LineBreak[];
const CR_ONLY = Array(9).fill("\r") as LineBreak[];

const LINE_BREAK_ROWS: readonly LineBreakRow[] = [
  { name: "LF only", body: ["first", anchor("one"), "body one", anchor("two"), "body two"], breaks: LF_ONLY, trailing: "\n" },
  { name: "CRLF only", body: ["first", anchor("one"), "body one", anchor("two"), "body two"], breaks: CRLF_ONLY, trailing: "\r\n" },
  { name: "lone CR only", body: ["first", anchor("one"), "body one", anchor("two"), "body two"], breaks: CR_ONLY, trailing: "\r" },
  {
    name: "mixed LF and CRLF",
    body: ["first", anchor("one"), "body one", anchor("two"), "body two"],
    breaks: [...LF, ...CRLF, ...LF, ...CRLF, ...LF, ...CRLF, ...LF, ...CRLF, ...LF],
    trailing: "\n",
  },
  {
    name: "mixed LF and lone CR before anchor one",
    body: ["first", anchor("one"), "body one", anchor("two"), "body two"],
    breaks: [...LF, ...LF, ...LF, ...LF, ...LF, ...CR, ...LF, ...LF, ...LF],
  },
  {
    name: "mixed CRLF and lone CR",
    body: ["first", anchor("one"), "body one", anchor("two"), "body two"],
    breaks: [...CRLF, ...CR, ...CRLF, ...CRLF, ...CRLF, ...CRLF, ...CRLF, ...CRLF, ...CRLF],
    trailing: "\r\n",
  },
  {
    name: "all three line breaks mixed",
    body: ["first", anchor("one"), "body one", anchor("two"), "body two"],
    breaks: [...LF, ...CRLF, ...CR, ...LF, ...CRLF, ...CR, ...LF, ...CRLF, ...LF],
    trailing: "\r",
  },
  {
    name: "CRLF immediately before an anchor heading",
    body: ["preamble", anchor("one"), "body one", anchor("two"), "body two"],
    breaks: [...LF, ...LF, ...LF, ...LF, ...LF, ...CRLF, ...LF, ...LF, ...LF],
    trailing: "\n",
  },
  {
    name: "lone CR immediately before an anchor heading",
    body: ["preamble", anchor("one"), "body one", anchor("two"), "body two"],
    breaks: [...LF, ...LF, ...LF, ...LF, ...LF, ...CR, ...LF, ...LF, ...LF],
    trailing: "\n",
  },
  {
    name: "consecutive LF blank lines",
    body: ["first", "", "", anchor("one"), "", "", anchor("two"), "body two"],
    breaks: Array(12).fill("\n") as LineBreak[],
    trailing: "\n",
  },
  {
    name: "consecutive CRLF blank lines",
    body: ["first", "", "", anchor("one"), "", "", anchor("two"), "body two"],
    breaks: Array(12).fill("\r\n") as LineBreak[],
    trailing: "\r\n",
  },
  {
    name: "consecutive lone CR blank lines",
    body: ["first", "", "", anchor("one"), "", "", anchor("two"), "body two"],
    breaks: Array(12).fill("\r") as LineBreak[],
    trailing: "\r",
  },
  {
    name: "leading LF blank line and trailing CRLF",
    body: ["", "first", anchor("one"), "body one", anchor("two"), "body two"],
    breaks: [...LF, ...LF, ...LF, ...LF, ...LF, ...LF, ...LF, ...LF, ...LF, ...LF],
    trailing: "\r\n",
  },
  {
    name: "leading lone CR blank line, no trailing newline",
    body: ["", "first", anchor("one"), "body one", anchor("two"), "body two"],
    breaks: [...CR, ...LF, ...LF, ...LF, ...LF, ...LF, ...LF, ...LF, ...LF, ...LF],
  },
  {
    name: "empty body between two anchors",
    body: [anchor("one"), anchor("two")],
    breaks: [...LF, ...LF, ...LF, ...LF, ...LF, ...LF],
  },
  {
    name: "U+2028 and U+2029 are not line breaks",
    body: ["first\u2028second", anchor("one"), "body one\u2029continued", anchor("two"), "body two"],
    breaks: LF_ONLY,
  },
];

function documentLinesFor(row: LineBreakRow): readonly string[] {
  return [...FRONTMATTER, ...row.body];
}

function textFor(row: LineBreakRow): string {
  const documentLines = documentLinesFor(row);
  return documentLines
    .map((line, index) => (index < documentLines.length - 1 ? `${line}${row.breaks[index]}` : line))
    .join("") + (row.trailing ?? "");
}

describe("parseBookNote — CM6 line-break oracle (PL-036)", () => {
  it("has a complete, non-degenerate break table", () => {
    const inputs = LINE_BREAK_ROWS.map(textFor);
    expect(new Set(inputs).size).toBe(LINE_BREAK_ROWS.length);

    for (const row of LINE_BREAK_ROWS) {
      expect(row.breaks.length).toBe(documentLinesFor(row).length - 1);
    }

    const mixedRowCount = LINE_BREAK_ROWS.filter((row) => new Set(row.breaks).size >= 2).length;
    // Pinned count: 7 rows have multiple line-break kinds in their breaks array.
    // Deriving from the table under test is circular since a regression that
    // duplicates a mixed row would keep the count self-consistent.
    expect(mixedRowCount).toBe(7);
    expect(LINE_BREAK_ROWS.some((row) => row.trailing !== undefined)).toBe(true);
    expect(LINE_BREAK_ROWS.some((row) => row.trailing === undefined)).toBe(true);

    const MIXED_ROW_NAMES: readonly string[] = [
      "mixed LF and CRLF",
      "mixed LF and lone CR before anchor one",
      "mixed CRLF and lone CR",
      "all three line breaks mixed",
      "CRLF immediately before an anchor heading",
      "lone CR immediately before an anchor heading",
      "leading lone CR blank line, no trailing newline",
    ];
    for (const name of MIXED_ROW_NAMES) {
      const row = LINE_BREAK_ROWS.find((r) => r.name === name)!;
      const breakKinds = new Set(row.breaks);
      expect(breakKinds.size).toBeGreaterThanOrEqual(2);
    }

    // Census: verify that for the rows whose names claim a specific break
    // before anchor one, the produced text actually has that break.
    // Checks the produced string, not the breaks array, so a mislabelled
    // row (break at wrong index) can never pass.
    {
      const texts = LINE_BREAK_ROWS.map(textFor);
      const atNew = anchor("one");

      for (let i = 0; i < LINE_BREAK_ROWS.length; i++) {
        const row = LINE_BREAK_ROWS[i];
        const at = texts[i].indexOf(atNew);
        if (at < 0) continue;
        if (row.name === "mixed LF and lone CR before anchor one") {
          expect(texts[i].at(at - 1)).toBe("\r");
          expect(texts[i].at(at - 2)).not.toBe("\r");
        }
        if (row.name === "CRLF immediately before an anchor heading") {
          expect(texts[i].slice(at - 2, at)).toBe("\r\n");
        }
        if (row.name === "lone CR immediately before an anchor heading") {
          expect(texts[i].at(at - 1)).toBe("\r");
          expect(texts[i].at(at - 2)).not.toBe("\r");
        }
      }
    }

    // General form: each of the three line-break kinds precedes
    // anchor("one") in at least one row's produced text.
    {
      const texts = LINE_BREAK_ROWS.map(textFor);
      const atNew = anchor("one");
      let seenLoneCR = false, seenCRLF = false, seenLF = false;
      for (let i = 0; i < LINE_BREAK_ROWS.length; i++) {
        const at = texts[i].indexOf(atNew);
        if (at < 0) continue;
        const c = texts[i].at(at - 1);
        if (c === "\r" && texts[i].at(at - 2) !== "\r") seenLoneCR = true;
        if (c === "\n" && texts[i].at(at - 2) === "\r") seenCRLF = true;
        if (c === "\n" && texts[i].at(at - 2) !== "\r") seenLF = true;
      }
      expect(seenLoneCR).toBe(true);
      expect(seenCRLF).toBe(true);
      expect(seenLF).toBe(true);
    }
  });

  for (const row of LINE_BREAK_ROWS) {
    it(`matches CodeMirror for ${row.name}`, () => {
      const text = textFor(row);
      const document = EditorState.create({ doc: text }).doc;
      const parsed = parseBookNote(text);

      expect(parsed.sourceText).toBe(document.toString());
      expect(parsed.sections.length).toBe(2);

      
      for (const section of parsed.sections) {
        const label = section.fragment.includes("/6/4") ? "one" : "two";
        
        expect(document.line(section.headingLine + 1).text).toBe(anchor(label));
        expect(section.bodyRange.start).toBe(section.headingLine);
        expect(section.bodyRange.end).toBeLessThan(document.lines);
        expect(section.bodyRange.end).toBeGreaterThanOrEqual(section.headingLine);
      }

      const docLineCount = documentLinesFor(row).length + (row.trailing ? 1 : 0);
      expect(document.lines).toBe(docLineCount);
      const headingLines = [anchor("one"), anchor("two")].map(
        (h) => documentLinesFor(row).indexOf(h),
      );
      expect(parsed.sections.map((s) => s.headingLine)).toEqual(headingLines);
    });
  }
});
