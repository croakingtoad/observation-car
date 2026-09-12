// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BookNoteSection } from "../model/bookNote";
import {
  currentSectionViewPlugin,
  setCurrentSectionDecoration,
} from "./currentSectionDecoration";

const NOTE = [
  "preamble",
  "## Chapter one",
  "first paragraph",
  "second paragraph",
  "## Chapter two",
  "final paragraph",
].join("\n");

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

describe("current-section CM6 decoration", () => {
  it("adds oc-current to every line in the heading and body only", () => {
    view = createView();

    setCurrentSectionDecoration({ cm: view }, section(1, 3));

    expect(currentLineTexts(view)).toEqual([
      "## Chapter one",
      "first paragraph",
      "second paragraph",
    ]);
  });

  it("moves the class to the next section without editing the note", () => {
    view = createView();
    const original = view.state.doc.toString();

    setCurrentSectionDecoration({ cm: view }, section(1, 3));
    setCurrentSectionDecoration({ cm: view }, section(4, 5));

    expect(currentLineTexts(view)).toEqual([
      "## Chapter two",
      "final paragraph",
    ]);
    expect(view.state.doc.toString()).toBe(original);
  });

  it("removes every current-section class when cleared", () => {
    view = createView();
    setCurrentSectionDecoration({ cm: view }, section(1, 3));

    setCurrentSectionDecoration({ cm: view }, null);

    expect(currentLineTexts(view)).toEqual([]);
    expect(view.state.doc.toString()).toBe(NOTE);
  });

  it("ignores editors without a live CM6 EditorView", () => {
    expect(setCurrentSectionDecoration({}, section(1, 3))).toBe(false);
  });
});

describe("current-section styling", () => {
  it("scopes the highlight to CM6 and uses Obsidian theme variables", () => {
    const stylesPath = join(process.cwd(), "styles.css");
    const styles = readFileSync(stylesPath, "utf8");
    const rule = styles.match(
      /\.markdown-source-view\.mod-cm6 \.cm-line\.oc-current\s*\{([^}]*)\}/u,
    );

    expect(rule?.[1]).toContain("var(--background-modifier-hover)");
    expect(rule?.[1]).toContain("var(--interactive-accent)");
    expect(rule?.[1]).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });
});

function createView(): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: NOTE,
      extensions: [currentSectionViewPlugin],
    }),
  });
}

function currentLineTexts(editorView: EditorView): string[] {
  return [...editorView.dom.querySelectorAll<HTMLElement>(".cm-line.oc-current")]
    .map((line) => line.textContent ?? "");
}

function section(start: number, end: number): BookNoteSection {
  return {
    headingLine: start,
    bodyRange: { start, end },
    fragment: "epubcfi(/6/8!/4/2/1:0)",
    position: { kind: "epub-cfi", cfi: "/6/8!/4/2/1:0" },
    chapter: 3,
  };
}
