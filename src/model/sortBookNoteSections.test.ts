import { describe, expect, it } from "vitest";
import { parseBookNote, type BookNoteSection } from "./bookNote";
import { sortSectionsByBookPosition } from "./sortBookNoteSections";

const SOURCE = "Books/Book.epub";
const EARLY = "epubcfi(/6/4!/4/2/1:0)";
const LATE = "epubcfi(/6/12!/4/2/1:0)";

function note(body: readonly string[], separator = "\n"): string {
  return [
    "---",
    `source: "[[${SOURCE}]]"`,
    "format: epub",
    "---",
    "Preamble: keep  two  spaces",
    ...body,
  ].join(separator);
}

function sortParsed(text: string): string {
  return sortSectionsByBookPosition(text, parseBookNote(text).sections);
}

describe("sortSectionsByBookPosition", () => {
  it("moves each hand-reordered heading with its complete section body", () => {
    const input = note([
      `## [[${SOURCE}#${LATE}|Later]]`,
      "later body",
      "### Nested heading",
      "nested body",
      `## [[${SOURCE}#${EARLY}|Earlier]]`,
      "earlier body",
    ]);

    expect(sortParsed(input)).toBe(
      note([
        `## [[${SOURCE}#${EARLY}|Earlier]]`,
        "earlier body",
        `## [[${SOURCE}#${LATE}|Later]]`,
        "later body",
        "### Nested heading",
        "nested body",
      ]),
    );
  });

  it("preserves preamble and trailing text outside supplied ranges byte-for-byte", () => {
    const input = note(
      [
        `## [[${SOURCE}#${LATE}|Later]]`,
        "later body",
        `## [[${SOURCE}#${EARLY}|Earlier]]`,
        "earlier body",
        "Trailing\ttext  stays here",
        "",
      ],
      "\r\n",
    );
    const parsed = parseBookNote(input).sections;
    const last = parsed[1];
    const sections: readonly BookNoteSection[] = [
      parsed[0],
      {
        ...last,
        bodyRange: { start: last.bodyRange.start, end: last.bodyRange.end - 2 },
      },
    ];

    expect(sortSectionsByBookPosition(input, sections)).toBe(
      note(
        [
          `## [[${SOURCE}#${EARLY}|Earlier]]`,
          "earlier body",
          `## [[${SOURCE}#${LATE}|Later]]`,
          "later body",
          "Trailing\ttext  stays here",
          "",
        ],
        "\r\n",
      ),
    );
  });

  it("keeps mixed LF and CRLF terminators at their document boundaries", () => {
    const prefix = note([
      `## [[${SOURCE}#${LATE}|Later]]`,
      "later body",
    ]);
    const input = [
      `${prefix}\r`,
      `## [[${SOURCE}#${EARLY}|Earlier]]`,
      "earlier body",
    ].join("\n");
    const expected = note([
      `## [[${SOURCE}#${EARLY}|Earlier]]`,
      "earlier body\r",
      `## [[${SOURCE}#${LATE}|Later]]`,
      "later body",
    ]);

    expect(sortParsed(input)).toBe(expected);
  });

  it("sorts lone CR notes without normalizing the prose (LOCO-936)", () => {
    const input = note(
      [
        `## [[${SOURCE}#${LATE}|Later]]`,
        "later\rbody",
        `## [[${SOURCE}#${EARLY}|Earlier]]`,
        "earlier body",
      ],
      "\n",
    );

    expect(() => sortParsed(input)).not.toThrow();
    expect(sortParsed(input)).toBe(
      note(
        [
          `## [[${SOURCE}#${EARLY}|Earlier]]`,
          "earlier body",
          `## [[${SOURCE}#${LATE}|Later]]`,
          "later\rbody",
        ],
        "\n",
      ),
    );
  });

  it("preserves file order when sections share the same book position", () => {
    const input = note([
      `## [[${SOURCE}#${EARLY}|First at position]]`,
      "first body",
      `## [[${SOURCE}#${LATE}|Second at position]]`,
      "second body",
    ]);
    const parsed = parseBookNote(input).sections;
    const sections: readonly BookNoteSection[] = [
      parsed[0],
      { ...parsed[1], position: parsed[0].position },
    ];

    expect(sortSectionsByBookPosition(input, sections)).toBe(input);
  });

  it("rejects a gap between supplied section ranges", () => {
    const input = note([
      `## [[${SOURCE}#${EARLY}|Earlier]]`,
      "earlier body",
      `## [[${SOURCE}#${LATE}|Later]]`,
      "later body",
    ]);
    const parsed = parseBookNote(input).sections;
    const sections: readonly BookNoteSection[] = [
      parsed[0],
      {
        ...parsed[1],
        bodyRange: {
          start: parsed[1].bodyRange.start + 1,
          end: parsed[1].bodyRange.end,
        },
      },
    ];

    expect(() => sortSectionsByBookPosition(input, sections)).toThrow(
      RangeError,
    );
  });

  it("rejects an end-before-start section range", () => {
    const input = note([
      `## [[${SOURCE}#${EARLY}|Earlier]]`,
      "earlier body",
      `## [[${SOURCE}#${LATE}|Later]]`,
      "later body",
    ]);
    const parsed = parseBookNote(input).sections;
    const sections: readonly BookNoteSection[] = [
      {
        ...parsed[0],
        bodyRange: {
          start: parsed[0].bodyRange.start,
          end: parsed[0].bodyRange.start - 1,
        },
      },
      parsed[1],
    ];

    expect(() => sortSectionsByBookPosition(input, sections)).toThrowError(
      /Invalid book-note section range/,
    );
  });

  it("accepts supplied sections in non-file order", () => {
    const input = note([
      `## [[${SOURCE}#${EARLY}|Earlier]]`,
      "earlier body",
      `## [[${SOURCE}#${LATE}|Later]]`,
      "later body",
    ]);
    const parsed = parseBookNote(input).sections;

    expect(
      sortSectionsByBookPosition(input, [parsed[1], parsed[0]]),
    ).toBe(input);
  });

  it("is a no-op when there are no sections or they are already sorted", () => {
    const plain = "preamble\r\ntrailing\r\n";
    expect(sortSectionsByBookPosition(plain, [])).toBe(plain);

    const sorted = note([
      `## [[${SOURCE}#${EARLY}|Earlier]]`,
      "earlier body",
      `## [[${SOURCE}#${LATE}|Later]]`,
      "later body",
    ]);
    expect(sortParsed(sorted)).toBe(sorted);
  });

  it("is idempotent when the already-sorted document is parsed again", () => {
    const handReordered = note([
      `## [[${SOURCE}#${LATE}|Later]]`,
      "later body",
      `## [[${SOURCE}#${EARLY}|Earlier]]`,
      "earlier body",
    ]);

    const once = sortParsed(handReordered);
    expect(sortParsed(once)).toBe(once);
  });
});
