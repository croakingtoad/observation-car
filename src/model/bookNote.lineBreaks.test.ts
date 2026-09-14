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
    expect(LINE_BREAK_ROWS.length).toBe(16);
    expect(LINE_BREAK_ROWS.map((r) => r.name)).toEqual([
      "LF only",
      "CRLF only",
      "lone CR only",
      "mixed LF and CRLF",
      "mixed LF and lone CR before anchor one",
      "mixed CRLF and lone CR",
      "all three line breaks mixed",
      "CRLF immediately before an anchor heading",
      "lone CR immediately before an anchor heading",
      "consecutive LF blank lines",
      "consecutive CRLF blank lines",
      "consecutive lone CR blank lines",
      "leading LF blank line and trailing CRLF",
      "leading lone CR blank line, no trailing newline",
      "empty body between two anchors",
      "U+2028 and U+2029 are not line breaks",
    ]);

    for (const row of LINE_BREAK_ROWS) {
      expect(row.breaks.length).toBe(documentLinesFor(row).length - 1);
    }

    const mixedRowCount = LINE_BREAK_ROWS.filter((row) => new Set(row.breaks).size >= 2).length;
    // Pinned count: 7 rows have multiple line-break kinds in their breaks array.
    // Deriving from the table under test is circular since a regression that
    // duplicates a mixed row would keep the count self-consistent.
    expect(mixedRowCount).toBe(7);

    const TRAILING: Record<string, "\n" | "\r\n" | "\r" | undefined> = {
      "LF only": "\n",
      "CRLF only": "\r\n",
      "lone CR only": "\r",
      "mixed LF and CRLF": "\n",
      "mixed LF and lone CR before anchor one": undefined,
      "mixed CRLF and lone CR": "\r\n",
      "all three line breaks mixed": "\r",
      "CRLF immediately before an anchor heading": "\n",
      "lone CR immediately before an anchor heading": "\n",
      "consecutive LF blank lines": "\n",
      "consecutive CRLF blank lines": "\r\n",
      "consecutive lone CR blank lines": "\r",
      "leading LF blank line and trailing CRLF": "\r\n",
      "leading lone CR blank line, no trailing newline": undefined,
      "empty body between two anchors": undefined,
      "U+2028 and U+2029 are not line breaks": undefined,
    };
    for (const row of LINE_BREAK_ROWS) {
      const expected = TRAILING[row.name];
      expect(row.trailing).toBe(expected);
      if (expected !== undefined) {
        expect(textFor(row).endsWith(expected)).toBe(true);
      } else {
        expect(textFor(row).endsWith("\n")).toBe(false);
        expect(textFor(row).endsWith("\r")).toBe(false);
      }
    }
    expect(LINE_BREAK_ROWS.filter((r) => r.trailing !== undefined).length).toBe(12);
    expect(LINE_BREAK_ROWS.filter((r) => r.trailing === undefined).length).toBe(4);
    expect(Object.keys(TRAILING).sort()).toEqual(LINE_BREAK_ROWS.map((r) => r.name).sort());

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
    expect(MIXED_ROW_NAMES.length).toBe(7);
    expect(new Set(MIXED_ROW_NAMES)).toEqual(new Set(LINE_BREAK_ROWS.filter((r) => new Set(r.breaks).size >= 2).map((r) => r.name)));

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
        expect(at).toBeGreaterThanOrEqual(0);
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
      let loneCR = 0, crlf = 0, lf = 0;
      for (let i = 0; i < LINE_BREAK_ROWS.length; i++) {
        const at = texts[i].indexOf(atNew);
        expect(at).toBeGreaterThanOrEqual(0);
        const c = texts[i].at(at - 1);
        if (c === "\n" && texts[i].at(at - 2) === "\r") crlf++;
        else if (c === "\n") lf++;
        else if (c === "\r") loneCR++;
      }
      expect(loneCR).toBe(5);
      expect(crlf).toBe(5);
      expect(lf).toBe(6);
    }

    // U+2028 / U+2029 are not real line breaks
    {
      const u2028row = LINE_BREAK_ROWS.find((r) => r.name === "U+2028 and U+2029 are not line breaks")!;
      const u2028text = textFor(u2028row);
      expect(u2028text).toContain("\u2028");
      expect(u2028text).toContain("\u2029");
      const doc = EditorState.create({ doc: u2028text }).doc;
      {
        const lines = Array.from({ length: doc.lines }, (_, i) => doc.line(i + 1).text);
        expect(doc.lines).toBe(10);
        expect(lines.filter((t) => t.includes("\u2028"))).toEqual(["first\u2028second"]);
        expect(lines.filter((t) => t.includes("\u2029"))).toEqual(["body one\u2029continued"]);
      }
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
