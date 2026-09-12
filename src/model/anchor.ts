import { EpubCFI } from "epubjs";

/**
 * Anchor fragment utilities (F1.3, PRD §5.2).
 *
 * A book note anchors sections to locations in the source book through
 * wikilink fragments:
 *
 *     [[Books/Surprised by Grace.epub#epubcfi(/6/8!/4/2/1:0)|Ch. 1]]
 *     [[Books/Some Paper.pdf#page=7&selection=12,0,14,40|p. 7]]
 *
 * Fragment grammar (a leading "#" is accepted but optional):
 *
 *   epub-cfi    epubcfi(<cfi>)            epub.js CFI, point or range
 *   epub-spine  <href>                    spine-item href, chapter level
 *   pdf-page    page=N                    Obsidian-native page link
 *               page=N&selection=a,b,c,d  PDF++-compatible rectangle
 *               page=N&height=<number>    parsed and ignored
 *
 * Parsing is strict: anything outside the grammar throws AnchorError.
 * The utilities are deliberately book-agnostic — the BookNote parser
 * (F1.2) knows the source file's format and rejects fragments that
 * cannot apply to it.
 */

/** PDF++-style selection rectangle: x1, y1, x2, y2 in page coordinates. */
export type SelectionRect = readonly [number, number, number, number];

export type AnchorKind = "epub-cfi" | "epub-spine" | "pdf-page";

export type AnchorPosition =
  | { readonly kind: "epub-cfi"; readonly cfi: string }
  | { readonly kind: "epub-spine"; readonly href: string }
  | {
      readonly kind: "pdf-page";
      readonly page: number;
      readonly selection?: SelectionRect;
    };

type PdfPosition = Extract<AnchorPosition, { kind: "pdf-page" }>;

export class AnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorError";
  }
}

const EPUBCFI_PREFIX = "epubcfi(";
const CFI_CHARSET = /^[\d/:!,\[\]A-Za-z._-]+$/;
const CFI_SPINE = /^\/\d+\/\d+$/;
const CFI_STEP = /^\d+(\[[^\][]*\])?$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * Parse a wikilink fragment into a book position.
 *
 * @param fragment - fragment text; the leading "#" is optional.
 * @throws AnchorError when the fragment is not a valid book position.
 */
export function parseFragment(fragment: string): AnchorPosition {
  const body = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (body.length === 0) {
    throw new AnchorError("fragment is empty");
  }
  if (body.startsWith(EPUBCFI_PREFIX)) {
    return parseEpubCfiFragment(body);
  }
  if (body.startsWith("page=")) {
    return parsePdfFragment(body);
  }
  return { kind: "epub-spine", href: assertSpineHref(body) };
}

/** Build the canonical fragment for a parsed position. */
export function buildFragment(position: AnchorPosition): string {
  switch (position.kind) {
    case "epub-cfi":
      return buildEpubCfiFragment(position.cfi);
    case "epub-spine":
      return buildEpubSpineFragment(position.href);
    case "pdf-page":
      return buildPdfFragment(position.page, position.selection);
  }
}

export function buildEpubCfiFragment(cfi: string): string {
  const bare =
    cfi.startsWith(EPUBCFI_PREFIX) && cfi.endsWith(")")
      ? cfi.slice(EPUBCFI_PREFIX.length, -1)
      : cfi;
  assertValidCfi(bare);
  return `#${EPUBCFI_PREFIX}${bare})`;
}

/**
 * 0-based spine item index from a CFI's chapter component, or null when
 * the component is not the canonical two-step form `/M/N!`.
 *
 * The second step encodes `(itemIndex + 1) * 2` (epub.js
 * `EpubCFI.generateChapterComponent`), so `itemIndex = N / 2 - 1` — the
 * same index `book.spine.items` is addressed by. Range CFIs take the
 * chapter from the base component. A leading `epubcfi(...)` wrapper is
 * accepted, as epub.js `relocated` events carry it.
 *
 * This is the `chapter` convention shared by the BookNote model (F1.2)
 * and the reader's LocationChanged events (F2.5), so focus mode (F4.5)
 * can pair a note section's chapter with a reader location's directly.
 */
export function spineIndexFromCfi(cfi: string): number | null {
  let bare = cfi;
  if (bare.startsWith(EPUBCFI_PREFIX) && bare.endsWith(")")) {
    bare = bare.slice(EPUBCFI_PREFIX.length, -1);
  }
  const spineEnd = bare.indexOf("!");
  if (spineEnd === -1) {
    return null;
  }
  const match = /^\/(\d+)(?:\[[^\][]*\])?\/(\d+)(?:\[[^\][]*\])?$/.exec(
    bare.slice(0, spineEnd),
  );
  if (match === null) {
    return null;
  }
  const second = Number(match[2]);
  if (second < 2 || second % 2 !== 0) {
    return null;
  }
  const index = second / 2 - 1;
  return Number.isSafeInteger(index) ? index : null;
}

export function buildEpubSpineFragment(href: string): string {
  assertSpineHref(href);
  return `#${href}`;
}

/**
 * Build a PDF fragment. `height` is deliberately not emitted: the PRD
 * only requires parsing it, and PDF++ omits it unless the offset
 * matters for a highlight.
 */
export function buildPdfFragment(
  page: number,
  selection?: SelectionRect,
): string {
  if (Number.isSafeInteger(page) !== true || page < 1) {
    throw new AnchorError(`PDF page must be an integer >= 1: ${page}`);
  }
  if (selection === undefined) {
    return `#page=${page}`;
  }
  for (const coordinate of selection) {
    if (Number.isFinite(coordinate) !== true) {
      throw new AnchorError(
        `selection coordinates must be finite numbers: ${selection.join(",")}`,
      );
    }
  }
  return `#page=${page}&selection=${selection.join(",")}`;
}

/**
 * Order two positions for "sort sections by book position".
 *
 * - epub-cfi vs epub-cfi: `EpubCFI.compare` — spine position, then path
 *   steps, then character offset. Range CFIs compare by their start.
 * - epub-spine vs epub-spine: code-unit order of the href. Resolving an
 *   href to its chapter's CFI needs the book; the BookNote layer (F1.2)
 *   owns that upgrade.
 * - pdf-page vs pdf-page: page, then selection start (a bare page anchor
 *   sorts before any selection on that page), then the remaining
 *   coordinates.
 * - Different kinds cannot coexist in one book note (a note has a single
 *   source file, hence a single format); the order is fixed
 *   epub-cfi < epub-spine < pdf-page so the comparator stays total.
 */
export function comparePositions(a: AnchorPosition, b: AnchorPosition): number {
  if (a.kind !== b.kind) {
    return KIND_ORDER[a.kind] < KIND_ORDER[b.kind] ? -1 : 1;
  }
  if (a.kind === "epub-cfi" && b.kind === "epub-cfi") {
    return epubCfi.compare(toEpubCfiString(a.cfi), toEpubCfiString(b.cfi));
  }
  if (a.kind === "epub-spine" && b.kind === "epub-spine") {
    return compareStrings(a.href, b.href);
  }
  // a.kind === b.kind narrowed both to pdf-page; TS cannot express the
  // cross-variable narrowing, so the cast restates a proven invariant.
  const left = a as PdfPosition;
  const right = b as PdfPosition;
  if (left.page !== right.page) {
    return left.page < right.page ? -1 : 1;
  }
  return compareSelections(left.selection, right.selection);
}

const KIND_ORDER: Record<AnchorKind, number> = {
  "epub-cfi": 0,
  "epub-spine": 1,
  "pdf-page": 2,
};

// EpubCFI.compare is an instance method in epub.js 0.3.x; one shared
// instance suffices because compare() is stateless.
const epubCfi = new EpubCFI();

function parseEpubCfiFragment(body: string): AnchorPosition {
  const inner = body.slice(EPUBCFI_PREFIX.length);
  if (inner.length === 0 || inner.endsWith(")") !== true) {
    throw new AnchorError(`unterminated epubcfi fragment: "${body}"`);
  }
  let cfi = inner.slice(0, -1);
  // Tolerate a raw epub.js location pasted in already wrapped
  // ("epubcfi(epubcfi(...))"); the canonical form stores the bare CFI.
  if (cfi.startsWith(EPUBCFI_PREFIX) && cfi.endsWith(")")) {
    cfi = cfi.slice(EPUBCFI_PREFIX.length, -1);
  }
  assertValidCfi(cfi);
  return { kind: "epub-cfi", cfi };
}

function parsePdfFragment(body: string): AnchorPosition {
  const ampersand = body.indexOf("&");
  const pagePart = ampersand === -1 ? body : body.slice(0, ampersand);
  const pageMatch = /^page=(\d+)$/.exec(pagePart);
  if (pageMatch === null) {
    throw new AnchorError(`invalid PDF page fragment: "${body}"`);
  }
  const page = Number(pageMatch[1]);
  if (Number.isSafeInteger(page) !== true || page < 1) {
    throw new AnchorError(`PDF page must be an integer >= 1: "${pagePart}"`);
  }

  let selection: SelectionRect | undefined;
  const seen = new Set<string>();
  const params = ampersand === -1 ? [] : body.slice(ampersand + 1).split("&");
  for (const param of params) {
    const equals = param.indexOf("=");
    const name = equals === -1 ? param : param.slice(0, equals);
    const value = equals === -1 ? "" : param.slice(equals + 1);
    if (seen.has(name)) {
      throw new AnchorError(`duplicate fragment parameter: "${name}"`);
    }
    seen.add(name);
    if (name === "page") {
      throw new AnchorError(
        `"page" must be the first fragment parameter: "${body}"`,
      );
    }
    if (name === "selection") {
      selection = parseSelectionRect(value);
    } else if (name === "height") {
      // Parsed and ignored (PRD §5.2): PDF++ vertical offset.
      if (NUMBER.test(value) !== true) {
        throw new AnchorError(`invalid height value: "${value}"`);
      }
    } else {
      throw new AnchorError(`unknown fragment parameter: "${name}"`);
    }
  }
  if (selection === undefined) {
    return { kind: "pdf-page", page };
  }
  return { kind: "pdf-page", page, selection };
}

function parseSelectionRect(value: string): SelectionRect {
  const parts = value.split(",");
  if (parts.length !== 4) {
    throw new AnchorError(
      `selection must be four comma-separated numbers: "${value}"`,
    );
  }
  const coordinates = parts.map((part) => {
    if (NUMBER.test(part) !== true) {
      throw new AnchorError(`invalid selection coordinate: "${part}"`);
    }
    return Number(part);
  });
  const x1 = coordinates[0];
  const y1 = coordinates[1];
  const x2 = coordinates[2];
  const y2 = coordinates[3];
  return [x1, y1, x2, y2] as const;
}

function assertSpineHref(body: string): string {
  if (body.includes("#")) {
    throw new AnchorError(`spine href must not contain "#": "${body}"`);
  }
  if (/[\s\0-\x1f]/.test(body)) {
    throw new AnchorError(
      `spine href must not contain whitespace or control characters: "${body}"`,
    );
  }
  return body;
}

/**
 * Structural validation for the CFI grammar epub.js 0.3.x accepts. The
 * checks exist to reject malformed anchors at parse time rather than
 * mid-sort; epub.js itself throws on an empty path after "!".
 */
function assertValidCfi(cfi: string): void {
  if (CFI_CHARSET.test(cfi) !== true) {
    throw new AnchorError(`CFI contains invalid characters: "${cfi}"`);
  }
  const spineEnd = cfi.indexOf("!");
  if (spineEnd === -1) {
    throw new AnchorError(`CFI is missing the "!" spine separator: "${cfi}"`);
  }
  if (cfi.indexOf("!", spineEnd + 1) !== -1) {
    throw new AnchorError(`CFI must contain exactly one "!": "${cfi}"`);
  }
  const spine = cfi.slice(0, spineEnd).replace(/\[[^\][]*\]/g, "");
  if (CFI_SPINE.test(spine) !== true) {
    throw new AnchorError(
      `CFI spine component is not "/<index>/<position>": "${cfi}"`,
    );
  }
  const [spineIndex, spinePosition] = spine.slice(1).split("/").map(Number);
  if (spineIndex % 2 !== 0 || spinePosition % 2 !== 0) {
    throw new AnchorError(
      `CFI spine component must use even indices: "${cfi}"`,
    );
  }
  const components = cfi.slice(spineEnd + 1).split(",");
  // A range CFI is exactly three components (base!path, start, end);
  // epub.js would silently drop the tail of a two-component range.
  if (components.length !== 1 && components.length !== 3) {
    throw new AnchorError(
      `CFI range must have exactly three components: "${cfi}"`,
    );
  }
  components.forEach((component, index) => {
    if (assertCfiComponent(component, index === 0) !== true) {
      throw new AnchorError(`CFI path component is invalid: "${component}"`);
    }
  });
}

function assertCfiComponent(component: string, isPrimary: boolean): boolean {
  if (component.length === 0) {
    return false;
  }
  if (isPrimary === false && component.startsWith(":")) {
    // Range endpoints may be a bare character offset.
    return /^\d+$/.test(component.slice(1));
  }
  return component.startsWith("/") === true && assertCfiPath(component);
}

function assertCfiPath(path: string): boolean {
  const bare = path.replace(/\[[^\][]*\]/g, "");
  const colon = bare.lastIndexOf(":");
  const stem = colon === -1 ? bare : bare.slice(0, colon);
  const offset = colon === -1 ? "" : bare.slice(colon + 1);
  if (colon !== -1 && /^\d+$/.test(offset) !== true) {
    return false;
  }
  if (stem.startsWith("/") !== true) {
    return false;
  }
  return stem.slice(1).split("/").every((step) => CFI_STEP.test(step));
}

function toEpubCfiString(cfi: string): string {
  // EpubCFI requires the "epubcfi(...)" wrapper; parsed positions store
  // the bare CFI.
  return cfi.startsWith(EPUBCFI_PREFIX) ? cfi : `${EPUBCFI_PREFIX}${cfi})`;
}

function compareSelections(
  a: SelectionRect | undefined,
  b: SelectionRect | undefined,
): number {
  if (a === undefined && b === undefined) {
    return 0;
  }
  if (a === undefined) {
    return -1;
  }
  if (b === undefined) {
    return 1;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
