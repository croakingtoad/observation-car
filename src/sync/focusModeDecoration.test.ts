// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import type { BookNoteSection } from "../model/bookNote";
import {
  focusModeViewPlugin,
  setFocusModeDecoration,
  setFocusSectionsDecoration,
} from "./focusModeDecoration";

const NOTE = [
  "preamble",
  "## Chapter one",
  "first paragraph",
  "## Chapter two",
  "second paragraph",
  "## Chapter one again",
  "third paragraph",
].join("\n");

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

describe("focus-mode CM6 decoration", () => {
  it("does not fold when the decoration extension is absent", () => {
    view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({ doc: NOTE }),
    });
    enableFocus(section(4, 5, 0));

    expect(foldedWidgets(view)).toEqual([]);
  });

  it("replaces sections outside the current chapter with folded widgets", async () => {
    view = createView();

    enableFocus(section(4, 5, 0));

    view.requestMeasure();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(foldedWidgets(view).map((widget) => widget.textContent)).toEqual([
      "2 sections in other chapters folded",
      "2 sections in other chapters folded",
    ]);
    expect(view.state.doc.toString()).toBe(NOTE);
  });

  it("removes folding when the widget is clicked", async () => {
    view = createView();
    enableFocus(section(0, 1, 0));

    foldedWidgets(view)[0]?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(foldedWidgets(view)).toEqual([]);
    expect(view.state.doc.toString()).toBe(NOTE);
  });

  it("keeps the note unchanged and clear when disabled", () => {
    view = createView();
    const original = view.state.doc.toString();
    enableFocus(section(4, 5, 0));
    setFocusModeDecoration({ cm: view }, false);

    expect(foldedWidgets(view)).toEqual([]);
    expect(view.state.doc.toString()).toBe(original);
  });

  it("clears folding when the reader location has no matching section", () => {
    view = createView();
    enableFocus(section(0, 1, 0));
    setFocusSectionsDecoration(
      { cm: view },
      [section(0, 1, 0), section(2, 3, 1)],
      null,
    );

    expect(foldedWidgets(view)).toEqual([]);
  });

  it("clears folding after a document replacement", () => {
    view = createView();
    enableFocus(section(0, 1, 0));

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "new note" },
    });

    expect(foldedWidgets(view)).toEqual([]);
  });

  it("ignores editors without a live CM6 EditorView", () => {
    expect(() => setFocusModeDecoration({}, true)).not.toThrow();
    expect(() => setFocusSectionsDecoration({}, [], null)).not.toThrow();
  });
});

function createView(): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: NOTE,
      extensions: [focusModeViewPlugin],
    }),
  });
}

function enableFocus(current: BookNoteSection): void {
  setFocusModeDecoration({ cm: view }, true);
  setFocusSectionsDecoration(
    { cm: view },
    [section(0, 1, 0), section(2, 3, 1), section(4, 5, 2)],
    current,
  );
}

function foldedWidgets(editorView: EditorView): HTMLElement[] {
  return [...editorView.dom.querySelectorAll<HTMLElement>(".oc-focus-fold")];
}

function section(
  start: number,
  end: number,
  chapter: number | null,
): BookNoteSection {
  return {
    headingLine: start,
    bodyRange: { start, end },
    fragment: "epubcfi(/6/8!/4/2/1:0)",
    position: { kind: "epub-cfi", cfi: "/6/8!/4/2/1:0" },
    chapter,
  };
}
