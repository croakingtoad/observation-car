/**
 * EPUB reader view (F2.1, PRD §6 E002).
 *
 * Forked from `src/epub-view.ts` in vinceRV/obsidian-epub-reader (MIT) at
 * commit 67e5edbfee12cb09ba3c7216442d251196ff806f — licence and per-file
 * provenance in `VENDOR_NOTICE.md`.
 *
 * F2.1 registers this view for `.epub` so a book opens in-plugin; F2.5
 * adds the LocationChanged events the sync layer (E004) consumes
 * (`on("location", …)`); selection and link navigation arrive with
 * F2.6–F2.9.
 *
 * `FileView` (an `ItemView` subclass, like the core PDF view) is the base:
 * Obsidian routes `leaf.openFile(file)` for a registered extension to
 * `onLoadFile` here.
 */
import { FileView, TFile, WorkspaceLeaf } from "obsidian";
import ePub, { Book, Rendition } from "epubjs";
import { type Location as EpubRenditionLocation } from "epubjs/types/rendition";
import { EpubNavigationTools } from "./epubNavigationTools";
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

export class EpubView extends FileView {
  /** The book currently loaded in this leaf, or null before first open. */
  file: TFile | null = null;

  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private themes: EpubThemes | null = null;

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
   * without an intervening `onClose`, so the previous reader is disposed
   * first (upstream rendered on top of the live book instead).
   */
  private async renderBook(file: TFile): Promise<void> {
    this.disposeReader();

    const bytes = await this.app.vault.readBinary(file);
    const viewerEl = this.contentEl.createDiv({ cls: "epub-viewer" });

    this.book = ePub(bytes);
    this.rendition = this.book.renderTo(viewerEl, {
      width: "100%",
      height: "100%",
    });
    new EpubNavigationTools(
      viewerEl,
      file.path,
      this.book,
      this.rendition,
    );
    this.themes = new EpubThemes(this.rendition);
    this.attachLocationEvents();
    await this.rendition.display();
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
  private attachLocationEvents(): void {
    const book = this.book;
    const rendition = this.rendition;
    if (book === null || rendition === null) {
      return;
    }
    const tracker = new EpubLocationTracker();
    const onRelocated = (
      loc: EpubRenditionLocation | null | undefined,
    ): void => {
      const start = loc?.start;
      tracker.onRelocated(
        start === undefined ? null : { cfi: start.cfi, href: start.href },
      );
    };
    this.locationTracker = tracker;
    this.locationRelocatedHandler = onRelocated;
    rendition.on("relocated", onRelocated);

    // Label resolution: once the TOC loads, chapter labels come from it;
    // a book without one keeps the "Ch. N" fallback.
    void book.loaded.navigation
      .then((navigation) => tracker.setToc(navigation.toc))
      .catch(() => {
        // An unresolvable TOC is not fatal; labels stay "Ch. N".
      });

    this.locationForward = tracker.on((loc) => {
      const file = this.file;
      if (file === null) {
        return;
      }
      const event: EpubLocationEvent = { ...loc, file };
      for (const listener of [...this.locationListeners]) {
        listener(event);
      }
    });
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
