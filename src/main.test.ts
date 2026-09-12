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
import { ReaderRegistry } from "./sync/ReaderRegistry";

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
    registerView(viewType: string, factory: unknown): void {
      if (
        typeof this.app === "object" &&
        this.app !== null &&
        "registeredViews" in this.app
      ) {
        const app = this.app as {
          registeredViews: Map<string, (leaf: unknown) => unknown>;
        };
        app.registeredViews.set(
          viewType,
          factory as (leaf: unknown) => unknown,
        );
      }
    }
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
  EpubView: class {
    file: TFile | null = null;
    getViewType(): string {
      return "observation-car-epub";
    }
  },
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
  workspaceHandlers: Map<string, Handler>;
  registeredViews: Map<string, (leaf: unknown) => unknown>;
  leaves: Set<unknown>;
  leafQueries: { count: number };
  createdFiles: string[];
  generatedLinks: { filePath: string; sourcePath: string }[];
  openedFiles: string[];
  rootSplit: object;
  sidebarRoot: object;
  createdSplitLeaves: FakeLeaf[];
  runtime: {
    activeView: unknown;
    mostRecentMainLeaf: FakeLeaf | null;
    splitRootOverride: object | null;
    useMarkdownLinks: boolean;
  };
}

interface FakeLeaf {
  view: unknown;
  area: "main" | "sidebar";
  splitDirection?: "vertical" | "horizontal";
  splitFrom?: FakeLeaf;
  detached: boolean;
  detach(): void;
  getRoot(): object;
  openFile(file: TFile): Promise<void>;
}

function makeFakeVault(): FakeVault {
  const files = new Map<string, TFile>();
  const folders = new Set<string>();
  const contents = new Map<string, string>();
  const caches = new Map<string, { frontmatter: Record<string, unknown> | null }>();
  const linkDests = new Map<string, string>();
  const metadataHandlers = new Map<string, Handler>();
  const vaultHandlers = new Map<string, Handler>();
  const workspaceHandlers = new Map<string, Handler>();
  const registeredViews = new Map<string, (leaf: unknown) => unknown>();
  const leaves = new Set<unknown>();
  const leafQueries = { count: 0 };
  const createdFiles: string[] = [];
  const generatedLinks: { filePath: string; sourcePath: string }[] = [];
  const openedFiles: string[] = [];
  const rootSplit = {};
  const sidebarRoot = {};
  const createdSplitLeaves: FakeLeaf[] = [];
  const runtime = {
    activeView: null as unknown,
    mostRecentMainLeaf: null as FakeLeaf | null,
    splitRootOverride: null as object | null,
    useMarkdownLinks: false,
  };

  function makeLeaf(
    area: "main" | "sidebar",
    root: object,
    view: unknown = null,
  ): FakeLeaf {
    const leaf: FakeLeaf = {
      view,
      area,
      detached: false,
      detach: () => {
        leaf.detached = true;
      },
      getRoot: () => root,
      openFile: async (file: TFile): Promise<void> => {
        openedFiles.push(file.path);
        workspaceHandlers.get("file-open")?.(file);
      },
    };
    return leaf;
  }

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
      rootSplit,
      getActiveViewOfType: (): unknown => runtime.activeView,
      getMostRecentLeaf: (root?: object): FakeLeaf | null =>
        root === rootSplit ? runtime.mostRecentMainLeaf : null,
      on: (name: string, callback: Handler): { name: string } => {
        workspaceHandlers.set(name, callback);
        return { name };
      },
      getLeavesOfType: (viewType: string): unknown[] => {
        leafQueries.count += 1;
        return [...leaves].filter((leaf) => {
          if (
            typeof leaf !== "object" ||
            leaf === null ||
            !("view" in leaf)
          ) {
            return false;
          }
          const view = leaf.view;
          return (
            typeof view === "object" &&
            view !== null &&
            "getViewType" in view &&
            typeof view.getViewType === "function" &&
            view.getViewType() === viewType
          );
        });
      },
      getLeaf: (): { openFile: (file: TFile) => Promise<void> } => ({
        openFile: async (file: TFile): Promise<void> => {
          openedFiles.push(file.path);
        },
      }),
      createLeafBySplit: (
        sourceLeaf: FakeLeaf,
        direction: "vertical" | "horizontal",
      ): FakeLeaf => {
        const root =
          runtime.splitRootOverride ??
          (sourceLeaf.area === "main" ? rootSplit : sidebarRoot);
        const area = root === rootSplit ? "main" : "sidebar";
        const leaf = makeLeaf(area, root);
        leaf.splitDirection = direction;
        leaf.splitFrom = sourceLeaf;
        createdSplitLeaves.push(leaf);
        return leaf;
      },
    },
    registeredViews,
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
    workspaceHandlers,
    registeredViews,
    leaves,
    leafQueries,
    createdFiles,
    generatedLinks,
    openedFiles,
    rootSplit,
    sidebarRoot,
    createdSplitLeaves,
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
    fake = makeFakeVault();
    addBookFile(SOURCE);
    plugin = new ObservationCarPlugin(fake.app as App, MANIFEST);
    await plugin.onload();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    fake.linkDests.set(file.name.toLowerCase(), path);
    return file;
  }

  function fire(
    where: "metadata" | "vault" | "workspace",
    name: string,
    args: readonly unknown[],
  ): void {
    const handlers =
      where === "metadata"
        ? fake.metadataHandlers
        : where === "vault"
          ? fake.vaultHandlers
          : fake.workspaceHandlers;
    const handler = handlers.get(name);
    if (handler === undefined) {
      throw new Error(`no ${where} handler registered for "${name}"`);
    }
    handler(...args);
  }

  function openEpubReader(
    book: TFile,
    area: "main" | "sidebar" = "main",
  ): {
    leaf: FakeLeaf;
    view: { file: TFile | null; getViewType(): string };
  } {
    const factory = fake.registeredViews.get("observation-car-epub");
    if (factory === undefined) throw new Error("EPUB view was not registered");
    const root = area === "main" ? fake.rootSplit : fake.sidebarRoot;
    const leaf: FakeLeaf = {
      view: null,
      area,
      detached: false,
      detach: () => {
        leaf.detached = true;
      },
      getRoot: () => root,
      openFile: async (file: TFile): Promise<void> => {
        fake.openedFiles.push(file.path);
      },
    };
    const view = factory(leaf) as {
      file: TFile | null;
      getViewType(): string;
    };
    leaf.view = view;
    view.file = book;
    fake.leaves.add(leaf);
    fake.runtime.mostRecentMainLeaf = leaf;
    fire("workspace", "file-open", [book]);
    return { leaf, view };
  }

  function getCreateBookNoteCommand(): Command | undefined {
    const commands = (plugin as unknown as { commands: Command[] }).commands;
    return commands.find(
      (command) => command.id === "create-book-note-for-current-book",
    );
  }

  function getOpenBookNoteCommand(): Command | undefined {
    const commands = (plugin as unknown as { commands: Command[] }).commands;
    return commands.find(
      (command) => command.id === "open-book-note-beside-reader",
    );
  }

  async function settleCommand(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
  }

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

  it("preserves a literal author placeholder in the book filename", async () => {
    const source = "Books/Foo {{author}} Bar.epub";
    const book = addBookFile(source);
    fake.runtime.activeView = { file: book };

    const command = getCreateBookNoteCommand();
    expect(command).toBeDefined();
    if (command === undefined) return;
    expect(command.checkCallback?.(false)).toBe(true);
    await settleCommand();

    const notePath = "Reading/Foo {{author}} Bar.md";
    expect(fake.contents.get(notePath)).toBe(
      [
        "---",
        "type: book-note",
        'source: "[[Books/Foo {{author}} Bar.epub]]"',
        "format: epub",
        'title: "Foo {{author}} Bar"',
        'author: ""',
        "---",
        "",
      ].join("\n"),
    );
  });

  it("preserves a literal format placeholder in the book filename", async () => {
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
        "format: epub",
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

  it("opens a paired note beside its registered reader in the main area", async () => {
    fake.linkDests.set("surprised by grace.epub", SOURCE);
    const noteFile = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [noteFile]);
    await settle();

    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    const reader = openEpubReader(book);
    fake.runtime.activeView = { file: null };

    const command = getOpenBookNoteCommand();
    expect(command?.checkCallback?.(true)).toBe(true);
    expect(command?.checkCallback?.(false)).toBe(true);
    await settleCommand();

    expect(fake.openedFiles).toEqual(["Reading/A.md"]);
    expect(fake.createdSplitLeaves).toHaveLength(1);
    const noteLeaf = fake.createdSplitLeaves[0];
    expect(noteLeaf.area).toBe("main");
    expect(noteLeaf.getRoot()).toBe(fake.rootSplit);
    expect(noteLeaf.splitDirection).toBe("vertical");
    expect(noteLeaf.splitFrom).toBe(reader.leaf);
  });

  it("rejects a registered reader outside the main workspace root", async () => {
    await plugin.updateSettings({ autoOpenBookNote: true });
    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");

    openEpubReader(book, "sidebar");
    await settleCommand();

    expect(getOpenBookNoteCommand()?.checkCallback?.(true)).toBe(false);
    expect(fake.createdFiles).toEqual([]);
    expect(fake.createdSplitLeaves).toEqual([]);
    expect(fake.openedFiles).toEqual([]);
  });

  it("detaches a note split that resolves outside the main workspace root", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    openEpubReader(book);
    fake.runtime.splitRootOverride = fake.sidebarRoot;

    expect(getOpenBookNoteCommand()?.checkCallback?.(false)).toBe(true);
    await settleCommand();

    expect(fake.createdSplitLeaves).toHaveLength(1);
    const rejectedLeaf = fake.createdSplitLeaves[0];
    expect(rejectedLeaf.getRoot()).toBe(fake.sidebarRoot);
    expect(rejectedLeaf.detached).toBe(true);
    expect(fake.openedFiles).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      "[observation-car] could not open book note",
      expect.any(Error),
    );
  });

  it("hides the open-note command when the recent leaf is not a live reader", () => {
    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    const reader = openEpubReader(book);
    fake.leaves.delete(reader.leaf);

    expect(getOpenBookNoteCommand()?.checkCallback?.(true)).toBe(false);
    expect(fake.createdSplitLeaves).toEqual([]);
  });

  it("uses F1.5 creation when the reader has no existing note", async () => {
    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    openEpubReader(book);

    const command = getOpenBookNoteCommand();
    expect(command?.checkCallback?.(false)).toBe(true);
    await settleCommand();

    const notePath = "Reading/Surprised by Grace.md";
    expect(fake.createdFiles).toEqual([notePath]);
    expect(fake.contents.get(notePath)).toContain("type: book-note");
    expect(fake.openedFiles).toEqual([notePath]);
    expect(fake.createdSplitLeaves[0]?.area).toBe("main");
  });

  it("automatically opens or creates the note when a reader opens", async () => {
    await plugin.updateSettings({ autoOpenBookNote: true });
    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");

    const reader = openEpubReader(book);
    await settleCommand();

    expect(fake.createdFiles).toEqual(["Reading/Surprised by Grace.md"]);
    expect(fake.openedFiles).toEqual(["Reading/Surprised by Grace.md"]);
    expect(fake.createdSplitLeaves[0]?.splitFrom).toBe(reader.leaf);
    expect(fake.createdSplitLeaves[0]?.getRoot()).toBe(fake.rootSplit);
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
    await settle();

    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    const { leaf } = openEpubReader(book);
    expect(plugin.getReaderPairingForNote("Reading/A.md")?.leaf).toBe(leaf);

    fire("metadata", "changed", [file]);
    expect(vi.getTimerCount()).toBe(1); // the debounce window is pending
    const clear = vi.spyOn(ReaderRegistry.prototype, "clear");

    plugin.onunload();

    expect(clear).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(plugin.getBookNotePaths()).toEqual([]);
    expect(plugin.getReaderPairingForNote("Reading/A.md")).toBeUndefined();
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

  it("wires registered reader leaves to notes and removes closed leaves", async () => {
    fake.linkDests.set("surprised by grace.epub", SOURCE);
    const noteFile = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [noteFile]);
    await settle();

    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    const first = openEpubReader(book);
    expect(plugin.getReaderPairingForNote("Reading/A.md")?.leaf).toBe(
      first.leaf,
    );

    const second = openEpubReader(book);
    expect(plugin.getReaderPairingForNote("Reading/A.md")?.leaf).toBe(
      second.leaf,
    );

    // Re-focus and layout movement do not give the displaced leaf back
    // ownership: neither event changes leaf or file identity.
    fire("workspace", "active-leaf-change", [first.leaf]);
    fire("workspace", "layout-change", []);
    expect(plugin.getReaderPairingForNote("Reading/A.md")?.leaf).toBe(
      second.leaf,
    );

    fake.leaves.delete(second.leaf);
    fire("workspace", "layout-change", []);
    expect(plugin.getReaderPairingForNote("Reading/A.md")?.leaf).toBe(
      first.leaf,
    );

    fake.leaves.delete(first.leaf);
    fire("workspace", "layout-change", []);
    expect(plugin.getReaderPairingForNote("Reading/A.md")).toBeUndefined();
  });

  it.each(["layout-change", "file-open", "active-leaf-change"])(
    "refreshes reader pairings when workspace fires %s",
    async (eventName) => {
      fake.linkDests.set("surprised by grace.epub", SOURCE);
      const noteFile = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
      fire("metadata", "changed", [noteFile]);
      await settle();

      const book = fake.files.get(SOURCE);
      if (book === undefined) throw new Error("book fixture is missing");
      openEpubReader(book);
      const queriesBeforeEvent = fake.leafQueries.count;

      fire("workspace", eventName, []);

      expect(fake.leafQueries.count).toBe(queriesBeforeEvent + 1);
    },
  );
});
