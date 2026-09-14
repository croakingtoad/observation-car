import { describe, expect, it } from "vitest";
import {
  SWIPE_MAX_PRESS_MS,
  SWIPE_MIN_DISTANCE_PX,
  TAP_MAX_PRESS_MS,
  TAP_SLOP_PX,
  decidePagingAction,
  type PagingGesture,
} from "./pagingGestures";

/** A short, still tap at the left edge of a 300 px page. */
function tap(overrides: Partial<PagingGesture> = {}): PagingGesture {
  return {
    flowMode: "paginated",
    hasSelection: false,
    deltaX: 0,
    deltaY: 0,
    distance: 0,
    durationMs: 50,
    endX: 10,
    contentWidth: 300,
    ...overrides,
  };
}

describe("F2.2 tap zones (paginated mode)", () => {
  it("pages back in the left third", () => {
    expect(decidePagingAction(tap({ endX: 0 })).kind).toBe("page");
    expect(decidePagingAction(tap({ endX: 99 }))).toEqual({
      kind: "page",
      direction: "prev",
    });
  });

  it("pages forward in the right third", () => {
    expect(decidePagingAction(tap({ endX: 201 }))).toEqual({
      kind: "page",
      direction: "next",
    });
    expect(decidePagingAction(tap({ endX: 300 }))).toEqual({
      kind: "page",
      direction: "next",
    });
  });

  it("does nothing in the middle third", () => {
    expect(decidePagingAction(tap({ endX: 150 }))).toEqual({ kind: "none" });
  });

  it("treats the exact third boundaries as neutral", () => {
    expect(decidePagingAction(tap({ endX: 100 }))).toEqual({ kind: "none" });
    expect(decidePagingAction(tap({ endX: 200 }))).toEqual({ kind: "none" });
  });
});

describe("F2.2 tap guards", () => {
  it("rejects a tap once the pointer moved past the slop", () => {
    expect(decidePagingAction(tap({ distance: TAP_SLOP_PX }))).toEqual({
      kind: "page",
      direction: "prev",
    });
    expect(
      decidePagingAction(tap({ distance: TAP_SLOP_PX + 1, endX: 99 })),
    ).toEqual({ kind: "none" });
  });

  it("rejects a long press", () => {
    expect(decidePagingAction(tap({ durationMs: TAP_MAX_PRESS_MS }))).toEqual({
      kind: "page",
      direction: "prev",
    });
    expect(
      decidePagingAction(tap({ durationMs: TAP_MAX_PRESS_MS + 1 })),
    ).toEqual({ kind: "none" });
  });

  it("never pages while a non-empty selection is present", () => {
    expect(decidePagingAction(tap({ hasSelection: true, endX: 10 }))).toEqual({
      kind: "none",
    });
    expect(
      decidePagingAction(tap({ hasSelection: true, endX: 290 })),
    ).toEqual({ kind: "none" });
    expect(
      decidePagingAction(
        tap({ hasSelection: true, deltaX: -80, deltaY: 0, distance: 80 }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("does nothing when the document has no measurable width", () => {
    expect(decidePagingAction(tap({ contentWidth: 0 }))).toEqual({ kind: "none" });
  });

  it("ignores a drag that is neither a swipe nor a tap", () => {
    expect(
      decidePagingAction(
        tap({ deltaX: 30, deltaY: 0, distance: 30, endX: 40 }),
      ),
    ).toEqual({ kind: "none" });
  });
});

describe("F2.2 swipe (paginated mode)", () => {
  it("pages next on a fast leftward swipe", () => {
    expect(
      decidePagingAction(
        tap({ deltaX: -60, deltaY: 0, distance: 60, durationMs: 200 }),
      ),
    ).toEqual({ kind: "page", direction: "next" });
  });

  it("pages previous on a fast rightward swipe", () => {
    expect(
      decidePagingAction(tap({ deltaX: 60, deltaY: 0, distance: 60 })),
    ).toEqual({ kind: "page", direction: "prev" });
  });

  it("rejects a swipe under the horizontal distance threshold", () => {
    expect(
      decidePagingAction(
        tap({
          deltaX: -(SWIPE_MIN_DISTANCE_PX - 1),
          deltaY: 0,
          distance: SWIPE_MIN_DISTANCE_PX - 1,
        }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("accepts a swipe at exactly the threshold", () => {
    expect(
      decidePagingAction(
        tap({
          deltaX: -SWIPE_MIN_DISTANCE_PX,
          deltaY: 0,
          distance: SWIPE_MIN_DISTANCE_PX,
        }),
      ),
    ).toEqual({ kind: "page", direction: "next" });
  });

  it("rejects a slow swipe", () => {
    expect(
      decidePagingAction(
        tap({
          deltaX: -80,
          deltaY: 0,
          distance: 80,
          durationMs: SWIPE_MAX_PRESS_MS + 1,
        }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("rejects a vertical swipe", () => {
    expect(
      decidePagingAction(
        tap({ deltaX: 10, deltaY: -200, distance: 200 }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("rejects a diagonal that is not horizontally dominant", () => {
    expect(
      decidePagingAction(tap({ deltaX: 60, deltaY: 60, distance: 85 })),
    ).toEqual({ kind: "none" });
  });
});

describe("F2.2 scrolled mode (deliberate: zones and swipe are inert)", () => {
  it("ignores left- and right-third taps", () => {
    expect(
      decidePagingAction(tap({ flowMode: "scrolled", endX: 10 })),
    ).toEqual({ kind: "none" });
    expect(
      decidePagingAction(tap({ flowMode: "scrolled", endX: 290 })),
    ).toEqual({ kind: "none" });
  });

  it("ignores a fast horizontal swipe", () => {
    expect(
      decidePagingAction(
        tap({
          flowMode: "scrolled",
          deltaX: -80,
          deltaY: 0,
          distance: 80,
        }),
      ),
    ).toEqual({ kind: "none" });
  });
});
