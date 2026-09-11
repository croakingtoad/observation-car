import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REPARSE_DEBOUNCE_MS,
  BookNoteStore,
  type BookNoteStoreDeps,
} from "./bookNoteStore";
import {
  parseBookNote,
  type BookNote,
  type ParseBookNoteOptions,
} from "./bookNote";

vi.mock("./bookNote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bookNote")>();
  return {
    ...actual,
    // Pass-through by default; the failure-handling tests override it to
    // simulate a parser bug.
    parseBookNote: vi.fn(actual.parseBookNote),
  };
});

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

// A valid book note whose parse the mock is told to treat as a parser bug.
const BUG_NOTE_TEXT = [
  "---",
  "type: book-note",
  `source: "[[${SOURCE}]]"`,
  "format: epub",
  "---",
  "",
  `## [[${SOURCE}#epubcfi(/6/10!/4/2/1:0)|Ch. 2]]`,
  "body the parser will choke on",
].join("\n");

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

  it("treats a null read as a vanished file", async () => {
    const { store } = makeStore({ readText: async () => null });
    store.scheduleReparse("gone.md");
    await elapse();
    expect(store.has("gone.md")).toBe(false);
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

  describe("failure handling (LOCO-105)", () => {
    // The module mock above wraps parseBookNote in a pass-through vi.fn so
    // a parser bug can be simulated; capture the real implementation
    // before each test and restore it after, so no override leaks.
    let realParse: (text: string, options?: ParseBookNoteOptions) => BookNote;

    beforeEach(() => {
      realParse = vi.mocked(parseBookNote).getMockImplementation()!;
    });

    afterEach(() => {
      vi.mocked(parseBookNote).mockImplementation(realParse);
      vi.restoreAllMocks();
    });

    it("isolates a throwing parse: siblings still parse, the error is surfaced, the last-good entry stays", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const bug = new Error("simulated parser bug");
      let buggy = false;
      vi.mocked(parseBookNote).mockImplementation((text, options) => {
        if (buggy && text === BUG_NOTE_TEXT) throw bug;
        return realParse(text, options);
      });
      const { store } = makeStore({
        readText: async (path) => (path === "bad.md" ? BUG_NOTE_TEXT : NOTE_TEXT),
      });

      // bad.md first parses fine, establishing its last-good entry.
      store.scheduleReparse("bad.md");
      await elapse();
      const lastGood = store.get("bad.md");
      expect(lastGood).toBeDefined();

      // The parser bug trips on bad.md while healthy siblings are in the
      // same batch.
      buggy = true;
      store.scheduleReparse("a.md");
      store.scheduleReparse("bad.md");
      store.scheduleReparse("c.md");
      await elapse();

      // The remaining paths are still parsed and cached.
      expect(store.get("a.md")).toBeDefined();
      expect(store.get("c.md")).toBeDefined();
      // The throwing path keeps its prior cache entry.
      expect(store.get("bad.md")).toBe(lastGood);
      // The error is surfaced with the path and the error object, once,
      // for the throwing path only.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("bad.md"),
        bug,
      );
    });

    it("a failed read (not a deletion) retains the last-good entry and logs; a null read still evicts", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const ioError = new Error("EIO: transient vault failure");
      let readState: "good" | "failing" | "gone" = "good";
      const { store } = makeStore({
        readText: async () => {
          if (readState === "good") return NOTE_TEXT;
          if (readState === "failing") throw ioError;
          return null;
        },
      });

      store.scheduleReparse("flaky.md");
      await elapse();
      const lastGood = store.get("flaky.md");
      expect(lastGood).toBeDefined();

      readState = "failing";
      store.scheduleReparse("flaky.md");
      await elapse();
      expect(store.get("flaky.md")).toBe(lastGood);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("flaky.md"),
        ioError,
      );

      readState = "gone";
      store.scheduleReparse("flaky.md");
      await elapse();
      expect(store.has("flaky.md")).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1); // the null read is not logged
    });
  });
});
