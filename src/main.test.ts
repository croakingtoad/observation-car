// @vitest-environment jsdom
import {
  MarkdownView,
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
import { DEFAULT_SETTINGS } from "./settings";
import { ReaderRegistry } from "./sync/ReaderRegistry";
import { FocusModeController } from "./sync/focusMode";
import { currentSectionViewPlugin } from "./sync/currentSectionDecoration";
import {
  DEFAULT_SCROLL_DEBOUNCE_MS,
  DEFAULT_TYPING_IDLE_MS,
  ScrollSync,
  type LocationChanged,
} from "./sync/scrollSync";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { focusModeViewPlugin, setFocusModeDecoration, setFocusSectionsDecoration } from "./sync/focusModeDecoration";

const noticeMessages = vi.hoisted((): string[] => []);

interface RecordedCommand {
  id: string;
  name: string;
  icon?: string;
  hotkeys?: Array<{ modifiers: string[]; key: string }>;
  editorCallback?: (editor: unknown, context: unknown) => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
  callback?: () => void
}

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
    editorExtensions: unknown[] = [];
    registeredCleanups: Array<() => void> = [];
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
    registerEditorExtension(extension: unknown): void {
      this.editorExtensions.push(extension);
    }
    register(cleanup: () => void): void {
      this.registeredCleanups.push(cleanup);
    }
    addCommand(command: RecordedCommand): RecordedCommand {
      this.commands.push(command);
      if (
        typeof this.app === "object" &&
        this.app !== null &&
        "registeredCommands" in this.app
      ) {
        const app = this.app as {
          registeredCommands: Map<string, typeof command>;
        };
        app.registeredCommands.set(command.id, command);
      }
      return command;
    }
    addSettingTab(_tab: unknown): void {}
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
  class FileView {}
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
  class TFolder {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
  }
  class Notice {
    constructor(message: string) {
      noticeMessages.push(message);
    }
  }
  const normalizePath = (path: string): string =>
    path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\//, "");
  return {
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    FileView,
    TFile,
    TFolder,
    MarkdownView,
    normalizePath,
  };
});

vi.mock("./readers/EpubView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./readers/EpubView")>();

  return {
    EPUB_VIEW_TYPE: "observation-car-epub",
    EpubView: class {
    file: TFile | null = null;
    openedFragments: string[] = [];
    stylesheetToggleCount = 0;
    private readonly listeners = new Set<
      (location: LocationChanged) => void
    >();
    private readonly relocationListeners = new Set<
      (location: {
        start: { href: string; cfi: string };
        end: { href: string; cfi: string };
      }) => void
    >();
    private readonly book = {
      spine: { get: (target: string) => ({ href: target }) },
    };
    private readonly rendition = {
      epubcfi: { compare: () => 0 },
      on: (
        _event: "relocated",
        listener: (location: {
          start: { href: string; cfi: string };
          end: { href: string; cfi: string };
        }) => void,
      ) => {
        this.relocationListeners.add(listener);
      },
      off: (
        _event: "relocated",
        listener: (location: {
          start: { href: string; cfi: string };
          end: { href: string; cfi: string };
        }) => void,
      ) => {
        this.relocationListeners.delete(listener);
      },
      display: async (target: string) => {
        const location = {
          start: { href: target, cfi: target },
          end: { href: target, cfi: target },
        };
        for (const listener of [...this.relocationListeners]) listener(location);
      },
    };
    getViewType(): string {
      return "observation-car-epub";
    }
    on(
      _event: "location",
      listener: (location: LocationChanged) => void,
    ): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    emitLocation(fragment: string): void {
      if (this.file === null) return;
      const location: LocationChanged = {
        file: this.file,
        fragment,
        chapter: 0,
        label: "Chapter",
      };
      for (const listener of [...this.listeners]) listener(location);
    }
    async openAtFragment(fragment: string): Promise<void> {
      this.openedFragments.push(fragment);
      void this.book;
      void this.rendition;
      await actual.EpubView.prototype.openAtFragment.call(this, fragment);
    }
    async toggleBookStylesheet(): Promise<void> {
      this.stylesheetToggleCount += 1;
    }
    },
  };
});

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

const MarkdownViewDouble = MarkdownView as unknown as new (
  file: TFile | null,
  editor: unknown,
) => MarkdownView;

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
  registeredCommands: Map<string, RecordedCommand>;
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
    getViewState(): { type: string };
    loadIfDeferred(): Promise<void>;
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
  const registeredCommands = new Map<string, RecordedCommand>();
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
        if (
          typeof leaf.view === "object" &&
          leaf.view !== null &&
          "file" in leaf.view
        ) {
          (leaf.view as { file: TFile | null }).file = file;
        }
      },
      getViewState: (): { type: string } => ({ type: "markdown" }),
      loadIfDeferred: async (): Promise<void> => {},
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
      openLinkText: vi.fn(),
      getActiveViewOfType: (): unknown => runtime.activeView,
      getMostRecentLeaf: (root?: object): FakeLeaf | null =>
        root === undefined || root === rootSplit
          ? runtime.mostRecentMainLeaf
          : null,
      on: (name: string, callback: Handler): { name: string } => {
        const previous = workspaceHandlers.get(name);
        workspaceHandlers.set(name, (...args: unknown[]) => {
          previous?.(...args);
          callback(...args);
        });
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
      getLeaf: (newLeaf?: "split"): FakeLeaf => {
        const leaf = makeLeaf("main", rootSplit);
        leaf.view = {
          file: null,
          getViewType: (): string => "markdown",
        };
        if (newLeaf === "split") createdSplitLeaves.push(leaf);
        leaves.add(leaf);
        return leaf;
      },
      revealLeaf: async (leaf: FakeLeaf): Promise<void> => {
        runtime.mostRecentMainLeaf = leaf;
      },
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
    registeredCommands,
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
    registeredCommands,
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
  const FIRST_SAVED_CFI = "#epubcfi(/6/2!/4/2/1:0)";
  const SECOND_SAVED_CFI = "#epubcfi(/6/8!/4/2/1:0)";

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
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    noticeMessages.length = 0;
    fake = makeFakeVault();
    addBookFile(SOURCE);
    fake.linkDests.set(SOURCE.toLowerCase(), SOURCE);
    plugin = new ObservationCarPlugin(fake.app as App, MANIFEST);
    await plugin.onload();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
    options: { deferredView?: boolean } = {},
  ): {
    leaf: FakeLeaf;
    view: {
      file: TFile | null;
      getViewType(): string;
      emitLocation(fragment: string): void;
      openAtFragment(fragment: string): Promise<void>;
      openedFragments: string[];
      toggleBookStylesheet(): Promise<void>;
      stylesheetToggleCount: number;
    };
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
      getViewState: (): { type: string } => ({
        type: "observation-car-epub",
      }),
      loadIfDeferred: async (): Promise<void> => {},
    };
    const view = factory(leaf) as {
      file: TFile | null;
      getViewType(): string;
      emitLocation(fragment: string): void;
      openAtFragment(fragment: string): Promise<void>;
      openedFragments: string[];
      toggleBookStylesheet(): Promise<void>;
      stylesheetToggleCount: number;
    };
    leaf.view = view;
    if (options.deferredView === true) {
      view.file = null;
      leaf.loadIfDeferred = async (): Promise<void> => {
        view.file = book;
      };
    } else {
      view.file = book;
    }
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

  function getJumpToSectionCommand(): RecordedCommand | undefined {
    return fake.registeredCommands.get("jump-book-to-this-section");
  }

  async function settleCommand(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
  }

  async function invokeCreateBookNoteForTesting(): Promise<void> {
    const command = getCreateBookNoteCommand();
    if (command === undefined) {
      throw new Error("Create book note command was not registered");
    }
    command.callback?.();
    await settleCommand();
  }

  function makePersistencePlugin(stored: unknown = undefined): {
    persistencePlugin: ObservationCarPlugin & {
      registeredCleanups: Array<() => void>;
    };
    saves: unknown[];
  } {
    const persistenceFake = makeFakeVault();
    const persistencePlugin = new ObservationCarPlugin(
      persistenceFake.app as App,
      MANIFEST,
    ) as ObservationCarPlugin & {
      registeredCleanups: Array<() => void>;
    };
    const saves: unknown[] = [];
    vi.spyOn(persistencePlugin, "loadData").mockResolvedValue(stored);
    vi.spyOn(persistencePlugin, "saveData").mockImplementation(
      async (data: unknown) => {
        saves.push(JSON.parse(JSON.stringify(data)) as unknown);
      },
    );
    return { persistencePlugin, saves };
  }

  it("installs the EPUB link handler and registers its cleanup during load", async () => {
    const { persistencePlugin } = makePersistencePlugin();
    const workspace = persistencePlugin.app.workspace;
    const originalOpenLinkText = workspace.openLinkText;

    await persistencePlugin.onload();

    expect(workspace.openLinkText).not.toBe(originalOpenLinkText);
    expect(persistencePlugin.registeredCleanups).toHaveLength(1);
    persistencePlugin.registeredCleanups[0]();
    expect(workspace.openLinkText).toBe(originalOpenLinkText);
  });

  it("registers New note here for the command palette and mobile toolbar", () => {
    expect(fake.registeredCommands.get("new-note-here")).toMatchObject({
      name: "New note here",
      icon: "square-pen",
      hotkeys: [{ modifiers: ["Alt"], key: "N" }],
    });
  });

  it("writes a fresh snapshot when state changes during an in-flight save", async () => {
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const { persistencePlugin, saves } = makePersistencePlugin();
    vi.mocked(persistencePlugin.saveData).mockImplementation(
      async (data: unknown) => {
        saves.push(JSON.parse(JSON.stringify(data)) as unknown);
        if (saves.length === 1) await firstSaveGate;
      },
    );
    await persistencePlugin.onload();

    const firstRemember = persistencePlugin.rememberEpubLocation(
      "Books/One.epub",
      FIRST_SAVED_CFI,
    );
    await vi.waitFor(() => expect(saves).toHaveLength(1));
    const secondRemember = persistencePlugin.rememberEpubLocation(
      "Books/Two.epub",
      SECOND_SAVED_CFI,
    );

    if (releaseFirstSave === undefined) throw new Error("The first save did not start");
    releaseFirstSave();
    await Promise.all([firstRemember, secondRemember]);

    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({
      epubLastLocations: {
        "Books/One.epub": FIRST_SAVED_CFI,
        "Books/Two.epub": SECOND_SAVED_CFI,
      },
    });
  });

  it("round-trips a remembered CFI through the serialized data.json shape", async () => {
    const firstLoad = makePersistencePlugin();
    await firstLoad.persistencePlugin.onload();
    await firstLoad.persistencePlugin.rememberEpubLocation(
      "Books/One.epub",
      FIRST_SAVED_CFI,
    );

    expect(firstLoad.persistencePlugin.getLastEpubLocation("Books/One.epub")).toBe(
      FIRST_SAVED_CFI,
    );
    expect(firstLoad.saves).toHaveLength(1);

    const reload = makePersistencePlugin(firstLoad.saves[0]);
    await reload.persistencePlugin.onload();
    expect(reload.persistencePlugin.getLastEpubLocation("Books/One.epub")).toBe(
      FIRST_SAVED_CFI,
    );
  });

  it("round-trips a per-book stylesheet mode through plugin data", async () => {
    const firstLoad = makePersistencePlugin();
    await firstLoad.persistencePlugin.onload();
    expect(firstLoad.persistencePlugin.getEpubStylesheetMode("Books/One.epub")).toBe(
      "theme",
    );

    await firstLoad.persistencePlugin.setEpubStylesheetMode(
      "Books/One.epub",
      "book",
    );
    expect(firstLoad.saves.at(-1)).toMatchObject({
      epubStylesheetModes: { "Books/One.epub": "book" },
    });

    const reload = makePersistencePlugin(firstLoad.saves.at(-1));
    await reload.persistencePlugin.onload();
    expect(reload.persistencePlugin.getEpubStylesheetMode("Books/One.epub")).toBe(
      "book",
    );

    await reload.persistencePlugin.setEpubStylesheetMode(
      "Books/One.epub",
      "theme",
    );
    expect(reload.saves.at(-1)).toMatchObject({ epubStylesheetModes: {} });
  });

  it("moves a book stylesheet mode on rename and drops it on delete", async () => {
    await plugin.setEpubStylesheetMode(SOURCE, "book");
    const renamedPath = "Books/Renamed.epub";
    const renamed = new TFileDouble(renamedPath, "epub");
    fake.files.delete(SOURCE);
    fake.files.set(renamedPath, renamed);

    fire("vault", "rename", [renamed, SOURCE]);

    expect(plugin.getEpubStylesheetMode(SOURCE)).toBe("theme");
    expect(plugin.getEpubStylesheetMode(renamedPath)).toBe("book");

    fake.files.delete(renamedPath);
    fire("metadata", "deleted", [renamed]);

    expect(plugin.getEpubStylesheetMode(renamedPath)).toBe("theme");
    await settleCommand();
    expect(
      (plugin as unknown as { savedData: unknown[] }).savedData.at(-1),
    ).toMatchObject({ epubStylesheetModes: {} });
  });

  it("moves a remembered EPUB location on rename", async () => {
    await plugin.rememberEpubLocation(SOURCE, FIRST_SAVED_CFI);
    const renamedPath = "Books/Renamed.epub";
    const renamed = new TFileDouble(renamedPath, "epub");
    fake.files.delete(SOURCE);
    fake.files.set(renamedPath, renamed);

    fire("vault", "rename", [renamed, SOURCE]);

    expect(plugin.getLastEpubLocation(SOURCE)).toBeNull();
    expect(plugin.getLastEpubLocation(renamedPath)).toBe(FIRST_SAVED_CFI);
    await settleCommand();
    expect(
      (plugin as unknown as { savedData: unknown[] }).savedData.at(-1),
    ).toMatchObject({
      epubLastLocations: { [renamedPath]: FIRST_SAVED_CFI },
    });
  });

  it("drops a remembered EPUB location on delete", async () => {
    await plugin.rememberEpubLocation(SOURCE, FIRST_SAVED_CFI);
    const deleted = fake.files.get(SOURCE);
    expect(deleted).toBeDefined();
    if (deleted === undefined) return;
    fake.files.delete(SOURCE);

    fire("metadata", "deleted", [deleted]);

    expect(plugin.getLastEpubLocation(SOURCE)).toBeNull();
    await settleCommand();
    expect(
      (plugin as unknown as { savedData: unknown[] }).savedData.at(-1),
    ).toMatchObject({ epubLastLocations: {} });
  });

  it("does not attach stale destination state to a renamed default-mode book", async () => {
    const renamedPath = "Books/Reused.epub";
    await plugin.setEpubStylesheetMode(renamedPath, "book");
    const renamed = new TFileDouble(renamedPath, "epub");

    fire("vault", "rename", [renamed, SOURCE]);

    expect(plugin.getEpubStylesheetMode(renamedPath)).toBe("theme");
    await settleCommand();
    expect(
      (plugin as unknown as { savedData: unknown[] }).savedData.at(-1),
    ).toMatchObject({ epubStylesheetModes: {} });
  });

  it("suppresses only an identical location rewrite", async () => {
    const { persistencePlugin, saves } = makePersistencePlugin();
    await persistencePlugin.onload();

    await persistencePlugin.rememberEpubLocation("Books/One.epub", FIRST_SAVED_CFI);
    await persistencePlugin.rememberEpubLocation("Books/One.epub", FIRST_SAVED_CFI);
    expect(saves).toHaveLength(1);

    await persistencePlugin.rememberEpubLocation("Books/One.epub", SECOND_SAVED_CFI);
    expect(saves).toHaveLength(2);
    expect(persistencePlugin.getLastEpubLocation("Books/One.epub")).toBe(
      SECOND_SAVED_CFI,
    );
  });

  it("preserves flat settings and other book keys without persisting note content", async () => {
    const noteContent = "## Private reading note\nThis belongs in the vault.";
    const { persistencePlugin, saves } = makePersistencePlugin({
      ...DEFAULT_SETTINGS,
      booksFolder: "Library/Books",
      opdsUsername: "reader",
      epubLastLocations: { "Library/Other.epub": FIRST_SAVED_CFI },
      noteContent,
    });
    await persistencePlugin.onload();

    await persistencePlugin.rememberEpubLocation(
      "Library/New.epub",
      SECOND_SAVED_CFI,
    );

    expect(saves).toEqual([
      {
        ...DEFAULT_SETTINGS,
        booksFolder: "Library/Books",
        opdsUsername: "reader",
        epubLastLocations: {
          "Library/Other.epub": FIRST_SAVED_CFI,
          "Library/New.epub": SECOND_SAVED_CFI,
        },
        epubStylesheetModes: {},
      },
    ]);
    expect(JSON.stringify(saves[0])).not.toContain(
      JSON.stringify(noteContent).slice(1, -1),
    );
  });

  it("registers the mobile-capable command without writing on plugin load", async () => {
    const command = getCreateBookNoteCommand();
    expect(command).toBeDefined();
    if (command === undefined) return;

    expect(command.name).toBe("Create book note for current book");
    expect(command.icon).toBe("book-open");
    expect(command.hotkeys).toBeUndefined();
    expect(command.checkCallback).toBeUndefined();
    expect(command.callback).toBeTypeOf("function");
    await settleCommand();
    expect(fake.createdFiles).toEqual([]);
  });

  it("always lists the book-stylesheet toggle and notices when no book is open", async () => {
    const command = fake.registeredCommands.get("toggle-book-stylesheet");

    expect(command).toMatchObject({
      name: "Toggle book stylesheet for this book",
      callback: expect.any(Function),
    });
    expect(command?.checkCallback).toBeUndefined();

    command?.callback?.();
    await settleCommand();
    expect(noticeMessages).toContain("Open a book in Observation Car first");
  });

  it("toggles the active reader first, then the most recently active open reader", async () => {
    const command = fake.registeredCommands.get("toggle-book-stylesheet");
    const firstBook = addBookFile("Books/One.epub");
    const secondBook = addBookFile("Books/Two.epub");
    const first = openEpubReader(firstBook);
    const second = openEpubReader(secondBook);

    fake.runtime.activeView = null;
    fire("workspace", "active-leaf-change", [first.leaf]);
    fire("workspace", "active-leaf-change", [second.leaf]);
    command?.callback?.();
    await settleCommand();
    expect(second.view.stylesheetToggleCount).toBe(1);
    expect(first.view.stylesheetToggleCount).toBe(0);

    fake.runtime.activeView = first.view;
    command?.callback?.();
    await settleCommand();
    expect(first.view.stylesheetToggleCount).toBe(1);
    expect(second.view.stylesheetToggleCount).toBe(1);
  });

  // LOCO-490 W1: MRU rung guard must survive leaf close.
  it("favours the surviving MRU reader when the top MRU view's leaf is closed", async () => {
    const command = fake.registeredCommands.get("toggle-book-stylesheet");
    const firstBook = addBookFile("Books/One.epub");
    const secondBook = addBookFile("Books/Two.epub");
    const first = openEpubReader(firstBook);
    const second = openEpubReader(secondBook);

    fake.runtime.activeView = null;
    fire("workspace", "active-leaf-change", [first.leaf]);
    fire("workspace", "active-leaf-change", [second.leaf]);

    // Close the MRU reader's leaf.
    fake.leaves.delete(second.leaf);

    command?.callback?.();
    await settleCommand();
    expect(first.view.stylesheetToggleCount).toBe(1);
    expect(second.view.stylesheetToggleCount).toBe(0);
  });

  // LOCO-490 W2: rung 3 (first valid leaf) must resolve with no active view
  // and no MRU entry.
  it("reaches an open EPUB that was never activated via the first-leaf fallback", async () => {
    const command = fake.registeredCommands.get("toggle-book-stylesheet");
    const book = addBookFile("Books/Fallback.epub");

    fake.runtime.activeView = { file: null };
    const { view } = openEpubReader(book);

    command?.callback?.();
    await settleCommand();
    expect(view.stylesheetToggleCount).toBe(1);
    expect(noticeMessages).not.toContain("Open a book in Observation Car first");
  });

  it("registers the current-section CM6 view plugin", () => {
    const extensions = (
      plugin as unknown as { editorExtensions: unknown[] }
    ).editorExtensions;

    expect(extensions).toContain(currentSectionViewPlugin);
    expect(extensions).toContain(focusModeViewPlugin);
  });

  it("registers the reader/note split-ratio toggle command", () => {
    const command = fake.registeredCommands.get(
      "toggle-reader-note-split-ratio",
    );

    expect(command?.name).toBe("Toggle reader/note split ratio");
    expect(command?.checkCallback).toBeTypeOf("function");
  });
  it("registers the toggle-focus-mode command", () => {
    const command = fake.registeredCommands.get(
      "toggle-focus-mode",
    );
    expect(command).toBeDefined();
    expect(command?.name).toBe("Toggle focus mode");

    const toggle = vi.spyOn(
      plugin as unknown as { toggleFocusMode: () => void },
      "toggleFocusMode",
    );
    command?.callback?.();
    expect(toggle).toHaveBeenCalled();
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
    command.callback?.();
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
      command.callback?.();
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
    command.callback?.();
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

  it("preserves a literal author placeholder in the book filename", async () => {
    const source = "Books/Foo {{author}} Bar.epub";
    const book = addBookFile(source);
    fake.runtime.activeView = { file: book };

    const command = getCreateBookNoteCommand();
    expect(command).toBeDefined();
    if (command === undefined) return;
    command.callback?.();
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
    command.callback?.();
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
    command.callback?.();
    await settleCommand();

    expect(fake.createdFiles).toEqual([]);
    expect(fake.contents.get(notePath)).toBe("sentinel — keep me");
    expect(fake.openedFiles).toEqual([notePath]);
    expect(fake.generatedLinks).toEqual([]);
  });

  it("reopens book A's note while book B is also open", async () => {
    const bookA = addBookFile("Books/A.epub");
    const bookB = addBookFile("Books/B.epub");
    const { leaf: firstLeaf } = openEpubReader(bookA);
    openEpubReader(bookB);

    fake.runtime.activeView = { file: bookA };
    await invokeCreateBookNoteForTesting();
    expect(fake.createdFiles).toEqual(["Reading/A.md"]);

    fake.runtime.activeView = { file: null };
    fake.runtime.mostRecentMainLeaf = firstLeaf;
    await invokeCreateBookNoteForTesting();

    expect(fake.createdFiles).toEqual(["Reading/A.md"]);
    expect(fake.openedFiles).toEqual(["Reading/A.md"]);
    expect(fake.runtime.mostRecentMainLeaf).toBe(fake.createdSplitLeaves[0]);
    expect(noticeMessages).toEqual([]);
  });

  it("resolves the most recently active reader when the active view is not a file-backed reader", async () => {
    const firstBook = addBookFile("Books/One.epub");
    const secondBook = addBookFile("Books/Two.epub");
    openEpubReader(firstBook);
    const second = openEpubReader(secondBook, "main", { deferredView: true });
    fake.runtime.activeView = { file: null };
    fake.runtime.mostRecentMainLeaf = second.leaf;

    await invokeCreateBookNoteForTesting();

    expect(fake.createdFiles).toEqual(["Reading/Two.md"]);
    expect(fake.openedFiles).toEqual(["Reading/Two.md"]);
  });

  it("names both books when neither open reader can be disambiguated", async () => {
    addBookFile("Books/A.epub");
    addBookFile("Books/B.epub");
    openEpubReader(fake.files.get("Books/A.epub") as TFile);
    openEpubReader(fake.files.get("Books/B.epub") as TFile);
    fake.runtime.activeView = { file: null };
    fake.runtime.mostRecentMainLeaf = null;

    await invokeCreateBookNoteForTesting();

    expect(noticeMessages).toEqual([
      "Multiple books are open: A, B. Click the book you want, then run Create book note again.",
    ]);
    expect(fake.createdFiles).toEqual([]);
  });

  it("reveals an already open book note instead of splitting another pane", async () => {
    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    fake.runtime.activeView = { file: book };

    for (let index = 0; index < 5; index += 1) {
      await invokeCreateBookNoteForTesting();
    }

    const notePath = "Reading/Surprised by Grace.md";
    expect(fake.createdFiles).toEqual([notePath]);
    expect(fake.createdSplitLeaves).toHaveLength(1);
    expect(fake.openedFiles).toEqual([notePath]);
    expect(fake.runtime.mostRecentMainLeaf).toBe(fake.createdSplitLeaves[0]);
  });

  it("notices when no reader is available instead of splitting a note", async () => {
    fake.runtime.activeView = { file: null };
    fake.runtime.mostRecentMainLeaf = null;

    await invokeCreateBookNoteForTesting();

    expect(noticeMessages).toContain("Open a book in Observation Car first");
    expect(fake.createdFiles).toEqual([]);
    expect(fake.createdSplitLeaves).toEqual([]);
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

  it("shows a readable notice when no book note is open", async () => {
    const command = getJumpToSectionCommand();
    if (command?.editorCallback === undefined) {
      throw new Error("jump-to-section editor command was not registered");
    }

    command.editorCallback({}, { file: null });
    await settleCommand();

    expect(noticeMessages).toEqual([
      "Open a book note before jumping to one of its sections.",
    ]);
  });

  it("navigates F4.7 through the shipped EpubView.openAtFragment implementation", async () => {
    const noteFile = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [noteFile]);
    await settle();

    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    const { view } = openEpubReader(book);
    const liveCfi = "epubcfi(/6/10!/4/2/4:0)";
    const liveText = NOTE_TEXT.replace(CFI_1, liveCfi);
    const command = getJumpToSectionCommand();

    expect(command?.name).toBe("Jump book to this section");
    if (command?.editorCallback === undefined) {
      throw new Error("jump-to-section editor command was not registered");
    }
    for (const line of [6, 8, 9, 10]) {
      command.editorCallback(
        {
          getCursor: () => ({ line, ch: 0 }),
          getValue: () => liveText,
        },
        { file: noteFile },
      );
      await settleCommand();
    }

    expect(view.openedFragments).toEqual([
      liveCfi,
      liveCfi,
      CFI_2,
      CFI_2,
    ]);
    expect(noticeMessages).toEqual([]);
  });

  it("refuses to navigate when the live source differs from the pairing", async () => {
    const noteFile = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [noteFile]);
    await settle();

    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    const markdownView = new MarkdownViewDouble(
      noteFile,
      {
        hasFocus: () => true,
        lineCount: () => 20,
        scrollIntoView: vi.fn(),
      },
    );
    const markdownLeaf: FakeLeaf = {
      view: markdownView,
      area: "main",
      detached: false,
      detach: () => {
        markdownLeaf.detached = true;
      },
      getRoot: () => fake.rootSplit,
      openFile: async (): Promise<void> => {},
      getViewState: (): { type: string } => ({ type: "markdown" }),
      loadIfDeferred: async (): Promise<void> => {},
    };
    fake.leaves.add(markdownLeaf);
    const { view } = openEpubReader(book);
    const retargetedSource = "Books/Retargeted.epub";
    addBookFile(retargetedSource);
    const liveText = NOTE_TEXT.replaceAll(SOURCE, retargetedSource);
    const command = getJumpToSectionCommand();
    if (command?.editorCallback === undefined) {
      throw new Error("jump-to-section editor command was not registered");
    }

    command.editorCallback(
      {
        getCursor: () => ({ line: 7, ch: 0 }),
        getValue: () => liveText,
      },
      { file: noteFile },
    );
    await settleCommand();

    expect(view.openedFragments).toEqual([]);
    expect(noticeMessages).toEqual([
      "The note's current source does not match the paired reader.",
    ]);
  });

  it("shows a readable notice when the cursor is outside every section", async () => {
    const noteFile = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [noteFile]);
    await settle();

    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    const { view } = openEpubReader(book);
    const command = getJumpToSectionCommand();
    if (command?.editorCallback === undefined) {
      throw new Error("jump-to-section editor command was not registered");
    }

    command.editorCallback(
      {
        getCursor: () => ({ line: 5, ch: 0 }),
        getValue: () => NOTE_TEXT,
      },
      { file: noteFile },
    );
    await settleCommand();

    expect(view.openedFragments).toEqual([]);
    expect(noticeMessages).toEqual([
      "The cursor is not inside an anchored book-note section.",
    ]);
  });

  it("shows a readable notice when the note has no paired reader", async () => {
    const noteFile = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [noteFile]);
    await settle();

    const command = getJumpToSectionCommand();
    if (command?.editorCallback === undefined) {
      throw new Error("jump-to-section editor command was not registered");
    }
    command.editorCallback(
      {
        getCursor: () => ({ line: 7, ch: 0 }),
        getValue: () => NOTE_TEXT,
      },
      { file: noteFile },
    );
    await settleCommand();

    expect(noticeMessages).toEqual([
      "Open the book paired with this note before jumping to its section.",
    ]);
  });

  it("shows a readable notice when the paired reader cannot open fragments", async () => {
    const noteFile = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [noteFile]);
    await settle();

    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    const { view } = openEpubReader(book);
    Object.defineProperty(view, "openAtFragment", { value: undefined });
    const command = getJumpToSectionCommand();
    if (command?.editorCallback === undefined) {
      throw new Error("jump-to-section editor command was not registered");
    }

    command.editorCallback(
      {
        getCursor: () => ({ line: 7, ch: 0 }),
        getValue: () => NOTE_TEXT,
      },
      { file: noteFile },
    );
    await settleCommand();

    expect(view.openedFragments).toEqual([]);
    expect(noticeMessages).toEqual([
      "The paired reader cannot open anchored sections.",
    ]);
  });

  it("contains a paired reader navigation failure at the command boundary", async () => {
    const noteFile = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [noteFile]);
    await settle();

    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    const { view } = openEpubReader(book);
    const navigationError = new Error("reader failed");
    view.openAtFragment = vi.fn().mockRejectedValue(navigationError);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const command = getJumpToSectionCommand();
    if (command?.editorCallback === undefined) {
      throw new Error("jump-to-section editor command was not registered");
    }

    command.editorCallback(
      {
        getCursor: () => ({ line: 7, ch: 0 }),
        getValue: () => NOTE_TEXT,
      },
      { file: noteFile },
    );
    await settleCommand();

    expect(consoleError).toHaveBeenCalledWith(
      "[observation-car] could not jump book to note section",
      navigationError,
    );
    expect(noticeMessages).toEqual([
      "Could not jump to this section. Check the developer console for details.",
    ]);
  });

  it("registers an explicit, idempotent section-sort editor command", () => {
    const command = fake.registeredCommands.get(
      "sort-sections-by-book-position",
    );
    expect(command?.name).toBe("Sort sections by book position");
    if (command?.editorCallback === undefined) {
      throw new Error("section-sort editor command was not registered");
    }

    const handReordered = [
      "---",
      `source: "[[${SOURCE}]]"`,
      "format: epub",
      "---",
      "Preamble stays put.",
      `## [[${SOURCE}#${CFI_2}|Later]]`,
      "later body",
      `## [[${SOURCE}#${CFI_1}|Earlier]]`,
      "earlier body",
    ].join("\n");
    const expected = [
      "---",
      `source: "[[${SOURCE}]]"`,
      "format: epub",
      "---",
      "Preamble stays put.",
      `## [[${SOURCE}#${CFI_1}|Earlier]]`,
      "earlier body",
      `## [[${SOURCE}#${CFI_2}|Later]]`,
      "later body",
    ].join("\n");
    const noteFile = addMdFile(
      "Reading/A.md",
      handReordered,
      NOTE_FRONTMATTER,
    );
    let editorText = handReordered;
    const setValue = vi.fn((value: string) => {
      editorText = value;
    });
    const editor = {
      getValue: (): string => editorText,
      setValue,
    };

    command.editorCallback(editor, { file: noteFile });
    expect(editorText).toBe(expected);
    expect(setValue).toHaveBeenCalledOnce();

    command.editorCallback(editor, { file: noteFile });
    expect(editorText).toBe(expected);
    expect(setValue).toHaveBeenCalledOnce();
  });

  it("does not run the section-sort command without a backing file", () => {
    const command = fake.registeredCommands.get(
      "sort-sections-by-book-position",
    );
    if (command?.editorCallback === undefined) {
      throw new Error("section-sort editor command was not registered");
    }
    const getValue = vi.fn(() => NOTE_TEXT);
    const setValue = vi.fn();

    command.editorCallback({ getValue, setValue }, { file: undefined });

    expect(getValue).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
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

  it("scrolls the paired note on location without focus and resumes after typing idle", async () => {
    fake.linkDests.set("surprised by grace.epub", SOURCE);
    const noteFile = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [noteFile]);
    await settle();

    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const editor = {
      lineCount: () => 20,
      scrollIntoView,
      focus,
      hasFocus: () => true,
    };
    const markdownView = new MarkdownViewDouble(noteFile, editor);
    const markdownLeaf: FakeLeaf = {
      view: markdownView,
      area: "main",
      detached: false,
      detach: () => {
        markdownLeaf.detached = true;
      },
      getRoot: () => fake.rootSplit,
      openFile: async (): Promise<void> => {},
      getViewState: (): { type: string } => ({ type: "markdown" }),
      loadIfDeferred: async (): Promise<void> => {},
    };
    fake.leaves.add(markdownLeaf);

    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    const { view } = openEpubReader(book);

    view.emitLocation(`#${CFI_1}`);
    await vi.advanceTimersByTimeAsync(DEFAULT_SCROLL_DEBOUNCE_MS);
    expect(scrollIntoView).toHaveBeenCalledWith(
      {
        from: { line: 6, ch: 0 },
        to: { line: 6, ch: 0 },
      },
      false,
    );
    expect(focus).not.toHaveBeenCalled();

    fire("workspace", "editor-change", [editor, markdownView]);
    view.emitLocation(`#${CFI_2}`);
    await vi.advanceTimersByTimeAsync(DEFAULT_TYPING_IDLE_MS - 1);
    expect(scrollIntoView).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView).toHaveBeenLastCalledWith(
      {
        from: { line: 9, ch: 0 },
        to: { line: 9, ch: 0 },
      },
      false,
    );
    expect(focus).not.toHaveBeenCalled();
  });

  it("notices missing pairing or editor when toggling focus mode", async () => {
    expect(plugin.toggleFocusMode()).toBeUndefined();
    expect(noticeMessages).toEqual([
      "Open or create this book's note before toggling focus mode.",
    ]);

    noticeMessages.length = 0;
    fake.linkDests.set("surprised by grace.epub", SOURCE);
    const noteFile = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [noteFile]);
    await settle();

    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    openEpubReader(book);
    plugin.toggleFocusMode();
    expect(noticeMessages).toEqual([
      "Open this book's note before toggling focus mode.",
    ]);
  });


  it("notices spine-href-only note cannot be focused", async () => {
    fake.linkDests.set("surprised by grace.epub", "Books/Surprised by Grace.epub");
    const noteFile = addMdFile("Reading/SpineNote.md", '---\ntype: book-note\nsource: "[[Books/Surprised by Grace.epub]]"\nformat: epub\n---\n\n## [[Books/Surprised by Grace.epub#text/chapter1.xhtml|Ch. 1]]\nbody one\n\n## [[Books/Surprised by Grace.epub#text/chapter2.xhtml|Ch. 2]]\nbody two', { type: "book-note", source: `[[Books/Surprised by Grace.epub]]`, format: "epub" });
    fire("metadata", "changed", [noteFile]);
    await settle();

    const book = fake.files.get("Books/Surprised by Grace.epub");
    if (book === undefined) throw new Error("book fixture is missing");
    const markdownView = new MarkdownViewDouble(
      noteFile,
      {
        hasFocus: () => true,
        getViewType: () => "markdown",
        lineCount: () => 20,
        scrollIntoView: vi.fn(),
      },
    );
    fake.leaves.add({ view: markdownView });
    openEpubReader(book);
    noticeMessages.length = 0;
    plugin.toggleFocusMode();

    expect(noticeMessages).toEqual([
      "Focus mode needs CFI anchors; this note\'s anchors are chapter hrefs.",
    ]);
  });

  it("focuses a CFI-anchor note with no spine-href Notice", async () => {
    fake.linkDests.set("surprised by grace.epub", SOURCE);
    const noteFile = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [noteFile]);
    await settle();

    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    const markdownView = new MarkdownViewDouble(
      noteFile,
      {
        hasFocus: () => true,
        getViewType: () => "markdown",
        lineCount: () => 20,
        scrollIntoView: vi.fn(),
      },
    );
    fake.leaves.add({ view: markdownView });
    const { view } = openEpubReader(book);
    view.emitLocation("#" + CFI_2);
    await vi.advanceTimersByTimeAsync(DEFAULT_SCROLL_DEBOUNCE_MS);

    noticeMessages.length = 0;
    plugin.toggleFocusMode();

    expect(noticeMessages).toEqual([]);
  });

  it("does not emit spine-href Notice for a zero-section paired note", async () => {
    fake.linkDests.set("empty.epub", "Books/Empty.epub");
    const book = addBookFile("Books/Empty.epub");
    const noteFile = addMdFile("Reading/Empty.md", '---\ntype: book-note\nsource: "[[Books/Empty.epub]]"\nformat: epub\n---\n\nJust prose, no heading anchors.',
      { type: "book-note", source: "[[Books/Empty.epub]]", format: "epub" },
    );
    fire("metadata", "changed", [noteFile]);
    await settle();

    const markdownView = new MarkdownViewDouble(
      noteFile,
      {
        hasFocus: () => true,
        getViewType: () => "markdown",
        lineCount: () => 20,
        scrollIntoView: vi.fn(),
      },
    );
    fake.leaves.add({ view: markdownView });
    openEpubReader(book);
    noticeMessages.length = 0;
    plugin.toggleFocusMode();

    expect(noticeMessages).toEqual([]);
  });

  it("focuses a mixed note with both CFI and spine-href sections", async () => {
    fake.linkDests.set("mixed.epub", "Books/Mixed.epub");
    const book = addBookFile("Books/Mixed.epub");
    const noteFile = addMdFile("Reading/Mixed.md", '---\ntype: book-note\nsource: "[[Books/Mixed.epub]]"\nformat: epub\n---\n\n## [[Books/Mixed.epub#epubcfi(/6/8!/4/2/1:0)|Cfi Ch. 1]]\ncfi body\n\n## [[Books/Mixed.epub#text/chapter2.xhtml|Href Ch. 2]]\nhref body', {
      type: "book-note",
      source: "[[Books/Mixed.epub]]",
      format: "epub",
    });
    fire("metadata", "changed", [noteFile]);
    await settle();

    const markdownView = new MarkdownViewDouble(
      noteFile,
      {
        hasFocus: () => true,
        getViewType: () => "markdown",
        lineCount: () => 20,
        scrollIntoView: vi.fn(),
      },
    );
    fake.leaves.add({ view: markdownView });
    openEpubReader(book);
    noticeMessages.length = 0;
    plugin.toggleFocusMode();

    expect(noticeMessages).toEqual([]);
  });

  it("focuses a mixed note with both CFI and spine-href sections — Item 5 fence", () => {
    const docText = [
      "## Cfi Ch. 0",
      "cfi body 0",
      "## Href Ch. 1",
      "href body 1",
      "## Cfi Ch. 2",
      "cfi body 2",
    ].join("\n");
    const cmView = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        doc: docText,
        extensions: [focusModeViewPlugin],
      }),
    });
    const editor = {
      cm: cmView,
      lineCount: () => cmView.state.doc.lines,
      scrollIntoView: vi.fn(),
    };

    try {
      setFocusModeDecoration(editor, true);
      setFocusSectionsDecoration(
        editor,
        [
{ headingLine: 0, bodyRange: { start: 0, end: 1 }, fragment: "epubcfi(/6/2!/4/2/1:0)", position: { kind: "epub-cfi" as const, cfi: "/6/2!/4/2/1:0" }, chapter: 0 },
{ headingLine: 2, bodyRange: { start: 2, end: 3 }, fragment: "text/chapter1.xhtml", position: { kind: "epub-spine" as const, href: "text/chapter1.xhtml" }, chapter: null },
{ headingLine: 4, bodyRange: { start: 4, end: 5 }, fragment: "epubcfi(/6/6!/4/2/1:0)", position: { kind: "epub-cfi" as const, cfi: "/6/6!/4/2/1:0" }, chapter: 2 },
        ],
        { headingLine: 4, bodyRange: { start: 4, end: 5 }, fragment: "epubcfi(/6/6!/4/2/1:0)", position: { kind: "epub-cfi" as const, cfi: "/6/6!/4/2/1:0" }, chapter: 2 },
      );

      expect(cmView.dom.querySelectorAll(".oc-focus-fold")).toHaveLength(1);
      expect(
        cmView.dom.querySelector(".oc-focus-fold")?.textContent,
      ).toBe("2 sections in other chapters folded");
      expect(cmView.state.doc.toString()).toBe(docText);
    } finally {
      cmView.destroy();
    }
  });

  it("seeds focus mode on first toggle from the live reader location", async () => {
    fake.linkDests.set("surprised by grace.epub", SOURCE);
    const noteFile = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [noteFile]);
    await settle();

    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    const markdownView = new MarkdownViewDouble(
      noteFile,
      {
        hasFocus: () => true,
        getViewType: () => "markdown",
        lineCount: () => 20,
        scrollIntoView: vi.fn(),
      },
    );
    fake.leaves.add({ view: markdownView });
    const { view } = openEpubReader(book);
    view.emitLocation(`#${CFI_2}`);
    await vi.advanceTimersByTimeAsync(DEFAULT_SCROLL_DEBOUNCE_MS);

    const toggle = vi.spyOn(
      (plugin as unknown as { focusMode: FocusModeController }).focusMode,
      "toggle",
    );
    plugin.toggleFocusMode();

    expect(noticeMessages).toEqual([]);
    expect(toggle).toHaveBeenCalledWith(
      expect.objectContaining({ hasFocus: expect.any(Function) }),
      expect.arrayContaining([
        expect.objectContaining({ headingLine: 6 }),
        expect.objectContaining({ headingLine: 9 }),
      ]),
      expect.objectContaining({ headingLine: 9 }),
    );
  });
  it("propagates location events through the assembled ScrollSync to the plugin\'s FocusModeController", async () => {
    fake.linkDests.set("surprised by grace.epub", SOURCE);
    const noteFile = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [noteFile]);
    await settle();

    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    const markdownView = new MarkdownViewDouble(
      noteFile,
      {
        hasFocus: () => true,
        getViewType: () => "markdown",
        lineCount: () => 20,
        scrollIntoView: vi.fn(),
      },
    );
    fake.leaves.add({ view: markdownView });
    const { view } = openEpubReader(book);
    view.emitLocation(`#${CFI_1}`);
    await vi.advanceTimersByTimeAsync(DEFAULT_SCROLL_DEBOUNCE_MS);

    const setSections = vi.spyOn(
      (plugin as unknown as { focusMode: FocusModeController }).focusMode,
      "setSections",
    );
    const setCurrentSection = vi.spyOn(
      (plugin as unknown as { focusMode: FocusModeController }).focusMode,
      "setCurrentSection",
    );

    view.emitLocation(`#${CFI_2}`);
    await vi.advanceTimersByTimeAsync(DEFAULT_SCROLL_DEBOUNCE_MS);

    expect(setSections).toHaveBeenCalledWith(
      expect.objectContaining({ hasFocus: expect.any(Function) }),
      expect.arrayContaining([
        expect.objectContaining({ headingLine: 6 }),
        expect.objectContaining({ headingLine: 9 }),
      ]),
    );
    expect(setCurrentSection).toHaveBeenCalledWith(
      expect.objectContaining({ hasFocus: expect.any(Function) }),
      expect.objectContaining({ headingLine: 9 }),
    );
  });


  it("releases scroll sync and its pending timer when a reader leaf closes", async () => {
    fake.linkDests.set("surprised by grace.epub", SOURCE);
    const noteFile = addMdFile("Reading/A.md", NOTE_TEXT, NOTE_FRONTMATTER);
    fire("metadata", "changed", [noteFile]);
    await settle();

    const book = fake.files.get(SOURCE);
    if (book === undefined) throw new Error("book fixture is missing");
    const { leaf, view } = openEpubReader(book);

    view.emitLocation(`#${CFI_1}`);
    expect(vi.getTimerCount()).toBe(1);

    fake.leaves.delete(leaf);
    fire("workspace", "layout-change", []);

    expect(vi.getTimerCount()).toBe(0);
    view.emitLocation(`#${CFI_2}`);
    expect(vi.getTimerCount()).toBe(0);
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

  it("clears scroll subscriptions and timers on unload", async () => {
    const clear = vi.spyOn(ScrollSync.prototype, "clear");

    plugin.onunload();

    expect(clear).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
