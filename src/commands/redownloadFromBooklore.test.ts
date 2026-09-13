import type { Command } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type ObservationCarPlugin from "../main";
import type { BookNote } from "../model/bookNote";
import type { OpdsEntry, OpdsFeed } from "../booklore/opdsTypes";
import {
  BOOKLORE_ALL_BOOKS_CATALOG_ID,
  registerRedownloadFromBookloreCommand,
} from "./redownloadFromBooklore";

const mocks = vi.hoisted(() => ({
  notices: [] as string[],
  getRootFeed: vi.fn(),
  fetchFeed: vi.fn(),
  redownload: vi.fn(),
  getDownloader: vi.fn(),
  downloadIndex: {} as Record<string, { vaultPath: string }>,
}));

vi.mock("obsidian", () => ({
  MarkdownView: class {},
  Notice: class {
    constructor(message: string) {
      mocks.notices.push(message);
    }
  },
}));

vi.mock("../booklore/opdsClient", () => ({
  OpdsClient: class {
    getRootFeed = mocks.getRootFeed;
    fetchFeed = mocks.fetchFeed;
  },
}));

vi.mock("../booklore/bookDownloadRegistration", () => ({
  getBookloreDownloader: mocks.getDownloader,
}));

const EPUB_ACQUISITION = {
  rel: "http://opds-spec.org/acquisition",
  type: "application/epub+zip",
  href: "https://booklore.example/api/v1/opds/92/download?fileId=93",
  title: "EPUB",
};

function entry(id: string, acquisitions = [EPUB_ACQUISITION]): OpdsEntry {
  return {
    id,
    title: "Surprised by Grace",
    authors: ["A. N. Author"],
    updated: "2026-09-13T12:00:00Z",
    summary: "",
    categories: [],
    publisher: "",
    language: "en",
    kind: "acquisition",
    links: acquisitions,
    acquisitions,
    images: [],
    navigation: null,
  };
}

function feed(
  entries: OpdsEntry[],
  next: string | null = null,
): OpdsFeed {
  return {
    id: "feed",
    title: "Catalog",
    updated: "",
    url: "https://booklore.example/api/v1/opds/catalog",
    links: [],
    search: null,
    pagination: {
      next,
      prev: null,
      self: null,
      start: null,
      first: null,
      last: null,
    },
    opensearch: {
      totalResults: entries.length,
      startIndex: 1,
      itemsPerPage: entries.length,
    },
    entries,
  };
}

function bookNote(
  bookloreId: unknown,
  source: string | null = "Books/Surprised by Grace.epub",
): BookNote {
  return {
    frontmatter: {
      data: {
        type: "book-note",
        ...(source === null ? {} : { source: `[[${source}]]` }),
        format: "epub",
        ...(bookloreId === undefined ? {} : { booklore_id: bookloreId }),
      },
      source,
      format: "epub",
    },
    sections: [],
    diagnostics: [],
  };
}

function setup(note: BookNote): {
  command: Command;
  dispose: () => void;
  existingPaths: Set<string>;
  markdown: string;
  vaultWrite: ReturnType<typeof vi.fn>;
} {
  let command: Command | undefined;
  let dispose = (): void => {};
  const existingPaths = new Set<string>();
  const vaultWrite = vi.fn();
  const markdown = [
    "---",
    "type: book-note",
    'source: "[[Books/Surprised by Grace.epub]]"',
    "format: epub",
    `booklore_id: ${String(note.frontmatter.data.booklore_id ?? "")}`,
    "---",
    "",
    "My irreplaceable notes.",
  ].join("\n");
  const plugin = {
    settings: {},
    app: {
      vault: {
        adapter: {
          exists: async (path: string) => existingPaths.has(path),
        },
        modify: vaultWrite,
        process: vaultWrite,
      },
      workspace: {
        getActiveViewOfType: () => ({ file: { path: "Reading/Grace.md" } }),
      },
    },
    getBookNote: (path: string) =>
      path === "Reading/Grace.md" ? note : undefined,
    addCommand: (registered: Command) => {
      command = registered;
      return registered;
    },
    register: (callback: () => void) => {
      dispose = callback;
    },
  } as unknown as ObservationCarPlugin;
  registerRedownloadFromBookloreCommand(plugin);
  if (command === undefined) throw new Error("command was not registered");
  return { command, dispose, existingPaths, markdown, vaultWrite };
}

describe("Re-download from Booklore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notices.length = 0;
    mocks.downloadIndex = {};
    mocks.getDownloader.mockReturnValue({
      getDownloadIndex: () => mocks.downloadIndex,
      redownload: mocks.redownload,
    });
    mocks.redownload.mockResolvedValue({
      status: "downloaded",
      vaultPath: "Books/Surprised by Grace.epub",
    });
  });

  it("pins the Booklore all-books catalog ID", () => {
    expect(BOOKLORE_ALL_BOOKS_CATALOG_ID).toBe(
      "urn:booklore:catalog:all",
    );
  });

  it("finds a numeric booklore_id across catalog pages and replaces the matching format", async () => {
    const allBooks = entry("urn:booklore:catalog:all", []);
    allBooks.kind = "navigation";
    allBooks.navigation = {
      rel: "subsection",
      type: "application/atom+xml",
      href: "https://booklore.example/api/v1/opds/catalog?page=1&size=50",
      title: "",
    };
    mocks.getRootFeed.mockResolvedValue(feed([allBooks]));
    mocks.fetchFeed
      .mockResolvedValueOnce(
        feed(
          [entry("urn:booklore:book:91")],
          "https://booklore.example/api/v1/opds/catalog?page=2&size=50",
        ),
      )
      .mockResolvedValueOnce(feed([entry("urn:booklore:book:92")]));
    mocks.downloadIndex = {
      "urn:booklore:book:92": {
        vaultPath: "Books/Surprised by Grace.epub",
      },
    };
    const { command, existingPaths, markdown, vaultWrite } = setup(
      bookNote(92, "Books/Stale note source.epub"),
    );
    existingPaths.add("Books/Surprised by Grace.epub");
    existingPaths.add("Books/Stale note source.epub");

    expect(command.checkCallback?.(true)).toBe(true);
    expect(command.checkCallback?.(false)).toBe(true);
    await vi.waitFor(() => expect(mocks.redownload).toHaveBeenCalledOnce());

    expect(mocks.fetchFeed).toHaveBeenCalledTimes(2);
    expect(mocks.redownload).toHaveBeenCalledWith(
      expect.objectContaining({ id: "urn:booklore:book:92" }),
      EPUB_ACQUISITION,
      undefined,
    );
    expect(markdown).toContain("My irreplaceable notes.");
    expect(vaultWrite).not.toHaveBeenCalled();
    expect(mocks.notices.at(-1)).toBe(
      "Re-downloaded Books/Surprised by Grace.epub from Booklore.",
    );
  });

  it("replaces the note source and repairs a missing index record", async () => {
    const allBooks = entry("urn:booklore:catalog:all", []);
    allBooks.navigation = {
      rel: "subsection",
      type: "application/atom+xml",
      href: "https://booklore.example/api/v1/opds/catalog",
      title: "",
    };
    mocks.getRootFeed.mockResolvedValue(feed([allBooks]));
    mocks.fetchFeed.mockResolvedValue(feed([entry("urn:booklore:book:92")]));
    const { command, existingPaths } = setup(bookNote(92));
    existingPaths.add("Books/Surprised by Grace.epub");

    expect(command.checkCallback?.(false)).toBe(true);
    await vi.waitFor(() => expect(mocks.redownload).toHaveBeenCalledOnce());

    expect(mocks.redownload).toHaveBeenCalledWith(
      expect.objectContaining({ id: "urn:booklore:book:92" }),
      EPUB_ACQUISITION,
      "Books/Surprised by Grace.epub",
    );
  });

  it("does not download when neither the index nor note identifies a live book", async () => {
    const { command } = setup(bookNote(92, null));

    expect(command.checkCallback?.(false)).toBe(true);
    await vi.waitFor(() => expect(mocks.notices).toHaveLength(1));

    expect(mocks.notices[0]).toBe(
      "Could not re-download booklore_id 92: this note does not identify an existing vault book.",
    );
    expect(mocks.getRootFeed).not.toHaveBeenCalled();
    expect(mocks.redownload).not.toHaveBeenCalled();
  });

  it("allows only one forced download while the command is in flight", async () => {
    let resolveRoot: ((value: OpdsFeed) => void) | undefined;
    mocks.getRootFeed.mockReturnValue(
      new Promise<OpdsFeed>((resolve) => {
        resolveRoot = resolve;
      }),
    );
    const allBooks = entry("urn:booklore:catalog:all", []);
    allBooks.navigation = {
      rel: "subsection",
      type: "application/atom+xml",
      href: "https://booklore.example/api/v1/opds/catalog",
      title: "",
    };
    mocks.fetchFeed.mockResolvedValue(feed([entry("urn:booklore:book:92")]));
    const { command, existingPaths } = setup(bookNote(92));
    existingPaths.add("Books/Surprised by Grace.epub");

    command.checkCallback?.(false);
    command.checkCallback?.(false);
    await vi.waitFor(() => expect(mocks.getRootFeed).toHaveBeenCalledOnce());
    resolveRoot?.(feed([allBooks]));
    await vi.waitFor(() => expect(mocks.redownload).toHaveBeenCalledOnce());
  });

  it("does not download when disposed after a successful catalog walk", async () => {
    let resolvePage: ((value: OpdsFeed) => void) | undefined;
    const allBooks = entry("urn:booklore:catalog:all", []);
    allBooks.navigation = {
      rel: "subsection",
      type: "application/atom+xml",
      href: "https://booklore.example/api/v1/opds/catalog",
      title: "",
    };
    mocks.getRootFeed.mockResolvedValue(feed([allBooks]));
    mocks.fetchFeed.mockReturnValue(
      new Promise<OpdsFeed>((resolve) => {
        resolvePage = resolve;
      }),
    );
    const { command, dispose, existingPaths } = setup(bookNote(92));
    existingPaths.add("Books/Surprised by Grace.epub");

    command.checkCallback?.(false);
    await vi.waitFor(() => expect(mocks.fetchFeed).toHaveBeenCalledOnce());
    dispose();
    resolvePage?.(feed([entry("urn:booklore:book:92")]));
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.redownload).not.toHaveBeenCalled();
    expect(mocks.notices).toEqual([]);
  });

  it("does not report a catalog failure after disposal", async () => {
    let rejectRoot: ((reason: Error) => void) | undefined;
    mocks.getRootFeed.mockReturnValue(
      new Promise<OpdsFeed>((_resolve, reject) => {
        rejectRoot = reject;
      }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { command, dispose, existingPaths } = setup(bookNote(92));
    existingPaths.add("Books/Surprised by Grace.epub");

    command.checkCallback?.(false);
    await vi.waitFor(() => expect(mocks.getRootFeed).toHaveBeenCalledOnce());
    dispose();
    rejectRoot?.(new Error("late failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.notices).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("shows a readable error for a missing booklore_id", async () => {
    const { command } = setup(bookNote(undefined));
    expect(command.checkCallback?.(false)).toBe(true);
    await vi.waitFor(() => expect(mocks.notices).toHaveLength(1));
    expect(mocks.notices[0]).toBe(
      "This book note has no valid booklore_id.",
    );
    expect(mocks.getRootFeed).not.toHaveBeenCalled();
    expect(mocks.redownload).not.toHaveBeenCalled();
  });

  it("shows a readable error for a stale booklore_id", async () => {
    const allBooks = entry("urn:booklore:catalog:all", []);
    allBooks.kind = "navigation";
    allBooks.navigation = {
      rel: "subsection",
      type: "application/atom+xml",
      href: "https://booklore.example/api/v1/opds/catalog",
      title: "",
    };
    mocks.getRootFeed.mockResolvedValue(feed([allBooks]));
    mocks.fetchFeed.mockResolvedValue(feed([entry("urn:booklore:book:91")]));
    const { command, existingPaths } = setup(bookNote("92"));
    existingPaths.add("Books/Surprised by Grace.epub");

    expect(command.checkCallback?.(false)).toBe(true);
    await vi.waitFor(() => expect(mocks.notices).toHaveLength(1));
    expect(mocks.notices[0]).toBe(
      "Booklore has no book matching booklore_id 92. The ID may be stale.",
    );
    expect(mocks.redownload).not.toHaveBeenCalled();
  });
});
