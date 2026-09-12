import type { TFile, WorkspaceLeaf } from "obsidian";
import type { BookNote } from "../model/bookNote";

/**
 * Format-neutral surface implemented structurally by reader views.
 * `EpubView` and Obsidian's core PDF view can both satisfy this contract
 * without the registry importing either implementation.
 */
export interface Reader {
  /** The book currently open in the reader leaf. */
  readonly file: TFile | null;
  /** Obsidian workspace view type used to determine whether the leaf is open. */
  getViewType(): string;
}

export interface BookNoteEntry {
  readonly path: string;
  readonly bookNote: BookNote;
}

export interface ReaderRegistryDeps {
  /** Live book-note snapshot; read again whenever pairings are queried. */
  listBookNotes: () => readonly BookNoteEntry[];
  /** Resolve a note's source to Obsidian's canonical file object. */
  resolveLink: (linkpath: string, notePath: string) => TFile | null;
  /** True while the exact reader leaf remains in the workspace. */
  isLeafOpen: (leaf: WorkspaceLeaf, reader: Reader) => boolean;
}

export interface ReaderPairing {
  readonly leaf: WorkspaceLeaf;
  readonly reader: Reader;
  readonly bookFile: TFile;
  readonly notePath: string;
  readonly bookNote: BookNote;
}

interface ReaderState {
  readonly reader: Reader;
  observedFile: TFile | null;
  openedAt: number;
}

/**
 * Maps open reader leaves to parsed book notes by canonical source-file
 * identity. One pairing is active per book; when another leaf opens the
 * same book, its later registration/file-open sequence displaces the old
 * leaf without depending on focus or workspace position.
 */
export class ReaderRegistry {
  private readonly deps: ReaderRegistryDeps;
  private readonly readers = new Map<WorkspaceLeaf, ReaderState>();
  private byLeaf = new Map<WorkspaceLeaf, ReaderPairing>();
  private byNotePath = new Map<string, ReaderPairing>();
  private sequence = 0;

  constructor(deps: ReaderRegistryDeps) {
    this.deps = deps;
  }

  /** Register a reader implementation in its stable workspace leaf. */
  register(leaf: WorkspaceLeaf, reader: Reader): void {
    const current = this.readers.get(leaf);
    if (current?.reader === reader) return;
    this.readers.set(leaf, {
      reader,
      observedFile: reader.file,
      openedAt: ++this.sequence,
    });
  }

  /**
   * Reconcile reader lifecycle, current files, and the live book-note cache.
   * Layout moves and re-focus leave both leaf and file identity unchanged,
   * so they cannot change which leaf owns a book.
   */
  refresh(): void {
    for (const [leaf, state] of this.readers) {
      if (this.deps.isLeafOpen(leaf, state.reader) !== true) {
        this.readers.delete(leaf);
        continue;
      }
      if (state.observedFile !== state.reader.file) {
        state.observedFile = state.reader.file;
        state.openedAt = ++this.sequence;
      }
    }
    this.rebuildPairings();
  }

  getByLeaf(leaf: WorkspaceLeaf): ReaderPairing | undefined {
    this.refresh();
    return this.byLeaf.get(leaf);
  }

  getByNotePath(notePath: string): ReaderPairing | undefined {
    this.refresh();
    return this.byNotePath.get(notePath);
  }

  pairings(): readonly ReaderPairing[] {
    this.refresh();
    return [...this.byLeaf.values()];
  }

  /** Drop all reader references and derived pairings on plugin unload. */
  clear(): void {
    this.readers.clear();
    this.byLeaf.clear();
    this.byNotePath.clear();
  }

  private rebuildPairings(): void {
    const noteByBook = new Map<TFile, BookNoteEntry>();
    const notes = [...this.deps.listBookNotes()].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    for (const entry of notes) {
      const source = entry.bookNote.frontmatter.source;
      if (source === null) continue;
      const bookFile = this.deps.resolveLink(source, entry.path);
      if (bookFile !== null && noteByBook.has(bookFile) !== true) {
        noteByBook.set(bookFile, entry);
      }
    }

    const winnerByBook = new Map<
      TFile,
      { leaf: WorkspaceLeaf; state: ReaderState }
    >();
    for (const [leaf, state] of this.readers) {
      const bookFile = state.reader.file;
      if (bookFile === null || noteByBook.has(bookFile) !== true) continue;
      const current = winnerByBook.get(bookFile);
      if (current === undefined || state.openedAt > current.state.openedAt) {
        winnerByBook.set(bookFile, { leaf, state });
      }
    }

    const byLeaf = new Map<WorkspaceLeaf, ReaderPairing>();
    const byNotePath = new Map<string, ReaderPairing>();
    for (const [bookFile, { leaf, state }] of winnerByBook) {
      const entry = noteByBook.get(bookFile);
      if (entry === undefined) continue;
      const pairing: ReaderPairing = {
        leaf,
        reader: state.reader,
        bookFile,
        notePath: entry.path,
        bookNote: entry.bookNote,
      };
      byLeaf.set(leaf, pairing);
      byNotePath.set(entry.path, pairing);
    }
    this.byLeaf = byLeaf;
    this.byNotePath = byNotePath;
  }
}
