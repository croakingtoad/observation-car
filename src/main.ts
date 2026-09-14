import { MarkdownView, Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import { registerCreateBookNoteCommand } from "./commands/createBookNote";
import {
  openBookNoteBesideRecentReader,
  registerOpenBookNoteCommand,
} from "./commands/openBookNote";
import { registerJumpToSectionCommand } from "./commands/jumpToSection";
import { registerSplitRatioToggleCommand } from "./commands/toggleSplitRatio";
import {
  DEFAULT_SETTINGS,
  type ObservationCarSettings,
} from "./settings";
import { ObservationCarSettingTab } from "./settingsTab";
import {
  isBookNoteCandidate,
  parseBookNote,
  type BookNote,
} from "./model/bookNote";
import { BookNoteStore } from "./model/bookNoteStore";
import { sortSectionsByBookPosition } from "./model/sortBookNoteSections";
import { EpubView, EPUB_VIEW_TYPE } from "./readers/EpubView";
import { loadPluginData, serializePluginData } from "./pluginData";
import { installEpubLinkHandler } from "./epubLinkHandler";
import {
  ReaderRegistry,
  type Reader,
  type ReaderPairing,
} from "./sync/ReaderRegistry";
import {
  ScrollSync,
  type ScrollEditor,
} from "./sync/scrollSync";
import { currentSectionViewPlugin } from "./sync/currentSectionDecoration";

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

  /** F2.4: last canonical EPUB CFI, keyed by the book's vault path. */
  private epubLastLocations: Record<string, string> = {};
  private dataRevision = 0;
  private dataSave: Promise<void> | null = null;

  /** Parsed book notes, keyed by vault path (PRD §5.2 storage model). */
  private bookNoteStore!: BookNoteStore;

  /** Format-neutral reader-leaf ↔ book-note pairings (PRD F4.1). */
  private readerRegistry!: ReaderRegistry;

  /** Reader-location → note-heading synchronization (PRD F4.3). */
  private scrollSync!: ScrollSync;

  async onload(): Promise<void> {
    const pluginData = loadPluginData(await this.loadData());
    this.settings = pluginData.settings;
    this.epubLastLocations = pluginData.epubLastLocations;
    this.addSettingTab(new ObservationCarSettingTab(this.app, this));

    this.addCommand({
      id: "sort-sections-by-book-position",
      name: "Sort sections by book position",
      editorCallback: (editor, context) => {
        const notePath = context.file?.path;
        if (notePath === undefined) return;

        const text = editor.getValue();
        const bookNote = parseBookNote(text, {
          anchorHeadingLevel: this.settings.anchorHeadingLevel,
          resolveLink: (linkpath) =>
            this.resolveLink(linkpath, notePath)?.path ?? null,
        });
        const sorted = sortSectionsByBookPosition(text, bookNote.sections);
        if (sorted !== text) editor.setValue(sorted);
      },
    });

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
        this.resolveLink(linkpath, notePath)?.path ?? null,
    });

    this.readerRegistry = new ReaderRegistry({
      listBookNotes: () =>
        this.bookNoteStore.paths().flatMap((path) => {
          const bookNote = this.bookNoteStore.get(path);
          return bookNote === undefined ? [] : [{ path, bookNote }];
        }),
      // This is the same canonical Obsidian resolution seam the parser
      // uses above. The registry compares the returned TFile identity;
      // it never compares source/link text.
      resolveLink: (linkpath, notePath) =>
        this.resolveLink(linkpath, notePath),
      isLeafOpen: (leaf, reader) =>
        this.app.workspace
          .getLeavesOfType(reader.getViewType())
          .includes(leaf),
    });
    this.scrollSync = new ScrollSync({
      getPairing: (leaf) => this.readerRegistry.getByLeaf(leaf),
      findEditor: (notePath) => this.findOpenEditor(notePath),
      // The layout listener refreshes ReaderRegistry first; this lookup
      // reuses that lifecycle result instead of querying the workspace a
      // second time for every subscription.
      isLeafOpen: (leaf, reader) =>
        this.readerRegistry.hasReader(leaf, reader),
    });

    // F2.1: `.epub` opens in the in-plugin reader view; the concrete view
    // satisfies Reader structurally and only this composition root knows
    // its implementation. The registry itself is EPUB/PDF agnostic.
    this.registerView(EPUB_VIEW_TYPE, (leaf) => {
      const reader = new EpubView(leaf, this);
      this.readerRegistry.register(leaf, reader);
      this.scrollSync.register(leaf, reader);
      return reader;
    });
    this.registerExtensions(["epub"], EPUB_VIEW_TYPE);
    this.register(installEpubLinkHandler(this.app));
    this.registerEditorExtension(currentSectionViewPlugin);
    registerCreateBookNoteCommand(this);
    registerOpenBookNoteCommand(this);
    registerJumpToSectionCommand(this);
    registerSplitRatioToggleCommand(this);

    // Obsidian has no leaf-close event. `layout-change` covers closes and
    // moves; the other events make a newly loaded reader visible quickly.
    // Refresh is identity-based, so focus and layout changes cannot steal
    // a pairing from the newest leaf. registerEvent owns listener cleanup.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.readerRegistry.refresh();
        this.scrollSync.refresh();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.readerRegistry.refresh();
        if (this.settings.autoOpenBookNote && file !== null) {
          void openBookNoteBesideRecentReader(this, file);
        }
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.readerRegistry.refresh();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        const file = info.file;
        if (file !== null && editor.hasFocus()) {
          this.scrollSync.markEditorChanged(editor);
        }
      }),
    );

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
   * Merge a partial settings update and route the write through the plugin's
   * single persistence boundary. Keep the OPDS credentials out of
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
    await this.persistData();
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

  /** F2.4: the last location recorded for one EPUB, if any. */
  getLastEpubLocation(path: string): string | null {
    return this.epubLastLocations[path] ?? null;
  }

  /** F2.4: persist one EPUB's canonical CFI without disturbing other books. */
  async rememberEpubLocation(path: string, fragment: string): Promise<void> {
    if (this.epubLastLocations[path] === fragment) {
      return;
    }
    this.epubLastLocations[path] = fragment;
    await this.persistData();
  }

  /** The cached parse of a book note, or undefined if the store holds none. */
  getBookNote(path: string): BookNote | undefined {
    return this.bookNoteStore.get(path);
  }

  /** Vault paths of every cached book note. */
  getBookNotePaths(): string[] {
    return this.bookNoteStore.paths();
  }

  /** Active reader pairing for a cached book-note path, if one is open. */
  getReaderPairingForNote(path: string): ReaderPairing | undefined {
    return this.readerRegistry.getByNotePath(path);
  }

  /** Registered reader for a workspace leaf, with no note required. */
  getReaderForLeaf(leaf: WorkspaceLeaf): Reader | undefined {
    return this.readerRegistry.getReader(leaf);
  }

  /** Active pairing for a reader leaf, if its note already exists. */
  getReaderPairingForLeaf(leaf: WorkspaceLeaf): ReaderPairing | undefined {
    return this.readerRegistry.getByLeaf(leaf);
  }

  onunload(): void {
    this.scrollSync.clear();
    this.readerRegistry.clear();
    this.bookNoteStore.clear();
  }

  /** Find a live source-mode editor by note path without retaining its view. */
  private findOpenEditor(notePath: string): ScrollEditor | null {
    let fallback: ScrollEditor | null = null;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (
        leaf.view instanceof MarkdownView &&
        leaf.view.file?.path === notePath
      ) {
        if (leaf.view.editor.hasFocus()) return leaf.view.editor;
        fallback ??= leaf.view.editor;
      }
    }
    return fallback;
  }

  /** Resolve a wikilink target to Obsidian's canonical vault file. */
  private resolveLink(linkpath: string, sourcePath: string): TFile | null {
    return this.app.metadataCache.getFirstLinkpathDest(
      linkpath,
      sourcePath,
    );
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

  /**
   * The single writer for plugin data: serialize settings and per-book state
   * while keeping OPDS credentials out of notes, logs, and events. If state
   * changes during a save, the loop writes a fresh snapshot before resolving
   * callers.
   */
  private async persistData(): Promise<void> {
    this.dataRevision += 1;
    if (this.dataSave === null) {
      this.dataSave = this.flushData();
    }
    const save = this.dataSave;
    try {
      await save;
    } finally {
      if (this.dataSave === save) {
        this.dataSave = null;
      }
    }
  }

  private async flushData(): Promise<void> {
    let savedRevision = -1;
    while (savedRevision !== this.dataRevision) {
      savedRevision = this.dataRevision;
      await this.saveData(
        serializePluginData(this.settings, this.epubLastLocations),
      );
    }
  }
}
