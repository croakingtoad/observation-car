import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { parseBookNote } from "./bookNote";

const SOURCE = "Books/Surprised by Grace.epub";

function anchor(label: "one" | "two"): string {
  const spine = label === "one" ? 4 : 6;
  return `## [[${SOURCE}#epubcfi(/6/${spine}!/4/2/1:0)|${label}]]`;
}

const LINE_BREAK_ROWS = [
  { name: "LF only", body: ["first", anchor("one"), "body one", anchor("two"), "body two"] },
  { name: "CRLF only", body: ["first", anchor("one"), "body one", anchor("two"), "body two"] },
  { name: "lone CR only", body: ["first", anchor("one"), "body one", anchor("two"), "body two"] },
  { name: "mixed LF and CRLF", body: ["first", anchor("one"), "body one", anchor("two"), "body two"] },
  { name: "mixed LF and lone CR", body: ["first", anchor("one"), "body one", anchor("two"), "body two"] },
  { name: "mixed CRLF and lone CR", body: ["first", anchor("one"), "body one", anchor("two"), "body two"] },
  { name: "all three line breaks mixed", body: ["first", anchor("one"), "body one", anchor("two"), "body two"] },
  { name: "CRLF before an anchor heading", body: ["preamble", anchor("one"), "body one", anchor("two"), "body two"] },
  { name: "lone CR before an anchor heading", body: ["preamble", anchor("one"), "body one", anchor("two"), "body two"] },
  { name: "consecutive LF blank lines", body: ["first", "", "", anchor("one"), "", "", anchor("two"), "body two"] },
  { name: "consecutive CRLF blank lines", body: ["first", "", "", anchor("one"), "", "", anchor("two"), "body two"] },
  { name: "consecutive lone CR blank lines", body: ["first", "", "", anchor("one"), "", "", anchor("two"), "body two"] },
  { name: "leading LF blank line and trailing CRLF", body: ["", "first", anchor("one"), "body one", anchor("two"), "body two"] },
  { name: "leading lone CR blank line, no trailing newline", body: ["", "first", anchor("one"), "body one", anchor("two"), "body two"] },
  { name: "empty body between two anchors", body: [anchor("one"), anchor("two")] },
  {
    name: "U+2028 and U+2029 are not line breaks",
    body: ["first\u2028second", anchor("one"), "body one\u2029continued", anchor("two"), "body two"],
  },
];

function textFor(
  separator: "\n" | "\r\n" | "\r",
  body: readonly string[],
  rowName: string,
): string {
  const frontmatter = [
    "---",
    "type: book-note",
    `source: "[[${SOURCE}]]"`,
    "format: epub",
    "---",
  ].join(separator);
  const content = body.join(separator);
  const trailingBreak = rowName === "leading LF and trailing CRLF" ? "\r\n" : "";
  return `${frontmatter}${separator}${content}${trailingBreak}`;
}

describe("parseBookNote — CM6 line-break oracle (PL-036)", () => {
  for (const row of LINE_BREAK_ROWS) {
    it(`matches CodeMirror for ${row.name}`, () => {
      const separator = row.name.includes("CRLF")
        ? "\r\n"
        : row.name.includes("lone CR")
          ? "\r"
          : "\n";
      const text = textFor(separator, row.body, row.name);
      const document = EditorState.create({ doc: text }).doc;
      const parsed = parseBookNote(text);

      expect(parsed.sourceText).toBe(document.toString());
      expect(document.lines).toBe(parsed.sourceText.split("\n").length);
      expect(parsed.sections.length).toBeGreaterThanOrEqual(2);

      const normalizedLines = document.toString().split("\n");
      for (const section of parsed.sections) {
        const label = section.fragment.includes("/6/4") ? "one" : "two";
        expect(normalizedLines[section.headingLine]).toBe(anchor(label));
        expect(document.line(section.headingLine + 1).text).toBe(anchor(label));
        expect(section.bodyRange.start).toBe(section.headingLine);
        expect(section.bodyRange.end).toBeLessThan(document.lines);
        expect(section.bodyRange.end).toBeGreaterThanOrEqual(section.headingLine);
      }

      if (row.name === "U+2028 and U+2029 are not line breaks") {
        expect(document.lines).toBe(10);
        expect(parsed.sections.map((section) => section.headingLine)).toEqual([6, 8]);
      }
    });
  }
});
