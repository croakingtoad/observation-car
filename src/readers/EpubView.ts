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
import { FileView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import ePub, { Book, Rendition } from "epubjs";
import { EpubNavigationTools, EpubSelectionTracker } from "./epubNavigationTools";
import { type Location as EpubRenditionLocation } from "epubjs/types/rendition";
import { buildEpubCfiFragment, parseFragment } from "../model/anchor";
import { EpubThemes } from "./epubThemes";
import { EpubLocationTracker, type EpubLocation } from "./epubLocation";
import type { EpubFlowMode, ObservationCarSettings } from "../settings";

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

/**
 * The slice of the plugin the EPUB view reads and writes (F2.2 flow mode).
 * Kept as a narrow structural interface so the view never imports
 * `main.ts` (which imports it).
 */
export interface EpubViewHost {
  settings: ObservationCarSettings;
  updateSettings(patch: Partial<ObservationCarSettings>): Promise<void>;
  getLastEpubLocation(path: string): string | null;
  rememberEpubLocation(path: string, fragment: string): Promise<void>;
}

export class EpubView extends FileView {
  /** The book currently loaded in this leaf, or null before first open. */
  file: TFile | null = null;

  /** The file that owns `book` and `rendition`; unlike `file`, we assign it. */
  private renderedFile: TFile | null = null;
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
  /** Whether the latest rendition relocation came from a reader move. */
  private persistPendingLocation = true;
  private renderedFlowMode: EpubFlowMode | null = null;
  private flowModeChange: Promise<void> | null = null;
  /** The book whose initial relocation must not overwrite its saved CFI. */
  private restoringFile: TFile | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly host: EpubViewHost) {
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
    // FileView.loadFile has already assigned `this.file` to the incoming
    // book. Persist against our render owner before disposing that reader.
    void this.persistRenderedLocation();
    const restoredFragment = this.host.getLastEpubLocation(file.path);
    this.file = file;
    this.restoringFile = restoredFragment === null ? null : file;
    try {
      await this.renderBook(file);
      if (
        restoredFragment !== null &&
        this.file === file &&
        this.rendition !== null
      ) {
        await this.openAtFragment(restoredFragment);
      }
    } finally {
      if (this.restoringFile === file) {
        this.restoringFile = null;
      }
    }
  }

  async onClose(): Promise<void> {
    try {
      await this.persistRenderedLocation();
    } finally {
      this.disposeReader();
    }
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

        function onRelocated(location: EpubRenditionLocation): void {
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
   * without an intervening `onClose`, and `onClose` can land while a
   * render is still in flight. A render bails out after every `await`
   * if its generation has moved, and a superseded render disposes
   * everything it created. The fields are assigned only by a render
   * that finishes undisplaced, so `this.*` always point at the one
   * reader that owns the view. Returns whether this render installed its
   * reader, so callers never continue a transaction after supersession.
   */
  private async renderBook(
    file: TFile,
    flowMode: EpubFlowMode = this.host.settings.epubFlowMode,
  ): Promise<boolean> {
    this.disposeReader();
    const generation = this.renderGeneration;

    const bytes = await this.app.vault.readBinary(file);
    if (generation !== this.renderGeneration) {
      // Superseded before building anything — nothing to dispose.
      return false;
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
        flow: flowMode,
      });
      new EpubNavigationTools(
        viewerEl,
        file.path,
        book,
        rendition,
        selectionTracker,
        {
          mode: flowMode,
          onToggle: () => this.toggleFlowMode(),
        },
      );
      themes = new EpubThemes(rendition);
      locationEvents = this.prepareLocationEvents(
        book,
        rendition,
        file,
        generation,
      );
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
      return false;
    }

    this.book = book;
    this.rendition = rendition;
    this.renderedFile = file;
    this.themes = themes;
    this.selectionTracker = selectionTracker;
    this.locationTracker = locationEvents.tracker;
    this.locationRelocatedHandler = locationEvents.relocatedHandler;
    this.locationForward = locationEvents.forward;
    this.renderedFlowMode = flowMode;
    return true;
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
    file: TFile,
    generation: number,
  ): PreparedLocationEvents {
    const tracker = new EpubLocationTracker();
    this.persistPendingLocation = this.restoringFile !== file;
    const onRelocated = (
      loc: EpubRenditionLocation | null | undefined,
    ): void => {
      const start = loc?.start;
      if (start !== undefined && generation === this.renderGeneration) {
        this.persistPendingLocation = this.restoringFile !== file;
      }
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
      if (generation !== this.renderGeneration) {
        return;
      }
      const event: EpubLocationEvent = { ...loc, file };
      if (this.persistPendingLocation && this.restoringFile !== file) {
        void this.persistCurrentLocation(file.path, event.fragment);
      }
      for (const listener of [...this.locationListeners]) {
        listener(event);
      }
    });
    return { tracker, relocatedHandler: onRelocated, forward };
  }

  private async persistCurrentLocation(
    path: string,
    fragment: string,
  ): Promise<void> {
    try {
      await this.host.rememberEpubLocation(path, fragment);
    } catch (error: unknown) {
      console.error("Observation Car: could not save EPUB location", error);
    }
  }

  /** Persist the rendition's immediate position, including a debounced turn. */
  private persistRenderedLocation(): Promise<void> {
    const file = this.renderedFile;
    const cfi = this.rendition?.location?.start?.cfi;
    if (
      file === null ||
      cfi === undefined ||
      this.persistPendingLocation === false ||
      this.restoringFile === file
    ) {
      return Promise.resolve();
    }
    try {
      return this.persistCurrentLocation(
        file.path,
        buildEpubCfiFragment(cfi),
      );
    } catch (error: unknown) {
      console.error("Observation Car: could not save EPUB location", error);
      return Promise.resolve();
    }
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
    this.restoringFile = file;
    let generation = this.renderGeneration;
    try {
      await this.host.updateSettings({ epubFlowMode: mode });
      if (!this.ownsFlowChange(file, generation)) {
        return;
      }

      generation += 1;
      const rendered = await this.renderBook(file, mode);
      if (!rendered || !this.ownsFlowChange(file, generation)) {
        return;
      }
      const rendition = this.rendition;
      if (cfi !== null && rendition !== null) {
        const restored = await this.redisplayAndPersistFlowLocation(
          file,
          generation,
          rendition,
          cfi,
        );
        if (!restored) {
          return;
        }
      }
      return;
    } catch (error: unknown) {
      if (!this.ownsFlowChange(file, generation)) {
        console.error("Observation Car: abandoned EPUB flow-mode failure", error);
        return;
      }
      const failures: unknown[] = [error];
      try {
        await this.host.updateSettings({ epubFlowMode: previousMode });
      } catch (rollbackError: unknown) {
        failures.push(rollbackError);
      }

      if (!this.ownsFlowChange(file, generation)) {
        console.error("Observation Car: abandoned EPUB flow-mode failure", error);
        return;
      }
      if (this.rendition === null || this.renderedFlowMode !== previousMode) {
        try {
          generation += 1;
          const rendered = await this.renderBook(file, previousMode);
          if (!rendered || !this.ownsFlowChange(file, generation)) {
            return;
          }
          const rendition = this.rendition;
          if (cfi !== null && rendition !== null) {
            const restored = await this.redisplayAndPersistFlowLocation(
              file,
              generation,
              rendition,
              cfi,
            );
            if (!restored) {
              return;
            }
          }
        } catch (recoveryError: unknown) {
          if (!this.ownsFlowChange(file, generation)) {
            console.error(
              "Observation Car: abandoned EPUB flow-mode recovery failure",
              recoveryError,
            );
            return;
          }
          failures.push(recoveryError);
        }
      }

      if (failures.length === 1) {
        throw error;
      }
      throw new AggregateError(failures, "Could not switch or restore the EPUB flow mode");
    } finally {
      if (this.restoringFile === file) {
        this.restoringFile = null;
      }
    }
  }

  /**
   * Re-display and save a captured flow location while its render still owns
   * the leaf.
   */
  private async redisplayAndPersistFlowLocation(
    file: TFile,
    generation: number,
    rendition: Rendition,
    cfi: string,
  ): Promise<boolean> {
    await rendition.display(cfi);
    if (
      !this.ownsFlowChange(file, generation) ||
      this.rendition !== rendition
    ) {
      return false;
    }
    try {
      await this.persistCurrentLocation(file.path, buildEpubCfiFragment(cfi));
    } catch (error: unknown) {
      console.error("Observation Car: could not save EPUB location", error);
    }
    return true;
  }

  /** Whether a flow-mode transaction still owns this leaf and generation. */
  private ownsFlowChange(file: TFile, generation: number): boolean {
    return this.file === file && this.renderGeneration === generation;
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
    this.renderedFile = null;
    this.renderedFlowMode = null;
    this.book?.destroy();
    this.book = null;
    this.contentEl.empty();
  }
}
