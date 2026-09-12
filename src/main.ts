import { Plugin, TFile } from "obsidian";
import {
  DEFAULT_SETTINGS,
  type ObservationCarSettings,
} from "./settings";
import { ObservationCarSettingTab } from "./settingsTab";
import {
  isBookNoteCandidate,
  type BookNote,
} from "./model/bookNote";
import { BookNoteStore } from "./model/bookNoteStore";
import { EpubView, EPUB_VIEW_TYPE } from "./readers/EpubView";
import { loadPluginData, serializePluginData } from "./pluginData";
import { installEpubLinkHandler } from "./epubLinkHandler";

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
 * snapshot the settings object: `updateSettings` replaces it wholesale, and
 * there is no settings-change event, so on-demand parsing is the
 * live-reload path for mid-session heading-level changes.
 */
export default class ObservationCarPlugin extends Plugin {
  settings: ObservationCarSettings = DEFAULT_SETTINGS;

  /** F2.4: last canonical EPUB CFI, keyed by the book's vault path. */
  private epubLastLocations: Record<string, string> = {};
  private dataRevision = 0;
  private dataSave: Promise<void> | null = null;

  /** Parsed book notes, keyed by vault path (PRD §5.2 storage model). */
  private bookNoteStore!: BookNoteStore;

  async onload(): Promise<void> {
    const pluginData = loadPluginData(await this.loadData());
    this.settings = pluginData.settings;
    this.epubLastLocations = pluginData.epubLastLocations;
    this.addSettingTab(new ObservationCarSettingTab(this.app, this));

    // F2.1: `.epub` opens in the in-plugin reader view; no external
    // reader is involved. The view-type factory is called once per leaf.
    // The view holds the plugin (as the narrow EpubViewHost slice) so the
    // F2.2 flow toggle can read and persist `epubFlowMode`.
    this.registerView(EPUB_VIEW_TYPE, (leaf) => new EpubView(leaf, this));
    this.registerExtensions(["epub"], EPUB_VIEW_TYPE);
    this.register(installEpubLinkHandler(this.app));

    this.bookNoteStore = new BookNoteStore({
      readText: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile === false) return null;
        return this.app.vault.read(file);
      },
      anchorHeadingLevel: () => this.settings.anchorHeadingLevel,
    });

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
        this.reparseBookNotes().catch(() => {
          // A failed initial-load parse is non-fatal; the next change
          // event retries the affected note.
        });
      }),
    );

    // `resolved` can fire before community plugins finish loading (first
    // launch with a trust prompt: the cache indexes while the modal is up),
    // in which case the listener above misses it and the store would stay
    // empty until the first edit. An immediate pass is safe in either
    // ordering: while the metadata cache is not built, every cache lookup
    // returns null so nothing is parsed, and the `resolved` pass picks the
    // notes up later.
    this.reparseBookNotes().catch(() => {
      // Non-fatal; the next change event retries the affected note.
    });
  }

  /**
   * Merge a partial settings update and route the data.json write through
   * the plugin's persistence boundary.
   */
  async updateSettings(patch: Partial<ObservationCarSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await this.persistData();
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
    if (isBookNoteCandidate(this.app.metadataCache.getFileCache(file)?.frontmatter) !== true) {
      return;
    }
    this.bookNoteStore.scheduleReparse(file.path);
  }

  /**
   * (Re)parse every markdown file that looks like a book note. Runs once
   * when the metadata cache resolves (initial load and vault rescans).
   */
  private async reparseBookNotes(): Promise<void> {
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (isBookNoteCandidate(this.app.metadataCache.getFileCache(file)?.frontmatter) !== true) {
        continue;
      }
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
