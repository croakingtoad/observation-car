/**
 * F1.2 — BookNote model (PRD §5.2).
 *
 * Parses a book note's markdown into the shape every later epic reads:
 *
 *   {
 *     frontmatter: { data, source, format },
 *     sections:    [{ headingLine, bodyRange, fragment, position, chapter }],
 *     diagnostics: [{ line, message }],
 *   }
 *
 * `parseBookNote` is pure: no `App`, no vault access, no mutation of the
 * input, deterministic output. The debounced re-parse cache and the
 * `metadataCache` wiring live in `bookNoteStore.ts` and `main.ts`.
 *
 * Anchor recognition (PRD §5.2): an ATX heading at the configured level
 * (default H2) whose text contains a wikilink to the note's `source` file
 * with a non-empty fragment. H3+ (or other-level) headings, link-less
 * headings, links to other files, and source links without a fragment are
 * ordinary body content. A heading whose fragment is malformed (AnchorError)
 * or whose kind does not match the note's `format` is likewise body content
 * — plus a `diagnostics` entry naming the line.
 *
 * Line numbers are 0-based throughout (Obsidian's heading cache and CM6 use
 * the same). Sections are returned in file order, not book order: PRD §5.2
 * says a hand-reordered note is tolerated and consumers sort by
 * `comparePositions(section.position)`.
 *
 * `chapter` is the 0-based spine item index, derivable only from an EPUB
 * CFI anchor: the chapter component `/6/N!` encodes `(itemIndex + 1) * 2`
 * in `N` (see epub.js `EpubCFI.generateChapterComponent`), so
 * `itemIndex = N / 2 - 1` — the same index `book.spine.items` is addressed
 * by, which is what the reader layer (E002) and focus mode (F4.5) need for
 * TOC-title resolution. Spine-href and PDF anchors have `chapter: null`:
 * those need the book itself (spine lookup, PDF outline, or the ±N page
 * window) and are resolved at location time.
 *
 * Frontmatter parsing covers the flat `key: value` subset book notes use
 * (PRD §5.2 and the F1.4 template). Nested or flow YAML is skipped and the
 * value falls back to null; quoted, boolean, and numeric scalars parse to
 * their types.
 */

import {
  AnchorError,
  parseFragment,
  type AnchorKind,
  type AnchorPosition,
} from "./anchor";

export interface ParseBookNoteOptions {
  /**
   * Heading level (1–6) whose anchor-marked headings start a section.
   * The caller reads this live from settings at parse time (`main.ts`
   * passes `plugin.settings.anchorHeadingLevel`, which is replaced
   * wholesale on update); the parser never reads or caches settings.
   * Defaults to 2 (PRD §5.2).
   */
  anchorHeadingLevel?: number;
}

export interface BookNoteFrontmatter {
  /** Parsed frontmatter fields (empty object when the file has none). */
  readonly data: Record<string, unknown>;
  /**
   * Vault path the note's `source` field points at, e.g.
   * `Books/Surprised by Grace.epub`. `[[...]]` wrapping and any
   * `#fragment` are stripped. Null when absent or unusable.
   */
  readonly source: string | null;
  /** Normalized `format` field, or null when absent/unrecognized. */
  readonly format: "epub" | "pdf" | null;
}

export interface BookNoteSection {
  /** 0-based line index of the anchor heading. */
  readonly headingLine: number;
  /**
   * Inclusive 0-based line span of the section: from the anchor heading to
   * the line before the next anchor heading, or the file's last line.
   * `start` is always `headingLine`; consecutive sections tile without gap
   * or overlap.
   */
  readonly bodyRange: { readonly start: number; readonly end: number };
  /** Raw fragment text of the source wikilink (leading "#" stripped). */
  readonly fragment: string;
  /** Parsed position — the operand for `comparePositions`. */
  readonly position: AnchorPosition;
  /**
   * 0-based spine item index for EPUB CFI anchors, else null (see the
   * module docs for why spine-href/PDF chapters are resolved later).
   */
  readonly chapter: number | null;
}

export interface BookNoteDiagnostic {
  /** 0-based line index of the heading with the problem. */
  readonly line: number;
  /** Human-readable description, safe to surface in the UI. */
  readonly message: string;
}

export interface BookNote {
  readonly frontmatter: BookNoteFrontmatter;
  /** Anchor sections in file order (see module docs on ordering). */
  readonly sections: readonly BookNoteSection[];
  /** Non-fatal parse findings (malformed fragments, kind/format mismatch). */
  readonly diagnostics: readonly BookNoteDiagnostic[];
}

const DEFAULT_ANCHOR_HEADING_LEVEL = 2;

/** Fragment kinds each note `format` accepts (PRD §5.2). */
const KINDS_BY_FORMAT: Record<"epub" | "pdf", readonly AnchorKind[]> = {
  epub: ["epub-cfi", "epub-spine"],
  pdf: ["pdf-page"],
};

/**
 * Parse book-note markdown into a BookNote. Pure — see module docs.
 */
export function parseBookNote(
  text: string,
  options?: ParseBookNoteOptions,
): BookNote {
  const anchorHeadingLevel = options?.anchorHeadingLevel ?? DEFAULT_ANCHOR_HEADING_LEVEL;
  const lines = text.split(/\r?\n/);
  const data = parseFrontmatter(lines);
  const source = extractSource(data);
  const format = extractFormat(data);

  const anchors: { line: number; fragment: string; position: AnchorPosition }[] = [];
  const diagnostics: BookNoteDiagnostic[] = [];

  let fence: Fence | null = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (fence !== null) {
      if (isClosingFence(line, fence)) fence = null;
      continue;
    }
    const opened = openingFence(line);
    if (opened !== null) {
      fence = opened;
      continue;
    }
    if (source === null) continue; // Nothing can be an anchor without a source.
    const heading = parseAtxHeading(line);
    if (heading === null || heading.level !== anchorHeadingLevel) continue;
    const resolved = resolveAnchor(heading.text, lineIndex, source, format, diagnostics);
    if (resolved !== null) {
      anchors.push({ line: lineIndex, ...resolved });
    }
  }

  const sections: BookNoteSection[] = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const start = anchors[i].line;
    const end = i + 1 < anchors.length ? anchors[i + 1].line - 1 : lines.length - 1;
    sections.push({
      headingLine: start,
      bodyRange: { start, end },
      fragment: anchors[i].fragment,
      position: anchors[i].position,
      chapter: chapterOf(anchors[i].position),
    });
  }

  return { frontmatter: { data, source, format }, sections, diagnostics };
}

/**
 * A note is a book note when its frontmatter names a usable `source` — the
 * field anchor recognition depends on. (The `type: book-note` convention is
 * not required; `source` is the functional marker.)
 */
export function isBookNote(note: Pick<BookNote, "frontmatter">): boolean {
  return note.frontmatter.source !== null;
}

/**
 * Cheap frontmatter sniff for the Obsidian-side wiring, which uses it to
 * decide which files to read and parse. Intentionally permissive — the
 * parser's own `source` check (`isBookNote`) is authoritative for what
 * actually gets stored.
 */
export function isBookNoteCandidate(
  frontmatter: Record<string, unknown> | null | undefined,
): boolean {
  if (frontmatter === null || frontmatter === undefined) return false;
  if (frontmatter["type"] === "book-note") return true;
  const source = frontmatter["source"];
  return typeof source === "string" && source.trim() !== "";
}

interface Fence {
  readonly char: "`" | "~";
  readonly length: number;
}

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function openingFence(line: string): Fence | null {
  const match = OPENING_FENCE.exec(line);
  if (match === null) return null;
  const char = match[1].charAt(0) as "`" | "~";
  // A backtick fence's info string may not contain backticks (CommonMark).
  if (char === "`" && match[2].includes("`")) return null;
  return { char, length: match[1].length };
}

function isClosingFence(line: string, fence: Fence): boolean {
  const match = CLOSING_FENCE.exec(line);
  return (
    match !== null &&
    match[1].charAt(0) === fence.char &&
    match[1].length >= fence.length
  );
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

function parseAtxHeading(line: string): { level: number; text: string } | null {
  const match = ATX_HEADING.exec(line);
  if (match === null) return null;
  return { level: match[1].length, text: stripClosingHashes(match[2] ?? "") };
}

/**
 * Drop a CommonMark ATX closing sequence (trailing `#`s preceded by
 * whitespace); `foo##` is not a closing sequence and is kept verbatim.
 */
function stripClosingHashes(text: string): string {
  let hashStart = text.length;
  while (hashStart > 0 && text.charCodeAt(hashStart - 1) === 0x23) hashStart -= 1;
  if (hashStart === text.length) return text;
  if (hashStart === 0) return "";
  const before = text.charCodeAt(hashStart - 1);
  if (before !== 0x20 && before !== 0x09) return text;
  return text.slice(0, hashStart).replace(/[ \t]+$/u, "");
}

interface ResolvedAnchor {
  readonly fragment: string;
  readonly position: AnchorPosition;
}

function resolveAnchor(
  headingText: string,
  line: number,
  source: string,
  format: "epub" | "pdf" | null,
  diagnostics: BookNoteDiagnostic[],
): ResolvedAnchor | null {
  const sourceKey = source.toLowerCase();
  const candidate = extractWikilinks(headingText).find(
    (link) => link.fragment !== "" && link.path.toLowerCase() === sourceKey,
  );
  if (candidate === undefined) return null;

  let position: AnchorPosition;
  try {
    position = parseFragment(candidate.fragment);
  } catch (error) {
    if (error instanceof AnchorError) {
      diagnostics.push({ line, message: `Malformed anchor fragment: ${error.message}` });
      return null;
    }
    throw error;
  }

  if (format !== null && KINDS_BY_FORMAT[format].includes(position.kind) === false) {
    diagnostics.push({
      line,
      message: `Anchor fragment kind "${position.kind}" does not match the note's "${format}" format`,
    });
    return null;
  }

  return { fragment: candidate.fragment, position };
}

interface Wikilink {
  readonly path: string;
  readonly fragment: string;
}

/**
 * Extract `[[target|alias]]` links, where target is `path#fragment`.
 *
 * Bracket-matched rather than regex-matched because EPUB CFI fragments may
 * contain node-id assertions (`epubcfi(/6/4[chap01ref]!/…)`), so link
 * content legitimately contains balanced `[`/`]`.
 */
function extractWikilinks(text: string): readonly Wikilink[] {
  const links: Wikilink[] = [];
  let cursor = 0;
  for (;;) {
    const open = text.indexOf("[[", cursor);
    if (open === -1) break;
    let depth = 0;
    let close = -1;
    for (let j = open; j < text.length; j += 1) {
      const ch = text.charAt(j);
      if (ch === "[") {
        depth += 1;
      } else if (ch === "]" && --depth === 0) {
        close = j;
        break;
      }
    }
    if (close === -1) {
      cursor = open + 1;
      continue;
    }
    const content = text.slice(open + 2, close - 1);
    const pipe = content.indexOf("|");
    const target = (pipe === -1 ? content : content.slice(0, pipe)).trim();
    const hash = target.indexOf("#");
    const path = hash === -1 ? target : target.slice(0, hash);
    const fragment = hash === -1 ? "" : target.slice(hash + 1);
    if (path !== "") links.push({ path, fragment });
    cursor = close + 1;
  }
  return links;
}

/**
 * 0-based spine item index from a bare CFI, or null when the chapter
 * component is not the canonical two-component form.
 */
function chapterOf(position: AnchorPosition): number | null {
  if (position.kind !== "epub-cfi") return null;
  const spineEnd = position.cfi.indexOf("!");
  if (spineEnd === -1) return null;
  const match = /^\/(\d+)(?:\[[^\][]*\])?\/(\d+)(?:\[[^\][]*\])?$/.exec(
    position.cfi.slice(0, spineEnd),
  );
  if (match === null) return null;
  const second = Number(match[2]);
  if (second < 2 || second % 2 !== 0) return null;
  const index = second / 2 - 1;
  return Number.isSafeInteger(index) ? index : null;
}

const FRONTMATTER_DELIMITER = /^---[ \t]*$/;
const FRONTMATTER_KEY_VALUE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t]+(.*))?$/;

function parseFrontmatter(lines: readonly string[]): Record<string, unknown> {
  if (lines.length === 0) return {};
  let firstLine = lines[0];
  if (firstLine.charCodeAt(0) === 0xfeff) firstLine = firstLine.slice(1);
  if (FRONTMATTER_DELIMITER.exec(firstLine) === null) return {};

  const data: Record<string, unknown> = {};
  let closed = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (FRONTMATTER_DELIMITER.exec(line) !== null) {
      closed = true;
      break;
    }
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = FRONTMATTER_KEY_VALUE.exec(line);
    if (match === null) continue; // Indented/nested YAML is outside the subset.
    data[match[1]] = parseFrontmatterValue(match[2]);
  }
  // An opening --- with no closing --- is not frontmatter (it may be a
  // setext underline or a body rule); the whole file is body.
  if (closed === false) return {};
  return data;
}

function parseFrontmatterValue(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (value === "") return null;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unescapeDoubleQuoted(value.slice(1, -1));
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value === "true" || value === "True" || value === "TRUE") return true;
  if (value === "false" || value === "False" || value === "FALSE") return false;
  if (value === "null" || value === "Null" || value === "NULL" || value === "~") {
    return null;
  }
  if (/^[+-]?\d+$/.test(value)) return Number(value);
  if (/^[+-]?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  return value;
}

function unescapeDoubleQuoted(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charAt(i);
    if (ch === "\\" && i + 1 < value.length) {
      const next = value.charAt(i + 1);
      i += 1;
      switch (next) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case "0":
          out += "\0";
          break;
        default:
          out += next;
          break;
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function extractSource(data: Record<string, unknown>): string | null {
  const raw = data["source"];
  if (typeof raw !== "string") return null;
  let path = raw.trim();
  if (path.startsWith("[[") && path.endsWith("]]") && path.length >= 4) {
    path = path.slice(2, -2).trim();
  }
  const hash = path.indexOf("#");
  if (hash !== -1) path = path.slice(0, hash).trim();
  return path === "" ? null : path;
}

function extractFormat(data: Record<string, unknown>): "epub" | "pdf" | null {
  const raw = data["format"];
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "epub") return "epub";
  if (normalized === "pdf") return "pdf";
  return null;
}
