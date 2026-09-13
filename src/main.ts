import { Plugin, TFile } from "obsidian";
import { registerCreateBookNoteCommand } from "./commands/createBookNote";
import { registerBookloreDownloads } from "./booklore/bookDownloadRegistration";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type ObservationCarSettings,
} from "./settings";
import { ObservationCarSettingTab } from "./settingsTab";
import {
  isBookNoteCandidate,
  type BookNote,
} from "./model/bookNote";
import { BookNoteStore } from "./model/bookNoteStore";
import { EpubView, EPUB_VIEW_TYPE } from "./readers/EpubView";
import { registerBookloreCatalog } from "./booklore/catalogRegistration";

/**
 * Observation Car — plugin entry point.
 *
 * F1.1 scaffold + F1.4 settings + F1.2 book-note model + F2.1 EPUB view:
 * on load the settings are merged from `data.json`, the settings tab is
 * registered, `.epub` is routed to the in-plugin `EpubView`, and a
 * debounced `metadataCache` listener keeps the book-note cache up to date
 * so the sync layer (E004) always reads a fresh parse.
 *
 * `anchorHeadingLevel` is read from `this.settings` at parse time — never
 * snapshot the settings object: `updateSettings` replaces it wholesale.
 * There is no settings-change event, so `updateSettings` itself re-parses
 * the whole cache when the level changes — that re-parse (the store's
 * live level read picking up the new value) is the live-reload path for
 * mid-session heading-level changes.
 */
export default class ObservationCarPlugin extends Plugin {
  settings: ObservationCarSettings = DEFAULT_SETTINGS;

  /** Parsed book notes, keyed by vault path (PRD §5.2 storage model). */
  private bookNoteStore!: BookNoteStore;

  async onload(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());
    this.addSettingTab(new ObservationCarSettingTab(this.app, this));

    // F2.1: `.epub` opens in the in-plugin reader view; no external
    // reader is involved. The view-type factory is called once per leaf.
    this.registerView(EPUB_VIEW_TYPE, (leaf) => new EpubView(leaf));
    this.registerExtensions(["epub"], EPUB_VIEW_TYPE);
    registerCreateBookNoteCommand(this);
    registerBookloreCatalog(this);

    this.bookNoteStore = new BookNoteStore({
      readText: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile === false) return null;
        return this.app.vault.read(file);
      },
      anchorHeadingLevel: () => this.settings.anchorHeadingLevel,
      // Anchor links are matched by file identity, not string identity:
      // Obsidian's default "shortest path when possible" link format
      // writes [[Book.epub#…]] for a Books/Book.epub source, so the link
      // path and the frontmatter source must resolve to the same vault
      // file before a heading counts as an anchor (parseBookNote's
      // resolveLink contract).
      resolveLink: (linkpath, notePath) =>
        this.app.metadataCache.getFirstLinkpathDest(linkpath, notePath)
          ?.path ?? null,
    });
    await registerBookloreDownloads(this);

    // `changed` also fires when a file's cache entry is first built, which
    // covers notes created after load; `resolved` covers the initial load
    // and full vault rescans.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.scheduleReparse(file);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("deleted", (file) => {
        this.bookNoteStore.remove(file.path);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        this.reparseBookNotes().catch((error) => {
          // Per-path failures are contained and logged inside the store
          // (a bad note keeps its last-good parse). This backstop
          // surfaces a failure of the pass itself in the dev console.
          console.error(
            "[observation-car] book-note pass failed",
            error,
          );
        });
      }),
    );
    // `metadataCache.changed` is deliberately not fired for renames
    // (the vendored API says so at obsidian.d.ts:4449), so without this
    // hook a renamed book note keeps its old path cached forever — and
    // the `resolved` pass only adds, never evicts, so even a full rescan
    // would not clear the phantom.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.bookNoteStore.remove(oldPath);
        if (file instanceof TFile) this.scheduleReparse(file);
      }),
    );

    // `resolved` can fire before community plugins finish loading (first
    // launch with a trust prompt: the cache indexes while the modal is up),
    // in which case the listener above misses it and the store would stay
    // empty until the first edit. An immediate pass is safe in either
    // ordering: while the metadata cache is not built, every cache lookup
    // returns null so nothing is parsed, and the `resolved` pass picks the
    // notes up later. The pass is awaited (it no-ops cheaply while the
    // cache is unbuilt), so by the time onload resolves the store holds
    // every note the metadata cache currently describes.
    try {
      await this.reparseBookNotes();
    } catch (error) {
      // Non-fatal; the same backstop as the `resolved` listener above.
      console.error(
        "[observation-car] initial book-note pass failed",
        error,
      );
    }
  }

  /**
   * Merge a partial update into the settings and persist them to data.json.
   * The only writer for plugin data; keep the OPDS credentials out of
   * anything else (notes, logs, events).
   *
   * An `anchorHeadingLevel` change rewrites every cached note's sections
   * (which headings count as anchors is the level's call), so the whole
   * cache is re-parsed at the new level; the store's live level read makes
   * the re-parse pick the change up.
   */
  async updateSettings(patch: Partial<ObservationCarSettings>): Promise<void> {
    const previousLevel = this.settings.anchorHeadingLevel;
    this.settings = { ...this.settings, ...patch };
    await this.saveData(this.settings);
    if (
      patch.anchorHeadingLevel !== undefined &&
      patch.anchorHeadingLevel !== previousLevel
    ) {
      for (const path of this.bookNoteStore.paths()) {
        this.bookNoteStore.scheduleReparse(path);
      }
      await this.bookNoteStore.flush();
    }
  }

  /** The cached parse of a book note, or undefined if the store holds none. */
  getBookNote(path: string): BookNote | undefined {
    return this.bookNoteStore.get(path);
  }

  /** Vault paths of every cached book note. */
  getBookNotePaths(): string[] {
    return this.bookNoteStore.paths();
  }

  onunload(): void {
    this.bookNoteStore.clear();
  }

  /**
   * Debounce-reparse one note after a metadata change. The cache has
   * already been updated when these events fire, so the frontmatter sniff
   * is current; the parser's own `source` check stays authoritative for
   * what actually gets stored.
   */
  private scheduleReparse(file: TFile): void {
    if (file.extension !== "md") return;
    if (this.wantsReparse(file) !== true) return;
    this.bookNoteStore.scheduleReparse(file.path);
  }

  /**
   * Candidate gate for re-parse scheduling, with one carve-out: a path
   * the store already holds is always re-parsed, even when the sniff no
   * longer calls it a candidate. That carve-out is how a note that stops
   * being a book note (its `source` stripped) gets the final parse in
   * which the parser's authoritative `source` check evicts it — the sniff
   * is a cheap filter, never the source of truth.
   */
  private wantsReparse(file: TFile): boolean {
    if (this.bookNoteStore.has(file.path)) return true;
    return (
      isBookNoteCandidate(
        this.app.metadataCache.getFileCache(file)?.frontmatter,
      ) === true
    );
  }

  /**
   * (Re)parse every markdown file that looks like a book note. Runs once
   * when the metadata cache resolves (initial load and vault rescans).
   * The same candidate gate as `scheduleReparse` applies — including its
   * carve-out for paths the store already holds, so a rescan evicts a
   * de-book-noted file instead of leaving the stale entry behind.
   */
  private async reparseBookNotes(): Promise<void> {
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.wantsReparse(file) !== true) continue;
      this.bookNoteStore.scheduleReparse(file.path);
    }
    await this.bookNoteStore.flush();
  }
}
