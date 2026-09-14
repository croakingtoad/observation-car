// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { TFile, WorkspaceLeaf } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BookNote, BookNoteSection } from "../model/bookNote";
import { parseFragment } from "../model/anchor";
import { FocusModeController } from "./focusMode";
import { focusModeViewPlugin } from "./focusModeDecoration";
import { DEFAULT_LOCATION_DEBOUNCE_MS } from "../readers/epubLocation";
import type { Reader, ReaderPairing } from "./ReaderRegistry";
import {
  DEFAULT_SCROLL_DEBOUNCE_MS,
  DEFAULT_TYPING_IDLE_MS,
  ScrollSync,
  findSectionAtPosition,
  scrollHeadingIntoView,
  type LocationChanged,
  type LocationReader,
  type ScrollEditor,
} from "./scrollSync";

const BOOK_PATH = "Books/Book.epub";
const NOTE_PATH = "Reading/Book.md";
const CFI_1 = "/6/8!/4/2/1:0";
const CFI_BETWEEN = "/6/10!/4/2/1:0";
const CFI_2 = "/6/14!/4/2/1:0";

class TestReader implements LocationReader {
  readonly file: TFile;
  private readonly listeners = new Set<(location: LocationChanged) => void>();

  constructor(file: TFile) {
    this.file = file;
  }

  getViewType(): string {
    return "test-reader";
  }

  on(
    _event: "location",
    listener: (location: LocationChanged) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(cfi: string): void {
    const location: LocationChanged = {
      file: this.file,
      fragment: `#epubcfi(${cfi})`,
      chapter: 0,
      label: "Chapter",
    };
    for (const listener of [...this.listeners]) listener(location);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

interface Rig {
  readonly sync: ScrollSync;
  readonly bookFile: TFile;
  readonly leaf: WorkspaceLeaf;
  readonly reader: TestReader;
  readonly scrollIntoView: ReturnType<typeof vi.fn>;
  readonly focus: ReturnType<typeof vi.fn>;
  readonly editor: ScrollEditor;
  readonly setCurrentSection: ReturnType<typeof vi.fn>;
  currentEditor: ScrollEditor;
  pairing: ReaderPairing | undefined;
  editorOpen: boolean;
  leafOpen: boolean;
}

function makeRig(
  overrides: Partial<ConstructorParameters<typeof ScrollSync>[0]> = {},
): Rig {
  const bookFile = file(BOOK_PATH);
  const note = bookNote([
    section(9, CFI_2),
    section(6, CFI_1),
  ]);
  const leaf = {} as WorkspaceLeaf;
  const reader = new TestReader(bookFile);
  const scrollIntoView = vi.fn();
  const focus = vi.fn();
  const editor = {
    lineCount: () => 20,
    scrollIntoView,
    focus,
  } as unknown as ScrollEditor;
  const setCurrentSection = vi.fn();
  const rig = {
    sync: null as unknown as ScrollSync,
    bookFile,
    leaf,
    reader,
    scrollIntoView,
    focus,
    editor,
    setCurrentSection,
    currentEditor: editor,
    pairing: pairing(leaf, reader, bookFile, note),
    editorOpen: true,
    leafOpen: true,
  };
  rig.sync = new ScrollSync({
    getPairing: () => rig.pairing,
    findEditor: () => (rig.editorOpen ? rig.currentEditor : null),
    isLeafOpen: () => rig.leafOpen,
    setCurrentSection,
    ...overrides,
  });
  rig.sync.register(leaf, reader);
  return rig;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("findSectionAtPosition", () => {
  it("finds the greatest anchor not after the current position in a hand-reordered note", () => {
    const sections = [section(9, CFI_2), section(6, CFI_1)];

    expect(
      findSectionAtPosition(sections, parseFragment(`#epubcfi(${CFI_BETWEEN})`))
        ?.headingLine,
    ).toBe(6);
    expect(
      findSectionAtPosition(sections, parseFragment(`#epubcfi(${CFI_2})`))
        ?.headingLine,
    ).toBe(9);
  });

  it("returns no section before the first anchor", () => {
    expect(
      findSectionAtPosition(
        [section(6, CFI_1)],
        parseFragment("#epubcfi(/6/4!/4/2/1:0)"),
      ),
    ).toBeUndefined();
  });
});

describe("ScrollSync", () => {
  it("keeps the reader and sync debounces inside the 200 ms latency budget", () => {
    expect(
      DEFAULT_LOCATION_DEBOUNCE_MS + DEFAULT_SCROLL_DEBOUNCE_MS,
    ).toBeLessThanOrEqual(200);
  });

  it("coalesces locations and scrolls the newest relevant heading within 25 ms", () => {
    vi.useFakeTimers();
    const rig = makeRig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    rig.reader.emit(CFI_1);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS - 10);
    rig.reader.emit(CFI_2);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS - 1);
    expect(rig.scrollIntoView).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(rig.scrollIntoView).toHaveBeenCalledOnce();
    expect(rig.scrollIntoView).toHaveBeenCalledWith(
      {
        from: { line: 9, ch: 0 },
        to: { line: 9, ch: 0 },
      },
      false,
    );
    expect(rig.focus).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not move again while later pages still resolve to the same section", () => {
    vi.useFakeTimers();
    const rig = makeRig();

    rig.reader.emit(CFI_1);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
    rig.reader.emit(CFI_BETWEEN);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

    expect(rig.scrollIntoView).toHaveBeenCalledOnce();
    expect(rig.setCurrentSection).toHaveBeenCalledTimes(2);
  });

  it("highlights the resolved section alongside its scroll", () => {
    vi.useFakeTimers();
    const rig = makeRig();

    rig.reader.emit(CFI_1);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

    expect(rig.setCurrentSection).toHaveBeenCalledOnce();
    expect(rig.setCurrentSection).toHaveBeenCalledWith(
      rig.editor,
      expect.objectContaining({ headingLine: 6 }),
    );
  });

  it("clears the displaced editor when a different section resolves in a replacement editor", () => {
    vi.useFakeTimers();
    const rig = makeRig();

    rig.reader.emit(CFI_1);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

    const firstEditor = rig.currentEditor;
    rig.currentEditor = {
      lineCount: () => 20,
      scrollIntoView: vi.fn(),
    };
    rig.reader.emit(CFI_2);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

    expect(rig.setCurrentSection).toHaveBeenCalledWith(firstEditor, null);
  });

  it("turns focus mode off when the reader leaf closes", () => {
    vi.useFakeTimers();
    const focusMode = new FocusModeController();
    const reset = vi.spyOn(focusMode, "reset");
    const rig = makeRig({ focusMode });

    rig.reader.emit(CFI_1);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

    rig.leafOpen = false;
    rig.sync.refresh();

    expect(reset).toHaveBeenCalledWith(rig.editor);
    expect(rig.setCurrentSection).toHaveBeenLastCalledWith(rig.editor, null);
  });

  it("exposes the last matching section for focus-mode seeding", () => {
    vi.useFakeTimers();
    const rig = makeRig();

    expect(rig.sync.getCurrentSection(rig.editor)).toBeNull();
    rig.reader.emit(CFI_1);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

    expect(rig.sync.getCurrentSection(rig.editor)).toEqual({
      headingLine: 6,
      bodyRange: { start: 6, end: 8 },
      fragment: `epubcfi(${CFI_1})`,
      position: expect.any(Object),
      chapter: 0,
    });
  });

  it("keeps focus mode inert before the first controller state exists", () => {
    vi.useFakeTimers();
    const focusMode = new FocusModeController();
    const setSections = vi.spyOn(focusMode, "setSections");
    const rig = makeRig({ focusMode });
    const cm = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        doc: "note",
        extensions: [focusModeViewPlugin],
      }),
    });
    const editor: ScrollEditor & { readonly cm: EditorView } = {
      cm,
      lineCount: () => cm.state.doc.lines,
      scrollIntoView: vi.fn(),
    };
    rig.currentEditor = editor;

    try {
      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

      expect(setSections).toHaveBeenCalledWith(
        editor,
        rig.pairing?.bookNote.sections,
      );
      expect(cm.dom.querySelectorAll(".oc-focus-fold")).toHaveLength(0);
    } finally {
      cm.destroy();
    }
  });

  it("passes the paired sections and resolved section to focus mode", () => {
    vi.useFakeTimers();
    const focusMode = new FocusModeController();
    const setSections = vi.spyOn(focusMode, "setSections");
    const setCurrentSection = vi.spyOn(focusMode, "setCurrentSection");
    const rig = makeRig({ focusMode });

    rig.reader.emit(CFI_1);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

    expect(setSections).toHaveBeenCalledWith(
      rig.editor,
      rig.pairing?.bookNote.sections,
    );
    expect(setCurrentSection).toHaveBeenCalledWith(
      rig.editor,
      expect.objectContaining({ headingLine: 6 }),
    );
  });

  it("does not move before the first anchor, then scrolls when the first anchor is reached", () => {
    vi.useFakeTimers();
    const rig = makeRig();

    rig.reader.emit("/6/4!/4/2/1:0");
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
    expect(rig.scrollIntoView).not.toHaveBeenCalled();

    rig.reader.emit(CFI_1);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
    expect(rig.scrollIntoView).toHaveBeenCalledOnce();
  });

  it("waits for 1.5 seconds of typing idle and resets the threshold on another edit", () => {
    vi.useFakeTimers();
    const rig = makeRig();

    rig.sync.markEditorChanged(rig.editor);
    rig.reader.emit(CFI_1);
    vi.advanceTimersByTime(DEFAULT_TYPING_IDLE_MS - 500);
    expect(rig.scrollIntoView).not.toHaveBeenCalled();

    rig.sync.markEditorChanged(rig.editor);
    vi.advanceTimersByTime(DEFAULT_TYPING_IDLE_MS - 1);
    expect(rig.scrollIntoView).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(rig.scrollIntoView).toHaveBeenCalledOnce();
  });

  it("ignores a location from a reader that no longer owns the pairing", () => {
    vi.useFakeTimers();
    const rig = makeRig();
    const otherReader = new TestReader(rig.bookFile);
    rig.pairing = pairing(rig.leaf, otherReader, rig.bookFile, bookNote([]));

    rig.reader.emit(CFI_1);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

    expect(rig.scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps only one subscription and releases it when the leaf closes", () => {
    const rig = makeRig();

    vi.useFakeTimers();
    rig.reader.emit(CFI_1);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

    rig.sync.register(rig.leaf, rig.reader);
    expect(rig.reader.listenerCount).toBe(1);

    rig.currentEditor = {
      lineCount: () => 20,
      scrollIntoView: vi.fn(),
    };
    rig.leafOpen = false;
    rig.sync.refresh();
    expect(rig.reader.listenerCount).toBe(0);
    expect(rig.setCurrentSection).toHaveBeenLastCalledWith(rig.editor, null);
  });

  it("cancels a deferred scroll and unsubscribes on clear", () => {
    vi.useFakeTimers();
    const rig = makeRig();
    rig.sync.markEditorChanged(rig.editor);
    rig.reader.emit(CFI_1);

    rig.sync.clear();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(DEFAULT_TYPING_IDLE_MS + 100);

    expect(rig.scrollIntoView).not.toHaveBeenCalled();
    expect(rig.reader.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a deferred scroll as soon as its reader leaf closes", () => {
    vi.useFakeTimers();
    const rig = makeRig();
    rig.reader.emit(CFI_1);

    rig.leafOpen = false;
    rig.sync.refresh();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

    expect(rig.scrollIntoView).not.toHaveBeenCalled();
    expect(rig.reader.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("warns for an unparseable location and still syncs the next valid one", () => {
    vi.useFakeTimers();
    const rig = makeRig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    rig.reader.emit("not-a-fragment");
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[observation-car] ignoring unparseable reader location",
      "#epubcfi(not-a-fragment)",
    );
    expect(rig.scrollIntoView).not.toHaveBeenCalled();

    rig.reader.emit(CFI_1);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

    expect(rig.scrollIntoView).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("scrollHeadingIntoView", () => {
  it("uses the public editor API without changing focus when CM6 is unavailable", () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const editor = {
      lineCount: () => 20,
      scrollIntoView,
      focus,
    } as unknown as ScrollEditor;

    scrollHeadingIntoView(editor, 12);

    expect(scrollIntoView).toHaveBeenCalledWith(
      {
        from: { line: 12, ch: 0 },
        to: { line: 12, ch: 0 },
      },
      false,
    );
    expect(focus).not.toHaveBeenCalled();
  });

  it("clamps the same past-EOF heading for the CM6 and fallback paths", () => {
    const effect = EditorView.scrollIntoView(0);
    vi.spyOn(EditorView, "scrollIntoView").mockReturnValue(effect);
    const line = vi.fn(() => ({ from: 40 }));
    const dispatch = vi.fn();
    const cm = Object.create(EditorView.prototype) as EditorView;
    Object.defineProperty(cm, "state", {
      value: { doc: { lines: 5, line } },
    });
    Object.defineProperty(cm, "dispatch", { value: dispatch });
    const cmFallback = vi.fn();
    const cmEditor = {
      cm,
      lineCount: () => 5,
      scrollIntoView: cmFallback,
    } as unknown as ScrollEditor;
    const publicFallback = vi.fn();
    const publicEditor = {
      lineCount: () => 5,
      scrollIntoView: publicFallback,
    } as unknown as ScrollEditor;

    scrollHeadingIntoView(cmEditor, 9);
    scrollHeadingIntoView(publicEditor, 9);

    expect(line).toHaveBeenCalledWith(5);
    expect(dispatch).toHaveBeenCalledWith({ effects: effect });
    expect(cmFallback).not.toHaveBeenCalled();
    expect(publicFallback).toHaveBeenCalledWith(
      {
        from: { line: 4, ch: 0 },
        to: { line: 4, ch: 0 },
      },
      false,
    );
  });

  it("uses CM6 start alignment with a margin without changing focus", () => {
    const effect = EditorView.scrollIntoView(0);
    const effectFactory = vi
      .spyOn(EditorView, "scrollIntoView")
      .mockReturnValue(effect);
    const dispatch = vi.fn();
    const cm = Object.create(EditorView.prototype) as EditorView;
    Object.defineProperty(cm, "state", {
      value: {
        doc: {
          lines: 20,
          line: (number: number) => ({ from: number * 10 }),
        },
      },
    });
    Object.defineProperty(cm, "dispatch", { value: dispatch });
    const fallback = vi.fn();
    const focus = vi.fn();
    const editor = {
      cm,
      lineCount: () => 20,
      scrollIntoView: fallback,
      focus,
    } as unknown as ScrollEditor;

    scrollHeadingIntoView(editor, 7);

    expect(effectFactory).toHaveBeenCalledWith(80, {
      y: "start",
      yMargin: 32,
    });
    expect(dispatch).toHaveBeenCalledWith({ effects: effect });
    expect(fallback).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});

function section(headingLine: number, cfi: string): BookNoteSection {
  return {
    headingLine,
    bodyRange: { start: headingLine, end: headingLine + 2 },
    fragment: `epubcfi(${cfi})`,
    position: parseFragment(`#epubcfi(${cfi})`),
    chapter: 0,
  };
}

function bookNote(sections: readonly BookNoteSection[]): BookNote {
  return {
    frontmatter: {
      data: { source: BOOK_PATH, format: "epub" },
      source: BOOK_PATH,
      format: "epub",
    },
    sections,
    diagnostics: [],
  };
}

function pairing(
  leaf: WorkspaceLeaf,
  reader: Reader,
  bookFile: TFile,
  note: BookNote,
): ReaderPairing {
  return {
    leaf,
    reader,
    bookFile,
    notePath: NOTE_PATH,
    bookNote: note,
  };
}

function file(path: string): TFile {
  return { path } as TFile;
}
