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
import { FileView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import ePub, { Book, Rendition } from "epubjs";
import type { Location } from "epubjs/types/rendition";
import { parseFragment } from "../model/anchor";
import { EpubNavigationTools } from "./epubNavigationTools";
import { EpubThemes } from "./epubThemes";

export const EPUB_VIEW_TYPE = "observation-car-epub";

export class EpubView extends FileView {
  /** The book currently loaded in this leaf, or null before first open. */
  file: TFile | null = null;

  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private themes: EpubThemes | null = null;

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

  /** Open this EPUB at a CFI or spine-item fragment. */
  async openAtFragment(fragment: string): Promise<void> {
    try {
      const position = parseFragment(fragment);
      const book = this.book;
      const rendition = this.rendition;
      if (book === null || rendition === null) {
        throw new Error("no book is loaded in this leaf");
      }
      const activeRendition: Rendition = rendition;
      if (position.kind === "pdf-page") {
        throw new Error("a PDF page fragment cannot be opened in an EPUB");
      }

      const target = position.kind === "epub-cfi"
        ? `epubcfi(${position.cfi})`
        : position.href;
      const section = book.spine.get(target);
      if (section === null || section === undefined) {
        throw new Error(`the EPUB spine does not contain "${target}"`);
      }

      await new Promise<void>((resolve, reject) => {
        let matchingRelocations = 0;
        let settled = false;
        let timeout = 0;
        const targetHref = section.href;
        const targetCfi = position.kind === "epub-cfi" ? target : null;

        function finish(error?: unknown): void {
          if (settled) {
            return;
          }
          settled = true;
          window.clearTimeout(timeout);
          activeRendition.off("relocated", onRelocated);
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        }

        function onRelocated(location: Location): void {
          const matches = targetCfi === null
            ? location.start.href === targetHref
            : activeRendition.epubcfi.compare(
                location.start.cfi,
                targetCfi,
              ) <= 0 &&
              activeRendition.epubcfi.compare(targetCfi, location.end.cfi) <= 0;
          if (matches === false) {
            return;
          }

          matchingRelocations += 1;
          if (matchingRelocations === 1) {
            // Queue one final display behind any correction that a pending
            // resize scheduled from this relocation; the deliberate jump wins.
            void activeRendition.display(target).catch(finish);
          } else {
            finish();
          }
        }

        activeRendition.on("relocated", onRelocated);
        timeout = window.setTimeout(() => {
          finish(new Error("the reader did not report the new location"));
        }, 5000);
        void activeRendition.display(target).catch(finish);
      });
    } catch (error) {
      console.error("Unable to open EPUB fragment", fragment, error);
      const reason = error instanceof Error ? error.message : String(error);
      new Notice(`Cannot open EPUB fragment "${fragment}": ${reason}`, 6000);
    }
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
    await this.rendition.display();
  }

  private disposeReader(): void {
    this.themes?.destroy();
    this.themes = null;
    this.rendition?.destroy();
    this.rendition = null;
    this.book?.destroy();
    this.book = null;
    this.contentEl.empty();
  }
}
