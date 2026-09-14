// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { TFile, WorkspaceLeaf } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BookNote, BookNoteSection } from "../model/bookNote";
import { parseFragment } from "../model/anchor";
import { FocusModeController } from "./focusMode";
import { parseBookNote } from "../model/bookNote";
import {
  focusModeViewPlugin,
  isFocusModeDecorationEnabled,
} from "./focusModeDecoration";
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
const FOCUS_NOTE = [
  "preamble",
  "## Chapter one",
  "first paragraph",
  "## Chapter two",
  "second paragraph",
].join("\n");

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
  const note = bookNote([section(9, CFI_2), section(6, CFI_1)]);
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
    const setBookNote = vi.spyOn(focusMode, "setBookNote");
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

      expect(setBookNote).toHaveBeenCalledWith(
        editor,
        rig.pairing?.bookNote,
      );
      expect(cm.dom.querySelectorAll(".oc-focus-fold")).toHaveLength(0);
    } finally {
      cm.destroy();
    }
  });

  it("passes the paired sections and resolved section to focus mode", () => {
    vi.useFakeTimers();
    const focusMode = new FocusModeController();
    const setBookNote = vi.spyOn(focusMode, "setBookNote");
    const setCurrentSection = vi.spyOn(focusMode, "setCurrentSection");
    const rig = makeRig({ focusMode });

    rig.reader.emit(CFI_1);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

    expect(setBookNote).toHaveBeenCalledWith(
      rig.editor,
      rig.pairing?.bookNote,
    );
    expect(setCurrentSection).toHaveBeenCalledWith(
      rig.editor,
      expect.objectContaining({ headingLine: 6 }),
    );
  });

  it("disables focus mode decoration when the pairing is lost mid-session", () => {
    vi.useFakeTimers();
    const focusMode = new FocusModeController();
    const rig = makeRig({ focusMode });
    const { editor, view } = focusEditor();
    rig.currentEditor = editor;

    try {
      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      focusMode.toggle(
        editor,
        rig.pairing?.bookNote ?? null,
        rig.sync.getCurrentSection(editor),
      );
      expect(isFocusModeDecorationEnabled(editor)).toBe(true);

      rig.pairing = undefined;
      rig.reader.emit(CFI_2);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

      expect(isFocusModeDecorationEnabled(editor)).toBe(false);
      expect(view.state.doc.toString()).toBe(FOCUS_NOTE);
    } finally {
      view.destroy();
    }
  });

  it("re-folds without another press after paging before the first anchor", () => {
    vi.useFakeTimers();
    const focusMode = new FocusModeController();
    const rig = makeRig({ focusMode });
    const sections = [section(1, CFI_1, 0), section(3, CFI_2, 1)];
    rig.pairing = pairing(
      rig.leaf,
      rig.reader,
      rig.bookFile,
      bookNote(sections),
    );
    const { editor, view } = focusEditor();
    rig.currentEditor = editor;

    try {
      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      focusMode.toggle(
        editor,
        bookNote(sections),
        rig.sync.getCurrentSection(editor),
      );
      const widgetSequence = [focusWidgetCount(view)];

      rig.reader.emit("/6/4!/4/2/1:0");
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      widgetSequence.push(focusWidgetCount(view));

      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      widgetSequence.push(focusWidgetCount(view));

      expect(widgetSequence).toEqual([1, 0, 1]);
      expect(view.state.doc.toString()).toBe(FOCUS_NOTE);
    } finally {
      view.destroy();
    }
  });

  it("waits for fresh sections before re-folding after a new-note-here insertion", () => {
    vi.useFakeTimers();
    const focusMode = new FocusModeController();
    const rig = makeRig({ focusMode });
    const staleSections = [
      sectionRange(0, 2, CFI_1, 0),
      sectionRange(3, 5, CFI_2, 1),
    ];
    rig.pairing = pairing(
      rig.leaf,
      rig.reader,
      rig.bookFile,
      bookNote(staleSections),
    );
    const initialNote = [
      "## [[Books/Book.epub#epubcfi(/6/8!/4/2/1:0)|Current]]",
      "current note",
      "",
      "## [[Books/Book.epub#epubcfi(/6/14!/4/2/1:0)|Late]]",
      "late note one",
      "late note two",
    ].join("\n");
    const insertedNote = [
      "## [[Books/Book.epub#epubcfi(/6/8!/4/2/1:0)|Current]]",
      "current note",
      "",
      "## [[Books/Book.epub#epubcfi(/6/10!/4/2/1:0)|New note here]]",
      "new note",
      "## [[Books/Book.epub#epubcfi(/6/14!/4/2/1:0)|Late]]",
      "late note one",
      "late note two",
    ].join("\n");
    const { editor, view } = focusEditor(initialNote);
    rig.currentEditor = editor;

    try {
      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      focusMode.toggle(
        editor,
        bookNote(staleSections, initialNote),
        rig.sync.getCurrentSection(editor),
      );
      expect(focusWidgetCount(view)).toBe(1);

      editor.setValue(insertedNote);
      expect(focusWidgetCount(view)).toBe(0);

      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

      expect(view.dom.querySelectorAll(".oc-focus-fold")).toHaveLength(0);
      expect(view.state.doc.toString()).toBe(insertedNote);

      const freshSections = [
        sectionRange(0, 2, CFI_1, 0),
        sectionRange(3, 4, CFI_BETWEEN, 0),
        sectionRange(5, 7, CFI_2, 1),
      ];
      rig.pairing = pairing(
        rig.leaf,
        rig.reader,
        rig.bookFile,
        bookNote(freshSections, insertedNote),
      );
      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

      expect(
        [...view.dom.querySelectorAll<HTMLElement>(".oc-focus-fold")].map(
          (widget) => widget.textContent,
        ),
      ).toEqual(["1 section in other chapters folded"]);
      expect(view.state.doc.toString()).toBe(insertedNote);
    } finally {
      view.destroy();
    }
  });

  it("rejects a pre-insertion parse first delivered after the insertion", () => {
    vi.useFakeTimers();
    const focusMode = new FocusModeController();
    const rig = makeRig({ focusMode });
    const firstParse = [
      sectionRange(0, 2, CFI_1, 0),
      sectionRange(3, 5, CFI_2, 1),
    ];
    const secondSameTextParse = [
      sectionRange(0, 2, CFI_1, 0),
      sectionRange(3, 5, CFI_2, 1),
    ];
    const initialNote = [
      "## [[Books/Book.epub#epubcfi(/6/8!/4/2/1:0)|Current]]",
      "current note",
      "",
      "## [[Books/Book.epub#epubcfi(/6/14!/4/2/1:0)|Late]]",
      "late note one",
      "late note two",
    ].join("\n");
    const insertedNote = [
      "## [[Books/Book.epub#epubcfi(/6/8!/4/2/1:0)|Current]]",
      "current note",
      "",
      "## [[Books/Book.epub#epubcfi(/6/10!/4/2/1:0)|New note here]]",
      "new note",
      "## [[Books/Book.epub#epubcfi(/6/14!/4/2/1:0)|Late]]",
      "late note one",
      "late note two",
    ].join("\n");
    const { editor, view } = focusEditor(initialNote);
    rig.currentEditor = editor;
    rig.pairing = pairing(
      rig.leaf,
      rig.reader,
      rig.bookFile,
      bookNote(firstParse, initialNote),
    );

    try {
      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      focusMode.toggle(
        editor,
        bookNote(firstParse, initialNote),
        rig.sync.getCurrentSection(editor),
      );
      expect(focusWidgetCount(view)).toBe(1);

      rig.pairing = pairing(
        rig.leaf,
        rig.reader,
        rig.bookFile,
        bookNote(secondSameTextParse, initialNote),
      );
      editor.setValue(insertedNote);
      expect(focusWidgetCount(view)).toBe(0);

      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

      expect(focusWidgetCount(view)).toBe(0);
      expect(view.state.doc.toString()).toBe(insertedNote);
    } finally {
      view.destroy();
    }
  });

  it("rejects stale sections when focus mode is toggled after an insertion", () => {
    const focusMode = new FocusModeController();
    const staleSections = [
      sectionRange(0, 2, CFI_1, 0),
      sectionRange(3, 5, CFI_2, 1),
    ];
    const initialNote = [
      "## [[Books/Book.epub#epubcfi(/6/8!/4/2/1:0)|Current]]",
      "current note",
      "",
      "## [[Books/Book.epub#epubcfi(/6/14!/4/2/1:0)|Late]]",
      "late note one",
      "late note two",
    ].join("\n");
    const insertedNote = [
      ...initialNote.split("\n").slice(0, 3),
      "## New note here",
      "new note",
      ...initialNote.split("\n").slice(3),
    ].join("\n");
    const { editor, view } = focusEditor(initialNote);

    try {
      editor.setValue(insertedNote);
      focusMode.toggle(
        editor,
        bookNote(staleSections, initialNote),
        staleSections[0] ?? null,
      );

      expect(focusWidgetCount(view)).toBe(0);
      expect(view.state.doc.toString()).toBe(insertedNote);
    } finally {
      view.destroy();
    }
  });

  it("folds from a current parse without changing the live document", () => {
    const focusMode = new FocusModeController();
    const currentNote = [
      "## [[Books/Book.epub#epubcfi(/6/8!/4/2/1:0)|Current]]",
      "current note",
      "",
      "## [[Books/Book.epub#epubcfi(/6/10!/4/2/1:0)|New note here]]",
      "new note",
      "## [[Books/Book.epub#epubcfi(/6/14!/4/2/1:0)|Late]]",
      "late note one",
      "late note two",
    ].join("\n");
    const currentSections = [
      sectionRange(0, 2, CFI_1, 0),
      sectionRange(3, 4, CFI_BETWEEN, 0),
      sectionRange(5, 7, CFI_2, 1),
    ];
    const { editor, view } = focusEditor(currentNote);

    try {
      focusMode.toggle(
        editor,
        bookNote(currentSections, currentNote),
        currentSections[0] ?? null,
      );

      expect(
        [...view.dom.querySelectorAll<HTMLElement>(".oc-focus-fold")].map(
          (widget) => widget.textContent,
        ),
      ).toEqual(["1 section in other chapters folded"]);
      expect(view.state.doc.toString()).toBe(currentNote);
    } finally {
      view.destroy();
    }
  });

  it("clears focus state from a displaced editor before seeding its replacement", () => {
    vi.useFakeTimers();
    const focusMode = new FocusModeController();
    const rig = makeRig({ focusMode });
    const sections = [section(1, CFI_1, 0), section(3, CFI_2, 1)];
    rig.pairing = pairing(
      rig.leaf,
      rig.reader,
      rig.bookFile,
      bookNote(sections),
    );
    const first = focusEditor();
    const second = focusEditor();
    rig.currentEditor = first.editor;

    try {
      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      focusMode.toggle(
        first.editor,
        bookNote(sections),
        rig.sync.getCurrentSection(first.editor),
      );
      expect(focusWidgetCounts(first.view, second.view)).toEqual([1, 0]);

      rig.currentEditor = second.editor;
      rig.reader.emit(CFI_2);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      expect(focusWidgetCounts(first.view, second.view)).toEqual([0, 1]);
      expect(first.view.state.doc.toString()).toBe(FOCUS_NOTE);
      expect(second.view.state.doc.toString()).toBe(FOCUS_NOTE);
    } finally {
      first.view.destroy();
      second.view.destroy();
    }
  });

  it("preserves focus mode when an unmatched location precedes editor displacement", () => {
    vi.useFakeTimers();
    const focusMode = new FocusModeController();
    const rig = makeRig({ focusMode });
    const sections = [section(1, CFI_1, 0), section(3, CFI_2, 1)];
    rig.pairing = pairing(
      rig.leaf,
      rig.reader,
      rig.bookFile,
      bookNote(sections),
    );
    const first = focusEditor();
    const second = focusEditor();
    rig.currentEditor = first.editor;

    try {
      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      focusMode.toggle(
        first.editor,
        bookNote(sections),
        rig.sync.getCurrentSection(first.editor),
      );

      rig.reader.emit("/6/4!/4/2/1:0");
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      rig.currentEditor = second.editor;
      rig.reader.emit(CFI_2);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

      expect(isFocusModeDecorationEnabled(second.editor)).toBe(true);
    } finally {
      first.view.destroy();
      second.view.destroy();
    }
  });

  it("turns focus mode off on reader close after an unmatched location", () => {
    vi.useFakeTimers();
    const focusMode = new FocusModeController();
    const rig = makeRig({ focusMode });
    const { editor, view } = focusEditor();
    rig.currentEditor = editor;

    try {
      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      focusMode.toggle(
        editor,
        rig.pairing?.bookNote ?? null,
        rig.sync.getCurrentSection(editor),
      );
      rig.reader.emit("/6/4!/4/2/1:0");
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

      rig.leafOpen = false;
      rig.sync.refresh();

      expect(isFocusModeDecorationEnabled(editor)).toBe(false);
      expect(rig.sync.getCurrentSection(editor)).toBeNull();
    } finally {
      view.destroy();
    }
  });

  it("starts re-registered reader leaves without stale editor carry-over", () => {
    vi.useFakeTimers();
    const rig = makeRig();

    rig.reader.emit(CFI_1);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
    rig.leafOpen = false;
    rig.sync.refresh();

    const firstEditor = rig.editor;
    rig.setCurrentSection.mockClear();
    rig.currentEditor = {
      lineCount: () => 20,
      scrollIntoView: vi.fn(),
    };
    rig.leafOpen = true;
    rig.sync.register(rig.leaf, rig.reader);
    rig.reader.emit(CFI_2);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

    expect(rig.setCurrentSection).not.toHaveBeenCalledWith(firstEditor, null);
  });

  it("keeps an already-enabled replacement editor focused during displacement", () => {
    vi.useFakeTimers();
    const focusMode = new FocusModeController();
    const rig = makeRig({ focusMode });
    const sections = [section(1, CFI_1, 0), section(3, CFI_2, 1)];
    rig.pairing = pairing(
      rig.leaf,
      rig.reader,
      rig.bookFile,
      bookNote(sections),
    );
    const first = focusEditor();
    const second = focusEditor();
    rig.currentEditor = first.editor;

    try {
      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      focusMode.toggle(
        first.editor,
        bookNote(sections),
        rig.sync.getCurrentSection(first.editor),
      );
      focusMode.toggle(second.editor, bookNote(sections), sections[0] ?? null);
      expect(isFocusModeDecorationEnabled(second.editor)).toBe(true);

      rig.currentEditor = second.editor;
      rig.reader.emit(CFI_2);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

      expect(isFocusModeDecorationEnabled(second.editor)).toBe(true);
    } finally {
      first.view.destroy();
      second.view.destroy();
    }
  });

  it("does not enable focus mode on displacement when it was never toggled on", () => {
    vi.useFakeTimers();
    const focusMode = new FocusModeController();
    const rig = makeRig({ focusMode });
    const sections = [section(1, CFI_1, 0), section(3, CFI_2, 1)];
    rig.pairing = pairing(
      rig.leaf,
      rig.reader,
      rig.bookFile,
      bookNote(sections),
    );
    const first = focusEditor();
    const second = focusEditor();
    rig.currentEditor = first.editor;

    try {
      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

      rig.currentEditor = second.editor;
      rig.reader.emit(CFI_2);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

      expect(isFocusModeDecorationEnabled(second.editor)).toBe(false);
      expect(focusWidgetCount(second.view)).toBe(0);
    } finally {
      first.view.destroy();
      second.view.destroy();
    }
  });
  it("reports focus mode disabled for a ScrollEditor with no live CM6 view (F3a: non-CM6 guard)", () => {
    const editor = { lineCount: () => 10, scrollIntoView: vi.fn() } as unknown as ScrollEditor;
    expect(isFocusModeDecorationEnabled(editor)).toBe(false);
  });

  it("does not enable focus mode on displacement from a no-cm editor (F3b: non-CM6 guard)", () => {
    vi.useFakeTimers();
    const focusMode = new FocusModeController();
    const rig = makeRig({ focusMode });
    const sections = [section(1, CFI_1, 0), section(3, CFI_2, 1)];
    rig.pairing = pairing(
      rig.leaf,
      rig.reader,
      rig.bookFile,
      bookNote(sections),
    );
    const noCmEditor = {
      lineCount: () => 20,
      scrollIntoView: vi.fn(),
    } as unknown as ScrollEditor;
    rig.currentEditor = noCmEditor;

    const secondCm = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        doc: FOCUS_NOTE,
        extensions: [focusModeViewPlugin],
      }),
    });
    const secondEditor = {
      cm: secondCm,
      lineCount: () => secondCm.state.doc.lines,
      scrollIntoView: vi.fn(),
    };

    try {
      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

      rig.currentEditor = secondEditor;
      rig.reader.emit(CFI_2);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);

      expect(isFocusModeDecorationEnabled(secondEditor)).toBe(false);
      expect(focusWidgetCount(secondCm)).toBe(0);
    } finally {
      secondCm.destroy();
    }
  });


  it("resets focus mode on a displaced editor when a replacement editor appears", async () => {
    vi.useFakeTimers();
    const focusMode = new FocusModeController();
    const rig = makeRig({ focusMode });
    const note = Array.from(
      { length: 12 },
      (_, line) => `line ${line + 1}`,
    ).join("\n");
    const sections = (rig.pairing?.bookNote.sections ?? []).map((section) => ({
      ...section,
      chapter: section.headingLine === 9 ? 1 : 0,
    }));
    rig.pairing = pairing(
      rig.leaf,
      rig.reader,
      rig.bookFile,
      bookNote(sections),
    );
    const firstCm = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        doc: note,
        extensions: [focusModeViewPlugin],
      }),
    });
    const firstEditor = createFocusEditor(firstCm);
    const secondCm = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        doc: note,
        extensions: [focusModeViewPlugin],
      }),
    });
    const secondEditor = createFocusEditor(secondCm);
    rig.currentEditor = firstEditor;
    firstCm.requestMeasure();
    secondCm.requestMeasure();
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.useFakeTimers();

    try {
      focusMode.toggle(
        firstEditor,
        bookNote(sections, note),
        sections[0] ?? null,
      );
      expect(isFocusModeDecorationEnabled(firstEditor)).toBe(true);
      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      firstCm.requestMeasure();
      vi.advanceTimersByTime(0);
      const firstBeforeSwap =
        firstCm.dom.querySelectorAll(".oc-focus-fold").length;

      rig.currentEditor = secondEditor;
      rig.reader.emit(CFI_2);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      firstCm.requestMeasure();
      secondCm.requestMeasure();
      vi.advanceTimersByTime(0);
      secondCm.requestMeasure();
      vi.advanceTimersByTime(0);
      const firstAfterSwap =
        firstCm.dom.querySelectorAll(".oc-focus-fold").length;
      const secondAfterSwap = isFocusModeDecorationEnabled(secondEditor)
        ? 1
        : 0;

      expect({ firstBeforeSwap, firstAfterSwap, secondAfterSwap }).toEqual({
        firstBeforeSwap: 1,
        firstAfterSwap: 0,
        secondAfterSwap: 1,
      });
      expect(firstCm.state.doc.toString()).toBe(note);
      expect(secondCm.state.doc.toString()).toBe(note);
    } finally {
      firstCm.destroy();
      secondCm.destroy();
    }
  });

  it("never edits the note across toggles, an edit, leaf close, and unload", () => {
    vi.useFakeTimers();
    const focusMode = new FocusModeController();
    const rig = makeRig({ focusMode });
    const sections = [section(1, CFI_1, 0), section(3, CFI_2, 1)];
    rig.pairing = pairing(
      rig.leaf,
      rig.reader,
      rig.bookFile,
      bookNote(sections),
    );
    const { editor, view } = focusEditor();
    rig.currentEditor = editor;

    try {
      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      focusMode.toggle(
        editor,
        bookNote(sections),
        rig.sync.getCurrentSection(editor),
      );
      expect(view.state.doc.toString()).toBe(FOCUS_NOTE);

      focusMode.toggle(
        editor,
        bookNote(sections),
        rig.sync.getCurrentSection(editor),
      );
      focusMode.toggle(
        editor,
        bookNote(sections),
        rig.sync.getCurrentSection(editor),
      );
      expect(view.state.doc.toString()).toBe(FOCUS_NOTE);

      view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } });
      const editedNote = `${FOCUS_NOTE}!`;
      expect(view.state.doc.toString()).toBe(editedNote);
      const reparsedSections = sections.map((section) => ({
        ...section,
        bodyRange: { ...section.bodyRange },
      }));
      rig.pairing = pairing(
        rig.leaf,
        rig.reader,
        rig.bookFile,
        bookNote(reparsedSections, editedNote),
      );
      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      expect(focusWidgetCount(view)).toBe(1);
      expect(view.state.doc.toString()).toBe(editedNote);

      rig.leafOpen = false;
      rig.sync.refresh();
      expect(focusWidgetCount(view)).toBe(0);
      expect(view.state.doc.toString()).toBe(editedNote);

      rig.leafOpen = true;
      rig.sync.register(rig.leaf, rig.reader);
      rig.reader.emit(CFI_1);
      vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
      focusMode.toggle(
        editor,
        rig.pairing?.bookNote ?? null,
        rig.sync.getCurrentSection(editor),
      );
      expect(focusWidgetCount(view)).toBe(1);

      rig.sync.clear();
      expect(focusWidgetCount(view)).toBe(0);
      expect(view.state.doc.toString()).toBe(editedNote);
    } finally {
      view.destroy();
    }
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
  it("re-scrolls after a no-match location clears the cached section", () => {
    vi.useFakeTimers();
    const rig = makeRig();

    rig.reader.emit(CFI_1);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
    expect(rig.scrollIntoView).toHaveBeenCalledOnce();
    expect(rig.sync.getCurrentSection(rig.editor)).not.toBeNull();

    rig.reader.emit("/6/4!/4/2/1:0");
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
    expect(rig.scrollIntoView).toHaveBeenCalledOnce();
    expect(rig.sync.getCurrentSection(rig.editor)).toBeNull();
    expect(rig.setCurrentSection).toHaveBeenCalledWith(rig.editor, null);

    rig.reader.emit(CFI_1);
    vi.advanceTimersByTime(DEFAULT_SCROLL_DEBOUNCE_MS);
    expect(rig.scrollIntoView).toHaveBeenCalledTimes(2);
    expect(rig.sync.getCurrentSection(rig.editor)).not.toBeNull();
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

  it("folds from a current CRLF parse (LOCO-924)", () => {
    const focusMode = new FocusModeController();
    const fm = ["---", 'source: "[[Books/Book.epub]]"', "format: epub", "---"];
    const body = [
      "## [[Books/Book.epub#epubcfi(/6/8!/4/2/1:0)|Current]]",
      "current note",
      "",
      "## [[Books/Book.epub#epubcfi(/6/10!/4/2/1:0)|New note here]]",
      "new note",
      "## [[Books/Book.epub#epubcfi(/6/14!/4/2/1:0)|Late]]",
      "late note one",
      "late note two",
    ];
    const currentNote = [...fm, ...body].join("\n");
    const crlfNote = [...fm, ...body].join("\r\n");
    const { editor, view } = focusEditor(currentNote);
    const crlfParse = parseBookNote(crlfNote);

    try {
      focusMode.toggle(editor, crlfParse, crlfParse.sections[0] ?? null);

      expect(
        [...view.dom.querySelectorAll<HTMLElement>(".oc-focus-fold")].map(
          (widget) => widget.textContent,
        ),
      ).toEqual(["2 sections in other chapters folded"]);
      expect(view.state.doc.toString()).toBe(currentNote);
    } finally {
      view.destroy();
    }
  });

  it("folds from a current lone-CR parse (LOCO-936)", () => {
    const focusMode = new FocusModeController();
    const fm = ["---", 'source: "[[Books/Book.epub]]"', "format: epub", "---"];
    const body = [
      "## [[Books/Book.epub#epubcfi(/6/8!/4/2/1:0)|Current]]",
      "current\nnote",
      "",
      "## [[Books/Book.epub#epubcfi(/6/10!/4/2/1:0)|New note here]]",
      "new note",
      "## [[Books/Book.epub#epubcfi(/6/14!/4/2/1:0)|Late]]",
      "late note one",
      "late note two",
    ];
    const currentNote = [...fm, ...body].join("\n");
    const loneCrNote = [...fm, ...body].join("\n");
    const { editor, view } = focusEditor(currentNote);
    const loneCrParse = parseBookNote(loneCrNote);

    try {
      focusMode.toggle(editor, loneCrParse, loneCrParse.sections[0] ?? null);

      expect(
        [...view.dom.querySelectorAll<HTMLElement>(".oc-focus-fold")].map(
          (widget) => widget.textContent,
        ),
      ).toEqual(["2 sections in other chapters folded"]);
      expect(view.state.doc.toString()).toBe(currentNote);
    } finally {
      view.destroy();
    }
  });

  it("rejects a stale CRLF parse after an insertion (LOCO-924)", () => {
    const focusMode = new FocusModeController();
    const fm = ["---", 'source: "[[Books/Book.epub]]"', "format: epub", "---"];
    const preBody = [
      "## [[Books/Book.epub#epubcfi(/6/8!/4/2/1:0)|Current]]",
      "current note",
      "",
      "## [[Books/Book.epub#epubcfi(/6/14!/4/2/1:0)|Late]]",
      "late note one",
      "late note two",
    ];
    const postBody = [
      "## [[Books/Book.epub#epubcfi(/6/8!/4/2/1:0)|Current]]",
      "current note",
      "",
      "## [[Books/Book.epub#epubcfi(/6/10!/4/2/1:0)|New note here]]",
      "new note",
      "## [[Books/Book.epub#epubcfi(/6/14!/4/2/1:0)|Late]]",
      "late note one",
      "late note two",
    ];
    const preEditNote = [...fm, ...preBody].join("\r\n");
    const postEditNote = [...fm, ...postBody].join("\n");
    const { editor, view } = focusEditor(postEditNote);
    const staleParse = parseBookNote(preEditNote);

    try {
      expect(view.state.doc.length).not.toBe(staleParse.sourceText.length);
      focusMode.toggle(editor, staleParse, staleParse.sections[0] ?? null);

      expect(focusWidgetCount(view)).toBe(0);
      expect(view.state.doc.toString()).toBe(postEditNote);
    } finally {
      view.destroy();
    }
  });
});

function focusEditor(doc = FOCUS_NOTE): {
  readonly editor: ScrollEditor & {
    readonly cm: EditorView;
    setValue(value: string): void;
  };
  readonly view: EditorView;
} {
  if (Range.prototype.getClientRects === undefined) {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  }
  if (Range.prototype.getBoundingClientRect === undefined) {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    });
  }
  const view = new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      doc,
      extensions: [focusModeViewPlugin],
    }),
  });
  return {
    editor: {
      cm: view,
      lineCount: () => view.state.doc.lines,
      scrollIntoView: vi.fn(),
      setValue: (value: string) => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: value },
        });
      },
    },
    view,
  };
}

function focusWidgetCount(view: EditorView): number {
  return view.dom.querySelectorAll(".oc-focus-fold").length;
}

function focusWidgetCounts(...views: readonly EditorView[]): number[] {
  return views.map(focusWidgetCount);
}

function section(
  headingLine: number,
  cfi: string,
  chapter = 0,
): BookNoteSection {
  return {
    headingLine,
    bodyRange: { start: headingLine, end: headingLine + 2 },
    fragment: `epubcfi(${cfi})`,
    position: parseFragment(`#epubcfi(${cfi})`),
    chapter,
  };
}

function sectionRange(
  headingLine: number,
  endLine: number,
  cfi: string,
  chapter: number,
): BookNoteSection {
  return {
    ...section(headingLine, cfi, chapter),
    bodyRange: { start: headingLine, end: endLine },
  };
}

function bookNote(
  sections: readonly BookNoteSection[],
  sourceText = FOCUS_NOTE,
): BookNote {
  return {
    sourceText,
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

function createFocusEditor(cm: EditorView): ScrollEditor & {
  readonly cm: EditorView;
} {
  return {
    cm,
    lineCount: () => cm.state.doc.lines,
    scrollIntoView: vi.fn(),
  };
}
