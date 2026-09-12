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
import { EpubThemes } from "./epubThemes";

export const EPUB_VIEW_TYPE = "observation-car-epub";

export class EpubView extends FileView {
  /** The book currently loaded in this leaf, or null before first open. */
  file: TFile | null = null;

  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private themes: EpubThemes | null = null;
  private selectionTracker: EpubSelectionTracker | null = null;

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
    this.selectionTracker = new EpubSelectionTracker();

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
      this.selectionTracker,
    );
    this.themes = new EpubThemes(this.rendition);
    await this.rendition.display();
  }

  private disposeReader(): void {
    // A selection only lives inside a rendition's iframe; with the
    // reader gone, the retained one is stale by definition.
    this.selectionTracker = null;
    this.themes?.destroy();
    this.themes = null;
    this.rendition?.destroy();
    this.rendition = null;
    this.book?.destroy();
    this.book = null;
    this.contentEl.empty();
  }
}
