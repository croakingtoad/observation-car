import { EditorView } from "@codemirror/view";
import type { EditorRange, TFile, WorkspaceLeaf } from "obsidian";
import {
  comparePositions,
  parseFragment,
  type AnchorPosition,
} from "../model/anchor";
import type { BookNoteSection } from "../model/bookNote";
import type { Reader, ReaderPairing } from "./ReaderRegistry";
import { codeMirrorView } from "./codeMirrorView";
import { setCurrentSectionDecoration } from "./currentSectionDecoration";
import type { FocusModeController } from "./focusMode";

/** The reader-side debounce leaves 50 ms of the 200 ms PRD budget. */
export const DEFAULT_SCROLL_DEBOUNCE_MS = 25;
export const DEFAULT_TYPING_IDLE_MS = 1_500;
export const SCROLL_MARGIN_PX = 32;

/** Format-neutral location payload consumed by the note sync layer. */
export interface LocationChanged {
  readonly file: TFile;
  readonly fragment: string;
  readonly chapter: number | null;
  readonly label: string;
}

/** A Reader implementation that exposes the PRD location event contract. */
export interface LocationReader extends Reader {
  on(
    event: "location",
    listener: (location: LocationChanged) => void,
  ): () => void;
}

/** The minimal editor surface scroll-sync may inspect and operate. */
export interface ScrollEditor {
  lineCount(): number;
  scrollIntoView(range: EditorRange, center?: boolean): void;
}

export interface ScrollSyncDeps {
  /** Live pairing lookup; displaced/closed readers therefore go inert. */
  getPairing: (leaf: WorkspaceLeaf) => ReaderPairing | undefined;
  /** Resolve the currently open editor for a note without retaining its view. */
  findEditor: (notePath: string) => ScrollEditor | null;
  /** True while the exact reader remains in the workspace. */
  isLeafOpen: (leaf: WorkspaceLeaf, reader: Reader) => boolean;
  debounceMs?: number;
  typingIdleMs?: number;
  now?: () => number;
  setCurrentSection?: (
    editor: ScrollEditor,
    section: BookNoteSection | null,
  ) => void;
  focusMode?: FocusModeController;
}

interface Subscription {
  readonly reader: LocationReader;
  readonly unsubscribe: () => void;
}

interface PendingScroll {
  readonly leaf: WorkspaceLeaf;
  readonly reader: LocationReader;
  location: LocationChanged;
  timer: ReturnType<typeof setTimeout> | null;
}

interface CurrentSection {
  readonly key: string;
  /** Non-retaining handle to the exact editor that received the class. */
  readonly editor: WeakRef<ScrollEditor>;
}

/**
 * Reader-location → book-note-heading synchronization (PRD F4.3).
 *
 * The controller owns subscriptions and timers, but never an Obsidian view:
 * editor lookup is live for each scroll. Repeated pages inside one section
 * do not yank the note back after the user scrolls it manually.
 */
export class ScrollSync {
  private readonly deps: ScrollSyncDeps;
  private readonly subscriptions = new Map<WorkspaceLeaf, Subscription>();
  private readonly pending = new Map<WorkspaceLeaf, PendingScroll>();
  private readonly lastEditorChange = new WeakMap<ScrollEditor, number>();
  private readonly currentSection = new Map<WorkspaceLeaf, CurrentSection>();

  constructor(deps: ScrollSyncDeps) {
    this.deps = deps;
  }

  /** Subscribe once for a reader's stable workspace leaf. */
  register(leaf: WorkspaceLeaf, reader: LocationReader): void {
    const current = this.subscriptions.get(leaf);
    if (current?.reader === reader) return;
    this.removeLeaf(leaf);
    const unsubscribe = reader.on("location", (location) => {
      this.onLocation(leaf, reader, location);
    });
    this.subscriptions.set(leaf, { reader, unsubscribe });
  }

  /** Record an editor mutation so scrolling waits for a full idle window. */
  markEditorChanged(editor: ScrollEditor): void {
    this.lastEditorChange.set(editor, this.now());
  }

  /** Release subscriptions for reader leaves that have closed. */
  refresh(): void {
    for (const [leaf, subscription] of this.subscriptions) {
      if (this.deps.isLeafOpen(leaf, subscription.reader) !== true) {
        this.removeLeaf(leaf);
      }
    }
  }

  /** Cancel every deferred scroll and release every reader subscription. */
  clear(): void {
    for (const leaf of [...this.subscriptions.keys()]) {
      this.removeLeaf(leaf);
    }
  }

  private onLocation(
    leaf: WorkspaceLeaf,
    reader: LocationReader,
    location: LocationChanged,
  ): void {
    const previous = this.pending.get(leaf);
    if (previous !== undefined && previous.timer !== null) {
      clearTimeout(previous.timer);
    }
    const next: PendingScroll = {
      leaf,
      reader,
      location,
      timer: null,
    };
    this.pending.set(leaf, next);
    this.schedule(next, this.deps.debounceMs ?? DEFAULT_SCROLL_DEBOUNCE_MS);
  }

  private schedule(pending: PendingScroll, delayMs: number): void {
    pending.timer = setTimeout(() => {
      if (this.pending.get(pending.leaf) !== pending) return;
      pending.timer = null;
      this.attemptScroll(pending);
    }, delayMs);
  }

  private attemptScroll(pending: PendingScroll): void {
    const pairing = this.deps.getPairing(pending.leaf);
    if (
      pairing === undefined ||
      pairing.reader !== pending.reader ||
      pairing.bookFile !== pending.location.file
    ) {
      this.clearCurrentSection(pending.leaf);
      this.pending.delete(pending.leaf);
      return;
    }

    let position: AnchorPosition;
    try {
      position = parseFragment(pending.location.fragment);
    } catch {
      // An unparseable location is non-fatal; leave the note where it is.
      console.warn(
        "[observation-car] ignoring unparseable reader location",
        pending.location.fragment,
      );
      this.pending.delete(pending.leaf);
      return;
    }
    const section = findSectionAtPosition(
      pairing.bookNote.sections,
      position,
    );
    if (section === undefined) {
      this.clearCurrentSection(pending.leaf);
      this.pending.delete(pending.leaf);
      return;
    }

    const sectionKey = `${pairing.notePath}\0${section.headingLine}\0${section.fragment}`;
    const current = this.currentSection.get(pending.leaf);
    if (current?.key === sectionKey) {
      const editor = this.deps.findEditor(pairing.notePath);
      if (editor !== null) {
        this.applyCurrentSection(
          pairing,
          pending.leaf,
          editor,
          section,
          sectionKey,
        );
      }
      this.pending.delete(pending.leaf);
      return;
    }

    const editor = this.deps.findEditor(pairing.notePath);
    if (editor === null) {
      this.pending.delete(pending.leaf);
      return;
    }
    const lastChange = this.lastEditorChange.get(editor);
    const idleFor = lastChange === undefined
      ? Number.POSITIVE_INFINITY
      : this.now() - lastChange;
    const idleThreshold = this.deps.typingIdleMs ?? DEFAULT_TYPING_IDLE_MS;
    if (idleFor < idleThreshold) {
      this.schedule(pending, idleThreshold - idleFor);
      return;
    }

    scrollHeadingIntoView(editor, section.headingLine);
    this.applyCurrentSection(
      pairing,
      pending.leaf,
      editor,
      section,
      sectionKey,
    );
    this.pending.delete(pending.leaf);
  }

  private removeLeaf(leaf: WorkspaceLeaf): void {
    const subscription = this.subscriptions.get(leaf);
    subscription?.unsubscribe();
    this.subscriptions.delete(leaf);
    const pending = this.pending.get(leaf);
    if (pending !== undefined && pending.timer !== null) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(leaf);
    this.clearCurrentSection(leaf);
  }

  private clearCurrentSection(leaf: WorkspaceLeaf): void {
    const current = this.currentSection.get(leaf);
    if (current === undefined) return;
    const editor = current.editor.deref();
    if (editor !== undefined) {
      this.setCurrentSection(editor, null);
      this.deps.focusMode?.reset(editor);
    }
    this.currentSection.delete(leaf);
  }

  private applyCurrentSection(
    pairing: ReaderPairing,
    leaf: WorkspaceLeaf,
    editor: ScrollEditor,
    section: BookNoteSection,
    key: string,
  ): void {
    const previousEditor = this.currentSection.get(leaf)?.editor.deref();
    if (previousEditor !== undefined && previousEditor !== editor) {
      this.setCurrentSection(previousEditor, null);
    }
    this.setCurrentSection(editor, section);
    if (this.deps.focusMode !== undefined) {
      this.deps.focusMode.setSections(editor, pairing.bookNote.sections);
      this.deps.focusMode.setCurrentSection(editor, section);
    }
    this.currentSection.set(leaf, { key, editor: new WeakRef(editor) });
  }

  private setCurrentSection(
    editor: ScrollEditor,
    section: BookNoteSection | null,
  ): void {
    const setCurrent = this.deps.setCurrentSection ?? setCurrentSectionDecoration;
    setCurrent(editor, section);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/** The section with greatest position <= current, independent of file order. */
export function findSectionAtPosition(
  sections: readonly BookNoteSection[],
  current: AnchorPosition,
): BookNoteSection | undefined {
  let found: BookNoteSection | undefined;
  for (const section of sections) {
    if (comparePositions(section.position, current) > 0) continue;
    if (
      found === undefined ||
      comparePositions(found.position, section.position) < 0
    ) {
      found = section;
    }
  }
  return found;
}

/**
 * Put a heading near the top without moving selection or focus.
 *
 * Obsidian's CM6-backed editor exposes its EditorView as `cm`; narrow that
 * runtime seam before using the richer start-alignment/margin effect. The
 * public Editor API remains the compatibility fallback.
 */
export function scrollHeadingIntoView(
  editor: ScrollEditor,
  headingLine: number,
): void {
  const cm = codeMirrorView(editor);
  const lineCount = cm?.state.doc.lines ?? editor.lineCount();
  const resolvedLine = Math.min(
    Math.max(headingLine, 0),
    Math.max(lineCount - 1, 0),
  );
  if (cm !== null) {
    const position = cm.state.doc.line(resolvedLine + 1).from;
    cm.dispatch({
      effects: EditorView.scrollIntoView(position, {
        y: "start",
        yMargin: SCROLL_MARGIN_PX,
      }),
    });
    return;
  }
  const point = { line: resolvedLine, ch: 0 };
  editor.scrollIntoView({ from: point, to: point }, false);
}
