import {
  TFile,
  TFolder,
  type App,
  type Command,
  type PluginManifest,
} from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../manifest.json";
import { parseBookNote } from "./model/bookNote";
import { DEFAULT_REPARSE_DEBOUNCE_MS } from "./model/bookNoteStore";
import ObservationCarPlugin from "./main";

/**
 * The plugin wiring is the seam with the Obsidian runtime, so this suite
 * substitutes the `obsidian` module with recording doubles — the events
 * fired below are exactly the events Obsidian fires, and the assertions
 * are about the plugin's response to them. `./readers/EpubView` is
 * mocked out too, so loading the plugin in Node never pulls in `epubjs`
 * (a browser library).
 */
vi.mock("obsidian", () => {
  class Plugin {
    app: unknown;
    commands: unknown[] = [];
    savedData: unknown[] = [];
    constructor(app: unknown) {
      this.app = app;
    }
    registerEvent(ref: unknown): void {
      // Real Obsidian disposes registered refs on unload; nothing to do
      // here — the timers under test live in the plugin, not the refs.
      void ref;
    }
    registerView(_viewType: string, _factory: unknown): void {}
    registerExtensions(_extensions: string[], _viewType: string): void {}
    addSettingTab(_tab: unknown): void {}
    addCommand(command: unknown): unknown {
      this.commands.push(command);
      return command;
    }
    async loadData(): Promise<unknown> {
      return {};
    }
    async saveData(data: unknown): Promise<void> {
      this.savedData.push(data);
    }
  }
  class PluginSettingTab {
    app: unknown;
    plugin: unknown;
    constructor(app: unknown, plugin: unknown) {
      this.app = app;
      this.plugin = plugin;
    }
  }
  class Setting {
    constructor(_containerEl: unknown) {}
  }
  class TFile {
    path: string;
    extension: string;
    name: string;
    basename: string;
    constructor(path: string, extension: string) {
      this.path = path;
      this.extension = extension;
      this.name = path.split("/").at(-1) ?? path;
      this.basename = this.name.slice(0, -(extension.length + 1));
    }
  }
  class TFolder {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
  }
  class Notice {
    constructor(_message: string) {}
  }
  const normalizePath = (path: string): string =>
    path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\//, "");
  return {
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    TFolder,
    normalizePath,
  };
});

vi.mock("./readers/EpubView", () => ({
  EPUB_VIEW_TYPE: "observation-car-epub",
  EpubView: class {},
}));

const registrationMocks = vi.hoisted(() => ({
  registerBookloreCatalog: vi.fn(),
  registerBookloreDownloads: vi.fn(async () => {}),
}));

vi.mock("./booklore/catalogRegistration", () => ({
  registerBookloreCatalog: registrationMocks.registerBookloreCatalog,
}));

vi.mock("./booklore/bookDownloadRegistration", () => ({
  registerBookloreDownloads: registrationMocks.registerBookloreDownloads,
}));

type Handler = (...args: unknown[]) => void;

/**
 * The `TFile` double from the substituted module, with the constructor
 * that double actually has (the real class's constructor is vault-
 * internal, so its d.ts signature cannot be called from here). At
 * runtime this is exactly the class `main.ts` `instanceof`-checks.
 */
const TFileDouble = TFile as unknown as new (
  path: string,
  extension: string,
) => TFile;
const TFolderDouble = TFolder as unknown as new (path: string) => TFolder;

interface FakeVault {
  app: unknown;
  files: Map<string, TFile>;
  folders: Set<string>;
  contents: Map<string, string>;
  caches: Map<string, { frontmatter: Record<string, unknown> | null }>;
  /** Lowercased linkpath → vault path of the file it resolves to. */
  linkDests: Map<string, string>;
  metadataHandlers: Map<string, Handler>;
  vaultHandlers: Map<string, Handler>;
  createdFiles: string[];
  generatedLinks: { filePath: string; sourcePath: string }[];
  openedFiles: string[];
  runtime: { activeView: unknown; useMarkdownLinks: boolean };
}

function makeFakeVault(): FakeVault {
  const files = new Map<string, TFile>();
  const folders = new Set<string>();
  const contents = new Map<string, string>();
  const caches = new Map<string, { frontmatter: Record<string, unknown> | null }>();
  const linkDests = new Map<string, string>();
  const metadataHandlers = new Map<string, Handler>();
  const vaultHandlers = new Map<string, Handler>();
  const createdFiles: string[] = [];
  const generatedLinks: { filePath: string; sourcePath: string }[] = [];
  const openedFiles: string[] = [];
  const runtime = {
    activeView: null as unknown,
    useMarkdownLinks: false,
  };

  const app = {
    vault: {
      getAbstractFileByPath: (path: string): TFile | TFolder | null =>
        files.get(path) ?? (folders.has(path) ? new TFolderDouble(path) : null),
      create: async (path: string, text: string): Promise<TFile> => {
        if (files.has(path) || folders.has(path)) {
          throw new Error(`${path} already exists`);
        }
        const extension = path.split(".").at(-1) ?? "";
        const file = new TFileDouble(path, extension);
        files.set(path, file);
        contents.set(path, text);
        createdFiles.push(path);
        return file;
      },
      createFolder: async (path: string): Promise<TFolder> => {
        if (files.has(path) || folders.has(path)) {
          throw new Error(`${path} already exists`);
        }
        folders.add(path);
        return new TFolderDouble(path);
      },
      // Timer-based on purpose: under fake timers every async step of a
      // parse pass is a timer, so advanceTimersByTimeAsync tracks the
      // whole chain deterministically.
      read: (file: TFile): Promise<string | null> =>
        new Promise((resolve) => {
          setTimeout(() => resolve(contents.get(file.path) ?? null), 0);
        }),
      getMarkdownFiles: (): TFile[] =>
        [...files.values()].filter((f) => f.extension === "md"),
      on: (name: string, callback: Handler): { name: string } => {
        vaultHandlers.set(name, callback);
        return { name };
      },
    },
    metadataCache: {
      getFileCache: (
        file: TFile,
      ): { frontmatter: Record<string, unknown> | null } | null =>
        caches.get(file.path) ?? null,
      getFirstLinkpathDest: (linkpath: string): TFile | null => {
        const dest = linkDests.get(linkpath.toLowerCase());
        return dest === undefined ? null : files.get(dest) ?? null;
      },
      on: (name: string, callback: Handler): { name: string } => {
        metadataHandlers.set(name, callback);
        return { name };
      },
    },
    fileManager: {
      generateMarkdownLink: (file: TFile, sourcePath: string): string => {
        generatedLinks.push({ filePath: file.path, sourcePath });
        return runtime.useMarkdownLinks
          ? `[${file.basename}](${file.path})`
          : `[[${file.name}]]`;
      },
    },
    workspace: {
      getActiveViewOfType: (): unknown => runtime.activeView,
      getLeaf: (): { openFile: (file: TFile) => Promise<void> } => ({
        openFile: async (file: TFile): Promise<void> => {
          openedFiles.push(file.path);
        },
      }),
    },
  };

  return {
    app,
    files,
    folders,
    contents,
    caches,
    linkDests,
    metadataHandlers,
    vaultHandlers,
    createdFiles,
    generatedLinks,
    openedFiles,
    runtime,
  };
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

describe("manifest.json", () => {
  it("runs on mobile (isDesktopOnly is false)", () => {
    expect(manifest.isDesktopOnly).toBe(false);
  });

  it("targets a supported Obsidian version (minAppVersion >= 1.7.2)", () => {
    expect(compareVersions(manifest.minAppVersion, "1.7.2")).toBeGreaterThanOrEqual(0);
  });
});

describe("plugin wiring (substituted obsidian module)", () => {
  const MANIFEST: PluginManifest = {
    id: "observation-car",
    name: "Observation Car",
    version: "0.1.0",
    minAppVersion: "1.7.2",
    description: "test manifest",
    author: "test",
    isDesktopOnly: false,
  };

  const SOURCE = "Books/Surprised by Grace.epub";
  const CFI_1 = "epubcfi(/6/8!/4/2/1:0)";
  const CFI_2 = "epubcfi(/6/14!/4/2/12:0)";

  const NOTE_TEXT = [
    "---",
    "type: book-note",
    `source: "[[${SOURCE}]]"`,
    "format: epub",
    "---",
    "",
    `## [[${SOURCE}#${CFI_1}|Ch. 1]]`,
    "body one",
    "",
    `## [[${SOURCE}#${CFI_2}|Ch. 3]]`,
    "body two",
  ].join("\n");

  const NOTE_FRONTMATTER: Record<string, unknown> = {
    type: "book-note",
    source: `[[${SOURCE}]]`,
    format: "epub",
  };

  let fake: FakeVault;
  let plugin: ObservationCarPlugin;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    fake = makeFakeVault();
    addBookFile(SOURCE);
    plugin = new ObservationCarPlugin(fake.app as App, MANIFEST);
    await plugin.onload();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Settle all in-flight work. The first advance also flushes the
   * microtasks that schedule the next timers (an op like
   * `updateSettings` suspends on saveData before it schedules its
   * re-parse); it is unconditional for that reason. One
   * advanceTimersByTimeAsync call does not chase the 0ms read timers
   * that microtask continuations of a fired timer spawn (each parse
   * step spawns one), so the loop keeps advancing while timers remain.
   */
  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(DEFAULT_REPARSE_DEBOUNCE_MS + 1);
    for (let i = 0; i < 20 && vi.getTimerCount() > 0; i += 1) {
      await vi.advanceTimersByTimeAsync(DEFAULT_REPARSE_DEBOUNCE_MS + 1);
    }
  }

  function addMdFile(
    path: string,
    text: string,
    frontmatter: Record<string, unknown> | null,
  ): TFile {
    const file = new TFileDouble(path, "md");
    fake.files.set(path, file);
    fake.contents.set(path, text);
    fake.caches.set(path, { frontmatter });
    return file;
  }

  function addBookFile(path: string): TFile {
    const file = new TFileDouble(path, "epub");
    fake.files.set(path, file);
    fake.linkDests.set(path.toLowerCase(), path);
    return file;
  }

  function fire(
    where: "metadata" | "vault",
    name: string,
    args: readonly unknown[],
  ): void {
    const handler = (
      where === "metadata" ? fake.metadataHandlers : fake.vaultHandlers
    ).get(name);
    if (handler === undefined) {
      throw new Error(`no ${where} handler registered for "${name}"`);
    }
    handler(...args);
  }

  function getCreateBookNoteCommand(): Command | undefined {
    const commands = (plugin as unknown as { commands: Command[] }).commands;
    return commands.find(
      (command) => command.id === "create-book-note-for-current-book",
    );
  }

  async function settleCommand(): Promise<void> {
    await settle();
  }

  it("registers the Booklore catalog and downloads on plugin load", () => {
    expect(registrationMocks.registerBookloreCatalog).toHaveBeenCalledTimes(1);
    expect(
      registrationMocks.registerBookloreCatalog,
    ).toHaveBeenCalledWith(plugin);
    expect(registrationMocks.registerBookloreDownloads).toHaveBeenCalledTimes(1);
    expect(
      registrationMocks.registerBookloreDownloads,
    ).toHaveBeenCalledWith(plugin);
  });

  it("registers the mobile-capable command without writing on plugin load", async () => {
    const command = getCreateBookNoteCommand();
    expect(command).toBeDefined();
    if (command === undefined) return;

    expect(command.name).toBe("Create book note for current book");
    expect(command.icon).toBe("book-open");
    expect(command.hotkeys).toBeUndefined();
    expect(command.checkCallback?.(true)).toBe(false);
    await settleCommand();
    expect(fake.createdFiles).toEqual([]);

    const book = fake.files.get(SOURCE);
    expect(book).toBeDefined();
    fake.runtime.activeView = { file: book };
    expect(command.checkCallback?.(true)).toBe(true);
    await settleCommand();
    expect(fake.createdFiles).toEqual([]);
  });

  it("creates a templated note in the configured folder only when invoked", async () => {
    plugin.settings = {
      ...plugin.settings,
      notesFolder: "Notes/Reading",
    };
    const book = fake.files.get(SOURCE);
    expect(book).toBeDefined();
    fake.runtime.activeView = { file: book };

    const command = getCreateBookNoteCommand();
    expect(command).toBeDefined();
    if (command === undefined) return;
    expect(command.checkCallback?.(false)).toBe(true);
    await settleCommand();

    const notePath = "Notes/Reading/Surprised by Grace.md";
    expect(fake.folders).toEqual(new Set(["Notes", "Notes/Reading"]));
    expect(fake.createdFiles).toEqual([notePath]);
    expect(fake.contents.get(notePath)).toBe(
      [
        "---",
        "type: book-note",
        'source: "[[Books/Surprised by Grace.epub]]"',
        "format: epub",
        'title: "Surprised by Grace"',
        'author: ""',
        "---",
        "",
      ].join("\n"),
    );
    expect(fake.generatedLinks).toEqual([]);
    expect(fake.openedFiles).toEqual([notePath]);
  });

  it.each([
    { mode: "wikilinks on", useMarkdownLinks: false },
    { mode: "wikilinks off", useMarkdownLinks: true },
  ])(
    "writes a resolvable vault-path source with $mode",
    async ({ useMarkdownLinks }) => {
      fake.runtime.useMarkdownLinks = useMarkdownLinks;
      const book = fake.files.get(SOURCE);
      expect(book).toBeDefined();
      fake.runtime.activeView = { file: book };

      const command = getCreateBookNoteCommand();
      expect(command).toBeDefined();
      if (command === undefined) return;
      expect(command.checkCallback?.(false)).toBe(true);
      await settleCommand();

      const notePath = "Reading/Surprised by Grace.md";
      const content = fake.contents.get(notePath);
      expect(content).toBeDefined();
      if (content === undefined) return;
      const source = parseBookNote(content).frontmatter.source;
      expect(source).toBe(SOURCE);
      expect(
        source === null ? null : fake.linkDests.get(source.toLowerCase()),
      ).toBe(SOURCE);
    },
  );

  it("quotes a single-quoted source containing an apostrophe", async () => {
    plugin.settings = {
      ...plugin.settings,
      noteTemplate: [
        "---",
        "type: book-note",
        "source: '{{source}}'",
        "format: {{format}}",
        "title: {{title}}",
        "author: {{author}}",
        "---",
        "",
      ].join("\n"),
    };
    const source = "Books/Foo {{author}} O'Brien.epub";
    const book = addBookFile(source);
    fake.runtime.activeView = { file: book };

    const command = getCreateBookNoteCommand();
    expect(command).toBeDefined();
    if (command === undefined) return;
    expect(command.checkCallback?.(false)).toBe(true);
    await settleCommand();

    const notePath = "Reading/Foo {{author}} O'Brien.md";
    expect(fake.contents.get(notePath)).toBe(
      [
        "---",
        "type: book-note",
        "source: '[[Books/Foo {{author}} O''Brien.epub]]'",
        "format: epub",
        `title: "Foo {{author}} O'Brien"`,
        'author: ""',
        "---",
        "",
      ].join("\n"),
    );
  });

  it("preserves a literal format placeholder in the book filename", async () => {
    plugin.settings = {
      ...plugin.settings,
      noteTemplate: plugin.settings.noteTemplate.replace(
        "format: {{format}}",
        "format: '{{format}}'",
      ),
    };
    const source = "Books/Foo {{format}} Bar.epub";
    const book = addBookFile(source);
    fake.runtime.activeView = { file: book };

    const command = getCreateBookNoteCommand();
    expect(command).toBeDefined();
    if (command === undefined) return;
    expect(command.checkCallback?.(false)).toBe(true);
    await settleCommand();

    const notePath = "Reading/Foo {{format}} Bar.md";
    expect(fake.contents.get(notePath)).toBe(
      [
        "---",
        "type: book-note",
        'source: "[[Books/Foo {{format}} Bar.epub]]"',
        "format: 'epub'",
        'title: "Foo {{format}} Bar"',
        'author: ""',
        "---",
        "",
      ].join("\n"),
    );
  });

  it("opens an existing note without overwriting it", async () => {
    const notePath = "Reading/Surprised by Grace.md";
    addMdFile(notePath, "sentinel — keep me", null);
    const book = fake.files.get(SOURCE);
    expect(book).toBeDefined();
    fake.runtime.activeView = { file: book };

    const command = getCreateBookNoteCommand();
    expect(command).toBeDefined();
    if (command === undefined) return;
    expect(command.checkCallback?.(false)).toBe(true);
    await settleCommand();

    expect(fake.createdFiles).toEqual([]);
    expect(fake.contents.get(notePath)).toBe("sentinel — keep me");
    expect(fake.openedFiles).toEqual([notePath]);
    expect(fake.generatedLinks).toEqual([]);
  });

  it("a changed event caches a candidate note after the debounce window", async () => {
    const file = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    expect(plugin.getBookNote("Reading/A.md")).toBeUndefined();

    fire("metadata", "changed", [file]);
    expect(plugin.getBookNote("Reading/A.md")).toBeUndefined(); // debounced

    await settle();
    const cached = plugin.getBookNote("Reading/A.md");
    expect(cached?.frontmatter.source).toBe(SOURCE);
    expect(cached?.sections.map((s) => s.fragment)).toEqual([CFI_1, CFI_2]);
    expect(cached?.diagnostics).toEqual([]);
    expect(plugin.getBookNotePaths()).toEqual(["Reading/A.md"]);
  });

  it("a changed event ignores files the sniff does not call candidates", async () => {
    const file = addMdFile("Plain.md", "just prose, no frontmatter", null);
    fire("metadata", "changed", [file]);
    await settle();
    expect(plugin.getBookNotePaths()).toEqual([]);
  });

  it("a deleted event evicts the cached note", async () => {
    const file = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [file]);
    await settle();
    expect(plugin.getBookNote("Reading/A.md")).toBeDefined();

    fake.files.delete("Reading/A.md");
    fake.contents.delete("Reading/A.md");
    fire("metadata", "deleted", [new TFileDouble("Reading/A.md", "md")]);
    expect(plugin.getBookNote("Reading/A.md")).toBeUndefined();
    expect(plugin.getBookNotePaths()).toEqual([]);
  });

  it("a resolved event runs a full pass over the vault's candidate notes", async () => {
    // The files arrive after load, so the initial pass saw an empty vault
    // — this isolates the `resolved` handler itself.
    addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    addMdFile("Reading/B.md", NOTE_TEXT, NOTE_FRONTMATTER);
    addMdFile("Plain.md", "just prose, no frontmatter", null);

    fire("metadata", "resolved", []);
    await settle();

    expect(plugin.getBookNotePaths().sort()).toEqual([
      "Reading/A.md",
      "Reading/B.md",
    ]);
    expect(plugin.getBookNote("Reading/A.md")?.sections).toHaveLength(2);
    expect(plugin.getBookNote("Reading/B.md")?.sections).toHaveLength(2);
    expect(plugin.getBookNote("Plain.md")).toBeUndefined();
  });

  it("a rename evicts the old path and re-parses under the new path", async () => {
    const file = addMdFile("Reading/Old.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [file]);
    await settle();
    expect(plugin.getBookNotePaths()).toEqual(["Reading/Old.md"]);

    // The vault rename: the old file is gone, the new file holds the same
    // note, and the metadata cache already serves the new path (only the
    // `changed` event is suppressed on rename).
    const newFile = new TFileDouble("Reading/New.md", "md");
    fake.files.set("Reading/New.md", newFile);
    fake.contents.set("Reading/New.md", NOTE_TEXT);
    fake.caches.set("Reading/New.md", { frontmatter: NOTE_FRONTMATTER });
    fake.files.delete("Reading/Old.md");
    fake.contents.delete("Reading/Old.md");
    fake.caches.delete("Reading/Old.md");

    fire("vault", "rename", [newFile, "Reading/Old.md"]);

    // The phantom is gone immediately — no rescan required.
    expect(plugin.getBookNote("Reading/Old.md")).toBeUndefined();
    expect(plugin.getBookNotePaths()).toEqual([]);

    // And the note is re-parsed under its new path.
    await settle();
    expect(
      plugin.getBookNote("Reading/New.md")?.sections.map((s) => s.fragment),
    ).toEqual([CFI_1, CFI_2]);

    // A full rescan leaves exactly the new path behind — no phantom
    // survives (the resolved pass used to only add).
    fire("metadata", "resolved", []);
    await settle();
    expect(plugin.getBookNotePaths()).toEqual(["Reading/New.md"]);
  });

  it("a note that stops being a book note is evicted on its next change", async () => {
    const file = addMdFile("Reading/B.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [file]);
    await settle();
    expect(plugin.getBookNote("Reading/B.md")).toBeDefined();

    // The user strips the `source` frontmatter and saves.
    fake.contents.set("Reading/B.md", "no frontmatter\njust prose\n");
    fake.caches.set("Reading/B.md", { frontmatter: null });
    fire("metadata", "changed", [file]);

    // The sniff no longer calls it a candidate, but the store holds the
    // path, so it gets the final parse in which the parser's authoritative
    // source check evicts it.
    await settle();
    expect(plugin.getBookNote("Reading/B.md")).toBeUndefined();
    expect(plugin.getBookNotePaths()).toEqual([]);
  });

  it("a de-book-noted file is evicted by a full rescan as well", async () => {
    addMdFile("Reading/B.md", NOTE_TEXT, NOTE_FRONTMATTER);
    addMdFile("Reading/C.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "resolved", []);
    await settle();
    expect(plugin.getBookNotePaths().sort()).toEqual([
      "Reading/B.md",
      "Reading/C.md",
    ]);

    fake.contents.set("Reading/B.md", "no frontmatter\njust prose\n");
    fake.caches.set("Reading/B.md", { frontmatter: null });

    fire("metadata", "resolved", []);
    await settle();
    expect(plugin.getBookNote("Reading/B.md")).toBeUndefined();
    expect(plugin.getBookNotePaths()).toEqual(["Reading/C.md"]);
  });

  it("onunload leaves no live timer and empties the store", async () => {
    expect(vi.getTimerCount()).toBe(0); // onload's awaited pass left none

    const file = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [file]);
    expect(vi.getTimerCount()).toBe(1); // the debounce window is pending

    plugin.onunload();
    expect(vi.getTimerCount()).toBe(0);
    expect(plugin.getBookNotePaths()).toEqual([]);
  });

  it("matches shortest-path anchor links against the source via the metadata cache", async () => {
    // The QC Tier 2 probe, end to end: the source is the full vault path,
    // the headings use Obsidian's "shortest path when possible" form.
    addBookFile(SOURCE);
    fake.linkDests.set("surprised by grace.epub", SOURCE);
    const shortNote = [
      "---",
      `source: "[[${SOURCE}]]"`,
      "format: epub",
      "---",
      "",
      `## [[Surprised by Grace.epub#${CFI_1}|Ch. 1]]`,
      "body one",
      "",
      `## [[Surprised by Grace.epub#${CFI_2}|Ch. 3]]`,
      "body two",
    ].join("\n");
    const file = addMdFile("Reading/A.md", shortNote, {
      source: `[[${SOURCE}]]`,
      format: "epub",
    });

    fire("metadata", "changed", [file]);
    await settle();
    const cached = plugin.getBookNote("Reading/A.md");
    expect(cached?.sections.map((s) => s.fragment)).toEqual([CFI_1, CFI_2]);
    expect(cached?.diagnostics).toEqual([]);
  });

  it("diagnoses (not silently drops) an anchor link that resolves to another book", async () => {
    addBookFile(SOURCE);
    addBookFile("Books/Other.epub");
    const text = [
      "---",
      `source: "[[${SOURCE}]]"`,
      "format: epub",
      "---",
      "",
      `## [[Books/Other.epub#${CFI_1}|wrong book]]`,
      "body",
    ].join("\n");
    const file = addMdFile("Reading/A.md", text, {
      source: `[[${SOURCE}]]`,
      format: "epub",
    });

    fire("metadata", "changed", [file]);
    await settle();
    const cached = plugin.getBookNote("Reading/A.md");
    expect(cached?.sections).toHaveLength(0);
    expect(cached?.diagnostics).toHaveLength(1);
    expect(cached?.diagnostics[0].message).toContain("Books/Other.epub");
    expect(cached?.diagnostics[0].message).toContain(SOURCE);
  });

  it("re-parses the cached notes when anchorHeadingLevel changes", async () => {
    const h2h3Note = [
      "---",
      `source: "[[${SOURCE}]]"`,
      "format: epub",
      "---",
      "",
      `## [[${SOURCE}#${CFI_1}|H2 anchor]]`,
      "body",
      "",
      `### [[${SOURCE}#${CFI_2}|H3 anchor]]`,
      "deeper body",
    ].join("\n");
    const file = addMdFile("Reading/A.md", h2h3Note, NOTE_FRONTMATTER);
    fire("metadata", "changed", [file]);
    await settle();
    expect(
      plugin.getBookNote("Reading/A.md")?.sections.map((s) => s.fragment),
    ).toEqual([CFI_1]); // level 2: only the H2 heading anchors

    const toH3 = plugin.updateSettings({ anchorHeadingLevel: 3 });
    await settle();
    await toH3;
    expect(plugin.settings.anchorHeadingLevel).toBe(3);
    expect(
      plugin.getBookNote("Reading/A.md")?.sections.map((s) => s.fragment),
    ).toEqual([CFI_2]); // level 3: the H3 heading anchors instead

    const backToH2 = plugin.updateSettings({ anchorHeadingLevel: 2 });
    await settle();
    await backToH2;
    expect(
      plugin.getBookNote("Reading/A.md")?.sections.map((s) => s.fragment),
    ).toEqual([CFI_1]);
  });
});

describe("Booklore registrations from plugin onload", () => {
  const MANIFEST: PluginManifest = {
    id: "observation-car",
    name: "Observation Car",
    version: "0.1.0",
    minAppVersion: "1.7.2",
    description: "test manifest",
    author: "test",
    isDesktopOnly: false,
  };

  function makePlugin(storedData: unknown = {}): ObservationCarPlugin {
    const fake = makeFakeVault();
    const plugin = new ObservationCarPlugin(fake.app as App, MANIFEST);
    Object.assign(plugin, {
      loadData: async (): Promise<unknown> => storedData,
    });
    return plugin;
  }

  it("preserves the download index through an ordinary settings update", async () => {
    const { DEFAULT_SETTINGS } = await import("./settings");
    const downloadIndex = {
      "urn:booklore:book:92": {
        vaultPath: "Books/Surprised by Grace.epub",
        updated: "2026-09-11T12:00:00Z",
      },
    };
    const plugin = makePlugin({ ...DEFAULT_SETTINGS, downloadIndex });

    await plugin.onload();
    await plugin.updateSettings({ booksFolder: "Library" });

    const savedData = (plugin as unknown as { savedData: unknown[] }).savedData;
    expect(savedData.at(-1)).toMatchObject({
      booksFolder: "Library",
      downloadIndex,
    });
  });
});
