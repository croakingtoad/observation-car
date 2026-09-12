/**
 * EPUB reader view (F2.1, PRD §6 E002).
 *
 * Forked from `src/epub-view.ts` in vinceRV/obsidian-epub-reader (MIT) at
 * commit 67e5edbfee12cb09ba3c7216442d251196ff806f — licence and per-file
 * provenance in `VENDOR_NOTICE.md`.
 *
 * F2.1 registers this view for `.epub` so a book opens in-plugin; the
 * selection half (`getSelection`) of the API surface the sync layer
 * (E004) consumes (PRD §8) is in since F2.6; the location half
 * (`on("location")` / `getLocation`) arrives with F2.5 and link
 * navigation with F2.7–F2.9.
 *
 * `FileView` (an `ItemView` subclass, like the core PDF view) is the base:
 * Obsidian routes `leaf.openFile(file)` for a registered extension to
 * `onLoadFile` here.
 */
import { FileView, TFile, WorkspaceLeaf } from "obsidian";
import ePub, { Book, Rendition } from "epubjs";
import { EpubNavigationTools, EpubSelectionTracker } from "./epubNavigationTools";
import { type Location as EpubRenditionLocation } from "epubjs/types/rendition";
import { EpubThemes } from "./epubThemes";
import { EpubLocationTracker, type EpubLocation } from "./epubLocation";

export const EPUB_VIEW_TYPE = "observation-car-epub";

/**
 * A LocationChanged event (F2.5): PRD §8's Location plus the file the
 * location belongs to, so the sync layer never needs to look it up.
 */
export interface EpubLocationEvent extends EpubLocation {
  readonly file: TFile;
}

interface PreparedLocationEvents {
  tracker: EpubLocationTracker;
  relocatedHandler: (loc: EpubRenditionLocation | null | undefined) => void;
  forward: () => void;
}

export class EpubView extends FileView {
  /** The book currently loaded in this leaf, or null before first open. */
  file: TFile | null = null;

  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private themes: EpubThemes | null = null;
  /**
   * Bumped by every `disposeReader` (a re-open or `onClose`). A render
   * stays live only while it still holds the generation it took at
   * entry.
   */
  private renderGeneration = 0;
  private selectionTracker: EpubSelectionTracker | null = null;

  /** F2.5: debounce + emit engine for the currently rendered book. */
  private locationTracker: EpubLocationTracker | null = null;
  private locationRelocatedHandler:
    | ((loc: EpubRenditionLocation | null | undefined) => void)
    | null = null;
  private locationForward: (() => void) | null = null;
  private locationListeners = new Set<(loc: EpubLocationEvent) => void>();

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return EPUB_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "EPUB Reader";
  }

  /**
   * PRD §8 Reader contract: the current selection in the book as
   * `{text, fragment}` — `fragment` built by `buildEpubCfiFragment` —
   * or `null` when nothing is selected. F4.6 "new note here" builds
   * on this; a bad CFI resolves to `null` rather than a throw so that
   * path can never crash on a stray selection.
   */
  getSelection(): { text: string; fragment: string } | null {
    return this.selectionTracker?.getSelection() ?? null;
  }

  /**
   * Subscribe to LocationChanged events (F2.5; PRD §8 Reader contract).
   *
   * The subscription outlives re-renders: a subscriber attached before
   * a book loads still receives the first relocation once the book
   * displays. Returns the unsubscribe function.
   */
  on(
    _event: "location",
    listener: (loc: EpubLocationEvent) => void,
  ): () => void {
    this.locationListeners.add(listener);
    return () => {
      this.locationListeners.delete(listener);
    };
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.file = file;
    await this.renderBook(file);
  }

  async onClose(): Promise<void> {
    this.disposeReader();
  }

  /**
   * (Re)render a book into the view content. Re-entry is ours to handle:
   * opening a different `.epub` in this leaf re-enters `onLoadFile`
   * without an intervening `onClose`, and `onClose` can land while a
   * render is still in flight. A render bails out after every `await`
   * if its generation has moved, and a superseded render disposes
   * everything it created. The fields are assigned only by a render
   * that finishes undisplaced, so `this.*` always point at the one
   * reader that owns the view.
   */
  private async renderBook(file: TFile): Promise<void> {
    this.disposeReader();
    const generation = this.renderGeneration;

    const bytes = await this.app.vault.readBinary(file);
    if (generation !== this.renderGeneration) {
      // Superseded before building anything — nothing to dispose.
      return;
    }

    const viewerEl = this.contentEl.createDiv({ cls: "epub-viewer" });
    let book: Book | null = null;
    let rendition: Rendition | null = null;
    let themes: EpubThemes | null = null;
    let locationEvents: PreparedLocationEvents | null = null;
    const selectionTracker = new EpubSelectionTracker();
    try {
      book = ePub(bytes);
      rendition = book.renderTo(viewerEl, {
        width: "100%",
        height: "100%",
      });
      new EpubNavigationTools(
        viewerEl,
        file.path,
        book,
        rendition,
        selectionTracker,
      );
      themes = new EpubThemes(rendition);
      locationEvents = this.prepareLocationEvents(book, rendition);
      await rendition.display();
    } catch (error) {
      // A bad book can fail anywhere in the build; dispose what was
      // created before the failure propagates, so no partial reader
      // survives.
      this.disposeCreated(viewerEl, book, rendition, themes, locationEvents);
      throw error;
    }

    if (generation !== this.renderGeneration) {
      // Superseded while display was in flight: the newer render's
      // disposeReader emptied the content element but could not reach
      // these locals — dispose them here, exactly once.
      this.disposeCreated(viewerEl, book, rendition, themes, locationEvents);
      return;
    }

    this.book = book;
    this.rendition = rendition;
    this.themes = themes;
    this.selectionTracker = selectionTracker;
    this.locationTracker = locationEvents.tracker;
    this.locationRelocatedHandler = locationEvents.relocatedHandler;
    this.locationForward = locationEvents.forward;
  }

  /** Tear down a reader a render built locally, possibly only partially. */
  private disposeCreated(
    viewerEl: HTMLDivElement,
    book: Book | null,
    rendition: Rendition | null,
    themes: EpubThemes | null,
    locationEvents: PreparedLocationEvents | null,
  ): void {
    locationEvents?.forward();
    if (rendition !== null && locationEvents !== null) {
      rendition.off("relocated", locationEvents.relocatedHandler);
    }
    locationEvents?.tracker.destroy();
    themes?.destroy();
    rendition?.destroy();
    book?.destroy();
    viewerEl.remove();
  }

  /**
   * Wire F2.5 location events to a freshly rendered rendition.
   *
   * The relocated listener is registered on the rendition itself — not
   * on document or window — so its lifetime is bounded by the
   * rendition's: the leaked-first-book defect (LOCO-153) keeps the old
   * book's listener with the old rendition and can never feed this
   * tracker, because the closure captures the tracker, not
   * `this.locationTracker`.
   */
  private prepareLocationEvents(
    book: Book,
    rendition: Rendition,
  ): PreparedLocationEvents {
    const tracker = new EpubLocationTracker();
    const onRelocated = (
      loc: EpubRenditionLocation | null | undefined,
    ): void => {
      const start = loc?.start;
      tracker.onRelocated(
        start === undefined ? null : { cfi: start.cfi, href: start.href },
      );
    };
    rendition.on("relocated", onRelocated);

    // Label resolution: once the TOC loads, chapter labels come from it;
    // a book without one keeps the "Ch. N" fallback.
    void book.loaded.navigation
      .then((navigation) => tracker.setToc(navigation.toc))
      .catch(() => {
        // An unresolvable TOC is not fatal; labels stay "Ch. N".
      });

    const forward = tracker.on((loc) => {
      const file = this.file;
      if (file === null) {
        return;
      }
      const event: EpubLocationEvent = { ...loc, file };
      for (const listener of [...this.locationListeners]) {
        listener(event);
      }
    });
    return { tracker, relocatedHandler: onRelocated, forward };
  }

  /** Detach F2.5 location events from the current rendition. */
  private detachLocationEvents(): void {
    this.locationForward?.();
    this.locationForward = null;
    if (this.locationRelocatedHandler !== null) {
      this.rendition?.off("relocated", this.locationRelocatedHandler);
      this.locationRelocatedHandler = null;
    }
    this.locationTracker?.destroy();
    this.locationTracker = null;
  }

  private disposeReader(): void {
    // Retire any in-flight render: it sees the moved generation at its
    // next `await` and disposes what it has built.
    this.renderGeneration += 1;
    // A selection only lives inside a rendition's iframe; with the
    // reader gone, the retained one is stale by definition.
    this.selectionTracker = null;
    this.detachLocationEvents();
    this.themes?.destroy();
    this.themes = null;
    this.rendition?.destroy();
    this.rendition = null;
    this.book?.destroy();
    this.book = null;
    this.contentEl.empty();
  }
}
