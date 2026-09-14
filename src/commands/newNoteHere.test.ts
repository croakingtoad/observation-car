import { MarkdownView, TFile, type Command, type Editor, type WorkspaceLeaf } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type ObservationCarPlugin from "../main";
import { parseBookNote } from "../model/bookNote";
import type { Reader, ReaderPairing } from "../sync/ReaderRegistry";
import {
  NEW_NOTE_HERE_COMMAND_ID,
  newNoteHereFromReader,
  registerNewNoteHereCommand,
} from "./newNoteHere";

const notices = vi.hoisted((): string[] => []);

vi.mock("obsidian", () => {
  class TFile {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
  }
  class MarkdownView {
    file: InstanceType<typeof TFile> | null;
    editor: unknown;
    constructor(file: InstanceType<typeof TFile> | null, editor: unknown) {
      this.file = file;
      this.editor = editor;
    }
    getViewType(): string {
      return "markdown";
    }
  }
  class Notice {
    constructor(message: string) {
      notices.push(message);
    }
  }
  return { MarkdownView, Notice, TFile };
});

const TFileDouble = TFile as unknown as new (path: string) => TFile;
const MarkdownViewDouble = MarkdownView as unknown as new (
  file: TFile | null,
  editor: Editor,
) => MarkdownView;

interface FakeEditor {
  readonly editor: Editor;
  readonly setValue: ReturnType<typeof vi.fn>;
  readonly setCursor: ReturnType<typeof vi.fn>;
  readonly scrollIntoView: ReturnType<typeof vi.fn>;
  readonly focus: ReturnType<typeof vi.fn>;
  value(): string;
}

interface Harness {
  readonly plugin: ObservationCarPlugin;
  readonly readerLeaf: WorkspaceLeaf;
  readonly noteLeaf: WorkspaceLeaf;
  readonly reader: Reader & {
    getLocation?: () => {
      fragment: string;
      chapter: number | null;
      label: string;
    } | null;
    getSelection?: () => { text: string; fragment: string } | null;
  };
  readonly editor: FakeEditor;
  readonly commands: Command[];
}

const SOURCE = "Books/Test.epub";
const NOTE_PATH = "Reading/Test.md";
const EARLY = "#epubcfi(/6/4!/4/2/1:0)";
const MIDDLE = "#epubcfi(/6/8!/4/2/1:0)";
const LATE = "#epubcfi(/6/14!/4/2/1:0)";

function noteText(level = 2): string {
  const heading = "#".repeat(level);
  return [
    "---",
    "type: book-note",
    `source: "[[${SOURCE}]]"`,
    "format: epub",
    "---",
    "",
    `${heading} [[${SOURCE}${EARLY}|Ch. 1 — early]]`,
    "early body",
    "",
    `${heading} [[${SOURCE}${LATE}|Ch. 6 — late]]`,
    "late body",
    "",
  ].join("\n");
}

function emptyNoteText(): string {
  return '---\ntype: book-note\nsource: "[[Books/Test.epub]]"\nformat: epub\n---';
}

function fakeEditor(initial: string): FakeEditor {
  let value = initial;
  const setValue = vi.fn((next: string) => {
    value = next;
  });
  const setCursor = vi.fn();
  const scrollIntoView = vi.fn();
  const focus = vi.fn();
  const editor = {
    getValue: () => value,
    hasFocus: () => false,
    setValue,
    setCursor,
    scrollIntoView,
    focus,
  } as unknown as Editor;
  return { editor, setValue, setCursor, scrollIntoView, focus, value: () => value };
}

function makeHarness(options: {
  level?: number;
  eol?: "\n" | "\r\n";
  location?: ReturnType<NonNullable<Harness["reader"]["getLocation"]>>;
  selection?: ReturnType<NonNullable<Harness["reader"]["getSelection"]>>;
  hasLocationCapability?: boolean;
  hasSelectionCapability?: boolean;
  noteOpen?: boolean;
  noteMostRecent?: boolean;
  initialText?: string;
} = {}): Harness {
  const level = options.level ?? 2;
  const editor = fakeEditor(
    options.initialText !== undefined
      ? options.initialText
      : noteText(level).replaceAll("\n", options.eol ?? "\n"),
  );
  const bookFile = new TFileDouble(SOURCE);
  const noteFile = new TFileDouble(NOTE_PATH);
  const reader: Harness["reader"] = {
    file: bookFile,
    getViewType: () => "observation-car-epub",
  };
  if (options.hasLocationCapability !== false) {
    reader.getLocation = () =>
      options.location === undefined
        ? { fragment: MIDDLE, chapter: 2, label: "Ch. 2" }
        : options.location;
  }
  if (options.hasSelectionCapability !== false) {
    reader.getSelection = () => options.selection ?? null;
  }

  const rootSplit = {};
  const readerLeaf = {
    view: reader,
    getRoot: () => rootSplit,
  } as unknown as WorkspaceLeaf;
  const noteLeaf = {
    view: new MarkdownViewDouble(noteFile, editor.editor),
    getRoot: () => rootSplit,
  } as unknown as WorkspaceLeaf;
  const splitLeaf = {
    view: null as unknown,
    getRoot: () => rootSplit,
    detach: vi.fn(),
    openFile: async (file: TFile) => {
      splitLeaf.view = new MarkdownViewDouble(file, editor.editor);
    },
  };
  const pairing: ReaderPairing = {
    leaf: readerLeaf,
    reader,
    bookFile,
    notePath: NOTE_PATH,
    bookNote: parseBookNote(editor.value(), { anchorHeadingLevel: level }),
  };
  const commands: Command[] = [];
  const plugin = {
    settings: { anchorHeadingLevel: level },
    app: {
      vault: {
        getAbstractFileByPath: (path: string) => path === NOTE_PATH ? noteFile : null,
      },
      metadataCache: {
        getFirstLinkpathDest: (path: string) => path === SOURCE ? bookFile : null,
      },
      workspace: {
        rootSplit,
        getMostRecentLeaf: () =>
          options.noteMostRecent === true ? noteLeaf : readerLeaf,
        getLeavesOfType: (type: string) =>
          type === "markdown" && options.noteOpen !== false ? [noteLeaf] : [],
        createLeafBySplit: vi.fn(() => splitLeaf),
      },
    },
    addCommand: (command: Command) => {
      commands.push(command);
      return command;
    },
    getReaderPairingForLeaf: (leaf: WorkspaceLeaf) =>
      leaf === readerLeaf ? pairing : undefined,
    getReaderPairingForNote: (path: string) =>
      path === NOTE_PATH ? pairing : undefined,
  } as unknown as ObservationCarPlugin;

  return { plugin, readerLeaf, noteLeaf, reader, editor, commands };
}

describe("new note here", () => {
  beforeEach(() => {
    notices.length = 0;
    vi.restoreAllMocks();
  });

  it("registers a mobile-capable command-palette action with Alt+N", () => {
    const harness = makeHarness();
    registerNewNoteHereCommand(harness.plugin);

    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]).toMatchObject({
      id: NEW_NOTE_HERE_COMMAND_ID,
      name: "New note here",
      icon: "square-pen",
      hotkeys: [{ modifiers: ["Alt"], key: "N" }],
    });
    expect(harness.commands[0].mobileOnly).not.toBe(true);
    expect(harness.commands[0].checkCallback?.(true)).toBe(true);
  });

  it("executes from the focused paired Markdown note", async () => {
    const harness = makeHarness({ noteMostRecent: true });
    registerNewNoteHereCommand(harness.plugin);

    expect(harness.commands[0].checkCallback?.(false)).toBe(true);
    await vi.waitFor(() =>
      expect(harness.editor.setValue).toHaveBeenCalledOnce(),
    );

    expect(harness.editor.value()).toContain(
      `## [[${SOURCE}${MIDDLE}|Ch. 2 — note]]`,
    );
  });

  it("inserts a selected range at sorted position using the configured heading level", async () => {
    const selectionText =
      "A deliberately long selection with   repeated whitespace and enough " +
      "words to exceed sixty characters.\nSecond line.";
    const harness = makeHarness({
      level: 3,
      selection: { text: selectionText, fragment: MIDDLE },
    });

    await newNoteHereFromReader(harness.plugin, harness.readerLeaf);

    const output = harness.editor.value();
    const parsed = parseBookNote(output, { anchorHeadingLevel: 3 });
    expect(parsed.sections.map((section) => section.fragment)).toEqual([
      EARLY.slice(1),
      MIDDLE.slice(1),
      LATE.slice(1),
    ]);
    const inserted = parsed.sections[1];
    const lines = output.split("\n");
    expect(lines[inserted.headingLine]).toMatch(
      /^### \[\[Books\/Test\.epub#epubcfi\(.+\)\|Ch\. 2 — .+\]\]$/,
    );
    const alias = lines[inserted.headingLine].split("|", 2)[1].slice(0, -2);
    expect(Array.from(alias.slice("Ch. 2 — ".length))).toHaveLength(60);
    expect(alias).toBe(
      "Ch. 2 — A deliberately long selection with repeated whitespace and …",
    );
    expect(lines.slice(inserted.headingLine + 1, inserted.headingLine + 3)).toEqual([
      `> ${selectionText.split("\n")[0]}`,
      "> Second line.",
    ]);
    expect(lines[inserted.headingLine + 3]).toBe("");
    expect(harness.editor.setCursor).toHaveBeenCalledWith({
      line: inserted.headingLine + 3,
      ch: 0,
    });
    expect(harness.editor.focus).toHaveBeenCalledOnce();
  });

  it("normalizes blank-line separators for an empty note", async () => {
    const harness = makeHarness({ initialText: emptyNoteText() });
    const initialText = emptyNoteText();

    await newNoteHereFromReader(harness.plugin, harness.readerLeaf);

    const heading = `## [[${SOURCE}${MIDDLE}|Ch. 2 — note]]`;
    expect(harness.editor.value().startsWith(`${initialText}\n\n${heading}`)).toBe(true);
  });

  it("does not write anything when the focused leaf has no reader pairing", async () => {
    const harness = makeHarness();

    await newNoteHereFromReader(harness.plugin, {} as WorkspaceLeaf);

    expect(harness.editor.setValue).not.toHaveBeenCalled();
    expect(notices).toEqual([
      "Open or create this book's note before adding a section.",
    ]);
  });

  it.each([
    ["one EOL", `${emptyNoteText()}\nlatebody\n`],
    ["two EOLs", `${emptyNoteText()}\nlatebody\n\n`],
  ])("normalizes blank-line separators for a note ending with %s", async (_ending, initialText) => {
    const harness = makeHarness({ initialText });

    await newNoteHereFromReader(harness.plugin, harness.readerLeaf);

    const heading = `## [[${SOURCE}${MIDDLE}|Ch. 2 — note]]`;
    expect(harness.editor.value()).toContain(`latebody\n\n${heading}`);
    expect(harness.editor.value()).not.toContain("\n\n\n");
  });

  it("uses the current location and a note label when there is no selection", async () => {
    const harness = makeHarness({ hasSelectionCapability: false });

    await newNoteHereFromReader(harness.plugin, harness.readerLeaf);

    const output = harness.editor.value();
    expect(output).toContain(
      `## [[${SOURCE}${MIDDLE}|Ch. 2 — note]]`,
    );
    expect(output).not.toContain("> ");
    const inserted = parseBookNote(output).sections.find(
      (section) => section.fragment === MIDDLE.slice(1),
    );
    expect(inserted).toBeDefined();
    expect(harness.editor.setCursor).toHaveBeenCalledWith({
      line: (inserted?.headingLine ?? -2) + 1,
      ch: 0,
    });
  });

  it("treats a whitespace-only selection as no selection", async () => {
    const harness = makeHarness({
      selection: { text: " \r\n\t ", fragment: MIDDLE },
    });

    await newNoteHereFromReader(harness.plugin, harness.readerLeaf);

    expect(harness.editor.value()).toContain(
      `## [[${SOURCE}${MIDDLE}|Ch. 2 — note]]`,
    );
    expect(harness.editor.value()).not.toContain("> ");
  });

  it.each([
    ["pipe", "quoted | selection", "quoted ｜ selection"],
    ["left bracket", "quoted [ selection", "quoted ［ selection"],
    ["right bracket", "quoted ] selection", "quoted ］ selection"],
    ["double left bracket", "quoted [[ selection", "quoted ［［ selection"],
    ["balanced brackets", "quoted [sic] selection", "quoted ［sic］ selection"],
  ])("escapes %s in the anchor alias", async (_case, text, safeText) => {
    const harness = makeHarness({
      selection: { text, fragment: MIDDLE },
    });

    await newNoteHereFromReader(harness.plugin, harness.readerLeaf);

    expect(harness.editor.value()).toContain(`|Ch. 2 — ${safeText}]]`);
    expect(
      parseBookNote(harness.editor.value()).sections.some(
        (section) => section.fragment === MIDDLE.slice(1),
      ),
    ).toBe(true);
  });

  it("preserves CRLF line endings when inserting a section", async () => {
    const harness = makeHarness({ eol: "\r\n" });

    await newNoteHereFromReader(harness.plugin, harness.readerLeaf);

    const outputWithoutCrLf = harness.editor.value().replaceAll("\r\n", "");
    expect(harness.editor.value()).toContain("\r\n");
    expect(outputWithoutCrLf).not.toContain("\n");
  });

  it("preserves CRLF line endings when inserting a selected range", async () => {
    const harness = makeHarness({
      eol: "\r\n",
      selection: {
        text: "A quoted line.\r\nSecond quoted line.",
        fragment: MIDDLE,
      },
    });

    await newNoteHereFromReader(harness.plugin, harness.readerLeaf);

    expect(harness.editor.value()).toContain(
      "> A quoted line.\r\n> Second quoted line.",
    );
    const outputWithoutCrLf = harness.editor.value().replaceAll("\r\n", "");
    expect(outputWithoutCrLf).not.toContain("\n");
    expect(
      parseBookNote(harness.editor.value()).sections.find(
        (section) => section.fragment === MIDDLE.slice(1),
      ),
    ).toBeDefined();
  });

  it("round-trips a newline-bearing chapter label into one heading", async () => {
    const harness = makeHarness({
      location: {
        fragment: MIDDLE,
        chapter: 2,
        label: "\n    The Opening Image\r\n  ",
      },
    });

    await newNoteHereFromReader(harness.plugin, harness.readerLeaf);

    expect(harness.editor.value()).toContain(
      `## [[${SOURCE}${MIDDLE}|The Opening Image — note]]`,
    );
    const inserted = parseBookNote(harness.editor.value()).sections.find(
      (section) => section.fragment === MIDDLE.slice(1),
    );
    expect(inserted).toBeDefined();
    expect(harness.editor.setCursor).toHaveBeenCalledWith({
      line: (inserted?.headingLine ?? -2) + 1,
      ch: 0,
    });
  });

  it("opens the paired note in an ordinary Markdown editor before inserting", async () => {
    const harness = makeHarness({ noteOpen: false });

    await newNoteHereFromReader(harness.plugin, harness.readerLeaf);

    expect(harness.plugin.app.workspace.createLeafBySplit).toHaveBeenCalledWith(
      harness.readerLeaf,
      "vertical",
    );
    expect(harness.editor.value()).toContain(
      `## [[${SOURCE}${MIDDLE}|Ch. 2 — note]]`,
    );
    expect(harness.editor.focus).toHaveBeenCalledOnce();
  });

  it("jumps to an existing exact fragment instead of duplicating it", async () => {
    const harness = makeHarness({
      location: { fragment: EARLY, chapter: 0, label: "Ch. 0" },
    });

    await newNoteHereFromReader(harness.plugin, harness.readerLeaf);

    expect(harness.editor.setValue).not.toHaveBeenCalled();
    expect(parseBookNote(harness.editor.value()).sections).toHaveLength(2);
    expect(harness.editor.setCursor).toHaveBeenCalledWith({ line: 6, ch: 0 });
    expect(harness.editor.scrollIntoView).toHaveBeenCalledWith(
      { from: { line: 6, ch: 0 }, to: { line: 6, ch: 0 } },
      true,
    );
    expect(harness.editor.focus).toHaveBeenCalledOnce();
  });

  it("gracefully refuses readers without the optional location capability", async () => {
    const harness = makeHarness({ hasLocationCapability: false });

    await newNoteHereFromReader(harness.plugin, harness.readerLeaf);

    expect(harness.editor.setValue).not.toHaveBeenCalled();
    expect(notices).toEqual([
      "This reader cannot report its current location.",
    ]);
  });

  it("inserts nothing when the reader has no anchorable current location", async () => {
    const harness = makeHarness({ location: null });

    await newNoteHereFromReader(harness.plugin, harness.readerLeaf);

    expect(harness.editor.setValue).not.toHaveBeenCalled();
    expect(notices).toEqual([
      "No anchorable reader location is available yet.",
    ]);
  });

  it("reports an actionable error without requiring a developer console", async () => {
    const harness = makeHarness();
    const failure = new Error("location failure");
    harness.reader.getLocation = () => {
      throw failure;
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await newNoteHereFromReader(harness.plugin, harness.readerLeaf);

    expect(console.error).toHaveBeenCalledWith(
      "[observation-car] could not add note at reader location",
      failure,
    );
    expect(notices).toEqual([
      "Could not add an anchored section to the paired book note.",
    ]);
  });

  it("prefers the focused editor when the note is open in two panes", async () => {
    // Two note leaves, second one focused
    const focusedEditor = fakeEditor(noteText());
    (focusedEditor.editor as any).hasFocus = () => true;

    const unfocusedEditor = fakeEditor(noteText());

    const bookFile = new TFileDouble(SOURCE);
    const noteFile = new TFileDouble(NOTE_PATH);
    const reader: Harness["reader"] = {
      file: bookFile,
      getViewType: () => "observation-car-epub",
      getLocation: () => ({
        fragment: MIDDLE,
        chapter: 2,
        label: "Ch. 2",
      }),
    };

    const rootSplit = {};
    const readerLeaf = {
      view: reader,
      getRoot: () => rootSplit,
    } as unknown as WorkspaceLeaf;
    const unfocusedLeaf = {
      view: new MarkdownViewDouble(noteFile, unfocusedEditor.editor),
      getRoot: () => rootSplit,
    } as unknown as WorkspaceLeaf;
    const focusedLeaf = {
      view: new MarkdownViewDouble(noteFile, focusedEditor.editor),
      getRoot: () => rootSplit,
    } as unknown as WorkspaceLeaf;
    const pairing: ReaderPairing = {
      leaf: readerLeaf,
      reader,
      bookFile,
      notePath: NOTE_PATH,
      bookNote: parseBookNote(noteText(), { anchorHeadingLevel: 2 }),
    };
    const plugin = {
      settings: { anchorHeadingLevel: 2 },
      app: {
        vault: {
          getAbstractFileByPath: (path: string) =>
            path === NOTE_PATH ? noteFile : null,
        },
        metadataCache: {
          getFirstLinkpathDest: () => bookFile,
        },
        workspace: {
          rootSplit,
          getMostRecentLeaf: () => readerLeaf,
          getLeavesOfType: () => [unfocusedLeaf, focusedLeaf],
          createLeafBySplit: vi.fn(),
        },
      },
      addCommand: vi.fn(),
      getReaderPairingForLeaf: (leaf: WorkspaceLeaf) =>
        leaf === readerLeaf ? pairing : undefined,
      getReaderPairingForNote: () => pairing,
    } as unknown as ObservationCarPlugin;

    await newNoteHereFromReader(plugin, readerLeaf);

    // The focused editor should receive the content update
    expect(focusedEditor.setValue).toHaveBeenCalled();
    expect(unfocusedEditor.setValue).not.toHaveBeenCalled();
  });
});
