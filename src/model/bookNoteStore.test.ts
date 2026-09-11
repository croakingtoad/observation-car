import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bookNoteModule from "./bookNote";
import {
  DEFAULT_REPARSE_DEBOUNCE_MS,
  BookNoteStore,
  type BookNoteStoreDeps,
} from "./bookNoteStore";

const SOURCE = "Books/Surprised by Grace.epub";

const NOTE_TEXT = [
  "---",
  "type: book-note",
  `source: "[[${SOURCE}]]"`,
  "format: epub",
  "---",
  "",
  `## [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|Ch. 1]]`,
  "body",
].join("\n");

const NOT_A_BOOK_NOTE = ["no frontmatter at all", "just prose"].join("\n");

/** Distinct text the parse spy treats as unparseable (see parse-failure test). */
const BROKEN_TEXT = NOTE_TEXT + "\nBROKEN";

interface Rig {
  store: BookNoteStore;
  reads: string[];
}

function makeStore(overrides: Partial<BookNoteStoreDeps> = {}): Rig {
  const reads: string[] = [];
  const innerRead = overrides.readText ?? (async () => NOTE_TEXT);
  const deps: BookNoteStoreDeps = {
    readText: async (path) => {
      reads.push(path);
      return innerRead(path);
    },
    anchorHeadingLevel: overrides.anchorHeadingLevel ?? (() => 2),
    debounceMs: overrides.debounceMs,
  };
  return { store: new BookNoteStore(deps), reads };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function elapse(ms = DEFAULT_REPARSE_DEBOUNCE_MS): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("BookNoteStore", () => {
  it("re-parses only after the debounce window", async () => {
    const { store, reads } = makeStore();
    store.scheduleReparse("Reading/Book.md");
    expect(store.has("Reading/Book.md")).toBe(false);
    expect(reads).toEqual([]);

    await vi.advanceTimersByTimeAsync(DEFAULT_REPARSE_DEBOUNCE_MS - 1);
    expect(reads).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toEqual(["Reading/Book.md"]);
    const cached = store.get("Reading/Book.md");
    expect(cached?.sections.map((s) => s.fragment)).toEqual([
      "epubcfi(/6/8!/4/2/1:0)",
    ]);
  });

  it("coalesces rapid schedules for the same path into one read", async () => {
    const { store, reads } = makeStore();
    store.scheduleReparse("Reading/Book.md");
    store.scheduleReparse("Reading/Book.md");
    store.scheduleReparse("Reading/Book.md");
    await elapse();
    expect(reads).toEqual(["Reading/Book.md"]);
  });

  it("batches different paths into a single parse pass", async () => {
    const { store, reads } = makeStore();
    store.scheduleReparse("a.md");
    store.scheduleReparse("b.md");
    await elapse();
    expect(reads).toEqual(["a.md", "b.md"]);
    expect(store.has("a.md")).toBe(true);
    expect(store.has("b.md")).toBe(true);
    expect(store.paths().sort()).toEqual(["a.md", "b.md"]);
  });

  it("does not cache files that are not book notes", async () => {
    const { store, reads } = makeStore({
      readText: async () => NOT_A_BOOK_NOTE,
    });
    store.scheduleReparse("plain.md");
    await elapse();
    expect(reads).toEqual(["plain.md"]);
    expect(store.has("plain.md")).toBe(false);
    expect(store.size).toBe(0);
  });

  it("treats a vanished file as gone (null read and failed read)", async () => {
    const vanished = makeStore({ readText: async () => null });
    vanished.store.scheduleReparse("gone.md");
    await elapse();
    expect(vanished.store.has("gone.md")).toBe(false);

    const failing = makeStore({
      readText: async () => {
        throw new Error("ENOENT");
      },
    });
    failing.store.scheduleReparse("broken.md");
    await elapse();
    expect(failing.store.has("broken.md")).toBe(false);
  });

  it("drops a cached note when a re-parse finds the file gone", async () => {
    let fileExists = true;
    const { store } = makeStore({
      readText: async () => (fileExists ? NOTE_TEXT : null),
    });
    store.scheduleReparse("Book.md");
    await elapse();
    expect(store.has("Book.md")).toBe(true);

    fileExists = false;
    store.scheduleReparse("Book.md");
    await elapse();
    expect(store.has("Book.md")).toBe(false);
  });

  it("removes a path immediately and cancels its pending re-parse", async () => {
    const { store, reads } = makeStore();
    store.scheduleReparse("Reading/Book.md");
    store.remove("Reading/Book.md");
    await elapse();
    expect(reads).toEqual([]);
    expect(store.has("Reading/Book.md")).toBe(false);
  });

  it("flush() runs pending re-parses without waiting for the window", async () => {
    const { store, reads } = makeStore();
    store.scheduleReparse("Reading/Book.md");
    await store.flush();
    expect(reads).toEqual(["Reading/Book.md"]);
    expect(store.has("Reading/Book.md")).toBe(true);
  });

  it("clear() empties the cache and cancels the pending re-parse", async () => {
    const { store, reads } = makeStore();
    store.scheduleReparse("Reading/Book.md");
    store.clear();
    await vi.advanceTimersByTimeAsync(DEFAULT_REPARSE_DEBOUNCE_MS * 10);
    expect(reads).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("reads anchorHeadingLevel at parse time, never from a snapshot", async () => {
    let level = 2;
    const { store } = makeStore({
      readText: async () =>
        [
          "---",
          `source: "[[${SOURCE}]]"`,
          "---",
          "",
          "## [[x.epub#page=1|not this]]",
          `### [[${SOURCE}#epubcfi(/6/8!/4/2/1:0)|H3 anchor]]`,
        ].join("\n"),
      anchorHeadingLevel: () => level,
    });

    // Level 2 at first parse: the H3 heading is body content, zero sections.
    store.scheduleReparse("Reading/Book.md");
    await elapse();
    expect(level).toBe(2);
    expect(store.get("Reading/Book.md")?.sections).toEqual([]);

    // The user switches the level mid-session; the next parse picks it up.
    level = 3;
    store.scheduleReparse("Reading/Book.md");
    await elapse();
    expect(store.get("Reading/Book.md")?.sections).toHaveLength(1);
  });

  it("still parses paths scheduled while a run is in flight", async () => {
    let releaseFirst: (text: string) => void = () => {};
    const firstRead = new Promise<string>((resolve) => {
      releaseFirst = resolve;
    });
    const { store, reads } = makeStore({
      readText: async (path) => {
        if (path === "a.md") return await firstRead;
        return NOTE_TEXT;
      },
    });
    store.scheduleReparse("a.md");
    const flushing = store.flush();
    store.scheduleReparse("b.md"); // while a.md's read is in flight
    releaseFirst(NOTE_TEXT);
    await flushing;
    await elapse(); // let the debounced run for b.md fire
    expect(reads).toEqual(["a.md", "b.md"]);
    expect(store.has("a.md")).toBe(true);
    expect(store.has("b.md")).toBe(true);
  });

  it("a parse failure keeps batch siblings cached and surfaces the error", async () => {
    // The store's seam with the parser is this import; spy there so the
    // throw is deterministic. The parser's own throw contract (rethrow
    // non-AnchorError) is proven in bookNote.test.ts.
    const originalParse = bookNoteModule.parseBookNote;
    const parseSpy = vi.spyOn(bookNoteModule, "parseBookNote");
    parseSpy.mockImplementation((text, options) => {
      if (text === BROKEN_TEXT) throw new Error("synthetic parse failure");
      return originalParse(text, options);
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let serveBroken = false;
    const { store } = makeStore({
      readText: async (path) =>
        serveBroken && path === "broken.md" ? BROKEN_TEXT : NOTE_TEXT,
    });

    // Baseline pass: all three paths parse and cache.
    store.scheduleReparse("a.md");
    store.scheduleReparse("broken.md");
    store.scheduleReparse("c.md");
    await elapse();
    expect(store.has("a.md")).toBe(true);
    expect(store.has("broken.md")).toBe(true);
    expect(store.has("c.md")).toBe(true);

    // Second batch: broken.md now reads text that makes parse throw.
    serveBroken = true;
    store.scheduleReparse("a.md");
    store.scheduleReparse("broken.md");
    store.scheduleReparse("c.md");
    await elapse();

    // Siblings are untouched: one bad note must not drop the batch.
    expect(store.has("a.md")).toBe(true);
    expect(store.has("c.md")).toBe(true);
    expect(store.get("a.md")?.sections.map((s) => s.fragment)).toEqual([
      "epubcfi(/6/8!/4/2/1:0)",
    ]);
    // The failure is surfaced with the path, not swallowed.
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("broken.md"),
      expect.any(Error),
    );
    // Documented choice: the throwing path keeps its last-good parse.
    expect(store.has("broken.md")).toBe(true);
    expect(store.get("broken.md")?.frontmatter.source).toBe(SOURCE);
  });

  it("a thrown read keeps the last-good parse instead of evicting the entry", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let readShouldThrow = false;
    const { store } = makeStore({
      readText: async () => {
        if (readShouldThrow) throw new Error("ENOTSYNC: transient read failure");
        return NOTE_TEXT;
      },
    });
    store.scheduleReparse("Book.md");
    await elapse();
    expect(store.has("Book.md")).toBe(true);

    readShouldThrow = true;
    store.scheduleReparse("Book.md");
    await elapse();
    // Read failure is not deletion: the previous entry survives and the
    // error is logged (null reads still evict — see the vanished-file test).
    expect(store.has("Book.md")).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Book.md"),
      expect.any(Error),
    );
  });
});
