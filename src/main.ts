import {
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  type WorkspaceLeaf,
} from "obsidian";
import { registerCreateBookNoteCommand } from "./commands/createBookNote";
import {
  openBookNoteBesideRecentReader,
  registerOpenBookNoteCommand,
} from "./commands/openBookNote";
import { registerJumpToSectionCommand } from "./commands/jumpToSection";
import {
  activePairing,
  newNoteHereFromReader,
  registerNewNoteHereCommand,
} from "./commands/newNoteHere";
import { registerToggleFocusModeCommand } from "./commands/toggleFocusMode";
import { registerSplitRatioToggleCommand } from "./commands/toggleSplitRatio";
import { registerToggleBookStylesheetCommand } from "./commands/toggleBookStylesheet";
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
import type { EpubStylesheetMode } from "./readers/epubStyles";
import { loadPluginData, serializePluginData } from "./pluginData";
import { installEpubLinkHandler } from "./epubLinkHandler";
import {
  findDisplacements,
  openBesideInGroup,
  openBookInBookGroup,
  openNoteBesideReader,
  snapshotRootLeaves,
  type Displacement,
  type LayoutWorkspace,
} from "./workspace/readingLayout";
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
import { focusModeViewPlugin } from "./sync/focusModeDecoration";
import { FocusModeController } from "./sync/focusMode";

/**
 * File extensions routed to the in-plugin reader. One list, so the
 * reading layout's "is this a book?" test cannot drift from what
 * `registerExtensions` actually claims. PDF joins it in E003.
 */
const READER_EXTENSIONS: readonly string[] = ["epub"];

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
  /** Explicit per-book CSS choices; absent paths use the Obsidian theme. */
  private epubStylesheetModes: Record<string, EpubStylesheetMode> = {};
  private dataRevision = 0;
  private dataSave: Promise<void> | null = null;

  /** Parsed book notes, keyed by vault path (PRD §5.2 storage model). */
  private bookNoteStore!: BookNoteStore;

  /** Format-neutral reader-leaf ↔ book-note pairings (PRD F4.1). */
  private readerRegistry!: ReaderRegistry;

  /** Reader-location → note-heading synchronization (PRD F4.3). */
  private scrollSync!: ScrollSync;

  /** Read-only CM6 focus decoration state (PRD F4.5). */
  private focusMode!: FocusModeController;

  /**
   * Main-area leaf → vault path as of the last reconciliation, the only
   * way to tell that Obsidian reused a pane rather than opening one
   * (`readingLayout.findDisplacements`).
   */
  private layoutSnapshot: Map<WorkspaceLeaf, string> = new Map();
  /** Guards the reconciler against the layout events its own opens raise. */
  private reconcilingLayout = false;
  /** Latched on the first reconciliation failure; see `restoreDisplacedPanes`. */
  private layoutReconcilerFailed = false;

  async onload(): Promise<void> {
    const pluginData = loadPluginData(await this.loadData());
    this.settings = pluginData.settings;
    this.epubLastLocations = pluginData.epubLastLocations;
    this.epubStylesheetModes = pluginData.epubStylesheetModes;
    this.addSettingTab(new ObservationCarSettingTab(this.app, this));
    this.focusMode = new FocusModeController();

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
      focusMode: this.focusMode,
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
    this.registerExtensions([...READER_EXTENSIONS], EPUB_VIEW_TYPE);
    this.register(installEpubLinkHandler(this.app));
    this.registerEditorExtension(currentSectionViewPlugin);
    this.registerEditorExtension(focusModeViewPlugin);
    registerCreateBookNoteCommand(this);
    registerOpenBookNoteCommand(this);
    registerJumpToSectionCommand(this);
    registerNewNoteHereCommand(this);
    registerToggleFocusModeCommand(this);
    registerSplitRatioToggleCommand(this);
    registerToggleBookStylesheetCommand(this);

    // Obsidian has no leaf-close event. `layout-change` covers closes and
    // moves; the other events make a newly loaded reader visible quickly.
    // Refresh is identity-based, so focus and layout changes cannot steal
    // a pairing from the newest leaf. registerEvent owns listener cleanup.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.readerRegistry.refresh();
        this.scrollSync.refresh();
        this.reconcileReadingLayout();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.readerRegistry.refresh();
        // Both events are hooked on purpose: `layout-change` can land
        // while the repurposed leaf still reports its old file, and
        // `file-open` is the one event guaranteed to fire after the new
        // file is in place. The snapshot diff is idempotent, so whichever
        // arrives with the settled path does the work and the other is a
        // no-op.
        this.reconcileReadingLayout();
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
        this.dropEpubState(file.path);
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
        if (file instanceof TFile) {
          this.moveEpubState(file, oldPath);
          this.scheduleReparse(file);
        }
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

  /** Per-book stylesheet mode; the default is deliberately not persisted. */
  getEpubStylesheetMode(path: string): EpubStylesheetMode {
    return this.epubStylesheetModes[path] ?? "theme";
  }

  /** Remember a book CSS opt-in, or remove it when returning to the default. */
  async setEpubStylesheetMode(
    path: string,
    mode: EpubStylesheetMode,
  ): Promise<void> {
    if (this.getEpubStylesheetMode(path) === mode) {
      return;
    }
    if (mode === "theme") {
      delete this.epubStylesheetModes[path];
    } else {
      this.epubStylesheetModes[path] = mode;
    }
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

  /** Reader-toolbar bridge for F4.6's leaf-pinned action. */
  newNoteHereFromReader(leaf: WorkspaceLeaf): void {
    void newNoteHereFromReader(this, leaf);
  }

  /**
   * The single way a book note reaches the screen: revealed where it is
   * already open, else a new tab in the note pane. Every command that
   * used to call `getLeaf("split", …)` or `createLeafBySplit` itself now
   * comes through here, which is what stops the second book's note from
   * building a third tab group.
   */
  async openBookNotePane(
    readerLeaf: WorkspaceLeaf | null,
    note: TFile,
  ): Promise<WorkspaceLeaf> {
    return openNoteBesideReader(this.readingLayout(), readerLeaf, note);
  }

  /**
   * Adapt Obsidian's workspace to the layout module's seam. This is the
   * only place that knows both APIs.
   */
  private readingLayout(): LayoutWorkspace<WorkspaceLeaf> {
    const { workspace } = this.app;
    return {
      rootSplit: workspace.rootSplit,
      rootLeaves: () => {
        const leaves: WorkspaceLeaf[] = [];
        workspace.iterateRootLeaves((leaf) => {
          leaves.push(leaf);
        });
        return leaves;
      },
      pathOf: (leaf) => leafFilePath(leaf),
      isReader: (leaf) => leaf.getViewState().type === EPUB_VIEW_TYPE,
      // Making the anchor active and then asking for a `"tab"` is how
      // every "open in a new tab" plugin does this, and it keeps the
      // workspace tree construction entirely inside Obsidian. The
      // previous `createLeafInParent(leaf.parent as WorkspaceSplit, i)`
      // built a leaf Obsidian's own palette-close path then choked on.
      // `focus: false` keeps the keystroke's focus where it was.
      createTabBeside: (anchor) => {
        workspace.setActiveLeaf(anchor, { focus: false });
        return workspace.getLeaf("tab");
      },
      createLeafBySplit: (leaf, direction) =>
        workspace.createLeafBySplit(leaf, direction),
      splitActiveLeaf: (direction) => workspace.getLeaf("split", direction),
      revealLeaf: (leaf) => workspace.revealLeaf(leaf),
    };
  }

  /**
   * Put a book that took over the wrong pane, and whatever it pushed out
   * of that pane, back where the reading layout says they belong.
   *
   * Obsidian decides which leaf a file-explorer click lands in, and
   * `getLeaf(false)` hands back an existing navigable leaf — the note
   * pane, when that is what was last active. There is no hook to refuse
   * it, so this reads the reuse back off the leaf snapshot afterwards.
   */
  private reconcileReadingLayout(): void {
    if (this.reconcilingLayout || this.layoutReconcilerFailed) return;

    const layout = this.readingLayout();
    const current = snapshotRootLeaves(layout);
    const displacements = findDisplacements(
      this.layoutSnapshot,
      current,
      isBookPath,
    );
    // Adopt the new snapshot before acting: the opens below raise more
    // layout events, and their leaves must read as new rather than as
    // further displacements.
    this.layoutSnapshot = current;
    if (displacements.length === 0) return;

    this.reconcilingLayout = true;
    void this.restoreDisplacedPanes(displacements).finally(() => {
      this.reconcilingLayout = false;
      this.layoutSnapshot = snapshotRootLeaves(this.readingLayout());
    });
  }

  private async restoreDisplacedPanes(
    displacements: readonly Displacement<WorkspaceLeaf>[],
  ): Promise<void> {
    const layout = this.readingLayout();
    for (const displacement of displacements) {
      try {
        const displaced = this.app.vault.getAbstractFileByPath(
          displacement.displacedPath,
        );
        if (displaced instanceof TFile === false) continue;

        if (isBookPath(displacement.displacedPath)) {
          // A book took another book's pane. Both belong in the book
          // group, which is where the reused leaf already sits, so the
          // displaced book only needs a tab of its own beside it. Its
          // reading position is restored from `epubLastLocations`.
          await openBesideInGroup(layout, displacement.leaf, displaced);
          continue;
        }

        const book = this.app.vault.getAbstractFileByPath(
          displacement.bookPath,
        );
        const relocated =
          book instanceof TFile
            ? await openBookInBookGroup(layout, book, displacement.leaf)
            : null;
        if (relocated === null) {
          // No book pane anywhere else, so the reused leaf becomes the
          // book pane and the note it displaced moves to a note pane
          // beside it. Nothing is detached in this branch.
          await openNoteBesideReader(layout, displacement.leaf, displaced);
          continue;
        }

        // The reused leaf was the note pane, and the book now has a tab
        // of its own, so the note goes straight back into the leaf it
        // was evicted from. Re-opening the file is the whole undo: no
        // leaf is created or destroyed, so Obsidian is never left holding
        // a detached leaf as its active one.
        await displacement.leaf.openFile(displaced);
        await layout.revealLeaf(relocated);
      } catch (error) {
        // Fail closed. A reconciliation that throws has left the layout
        // in a state this pass did not finish reasoning about, and
        // repeating it on every later layout event is how one bad
        // decision becomes a broken workspace. Stay off until reload.
        this.layoutReconcilerFailed = true;
        console.error(
          "[observation-car] could not restore the reading layout; layout reconciliation is now off until Obsidian reloads",
          error,
        );
      }
    }
  }

  /** Toggle read-only focus decoration for the active paired note. */
  toggleFocusMode(): void {
    const pairing = activePairing(this);
    if (pairing === undefined) {
      new Notice("Open or create this book's note before toggling focus mode.");
      return;
    }
    const editor = this.findOpenEditor(pairing.notePath);
    if (editor === null) {
      new Notice("Open this book's note before toggling focus mode.");
      return;
    }
    const { sections } = pairing.bookNote;
    if (
      sections.length > 0 &&
      sections.every((s) => s.chapter === null)
    ) {
      new Notice("Focus mode needs CFI anchors; this note's anchors are chapter hrefs.");
      return;
    }
    this.focusMode.toggle(
      editor,
      pairing.bookNote.sections,
      this.scrollSync.getCurrentSection(editor),
    );
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

  /** Carry the saved EPUB state with a vault rename. */
  private moveEpubState(file: TFile, oldPath: string): void {
    const previousLocation = this.epubLastLocations[oldPath];
    const destinationLocation = this.epubLastLocations[file.path];
    const previousMode = this.epubStylesheetModes[oldPath];
    const destinationMode = this.epubStylesheetModes[file.path];
    if (
      previousLocation === undefined &&
      destinationLocation === undefined &&
      previousMode === undefined &&
      destinationMode === undefined
    ) {
      return;
    }
    delete this.epubLastLocations[oldPath];
    delete this.epubLastLocations[file.path];
    delete this.epubStylesheetModes[oldPath];
    delete this.epubStylesheetModes[file.path];
    if (file.extension.toLowerCase() === "epub") {
      if (previousLocation !== undefined) {
        this.epubLastLocations[file.path] = previousLocation;
      }
      if (previousMode !== undefined) {
        this.epubStylesheetModes[file.path] = previousMode;
      }
    }
    this.persistEpubStateCleanup("rename");
  }

  /** Drop state for a deleted path before that path can be reused. */
  private dropEpubState(path: string): void {
    if (
      this.epubLastLocations[path] === undefined &&
      this.epubStylesheetModes[path] === undefined
    ) {
      return;
    }
    delete this.epubLastLocations[path];
    delete this.epubStylesheetModes[path];
    this.persistEpubStateCleanup("delete");
  }

  private persistEpubStateCleanup(event: "rename" | "delete"): void {
    void this.persistData().catch((error: unknown) => {
      console.error(
        `[observation-car] could not persist EPUB state after ${event}`,
        error,
      );
    });
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
        serializePluginData(
          this.settings,
          this.epubLastLocations,
          this.epubStylesheetModes,
        ),
      );
    }
  }
}

/**
 * Vault path of the file a main-area leaf is showing, or null.
 *
 * The view's own `file` is read structurally rather than through
 * `instanceof FileView`, so any view that exposes one answers. The view
 * state is the fallback because a background leaf is deferred
 * (`WorkspaceLeaf.isDeferred`) and carries a `DeferredView` with no
 * `file` — the same reason `epubLinkHandler` reads the view state when
 * matching an already-open book.
 */
function leafFilePath(leaf: WorkspaceLeaf): string | null {
  const view: unknown = leaf.view;
  if (typeof view === "object" && view !== null && "file" in view) {
    const file: unknown = view.file;
    if (typeof file === "object" && file !== null && "path" in file) {
      if (typeof file.path === "string") return file.path;
    }
  }
  const state: unknown = leaf.getViewState().state;
  if (typeof state !== "object" || state === null || !("file" in state)) {
    return null;
  }
  return typeof state.file === "string" ? state.file : null;
}

/** True for a path the plugin's own reader view owns. */
function isBookPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  const extension = path.slice(dot + 1).toLowerCase();
  return READER_EXTENSIONS.includes(extension);
}
