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
import type { EpubFlowMode, ObservationCarSettings } from "../settings";

export const EPUB_VIEW_TYPE = "observation-car-epub";

/**
 * The slice of the plugin the EPUB view reads and writes (F2.2 flow mode).
 * Kept as a narrow structural interface so the view never imports
 * `main.ts` (which imports it).
 */
export interface EpubViewHost {
  settings: ObservationCarSettings;
  updateSettings(patch: Partial<ObservationCarSettings>): Promise<void>;
}

export class EpubView extends FileView {
  /** The book currently loaded in this leaf, or null before first open. */
  file: TFile | null = null;

  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private themes: EpubThemes | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly host: EpubViewHost) {
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
      // F2.2: flow mode from the (global) plugin setting; the toggle in
      // the reader chrome re-renders through this path with the new value.
      flow: this.host.settings.epubFlowMode,
    });
    new EpubNavigationTools(
      viewerEl,
      file.path,
      this.book,
      this.rendition,
      {
        mode: this.host.settings.epubFlowMode,
        onToggle: () => this.toggleFlowMode(),
      },
    );
    this.themes = new EpubThemes(this.rendition);
    await this.rendition.display();
  }

  /**
   * F2.2 — the on-screen flow toggle: switch to the other mode.
   */
  private toggleFlowMode(): void {
    const next: EpubFlowMode =
      this.host.settings.epubFlowMode === "paginated" ? "scrolled" : "paginated";
    void this.setFlowMode(next).catch((error: unknown) => {
      console.error("Observation Car: could not switch EPUB flow mode", error);
    });
  }

  /**
   * F2.2 — switch the reader's flow mode and persist it as a global
   * plugin setting. Re-renders through the existing render path (which
   * disposes the current reader first); the current CFI is re-displayed
   * afterwards so the reader does not lose its place on a toggle.
   */
  async setFlowMode(mode: EpubFlowMode): Promise<void> {
    const file = this.file;
    if (file === null || this.rendition === null || this.host.settings.epubFlowMode === mode) {
      return;
    }
    const cfi = this.rendition.location?.start?.cfi ?? null;
    await this.host.updateSettings({ epubFlowMode: mode });
    await this.renderBook(file);
    if (cfi !== null && this.rendition !== null) {
      await this.rendition.display(cfi);
    }
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
