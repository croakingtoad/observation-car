import {
  MarkdownView,
  TFile,
  TFolder,
} from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeCreateBookNoteForTesting } from "./createBookNote";
import { EpubView, EPUB_VIEW_TYPE } from "../readers/EpubView";
import type ObservationCarPlugin from "../main";

const obsidianMock = vi.hoisted(() => ({ noticeMessages: [] as string[] }));

vi.mock("obsidian", () => {
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

  class MarkdownView {
    file: unknown;

    constructor(file: unknown) {
      this.file = file;
    }
  }
  class Notice {
    constructor(message: string) {
      obsidianMock.noticeMessages.push(message);
    }
  }

  const normalizePath = (path: string): string =>
    path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\//, "");

  return { MarkdownView, Notice, TFile, TFolder, normalizePath };
});

vi.mock("../readers/EpubView", () => ({
  EPUB_VIEW_TYPE: "observation-car-epub",
  EpubView: class {
    file: unknown;

    constructor(file: unknown) {
      this.file = file;
    }
  },
}));

const TFileDouble = TFile as unknown as new (
  path: string,
  extension: string,
) => TFile;
const TFolderDouble = TFolder as unknown as new (path: string) => TFolder;
const MarkdownViewDouble = MarkdownView as unknown as new (
  file: TFile | null,
) => MarkdownView;
const EpubViewDouble = EpubView as unknown as new (
  file: TFile | null,
) => EpubView;

class FakeLeaf {
  viewType: string;
  view: unknown;
  openFileCalls: TFile[] = [];
  loadCalls = 0;

  constructor(viewType: string, view: unknown) {
    this.viewType = viewType;
    this.view = view;
  }

  getViewState(): { type: string } {
    return { type: this.viewType };
  }

  async loadIfDeferred(): Promise<void> {
    this.loadCalls += 1;
  }

  async openFile(file: TFile): Promise<void> {
    this.openFileCalls.push(file);
    this.viewType = "markdown";
    this.view = new MarkdownViewDouble(file);
  }
}

interface TestHarness {
  bookA: TFile;
  bookB: TFile;
  epubLeafA: FakeLeaf;
  epubLeafB: FakeLeaf;
  markdownLeaf: FakeLeaf;
  splitLeaves: FakeLeaf[];
  vault: {
    files: Map<string, TFile>;
    folders: Set<string>;
    createdFiles: string[];
  };
  workspace: {
    getMostRecentLeafCalls: number;
    revealedLeaves: FakeLeaf[];
  };
  app: ObservationCarPlugin;
}

async function invoke(harness: TestHarness): Promise<void> {
  return invokeCreateBookNoteForTesting(harness.app);
}

function createHarness({
  activeLeaf = null,
  mostRecentLeaf = null,
  includeBooks = true,
}: {
  activeLeaf?: FakeLeaf | null;
  mostRecentLeaf?: FakeLeaf | null;
  includeBooks?: boolean;
} = {}): TestHarness {
  const bookA = new TFileDouble("Books/A.epub", "epub");
  const bookB = new TFileDouble("Books/B.epub", "epub");
  const epubLeafA = includeBooks
    ? new FakeLeaf(EPUB_VIEW_TYPE, new EpubViewDouble(bookA))
    : null;
  const epubLeafB = includeBooks
    ? new FakeLeaf(EPUB_VIEW_TYPE, new EpubViewDouble(bookB))
    : null;
  const markdownLeaf = new FakeLeaf("markdown", new MarkdownViewDouble(null));
  const splitLeaves: FakeLeaf[] = [];
  const vault = {
    files: new Map<string, TFile>(),
    folders: new Set<string>(),
    createdFiles: [] as string[],
  };
  const workspace = {
    getMostRecentLeafCalls: 0,
    revealedLeaves: [] as FakeLeaf[],
  };

  const app = {
    vault: {
      getAbstractFileByPath: (path: string): TFile | TFolder | null =>
        vault.files.get(path) ??
        (vault.folders.has(path) ? new TFolderDouble(path) : null),
      create: async (path: string, _content: string): Promise<TFile> => {
        const file = new TFileDouble(path, "md");
        vault.files.set(path, file);
        vault.createdFiles.push(path);
        return file;
      },
      createFolder: async (path: string): Promise<void> => {
        vault.folders.add(path);
      },
    },
    workspace: {
      getActiveViewOfType: (type: abstract new () => unknown): unknown =>
        activeLeaf !== null &&
        activeLeaf.view instanceof type
          ? activeLeaf.view
          : null,
      getLeavesOfType: (viewType: string): FakeLeaf[] =>
        [epubLeafA, epubLeafB, markdownLeaf, ...splitLeaves]
          .flatMap((leaf) => (leaf === null ? [] : [leaf]))
          .filter((leaf) => leaf.getViewState().type === viewType),
      getMostRecentLeaf: (): FakeLeaf | null => {
        workspace.getMostRecentLeafCalls += 1;
        return mostRecentLeaf;
      },
      getLeaf: (_paneType: "split", _direction: "vertical"): FakeLeaf => {
        const leaf = new FakeLeaf("markdown", new MarkdownViewDouble(null));
        splitLeaves.push(leaf);
        return leaf;
      },
      revealLeaf: async (leaf: FakeLeaf): Promise<void> => {
        workspace.revealedLeaves.push(leaf);
      },
    },
  };

  const plugin = {
    app,
    settings: {
      notesFolder: "Reading",
      noteTemplate: [
        "source: {{source}}",
        "format: {{format}}",
        "title: {{title}}",
        "author: {{author}}",
      ].join("\n"),
    },
  } as unknown as ObservationCarPlugin;

  return {
    bookA,
    bookB,
    epubLeafA: epubLeafA ?? new FakeLeaf("empty", null),
    epubLeafB: epubLeafB ?? new FakeLeaf("empty", null),
    markdownLeaf,
    splitLeaves,
    vault,
    workspace,
    app: plugin,
  };
}

describe("Create book note for current book", () => {
  beforeEach(() => {
    obsidianMock.noticeMessages.length = 0;
  });

  it("uses the active reader when the iframe has Obsidian focus", async () => {
    const readerHarness = createHarness();
    const harness = createHarness({
      activeLeaf: readerHarness.epubLeafA,
    });
    await invoke(harness);
    expect(harness.vault.createdFiles).toEqual(["Reading/A.md"]);
  });

  it("uses the most recent reader when active view is markdown", async () => {
    const readerHarness = createHarness();
    const markdownHarness = createHarness();
    const harness = createHarness({
      activeLeaf: markdownHarness.markdownLeaf,
      mostRecentLeaf: readerHarness.epubLeafB,
    });
    await invoke(harness);
    expect(harness.vault.createdFiles).toEqual(["Reading/B.md"]);
    expect(harness.workspace.getMostRecentLeafCalls).toBe(1);
  });

  it("names every candidate when no reader was activated", async () => {
    const harness = createHarness();
    await invoke(harness);
    expect(obsidianMock.noticeMessages).toHaveLength(1);
    expect(obsidianMock.noticeMessages).toEqual([
      "Multiple books are open: A, B. Click the book you want, then run Create book note again.",
    ]);
    expect(harness.vault.createdFiles).toEqual([]);
  });

  it("reveals an existing note instead of splitting again", async () => {
    const readerHarness = createHarness();
    const harness = createHarness({
      activeLeaf: readerHarness.epubLeafA,
    });
    await invoke(harness);
    await invoke(harness);
    await invoke(harness);
    await invoke(harness);
    await invoke(harness);
    expect(harness.splitLeaves).toHaveLength(1);
    expect(harness.workspace.revealedLeaves).toEqual([
      ...harness.workspace.revealedLeaves.slice(0, -1),
      harness.splitLeaves[0],
    ]);
    expect(harness.vault.createdFiles).toEqual(["Reading/A.md"]);
  });

  it("shows the no-book notice and writes nothing without a book", async () => {
    const harness = createHarness({
      includeBooks: false,
    });
    await invoke(harness);
    expect(obsidianMock.noticeMessages).toEqual([
      "Open a book in Observation Car first",
    ]);
    expect(harness.vault.createdFiles).toEqual([]);
    expect(harness.splitLeaves).toEqual([]);
  });
});
