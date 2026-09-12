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
  private renderedFlowMode: EpubFlowMode | null = null;
  private flowModeChange: Promise<void> | null = null;

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
  private async renderBook(
    file: TFile,
    flowMode: EpubFlowMode = this.host.settings.epubFlowMode,
  ): Promise<void> {
    this.disposeReader();

    const bytes = await this.app.vault.readBinary(file);
    const viewerEl = this.contentEl.createDiv({ cls: "epub-viewer" });

    this.book = ePub(bytes);
    this.rendition = this.book.renderTo(viewerEl, {
      width: "100%",
      height: "100%",
      // F2.2: flow mode from the (global) plugin setting; the toggle in
      // the reader chrome re-renders through this path with the new value.
      flow: flowMode,
    });
    this.renderedFlowMode = flowMode;
    new EpubNavigationTools(
      viewerEl,
      file.path,
      this.book,
      this.rendition,
      {
        mode: flowMode,
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
    const current = this.renderedFlowMode ?? this.host.settings.epubFlowMode;
    const next: EpubFlowMode =
      current === "paginated" ? "scrolled" : "paginated";
    void this.setFlowMode(next).catch((error: unknown) => {
      console.error("Observation Car: could not switch EPUB flow mode", error);
      const recovered = this.rendition !== null && this.renderedFlowMode === current;
      new Notice(
        recovered
          ? "Could not switch EPUB flow mode. The previous mode was restored."
          : "Could not switch EPUB flow mode. Close and reopen the book to recover.",
      );
    });
  }

  /**
   * F2.2 — switch the reader's flow mode and persist it as a global
   * plugin setting. Re-renders through the existing render path (which
   * disposes the current reader first); the current CFI is re-displayed
   * afterwards so the reader does not lose its place on a toggle.
   */
  async setFlowMode(mode: EpubFlowMode): Promise<void> {
    if (this.flowModeChange !== null) {
      await this.flowModeChange;
      return;
    }

    const file = this.file;
    const previousMode = this.renderedFlowMode;
    if (file === null || this.rendition === null || previousMode === null || previousMode === mode) {
      return;
    }
    const cfi = this.rendition.location?.start?.cfi ?? null;
    const change = this.applyFlowMode(file, mode, previousMode, cfi);
    this.flowModeChange = change;
    try {
      await change;
    } finally {
      if (this.flowModeChange === change) {
        this.flowModeChange = null;
      }
    }
  }

  private async applyFlowMode(
    file: TFile,
    mode: EpubFlowMode,
    previousMode: EpubFlowMode,
    cfi: string | null,
  ): Promise<void> {
    try {
      await this.host.updateSettings({ epubFlowMode: mode });
      await this.renderBook(file, mode);
      if (cfi !== null && this.rendition !== null) {
        await this.rendition.display(cfi);
      }
      return;
    } catch (error: unknown) {
      const failures: unknown[] = [error];
      try {
        await this.host.updateSettings({ epubFlowMode: previousMode });
      } catch (rollbackError: unknown) {
        failures.push(rollbackError);
      }

      if (this.rendition === null || this.renderedFlowMode !== previousMode) {
        try {
          await this.renderBook(file, previousMode);
          if (cfi !== null && this.rendition !== null) {
            await this.rendition.display(cfi);
          }
        } catch (recoveryError: unknown) {
          failures.push(recoveryError);
        }
      }

      if (failures.length === 1) {
        throw error;
      }
      throw new AggregateError(failures, "Could not switch or restore the EPUB flow mode");
    }
  }

  private disposeReader(): void {
    this.themes?.destroy();
    this.themes = null;
    this.rendition?.destroy();
    this.rendition = null;
    this.renderedFlowMode = null;
    this.book?.destroy();
    this.book = null;
    this.contentEl.empty();
  }
}
