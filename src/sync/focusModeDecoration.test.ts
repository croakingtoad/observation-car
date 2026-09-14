// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import type { BookNoteSection } from "../model/bookNote";
import type { ScrollEditor } from "./scrollSync";
import { FocusModeController } from "./focusMode";
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
      "1 section in other chapters folded",
      "1 section in other chapters folded",
    ]);
    expect(view.state.doc.toString()).toBe(NOTE);
  });

  it("replaces each contiguous run with one widget using its own count", async () => {
    view = createView();

    setFocusModeDecoration({ cm: view }, true);
    setFocusSectionsDecoration(
      { cm: view } as unknown as ScrollEditor,
      [
        section(0, 1, 1),
        section(2, 3, 0),
        section(4, 5, 0),
        section(6, 6, 1),
      ],
      section(6, 6, 1),
    );
    view.requestMeasure();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(foldedWidgets(view).map((widget) => widget.textContent)).toEqual([
      "1 section in other chapters folded",
      "1 section in other chapters folded",
    ]);
    expect(view.state.doc.toString()).toBe(NOTE);
  });

  it("seeds a first controller toggle from live pairing state", async () => {
    view = createView();
    const controller = new FocusModeController();
    controller.toggle(
      { cm: view } as unknown as ScrollEditor,
      [section(0, 1, 0), section(2, 3, 1), section(4, 5, 2)],
      section(4, 5, 2),
    );
    view.requestMeasure();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(foldedWidgets(view).map((widget) => widget.textContent)).toEqual([
      "1 section in other chapters folded",
      "1 section in other chapters folded",
    ]);
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

  it("clears folding after an in-document edit while preserving the note", async () => {
    view = createView();
    enableFocus(section(4, 5, 0));
    view.requestMeasure();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(foldedWidgets(view)).toHaveLength(2);

    view.dispatch({ changes: { from: 0, to: 0, insert: "typed first\n" } });

    expect(foldedWidgets(view)).toEqual([]);
    expect(view.state.doc.toString()).toBe(`typed first\n${NOTE}`);
  });

  it("re-folds automatically on the next location after an in-document edit", () => {
    view = createView();
    enableFocus(section(4, 5, 0));

    view.dispatch({ changes: { from: 0, to: 0, insert: "typed first\n" } });
    setFocusSectionsDecoration(
      { cm: view },
      [section(0, 1, 0), section(2, 3, 1), section(5, 6, 2)],
      section(5, 6, 2),
    );

    expect(foldedWidgets(view)).toHaveLength(2);
    expect(view.state.doc.toString()).toBe(`typed first\n${NOTE}`);
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
