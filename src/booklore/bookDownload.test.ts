import { TFolder, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ObservationCarSettings } from "../settings";
import {
  BookloreDownloader,
  readDownloadIndex,
  sanitizeBookFilename,
  type BookDownloadTransport,
  type BookloreDownloadIndex,
} from "./bookDownload";

const TFolderDouble = TFolder as unknown as new (path: string) => TFolder;

interface Harness {
  app: App;
  settings: ObservationCarSettings;
  files: Map<string, ArrayBuffer>;
  folders: Set<string>;
  fileConflicts: Set<string>;
  writes: string[];
  saves: BookloreDownloadIndex[];
}

function makeHarness(): Harness {
  const files = new Map<string, ArrayBuffer>();
  const folders = new Set<string>();
  const fileConflicts = new Set<string>();
  const writes: string[] = [];
  const saves: BookloreDownloadIndex[] = [];
  const settings: ObservationCarSettings = {
    ...DEFAULT_SETTINGS,
    bookloreBaseUrl: "https://booklore.example",
    opdsUsername: "reader",
    opdsPassword: "library-pass",
  };
  const app = {
    vault: {
      adapter: {
        exists: async (path: string): Promise<boolean> =>
          files.has(path) || folders.has(path) || fileConflicts.has(path),
        writeBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
          writes.push(path);
          files.set(path, data);
        },
      },
      getAbstractFileByPath: (path: string): TFolder | { path: string } | null =>
        folders.has(path)
          ? new TFolderDouble(path)
          : fileConflicts.has(path)
            ? { path }
            : null,
      createFolder: async (path: string): Promise<TFolder> => {
        folders.add(path);
        return new TFolderDouble(path);
      },
    },
  } as unknown as App;
  return {
    app,
    settings,
    files,
    folders,
    fileConflicts,
    writes,
    saves,
  };
}

function response(
  body = new Uint8Array([1, 2, 3]).buffer,
  headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    ETag: '"v1"',
  },
  status = 200,
): Awaited<ReturnType<BookDownloadTransport>> {
  return { status, headers, arrayBuffer: body };
}

function makeDownloader(
  harness: Harness,
  transport: BookDownloadTransport,
  initialIndex: BookloreDownloadIndex = {},
): BookloreDownloader {
  return new BookloreDownloader({
    app: harness.app,
    settings: () => harness.settings,
    initialIndex,
    transport,
    saveIndex: async (index) => {
      harness.saves.push(index);
    },
  });
}

const EPUB_LINK = {
  href: "https://booklore.example/api/v1/opds/92/download?fileId=93",
  type: "application/epub+zip",
};

describe("sanitizeBookFilename", () => {
  it("removes the unsafe intersection across desktop and mobile filesystems", () => {
    const name = sanitizeBookFilename(
      '  A<B>C:D"E/F\\G|H?I* .  ',
      "epub",
    );
    expect(name).toBe("A-B-C-D-E-F-G-H-I.epub");
    expect(name).not.toMatch(/[<>:"/\\|?*]/);
  });

  it.each(["CON", "prn", "AUX", "nul", "COM9", "lpt1", "CON.notes"])(
    "guards the Windows reserved stem %s",
    (stem) => {
      expect(sanitizeBookFilename(stem, "pdf")).toBe(`_${stem}.pdf`);
    },
  );

  it("uses a stable fallback and stays below common 255-byte limits", () => {
    expect(sanitizeBookFilename("... ", "epub")).toBe("Untitled.epub");
    const long = sanitizeBookFilename("📚".repeat(200), "epub");
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(240);
    expect(long.endsWith(".epub")).toBe(true);
  });
});

describe("readDownloadIndex", () => {
  it("keeps only normalized records with valid vault paths", () => {
    const index = readDownloadIndex({
      downloadIndex: {
        "urn:booklore:book:92": {
          vaultPath: "Books\\Title.epub",
          updated: "2026-09-11T12:00:00Z",
          etag: '"v1"',
          ignored: true,
        },
        broken: { vaultPath: 42 },
        escaped: { vaultPath: "../Outside.epub" },
      },
    });
    expect({ ...index }).toEqual({
      "urn:booklore:book:92": {
        vaultPath: "Books/Title.epub",
        updated: "2026-09-11T12:00:00Z",
        etag: '"v1"',
      },
    });
  });

  it("does not inherit prototype properties from untrusted data", () => {
    expect(readDownloadIndex({ downloadIndex: null })).toEqual({});
    expect(readDownloadIndex({ downloadIndex: "bad" })).toEqual({});
  });
});

describe("BookloreDownloader", () => {
  it("downloads the arrayBuffer property, creates the folder, and records metadata", async () => {
    const harness = makeHarness();
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const body = new Uint8Array([9, 8, 7]).buffer;
    const downloader = makeDownloader(harness, async (url, headers) => {
      requests.push({ url, headers });
      return response(body);
    });

    const result = await downloader.download(
      {
        id: "urn:booklore:book:92",
        title: "Surprised: by Grace?",
        updated: "2026-09-11T12:00:00Z",
      },
      EPUB_LINK,
    );

    expect(result).toEqual({
      status: "downloaded",
      vaultPath: "Books/Surprised- by Grace.epub",
    });
    expect(harness.folders).toContain("Books");
    expect(harness.files.get(result.vaultPath)).toBe(body);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.Accept).toBe("application/epub+zip");
    expect(requests[0]?.headers.Authorization).toMatch(/^Basic /);
    expect(harness.saves.at(-1)).toEqual({
      "urn:booklore:book:92": {
        vaultPath: "Books/Surprised- by Grace.epub",
        updated: "2026-09-11T12:00:00Z",
        etag: '"v1"',
      },
    });
  });

  it("uses the OPDS link type for the extension, ignoring octet-stream", async () => {
    const harness = makeHarness();
    const downloader = makeDownloader(harness, async () => response());
    const result = await downloader.download(
      { id: "book-90", title: "A paper", updated: "v1" },
      { ...EPUB_LINK, type: "application/pdf" },
    );
    expect(result.vaultPath).toBe("Books/A paper.pdf");
  });

  it("skips the request when the indexed file has the same OPDS updated value", async () => {
    const harness = makeHarness();
    harness.files.set("Books/Existing.epub", new ArrayBuffer(1));
    const transport = vi.fn<BookDownloadTransport>();
    const downloader = makeDownloader(harness, transport, {
      "book-1": {
        vaultPath: "Books/Existing.epub",
        updated: "same",
        etag: '"same"',
      },
    });

    await expect(
      downloader.download(
        { id: "book-1", title: "Existing", updated: "same" },
        EPUB_LINK,
      ),
    ).resolves.toEqual({
      status: "unchanged",
      vaultPath: "Books/Existing.epub",
    });
    expect(transport).not.toHaveBeenCalled();
    expect(harness.writes).toEqual([]);
    expect(harness.saves).toEqual([]);
  });

  it("forcibly re-downloads and replaces its indexed vault copy", async () => {
    const harness = makeHarness();
    const oldBody = new Uint8Array([1]).buffer;
    const newBody = new Uint8Array([9, 8, 7]).buffer;
    harness.files.set("Books/Existing.epub", oldBody);
    const transport = vi.fn<BookDownloadTransport>(async (_url, headers) => {
      expect(headers["If-None-Match"]).toBeUndefined();
      return response(newBody, { ETag: '"new"' });
    });
    const downloader = makeDownloader(harness, transport, {
      "book-1": {
        vaultPath: "Books/Existing.epub",
        updated: "same",
        etag: '"old"',
      },
    });

    await expect(
      downloader.redownload(
        { id: "book-1", title: "Existing", updated: "same" },
        EPUB_LINK,
      ),
    ).resolves.toEqual({
      status: "downloaded",
      vaultPath: "Books/Existing.epub",
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(harness.writes).toEqual(["Books/Existing.epub"]);
    expect(harness.files.get("Books/Existing.epub")).toBe(newBody);
    expect(harness.saves.at(-1)?.["book-1"]?.etag).toBe('"new"');
  });

  it("uses ETag conditionally and accepts 304 when the feed timestamp changes", async () => {
    const harness = makeHarness();
    harness.files.set("Books/Existing.epub", new ArrayBuffer(1));
    const transport = vi.fn<BookDownloadTransport>(async (_url, headers) => {
      expect(headers["If-None-Match"]).toBe('"old"');
      return response(new ArrayBuffer(0), {}, 304);
    });
    const downloader = makeDownloader(harness, transport, {
      "book-1": {
        vaultPath: "Books/Existing.epub",
        updated: "old-date",
        etag: '"old"',
      },
    });

    await expect(
      downloader.download(
        { id: "book-1", title: "Existing", updated: "new-date" },
        EPUB_LINK,
      ),
    ).resolves.toMatchObject({ status: "unchanged" });
    expect(harness.writes).toEqual([]);
    expect(harness.saves.at(-1)?.["book-1"]).toEqual({
      vaultPath: "Books/Existing.epub",
      updated: "new-date",
      etag: '"old"',
    });
  });

  it("redownloads an unchanged indexed entry when its vault file is missing", async () => {
    const harness = makeHarness();
    const transport = vi.fn<BookDownloadTransport>(async (_url, headers) => {
      expect(headers["If-None-Match"]).toBeUndefined();
      return response();
    });
    const downloader = makeDownloader(harness, transport, {
      "book-1": {
        vaultPath: "Books/Missing.epub",
        updated: "same",
        etag: '"old"',
      },
    });

    const result = await downloader.download(
      { id: "book-1", title: "Missing", updated: "same" },
      EPUB_LINK,
    );
    expect(result).toEqual({
      status: "downloaded",
      vaultPath: "Books/Missing.epub",
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(harness.writes).toEqual(["Books/Missing.epub"]);
  });

  it("overwrites only the path already owned by the same changed book", async () => {
    const harness = makeHarness();
    harness.files.set("Books/Existing.epub", new ArrayBuffer(1));
    const downloader = makeDownloader(harness, async () => response(), {
      "book-1": {
        vaultPath: "Books/Existing.epub",
        updated: "old",
      },
    });
    const result = await downloader.download(
      { id: "book-1", title: "A renamed title", updated: "new" },
      EPUB_LINK,
    );
    expect(result.vaultPath).toBe("Books/Existing.epub");
    expect(harness.writes).toEqual(["Books/Existing.epub"]);
  });

  it("suffixes unrelated collisions instead of overwriting", async () => {
    const harness = makeHarness();
    harness.files.set("Books/Same title.epub", new ArrayBuffer(1));
    const downloader = makeDownloader(harness, async () => response());
    const result = await downloader.download(
      { id: "book-2", title: "Same title", updated: "v1" },
      EPUB_LINK,
    );
    expect(result.vaultPath).toBe("Books/Same title (2).epub");
    expect(harness.writes).toEqual(["Books/Same title (2).epub"]);
  });

  it("serializes concurrent downloads so equal titles get distinct paths", async () => {
    const harness = makeHarness();
    const downloader = makeDownloader(harness, async () => response());
    const [first, second] = await Promise.all([
      downloader.download(
        { id: "book-1", title: "Same", updated: "v1" },
        EPUB_LINK,
      ),
      downloader.download(
        { id: "book-2", title: "Same", updated: "v1" },
        EPUB_LINK,
      ),
    ]);
    expect([first.vaultPath, second.vaultPath]).toEqual([
      "Books/Same.epub",
      "Books/Same (2).epub",
    ]);
  });

  it("does not send Booklore credentials to another origin", async () => {
    const harness = makeHarness();
    const transport = vi.fn<BookDownloadTransport>(async (_url, headers) => {
      expect(headers.Authorization).toBeUndefined();
      return response();
    });
    const downloader = makeDownloader(harness, transport);
    await downloader.download(
      { id: "book-1", title: "Remote", updated: "v1" },
      { ...EPUB_LINK, href: "https://downloads.example/book.epub" },
    );
    expect(transport).toHaveBeenCalledOnce();
  });

  it("rejects MOBI, unsafe URLs, and auth failures without writing", async () => {
    const harness = makeHarness();
    const transport = vi.fn<BookDownloadTransport>(async () =>
      response(new ArrayBuffer(0), {}, 401),
    );
    const downloader = makeDownloader(harness, transport);

    await expect(
      downloader.download(
        { id: "book-1", title: "Mobi", updated: "v1" },
        { ...EPUB_LINK, type: "application/x-mobipocket-ebook" },
      ),
    ).rejects.toMatchObject({ kind: "unsupported-format" });
    await expect(
      downloader.download(
        { id: "book-1", title: "Unsafe", updated: "v1" },
        { ...EPUB_LINK, href: "javascript:alert(1)" },
      ),
    ).rejects.toMatchObject({ kind: "invalid-url" });
    await expect(
      downloader.download(
        { id: "book-1", title: "Private", updated: "v1" },
        EPUB_LINK,
      ),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(harness.writes).toEqual([]);
  });

  it("creates nested folders and fails clearly when a segment is a file", async () => {
    const harness = makeHarness();
    harness.settings.booksFolder = "Library/Books";
    const downloader = makeDownloader(harness, async () => response());
    await downloader.download(
      { id: "book-1", title: "Nested", updated: "v1" },
      EPUB_LINK,
    );
    expect(harness.folders).toEqual(new Set(["Library", "Library/Books"]));

    const conflict = makeHarness();
    conflict.settings.booksFolder = "Library/Books";
    conflict.fileConflicts.add("Library");
    const blocked = makeDownloader(conflict, async () => response());
    await expect(
      blocked.download(
        { id: "book-1", title: "Blocked", updated: "v1" },
        EPUB_LINK,
      ),
    ).rejects.toMatchObject({ kind: "folder-conflict" });
    expect(conflict.writes).toEqual([]);
  });

  it("rejects a configured path that could escape the vault", async () => {
    const harness = makeHarness();
    harness.settings.booksFolder = "../Outside";
    const downloader = makeDownloader(harness, async () => response());
    await expect(
      downloader.download(
        { id: "book-1", title: "Blocked", updated: "v1" },
        EPUB_LINK,
      ),
    ).rejects.toMatchObject({ kind: "invalid-folder" });
    expect(harness.writes).toEqual([]);
  });
});
