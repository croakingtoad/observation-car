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

  it("keeps working after a pending changed path is deleted", async () => {
    const { store, reads } = makeStore();

    // `changed`, then `deleted` inside the debounce window: removing the
    // only pending path must disarm the otherwise-empty timer callback.
    store.scheduleReparse("Reading/Deleted.md");
    expect(vi.getTimerCount()).toBe(1);
    store.remove("Reading/Deleted.md");
    expect(vi.getTimerCount()).toBe(0);
    await elapse();

    // A later ordinary edit still parses, and flush still terminates.
    store.scheduleReparse("Reading/B.md");
    await store.flush();
    expect(reads).toEqual(["Reading/B.md"]);
    expect(store.paths()).toEqual(["Reading/B.md"]);
  });

  it("flush() runs pending re-parses without waiting for the window", async () => {
    const { store, reads } = makeStore();
    store.scheduleReparse("Reading/Book.md");
    await store.flush();
    expect(reads).toEqual(["Reading/Book.md"]);
    expect(store.has("Reading/Book.md")).toBe(true);
  });

  it("flush() logs and returns if a settled run remains published", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { store } = makeStore();

    // Recreate the pathological state defensively guarded by flush. The
    // field is private to production callers, so Reflect is used only by
    // this white-box regression probe.
    Reflect.set(store, "runPromise", Promise.resolve());
    await store.flush();

    expect(consoleError).toHaveBeenCalledWith(
      "[observation-car] book-note flush made no progress",
    );
  });

  it("clear() empties the cache and cancels the pending re-parse", async () => {
    const { store, reads } = makeStore();
    store.scheduleReparse("Reading/Book.md");
    store.clear();
    await vi.advanceTimersByTimeAsync(DEFAULT_REPARSE_DEBOUNCE_MS * 10);
    expect(reads).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("clear() drops stale run state before the next flush", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { store, reads } = makeStore();

    // Recreate run state surviving until plugin unload. The fields are
    // private to production callers, so Reflect is limited to this
    // white-box regression setup.
    Reflect.set(store, "runPromise", Promise.resolve());
    Reflect.set(store, "rerunRequested", true);
    store.clear();
    expect(Reflect.get(store, "runPromise")).toBeNull();
    expect(Reflect.get(store, "rerunRequested")).toBe(false);

    store.scheduleReparse("Reading/Book.md");
    await store.flush();

    expect(reads).toEqual(["Reading/Book.md"]);
    expect(store.has("Reading/Book.md")).toBe(true);
    expect(consoleError).not.toHaveBeenCalledWith(
      "[observation-car] book-note flush made no progress",
    );
  });

  it("clear() stops the remaining reads in a snapshotted batch", async () => {
    let releaseFirstRead: (text: string) => void = () => {};
    let markFirstReadStarted: () => void = () => {};
    const firstRead = new Promise<string>((resolve) => {
      releaseFirstRead = resolve;
    });
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve;
    });
    const { store, reads } = makeStore({
      readText: async (path) => {
        if (path === "a.md") {
          markFirstReadStarted();
          return await firstRead;
        }
        return NOTE_TEXT;
      },
    });

    store.scheduleReparse("a.md");
    store.scheduleReparse("b.md");
    store.scheduleReparse("c.md");
    const abandonedFlush = store.flush();
    await firstReadStarted;

    store.clear();
    store.scheduleReparse("x.md");
    const successorFlush = store.flush();
    releaseFirstRead(NOTE_TEXT);
    await Promise.all([abandonedFlush, successorFlush]);

    expect(reads).toEqual(["a.md", "x.md"]);
    expect(store.has("x.md")).toBe(true);
  });

  it("an orphaned run cannot drain work queued after clear()", async () => {
    let releaseRead: (text: string) => void = () => {};
    let markReadStarted: () => void = () => {};
    const read = new Promise<string>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const { store, reads } = makeStore({
      readText: async () => {
        markReadStarted();
        return await read;
      },
    });

    store.scheduleReparse("a.md");
    const abandonedFlush = store.flush();
    store.clear();
    store.scheduleReparse("x.md");

    let successorFlushFinished = false;
    const successorFlush = store.flush().then(() => {
      successorFlushFinished = true;
    });
    await readStarted;
    expect(reads).toEqual(["x.md"]);

    await vi.advanceTimersByTimeAsync(0);
    expect(successorFlushFinished).toBe(false);

    releaseRead(NOTE_TEXT);
    await Promise.all([abandonedFlush, successorFlush]);
    expect(store.has("x.md")).toBe(true);
  });

  it("an orphaned run cannot clear its successor after clear()", async () => {
    let releaseFirst: (text: string) => void = () => {};
    let releaseSecond: (text: string) => void = () => {};
    let markFirstStarted: () => void = () => {};
    let markSecondStarted: () => void = () => {};
    const firstRead = new Promise<string>((resolve) => {
      releaseFirst = resolve;
    });
    const secondRead = new Promise<string>((resolve) => {
      releaseSecond = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const { store } = makeStore({
      readText: async (path) => {
        if (path === "a.md") {
          markFirstStarted();
          return await firstRead;
        }
        markSecondStarted();
        return await secondRead;
      },
    });

    store.scheduleReparse("a.md");
    const firstFlush = store.flush();
    const orphanedRun = Reflect.get(store, "runPromise") as Promise<void>;
    await firstStarted;

    store.clear();
    store.scheduleReparse("b.md");
    const successorFlush = store.flush();
    const successorRun = Reflect.get(store, "runPromise") as Promise<void>;
    await secondStarted;

    releaseFirst(NOTE_TEXT);
    await orphanedRun;
    expect(store.size).toBe(0);
    expect(store.has("a.md")).toBe(false);
    expect(Reflect.get(store, "runPromise")).toBe(successorRun);

    let lateFlushFinished = false;
    const lateFlush = store.flush().then(() => {
      lateFlushFinished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(lateFlushFinished).toBe(false);

    releaseSecond(NOTE_TEXT);
    await Promise.all([firstFlush, successorFlush, lateFlush]);
    expect(store.has("b.md")).toBe(true);
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

  it("flush() does not resolve until paths scheduled mid-run are parsed", async () => {
    // The QC Tier 2 probe: with a run in flight, the old flush() set
    // rerunRequested and returned immediately, so `await flush()`
    // resolved with b.md still unparsed.
    let releaseFirst: (text: string) => void = () => {};
    const firstRead = new Promise<string>((resolve) => {
      releaseFirst = resolve;
    });
    const { store, reads } = makeStore({
      readText: async (path) => (path === "a.md" ? await firstRead : NOTE_TEXT),
    });
    store.scheduleReparse("a.md");
    const flushing = store.flush();
    store.scheduleReparse("b.md"); // while a.md's read is in flight
    const secondFlush = store.flush();
    expect(store.has("b.md")).toBe(false); // still unparsed

    releaseFirst(NOTE_TEXT);
    await secondFlush;
    expect(reads).toEqual(["a.md", "b.md"]);
    expect(store.has("a.md")).toBe(true);
    expect(store.has("b.md")).toBe(true); // true at the moment flush resolved
    await flushing;
  });

  it("a second flush concurrent with the first also awaits the full drain", async () => {
    let releaseFirst: (text: string) => void = () => {};
    const firstRead = new Promise<string>((resolve) => {
      releaseFirst = resolve;
    });
    const { store } = makeStore({
      readText: async (path) => (path === "a.md" ? await firstRead : NOTE_TEXT),
    });
    store.scheduleReparse("a.md");
    const first = store.flush();
    store.scheduleReparse("b.md");
    const second = store.flush();
    let secondFinished = false;
    const observeSecond = async (): Promise<void> => {
      await second;
      secondFinished = true;
    };
    const observation = observeSecond();

    // Let every currently runnable microtask settle while a.md remains
    // blocked. The second flush must still be waiting for the shared run.
    await vi.advanceTimersByTimeAsync(0);
    expect(secondFinished).toBe(false);

    releaseFirst(NOTE_TEXT);
    await Promise.all([first, second, observation]);
    expect(secondFinished).toBe(true);
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
