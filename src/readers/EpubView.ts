/**
 * EPUB reader view (F2.1, PRD §6 E002).
 *
 * Forked from `src/epub-view.ts` in vinceRV/obsidian-epub-reader (MIT) at
 * commit 67e5edbfee12cb09ba3c7216442d251196ff806f — licence and per-file
 * provenance in `VENDOR_NOTICE.md`.
 *
 * F2.1 registers this view for `.epub` so a book opens in-plugin; the
 * location/selection/link-navigation API surface the sync layer (E004)
 * consumes arrives with F2.5–F2.9.
 *
 * `FileView` (an `ItemView` subclass, like the core PDF view) is the base:
 * Obsidian routes `leaf.openFile(file)` for a registered extension to
 * `onLoadFile` here.
 */
import { FileView, TFile, WorkspaceLeaf } from "obsidian";
import ePub, { Book, Rendition } from "epubjs";
import { EpubNavigationTools } from "./epubNavigationTools";
import { EpubThemes } from "./epubThemes";

export const EPUB_VIEW_TYPE = "observation-car-epub";

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

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return EPUB_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "EPUB Reader";
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
    try {
      book = ePub(bytes);
      rendition = book.renderTo(viewerEl, {
        width: "100%",
        height: "100%",
      });
      new EpubNavigationTools(viewerEl, file.path, book, rendition);
      themes = new EpubThemes(rendition);
      await rendition.display();
    } catch (error) {
      // A bad book can fail anywhere in the build; dispose what was
      // created before the failure propagates, so no partial reader
      // survives.
      this.disposeCreated(viewerEl, book, rendition, themes);
      throw error;
    }

    if (generation !== this.renderGeneration) {
      // Superseded while display was in flight: the newer render's
      // disposeReader emptied the content element but could not reach
      // these locals — dispose them here, exactly once.
      this.disposeCreated(viewerEl, book, rendition, themes);
      return;
    }

    this.book = book;
    this.rendition = rendition;
    this.themes = themes;
  }

  /** Tear down a reader a render built locally, possibly only partially. */
  private disposeCreated(
    viewerEl: HTMLDivElement,
    book: Book | null,
    rendition: Rendition | null,
    themes: EpubThemes | null,
  ): void {
    themes?.destroy();
    rendition?.destroy();
    book?.destroy();
    viewerEl.remove();
  }

  private disposeReader(): void {
    // Retire any in-flight render: it sees the moved generation at its
    // next `await` and disposes what it has built.
    this.renderGeneration += 1;
    this.themes?.destroy();
    this.themes = null;
    this.rendition?.destroy();
    this.rendition = null;
    this.book?.destroy();
    this.book = null;
    this.contentEl.empty();
  }
}
