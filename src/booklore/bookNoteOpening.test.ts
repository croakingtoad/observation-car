import { TFile, TFolder, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";
import { BookNoteOpeningDownloader } from "./bookNoteOpening";
import type { OpdsEntry, OpdsLink } from "./opdsTypes";

vi.mock("obsidian", () => {
  class TFile {
    path: string;
    extension: string;
    basename: string;
    constructor(path: string) {
      this.path = path;
      const name = path.split("/").at(-1) ?? path;
      const dot = name.lastIndexOf(".");
      this.extension = dot === -1 ? "" : name.slice(dot + 1);
      this.basename = dot === -1 ? name : name.slice(0, dot);
    }
  }
  class TFolder {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
  }
  return {
    Notice: class {},
    TFile,
    TFolder,
    normalizePath: (path: string) =>
      path.replaceAll("\\", "/").replace(/\/{2,}/g, "/"),
  };
});

vi.mock("../readers/EpubView", () => ({
  EpubView: class {},
}));

const TFileDouble = TFile as unknown as new (path: string) => TFile;
const TFolderDouble = TFolder as unknown as new (path: string) => TFolder;

const ACQUISITION: OpdsLink = {
  rel: "http://opds-spec.org/acquisition",
  type: "application/epub+zip",
  href: "https://booklore.example/api/v1/opds/92/download?fileId=93",
  title: "EPUB",
};

const ENTRY: OpdsEntry = {
  id: "urn:booklore:book:92",
  title: "A Title: With YAML",
  authors: ["Turco, Lewis", "Lewis Turco"],
  updated: "2026-09-13T12:00:00Z",
  summary: "First paragraph.\nSecond paragraph.",
  categories: [],
  publisher: "",
  language: "en",
  kind: "acquisition",
  links: [ACQUISITION],
  acquisitions: [ACQUISITION],
  images: [],
  navigation: null,
};

interface Harness {
  app: App;
  files: Map<string, TFile>;
  contents: Map<string, string>;
  create: ReturnType<typeof vi.fn>;
  modify: ReturnType<typeof vi.fn>;
  opened: Array<{ kind: string; direction?: string; path: string }>;
}

function makeHarness(): Harness {
  const files = new Map<string, TFile>();
  const folders = new Map<string, TFolder>();
  const contents = new Map<string, string>();
  const opened: Harness["opened"] = [];
  const create = vi.fn(async (path: string, content: string) => {
    const file = new TFileDouble(path);
    files.set(path, file);
    contents.set(path, content);
    return file;
  });
  const modify = vi.fn(async (file: TFile, content: string) => {
    contents.set(file.path, content);
  });
  const app = {
    vault: {
      adapter: {
        exists: async (path: string) => files.has(path) || folders.has(path),
        writeBinary: async (path: string) => {
          files.set(path, new TFileDouble(path));
        },
      },
      getAbstractFileByPath: (path: string) =>
        files.get(path) ?? folders.get(path) ?? null,
      create,
      modify,
      createFolder: async (path: string) => {
        const folder = new TFolderDouble(path);
        folders.set(path, folder);
        return folder;
      },
    },
    workspace: {
      getLeaf: (kind: string, direction?: string) => ({
        openFile: async (file: TFile) => {
          opened.push({ kind, direction, path: file.path });
        },
      }),
    },
  } as unknown as App;
  return { app, files, contents, create, modify, opened };
}

function downloader(
  harness: Harness,
  initialIndex: Record<string, { vaultPath: string; updated?: string }> = {},
): BookNoteOpeningDownloader {
  const settings = {
    ...DEFAULT_SETTINGS,
    noteTemplate: [
      "---",
      "type: stale-value",
      "custom: preserved",
      "---",
      "",
      "Opening thoughts.",
    ].join("\n"),
    bookloreBaseUrl: "https://booklore.example/",
  };
  return new BookNoteOpeningDownloader({
    host: { app: harness.app, settings },
    app: harness.app,
    settings: () => settings,
    initialIndex,
    saveIndex: async () => undefined,
    transport: async () => ({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(1),
    }),
  });
}

describe("BookNoteOpeningDownloader", () => {
  it("seeds all PRD fields and opens the downloaded reader beside its note", async () => {
    const harness = makeHarness();

    const result = await downloader(harness).download(ENTRY, ACQUISITION);

    expect(result.vaultPath).toBe("Books/A Title- With YAML.epub");
    expect(harness.contents.get("Reading/A Title- With YAML.md")).toBe(
      [
        "---",
        "type: book-note",
        'source: "[[Books/A Title- With YAML.epub]]"',
        "format: epub",
        'title: "A Title: With YAML"',
        'author: "Turco, Lewis, Lewis Turco"',
        "booklore_id: 92",
        'booklore_url: "https://booklore.example/book/92"',
        'cover: ""',
        "custom: preserved",
        "---",
        "",
        "Opening thoughts.",
      ].join("\n"),
    );
    expect(harness.opened).toEqual([
      { kind: "tab", direction: undefined, path: result.vaultPath },
      {
        kind: "split",
        direction: "vertical",
        path: "Reading/A Title- With YAML.md",
      },
    ]);
  });

  it("opens an existing note for the same book without overwriting it", async () => {
    const harness = makeHarness();
    const bookPath = "Books/A Title- With YAML.epub";
    const notePath = "Reading/A Title- With YAML.md";
    harness.files.set(bookPath, new TFileDouble(bookPath));
    harness.files.set(notePath, new TFileDouble(notePath));
    const irreplaceable = "---\ntype: book-note\n---\n\nMy irreplaceable notes.";
    harness.contents.set(notePath, irreplaceable);

    await downloader(harness, {
      [ENTRY.id]: { vaultPath: bookPath, updated: ENTRY.updated },
    }).download(ENTRY, ACQUISITION);

    expect(harness.contents.get(notePath)).toBe(irreplaceable);
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.modify).not.toHaveBeenCalled();
    expect(harness.opened.map(({ path }) => path)).toEqual([
      bookPath,
      notePath,
    ]);
  });

  it("opens a concurrently created winner without overwriting it", async () => {
    const harness = makeHarness();
    const notePath = "Reading/A Title- With YAML.md";
    const winner = "---\ntype: book-note\n---\n\nThe winning invocation's notes.";
    harness.create.mockImplementationOnce(async (path: string) => {
      harness.files.set(path, new TFileDouble(path));
      harness.contents.set(path, winner);
      throw new Error("File already exists");
    });

    await downloader(harness).download(ENTRY, ACQUISITION);

    expect(harness.create).toHaveBeenCalledOnce();
    expect(harness.contents.get(notePath)).toBe(winner);
    expect(harness.modify).not.toHaveBeenCalled();
    expect(harness.opened.map(({ path }) => path)).toEqual([
      "Books/A Title- With YAML.epub",
      notePath,
    ]);
  });
});
