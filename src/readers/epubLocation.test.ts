import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOCATION_DEBOUNCE_MS,
  EpubLocationTracker,
  chapterLabel,
  locationForRelocation,
  tocLabelForHref,
  type EpubLocation,
  type TocItem,
} from "./epubLocation";

const TOC: readonly TocItem[] = [
  { label: "Front Matter", href: "front-matter.xhtml" },
  {
    label: "The Opening Image",
    href: "chapters/ch1.xhtml",
    subitems: [{ label: "Prologue", href: "chapters/ch1.xhtml#prologue" }],
  },
  { label: "Leaves the Furniture", href: "chapters/ch3.xhtml" },
];

const rel = (cfi: string, href: string) => ({ cfi, href });

describe("tocLabelForHref", () => {
  it("resolves a chapter from an exact spine href match", () => {
    expect(tocLabelForHref(TOC, "chapters/ch1.xhtml")).toBe(
      "The Opening Image",
    );
  });

  it("ignores a fragment on the TOC side (sub-chapter anchors)", () => {
    // A TOC item anchored inside ch1 must not shadow the chapter entry
    // that comes first in document order.
    const subOnly: readonly TocItem[] = [
      { label: "Prologue", href: "chapters/ch1.xhtml#prologue" },
    ];
    expect(tocLabelForHref(subOnly, "chapters/ch1.xhtml")).toBe("Prologue");
  });

  it("ignores a fragment on the spine side", () => {
    expect(tocLabelForHref(TOC, "chapters/ch3.xhtml#end")).toBe(
      "Leaves the Furniture",
    );
  });

  it("matches URI-encoded variants", () => {
    const toc: readonly TocItem[] = [
      { label: "Notes", href: "notes/Ch.%205%20Notes.xhtml" },
    ];
    expect(tocLabelForHref(toc, "notes/Ch. 5 Notes.xhtml")).toBe("Notes");
    expect(tocLabelForHref(toc, "notes/Ch.%205%20Notes.xhtml")).toBe("Notes");
  });

  it("searches nested subitems", () => {
    const toc: readonly TocItem[] = [
      {
        label: "Part One",
        href: "part1.xhtml",
        subitems: [{ label: "Chapter Two", href: "chapters/ch2.xhtml" }],
      },
    ];
    expect(tocLabelForHref(toc, "chapters/ch2.xhtml")).toBe("Chapter Two");
  });

  it("returns null when no TOC item points at the spine item", () => {
    expect(tocLabelForHref(TOC, "chapters/zzz.xhtml")).toBeNull();
    expect(tocLabelForHref([], "chapters/ch1.xhtml")).toBeNull();
  });
});

describe("chapterLabel", () => {
  it("falls back to 'Ch. N' with the chapter (spine index)", () => {
    expect(chapterLabel(3)).toBe("Ch. 3");
    expect(chapterLabel(0)).toBe("Ch. 0");
  });

  it("is 'Unknown' when the chapter is unresolvable", () => {
    expect(chapterLabel(null)).toBe("Unknown");
  });
});

describe("locationForRelocation", () => {
  it("builds the PRD §8 Location from a wrapped relocated CFI", () => {
    expect(
      locationForRelocation(rel("epubcfi(/6/8!/4/2/1:0)", "chapters/ch1.xhtml"), TOC),
    ).toEqual({
      fragment: "#epubcfi(/6/8!/4/2/1:0)",
      chapter: 3,
      label: "The Opening Image",
    });
  });

  it("labels from the TOC when resolvable, else 'Ch. N'", () => {
    const labeled = locationForRelocation(
      rel("/6/8!/4/2/1:0", "chapters/ch1.xhtml"),
      TOC,
    );
    expect(labeled?.label).toBe("The Opening Image");

    const unlabeled = locationForRelocation(
      rel("/6/8!/4/2/1:0", "chapters/ch1.xhtml"),
      [],
    );
    expect(unlabeled?.label).toBe("Ch. 3");

    const noTocAtAll = locationForRelocation(
      rel("/6/8!/4/2/1:0", "mystery.xhtml"),
      TOC,
    );
    expect(noTocAtAll?.label).toBe("Ch. 3");
  });

  it("takes the chapter from the base component of a range CFI", () => {
    expect(
      locationForRelocation(
        rel("/6/4!/4/2/6:32,/2/1:1,/2/1:80", "front-matter.xhtml"),
        TOC,
      ),
    ).toEqual({
      fragment: "#epubcfi(/6/4!/4/2/6:32,/2/1:1,/2/1:80)",
      chapter: 1,
      label: "Front Matter",
    });
  });

  it("drops relocations without a position", () => {
    expect(locationForRelocation(rel("", "ch1.xhtml"), TOC)).toBeNull();
  });

  it("drops CFIs that are not a valid fragment", () => {
    expect(
      locationForRelocation(rel("not a cfi at all", "ch1.xhtml"), TOC),
    ).toBeNull();
    // A non-canonical chapter component is likewise not a valid fragment.
    expect(locationForRelocation(rel("/6!x", "ch1.xhtml"), TOC)).toBeNull();
  });
});

describe("EpubLocationTracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const collect = (
    tracker: EpubLocationTracker,
  ): EpubLocation[] => {
    const seen: EpubLocation[] = [];
    tracker.on((loc) => seen.push(loc));
    return seen;
  };

  it("defaults the debounce window to ~150 ms", () => {
    expect(DEFAULT_LOCATION_DEBOUNCE_MS).toBe(150);
    vi.useFakeTimers();
    const tracker = new EpubLocationTracker();
    const seen = collect(tracker);

    tracker.onRelocated(rel("/6/8!/4/2/1:0", "ch1.xhtml"));
    vi.advanceTimersByTime(149);
    expect(seen).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(seen).toHaveLength(1);
    tracker.destroy();
  });

  it("coalesces a burst into one event after the last move", () => {
    vi.useFakeTimers();
    const tracker = new EpubLocationTracker();
    const seen = collect(tracker);

    tracker.onRelocated(rel("/6/8!/4/2/1:0", "ch1.xhtml"));
    vi.advanceTimersByTime(100);
    tracker.onRelocated(rel("/6/8!/4/2/5:0", "ch1.xhtml"));
    vi.advanceTimersByTime(100); // t=200: first timer would have fired
    expect(seen).toHaveLength(0); // ...but the second move reset it
    vi.advanceTimersByTime(50); // t=250: 150 ms after the last move
    expect(seen).toHaveLength(1);
    expect(seen[0].fragment).toBe("#epubcfi(/6/8!/4/2/5:0)");
    tracker.destroy();
  });

  it("ignores null relocations (position not ready yet)", () => {
    vi.useFakeTimers();
    const tracker = new EpubLocationTracker();
    const seen = collect(tracker);

    tracker.onRelocated(null);
    vi.advanceTimersByTime(1000);
    expect(seen).toHaveLength(0);
    expect(tracker.current()).toBeNull();
    tracker.destroy();
  });

  it("resolves labels against a TOC that arrives after relocation", () => {
    vi.useFakeTimers();
    const tracker = new EpubLocationTracker();
    const seen = collect(tracker);

    tracker.onRelocated(rel("/6/8!/4/2/1:0", "chapters/ch1.xhtml"));
    tracker.setToc(TOC); // navigation resolves before the debounced emit
    vi.advanceTimersByTime(150);
    expect(seen[0].label).toBe("The Opening Image");
    tracker.destroy();
  });

  it("falls back to 'Ch. N' when the book has no TOC", () => {
    vi.useFakeTimers();
    const tracker = new EpubLocationTracker();
    const seen = collect(tracker);

    tracker.onRelocated(rel("/6/8!/4/2/1:0", "chapters/ch1.xhtml"));
    vi.advanceTimersByTime(150);
    expect(seen[0].label).toBe("Ch. 3");
    tracker.destroy();
  });

  it("returns an unsubscribe function that stops delivery", () => {
    vi.useFakeTimers();
    const tracker = new EpubLocationTracker();
    const seen = collect(tracker);
    const other: EpubLocation[] = [];
    const unsubscribe = tracker.on((loc) => other.push(loc));

    tracker.onRelocated(rel("/6/8!/4/2/1:0", "ch1.xhtml"));
    vi.advanceTimersByTime(150);
    expect(seen).toHaveLength(1);
    expect(other).toHaveLength(1);

    unsubscribe();
    tracker.onRelocated(rel("/6/14!/4/2/12:0", "ch3.xhtml"));
    vi.advanceTimersByTime(150);
    expect(seen).toHaveLength(2); // the other subscriber still gets it
    expect(other).toHaveLength(1);
    tracker.destroy();
  });

  it("records the last emitted location in current()", () => {
    vi.useFakeTimers();
    const tracker = new EpubLocationTracker();
    expect(tracker.current()).toBeNull();

    tracker.onRelocated(rel("/6/8!/4/2/1:0", "ch1.xhtml"));
    vi.advanceTimersByTime(150);
    expect(tracker.current()).toEqual({
      fragment: "#epubcfi(/6/8!/4/2/1:0)",
      chapter: 3,
      label: "Ch. 3",
    });
    tracker.destroy();
  });

  it("derives the latest accepted relocation synchronously in current()", () => {
    vi.useFakeTimers();
    const tracker = new EpubLocationTracker();
    expect(tracker.current()).toBeNull();

    tracker.onRelocated(rel("/6/8!/4/2/1:0", "ch1.xhtml"));
    expect(tracker.current()).toEqual({
      fragment: "#epubcfi(/6/8!/4/2/1:0)",
      chapter: 3,
      label: "Ch. 3",
    });

    tracker.onRelocated(rel("/6/14!/4/2/12:0", "ch3.xhtml"));
    expect(tracker.current()).toEqual({
      fragment: "#epubcfi(/6/14!/4/2/12:0)",
      chapter: 6,
      label: "Ch. 6",
    });
    tracker.destroy();
    expect(tracker.current()).toBeNull();
  });

  it("cancels a pending event on destroy", () => {
    vi.useFakeTimers();
    const tracker = new EpubLocationTracker();
    const seen = collect(tracker);

    tracker.onRelocated(rel("/6/8!/4/2/1:0", "ch1.xhtml"));
    tracker.destroy();
    vi.advanceTimersByTime(1000);
    expect(seen).toHaveLength(0);
  });

  it("clears its timer and rejects new relocations after destroy", () => {
    vi.useFakeTimers();
    const tracker = new EpubLocationTracker();

    tracker.onRelocated(rel("/6/8!/4/2/1:0", "ch1.xhtml"));
    tracker.destroy();
    expect(vi.getTimerCount()).toBe(0);

    const acceptedAfterDestroy: EpubLocation[] = [];
    tracker.on((loc) => acceptedAfterDestroy.push(loc));
    tracker.onRelocated(rel("/6/14!/4/2/12:0", "ch3.xhtml"));
    vi.advanceTimersByTime(1000);
    expect(acceptedAfterDestroy).toHaveLength(0);
  });

describe("EpubLocationTracker defect 4: throwing subscriber does not starve others (LOCO-1031)", () => {
  it("delivers to all good subscribers even when a subscriber throws", () => {
    vi.useFakeTimers();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tracker = new EpubLocationTracker();
    const seen: EpubLocation[] = [];
    const thrott: EpubLocation[] = [];

    // Four subscribers: throwing, good, throwing, good
    tracker.on(() => { throw new Error("boom one"); });
    tracker.on((loc) => seen.push(loc));
    tracker.on(() => { throw new Error("boom two"); });
    tracker.on((loc) => thrott.push(loc));

    tracker.onRelocated(rel("/6/8!/4/2/1:0", "ch1.xhtml"));
    vi.advanceTimersByTime(150);

    // Both good subscribers received the event
    expect(seen).toHaveLength(1);
    expect(thrott).toHaveLength(1);

    // console.warn was called twice (once per thrown subscriber)
    expect(consoleWarn).toHaveBeenCalledTimes(2);
    expect(consoleWarn).toHaveBeenCalledWith(
      "[Observation Car] Location subscriber threw",
      expect.any(Error),
    );

    tracker.destroy();
  });
});
});
