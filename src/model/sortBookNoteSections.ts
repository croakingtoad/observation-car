import { comparePositions } from "./anchor";
import type { BookNoteSection } from "./bookNote";

interface SectionBlock {
  readonly section: BookNoteSection;
  readonly originalIndex: number;
  readonly text: string;
}

/**
 * Reorder complete section ranges by book position without normalizing any
 * markdown bytes. Content before the first range and after the last range is
 * left untouched. Parser-produced ranges are contiguous; rejecting gaps or
 * overlaps here prevents a malformed caller from silently losing prose.
 */
export function sortSectionsByBookPosition(
  text: string,
  sections: readonly BookNoteSection[],
): string {
  if (sections.length < 2) return text;

  const byFilePosition = [...sections].sort(
    (left, right) => left.bodyRange.start - right.bodyRange.start,
  );
  assertContiguousRanges(byFilePosition);

  const lineStarts = lineStartOffsets(text);
  const firstLine = byFilePosition[0].bodyRange.start;
  const lastLine = byFilePosition[byFilePosition.length - 1].bodyRange.end;
  const firstOffset = offsetAtLine(lineStarts, firstLine);
  const lastOffset = offsetAfterLine(text, lineStarts, lastLine);
  const separators: string[] = [];

  const blocks: SectionBlock[] = byFilePosition.map((section, originalIndex) => {
    const contentEnd = offsetAfterLineContent(
      text,
      lineStarts,
      section.bodyRange.end,
    );
    separators.push(
      text.slice(
        contentEnd,
        offsetAfterLine(text, lineStarts, section.bodyRange.end),
      ),
    );
    return {
      section,
      originalIndex,
      text: text.slice(
        offsetAtLine(lineStarts, section.bodyRange.start),
        contentEnd,
      ),
    };
  });
  blocks.sort((left, right) => {
    const comparison = comparePositions(
      left.section.position,
      right.section.position,
    );
    return comparison === 0
      ? left.originalIndex - right.originalIndex
      : comparison;
  });

  // Line terminators stay at their original document boundaries rather than
  // travelling with blocks. Otherwise moving the unterminated final section
  // earlier would concatenate it with the following heading and move a line
  // ending to EOF.
  const sortedRegion = blocks
    .map((block, index) => block.text + separators[index])
    .join("");
  return text.slice(0, firstOffset) + sortedRegion + text.slice(lastOffset);
}

function assertContiguousRanges(sections: readonly BookNoteSection[]): void {
  for (let index = 0; index < sections.length; index += 1) {
    const { start, end } = sections[index].bodyRange;
    if (
      Number.isInteger(start) !== true ||
      Number.isInteger(end) !== true ||
      start < 0 ||
      end < start
    ) {
      throw new RangeError(`Invalid book-note section range ${start}..${end}`);
    }
    if (
      index > 0 &&
      sections[index - 1].bodyRange.end + 1 !== start
    ) {
      throw new RangeError("Book-note section ranges must be contiguous");
    }
  }
}

function lineStartOffsets(text: string): readonly number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charAt(index) === "\r") {
      offsets.push(index + (text.charAt(index + 1) === "\n" ? 2 : 0));
      if (text.charAt(index + 1) === "\n") index += 1;
    } else if (text.charAt(index) === "\n") {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function offsetAtLine(lineStarts: readonly number[], line: number): number {
  const offset = lineStarts[line];
  if (offset === undefined) {
    throw new RangeError(`Book-note section line ${line} is outside the document`);
  }
  return offset;
}

function offsetAfterLine(
  text: string,
  lineStarts: readonly number[],
  line: number,
): number {
  if (line + 1 < lineStarts.length) return lineStarts[line + 1];
  if (line + 1 === lineStarts.length) return text.length;
  throw new RangeError(`Book-note section line ${line} is outside the document`);
}

function offsetAfterLineContent(
  text: string,
  lineStarts: readonly number[],
  line: number,
): number {
  let offset = offsetAfterLine(text, lineStarts, line);
  if (offset > 0 && text.charAt(offset - 1) === "\n") offset -= 1;
  if (offset > 0 && text.charAt(offset - 1) === "\r") offset -= 1;
  return offset;
}
