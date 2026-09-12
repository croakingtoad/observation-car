// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { addPagingListeners } from "./epubNavigationTools";

interface PointerOptions {
  clientX: number;
  clientY?: number;
  timeStamp: number;
}

function dispatchPointer(
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup",
  options: PointerOptions,
): void {
  const view = (target as Node).ownerDocument?.defaultView;
  if (view === null || view === undefined) {
    throw new Error("Pointer target must belong to a document");
  }
  const event = new view.MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientX: options.clientX,
    clientY: options.clientY ?? 0,
  });
  Object.defineProperty(event, "timeStamp", { value: options.timeStamp });
  target.dispatchEvent(event);
}

function multiPageDocument(): Document {
  document.body.innerHTML = '<a href="chapter-2.xhtml">Next chapter</a>';
  Object.defineProperty(document.body, "clientWidth", { configurable: true, value: 300 });
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    value: 900,
  });
  return document;
}

describe("F2.2 paging event wiring", () => {
  it("uses the visible page width for a tap in a multi-page section", () => {
    const doc = multiPageDocument();
    const page = vi.fn();
    addPagingListeners(doc, "paginated", page);

    dispatchPointer(doc.body, "pointerdown", { clientX: 290, timeStamp: 100 });
    dispatchPointer(doc.body, "pointerup", { clientX: 290, timeStamp: 150 });

    expect(page).toHaveBeenCalledOnce();
    expect(page).toHaveBeenCalledWith("next");
  });

  it("pages when a horizontal swipe ends on an in-content link", () => {
    const doc = multiPageDocument();
    const page = vi.fn();
    const link = doc.querySelector("a");
    if (link === null) {
      throw new Error("Test fixture is missing its link");
    }
    addPagingListeners(doc, "paginated", page);

    dispatchPointer(doc.body, "pointerdown", { clientX: 120, timeStamp: 100 });
    dispatchPointer(doc.body, "pointermove", { clientX: 50, timeStamp: 180 });
    dispatchPointer(link, "pointerup", { clientX: 40, timeStamp: 220 });

    expect(page).toHaveBeenCalledOnce();
    expect(page).toHaveBeenCalledWith("next");
  });

  it("still leaves a tap on an in-content link to epub.js", () => {
    const doc = multiPageDocument();
    const page = vi.fn();
    const link = doc.querySelector("a");
    if (link === null) {
      throw new Error("Test fixture is missing its link");
    }
    addPagingListeners(doc, "paginated", page);

    dispatchPointer(link, "pointerdown", { clientX: 290, timeStamp: 100 });
    dispatchPointer(link, "pointerup", { clientX: 290, timeStamp: 150 });

    expect(page).not.toHaveBeenCalled();
  });
});
