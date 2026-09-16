/**
 * LocationChanged contract for the EPUB reader (F2.5, PRD §6 E002).
 *
 * Every relocation — page turn, TOC jump, scroll, restore — surfaces as
 * a Location event, debounced ~150 ms, carrying:
 *
 * - `fragment`: the canonical `#epubcfi(<cfi>)` for the position (F1.3),
 * - `chapter`:  the 0-based spine item index parsed from the CFI — the
 *   same convention the BookNote model (F1.2) uses for `section.chapter`,
 *   so focus mode (F4.5) can pair them directly,
 * - `label`:    the TOC title for the chapter when resolvable, else
 *   "Ch. N" (PRD §11).
 *
 * The sync layer (E004) consumes only this contract, never epub.js.
 *
 * Everything here is book-agnostic: the tracker takes the relocated
 * CFI/href pair and a TOC list, and knows nothing about Book, Rendition,
 * or the DOM. EpubView owns the wiring and lifetime.
 */
import {
  AnchorError,
  buildEpubCfiFragment,
  spineIndexFromCfi,
} from "../model/anchor";

/** Debounce window for LocationChanged events (PRD F2.5). */
export const DEFAULT_LOCATION_DEBOUNCE_MS = 150;

/** The location payload PRD §8's Reader contract emits. */
export interface EpubLocation {
  /** Canonical fragment for the position: `#epubcfi(<cfi>)`. */
  readonly fragment: string;
  /**
   * 0-based spine item index parsed from the CFI chapter component,
   * null when the component is not canonical.
   */
  readonly chapter: number | null;
  /** TOC title for the chapter when resolvable, else "Ch. N". */
  readonly label: string;
}

/** Structural subset of an epub.js TOC item (`Navigation.toc`). */
export interface TocItem {
  readonly label: string;
  readonly href: string | null;
  readonly subitems?: readonly TocItem[];
}

/** The relocated position the tracker needs from a rendition event. */
export interface RelocatedPosition {
  readonly cfi: string;
  readonly href: string;
}

/**
 * The TOC title for the spine item at `spineHref`, or null when no TOC
 * item points at it. TOC hrefs may carry a fragment (sub-chapter
 * anchors) and URI encoding; both are normalized before comparing. The
 * first match in document order wins, so a chapter-level entry wins
 * over sub-anchors that share its file.
 */
export function tocLabelForHref(
  toc: readonly TocItem[],
  spineHref: string,
): string | null {
  const target = normalizeHref(spineHref);
  const find = (items: readonly TocItem[]): string | null => {
    for (const item of items) {
      if (item.href !== null && normalizeHref(item.href) === target) {
        return item.label;
      }
      if (item.subitems !== undefined) {
        const nested = find(item.subitems);
        if (nested !== null) {
          return nested;
        }
      }
    }
    return null;
  };
  return find(toc);
}

/** "Ch. N" fallback (PRD §11), where N is the chapter (spine index). */
export function chapterLabel(chapter: number | null): string {
  return chapter === null ? "Unknown" : `Ch. ${chapter}`;
}

/**
 * Build the Location for a relocated position, or null when the CFI is
 * empty or not a valid fragment — a relocation without a position cannot
 * be expressed as an anchor, so it is dropped rather than emitted.
 */
export function locationForRelocation(
  position: RelocatedPosition,
  toc: readonly TocItem[],
): EpubLocation | null {
  if (position.cfi.length === 0) {
    return null;
  }
  let fragment: string;
  try {
    fragment = buildEpubCfiFragment(position.cfi);
  } catch (error) {
    if (error instanceof AnchorError) {
      return null;
    }
    throw error;
  }
  const chapter = spineIndexFromCfi(position.cfi);
  return {
    fragment,
    chapter,
    label: tocLabelForHref(toc, position.href) ?? chapterLabel(chapter),
  };
}

/**
 * Debounces relocated positions into Location events.
 *
 * Trailing debounce: each relocation reschedules the emit, so a burst
 * (a settling page turn, a streaming scroll) coalesces into one event
 * that fires ~`debounceMs` after the last move. Page turns are the
 * discrete case the PRD's 200 ms sync budget is measured against; one
 * event per turn arrives `debounceMs` later.
 */
export class EpubLocationTracker {
  private readonly listeners = new Set<(loc: EpubLocation) => void>();
  private toc: readonly TocItem[] = [];
  private latest: RelocatedPosition | null = null;
  private pending: RelocatedPosition | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    private readonly debounceMs: number = DEFAULT_LOCATION_DEBOUNCE_MS,
  ) {}

  /**
   * The book's TOC, for label resolution. Relocations before this
   * resolves (or for a book with no TOC) fall back to "Ch. N". Once a
   * position is held, a late TOC replays it so push consumers see the
   * same label that `current()` derives.
   */
  setToc(toc: readonly TocItem[]): void {
    this.toc = assertTocItems(toc);
    if (this.latest !== null) {
      this.onRelocated(this.latest);
    }
  }

  /** Feed one relocated position; the emitted event is debounced. */
  onRelocated(position: RelocatedPosition | null): void {
    if (this.destroyed || position === null) {
      return;
    }
    if (locationForRelocation(position, this.toc) === null) {
      return;
    }
    this.latest = position;
    this.pending = position;
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  /** Subscribe to Location events; returns the unsubscribe function. */
  on(listener: (loc: EpubLocation) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Derive the latest relocation immediately, without waiting for emit. */
  current(): EpubLocation | null {
    return this.latest === null
      ? null
      : locationForRelocation(this.latest, this.toc);
  }

  /** Cancel a pending event and drop every subscription. */
  destroy(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.latest = null;
    this.pending = null;
    this.listeners.clear();
    this.destroyed = true;
  }

  private flush(): void {
    this.timer = null;
    const position = this.pending;
    this.pending = null;
    // F2's onRelocated guard guarantees this invariant; this local
    // check only narrows the type.
    if (position === null) {
      return;
    }
    const location = locationForRelocation(position, this.toc);
    // locationForRelocation cannot be null for the latest position.
    if (location === null) {
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(location);
      } catch (error) {
        console.warn("[Observation Car] Location subscriber threw", error);
      }
    }
  }
}

function assertTocHref(body: unknown): string | null {
  if (body === null) {
    return null;
  }
  if (typeof body !== "string" || body.length === 0) {
    throw new AnchorError("TOC href must be a usable string or null");
  }
  return body;
}

function assertTocItems(
  toc: readonly TocItem[],
): readonly TocItem[] {
  return toc.map((item) => {
    const href = assertTocHref(item.href);
    if (item.subitems === undefined) {
      return { ...item, href };
    }
    return { ...item, href, subitems: assertTocItems(item.subitems) };
  });
}

/**
 * TOC and spine hrefs are both relative to the OPF root, but authors
 * differ: TOC entries may carry a `#fragment` and percent-encoding.
 * Normalize to the decoded path so the two can be compared directly.
 */
function normalizeHref(href: string): string {
  const hash = href.indexOf("#");
  const path = hash === -1 ? href : href.slice(0, hash);
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}
