/**
 * F2.2 — pure gesture decisions for the EPUB reader's paging inputs
 * (PRD §6 E002).
 *
 * Deliberately free of `obsidian` and `epubjs` imports so it unit-tests in
 * plain Node, the way `src/settings.ts` and `src/model/anchor.ts` already
 * do. The pointer-event glue that captures a press in the rendered
 * document and feeds this function lives in `epubNavigationTools.ts`.
 *
 * Per-mode behaviour is a deliberate call, not an omission: in scrolled
 * mode the tap zones and the horizontal swipe are INERT — scrolled mode
 * is vertical, so a horizontal gesture there is ambiguous. Arrow keys and
 * the on-screen prev/next buttons still page in both modes; they never
 * pass through this function.
 */
import type { EpubFlowMode } from "../settings";

/** What the reader should do after a completed pointer gesture. */
export type PagingAction =
  | { kind: "none" }
  | { kind: "page"; direction: "prev" | "next" };

/** A completed pointer press in the rendered document, in px and ms. */
export interface PagingGesture {
  /** Flow mode the reader was rendered with. */
  flowMode: EpubFlowMode;
  /** True when the document holds a non-empty text selection. */
  hasSelection: boolean;
  /** Horizontal travel during the press (endX - startX). */
  deltaX: number;
  /** Vertical travel during the press (endY - startY). */
  deltaY: number;
  /** Farthest the pointer moved from the press start. */
  distance: number;
  /** How long the pointer was held down, in ms. */
  durationMs: number;
  /** Pointer x on release, within the rendered document. */
  endX: number;
  /** Width of the rendered document content. */
  contentWidth: number;
}

/** A tap may wander this far from its start and still count as a tap. */
export const TAP_SLOP_PX = 10;
/** A press held longer than this is a long-press, not a tap. */
export const TAP_MAX_PRESS_MS = 500;
/** Horizontal travel needed before a gesture reads as a swipe. */
export const SWIPE_MIN_DISTANCE_PX = 45;
/** A swipe held longer than this is a drag, not a swipe. */
export const SWIPE_MAX_PRESS_MS = 500;

const NONE: PagingAction = { kind: "none" };
const PREV: PagingAction = { kind: "page", direction: "prev" };
const NEXT: PagingAction = { kind: "page", direction: "next" };

/**
 * Decide whether a completed gesture turns a page, and which way.
 * A fast, mostly-horizontal swipe outranks a tap; anything that is
 * neither, or that is guarded out below, does nothing.
 */
export function decidePagingAction(gesture: PagingGesture): PagingAction {
  // Selection protection comes first: selecting, dragging, or
  // long-pressing text must never turn a page (the F2.1 copy popup owns
  // the selection), so this short-circuits every other rule.
  if (gesture.hasSelection) {
    return NONE;
  }
  // Scrolled mode: tap zones and swipe are inert on purpose — the view
  // scrolls vertically there and a horizontal gesture is ambiguous.
  if (gesture.flowMode !== "paginated") {
    return NONE;
  }

  const horizontal = Math.abs(gesture.deltaX);
  const vertical = Math.abs(gesture.deltaY);
  if (
    horizontal >= SWIPE_MIN_DISTANCE_PX &&
    horizontal > vertical &&
    gesture.durationMs <= SWIPE_MAX_PRESS_MS
  ) {
    // Swipe left turns to the next page, swipe right to the previous —
    // mirroring a physical page turn.
    return gesture.deltaX < 0 ? NEXT : PREV;
  }

  if (gesture.distance <= TAP_SLOP_PX && gesture.durationMs <= TAP_MAX_PRESS_MS) {
    if (gesture.contentWidth <= 0) {
      return NONE;
    }
    // Left third pages back, right third pages forward, middle third is
    // neutral.
    const third = gesture.contentWidth / 3;
    if (gesture.endX < third) {
      return PREV;
    }
    if (gesture.endX > 2 * third) {
      return NEXT;
    }
  }

  return NONE;
}
