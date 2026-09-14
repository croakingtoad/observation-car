import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import type { BookNoteSection } from "../model/bookNote";
import { codeMirrorView } from "./codeMirrorView";

export const setFocusModeEffect = StateEffect.define<boolean>();
export const setFocusSectionsEffect = StateEffect.define<{
  readonly sections: readonly BookNoteSection[];
  readonly currentSection: BookNoteSection | null;
}>();

interface FocusState {
  readonly enabled: boolean;
  readonly invalidated: boolean;
  readonly sections: readonly BookNoteSection[];
  readonly currentSection: BookNoteSection | null;
}

const INITIAL_FOCUS_STATE: FocusState = {
  enabled: false,
  invalidated: false,
  sections: [],
  currentSection: null,
};

class FoldedSectionWidget extends WidgetType {
  constructor(private readonly count: number) {
    super();
  }

  eq(other: FoldedSectionWidget): boolean {
    return other.count === this.count;
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "oc-focus-fold";
    button.textContent =
      this.count === 1
        ? "1 section in other chapters folded"
        : `${this.count} sections in other chapters folded`;
    button.addEventListener("click", () => {
      view.dispatch({ effects: setFocusModeEffect.of(false) });
    });
    return button;
  }
}

const focusStateField = StateField.define<FocusState>({
  create: () => INITIAL_FOCUS_STATE,
  update(currentState, transaction) {
    let nextState = transaction.docChanged
      ? {
          ...currentState,
          invalidated: true,
          sections: [],
          currentSection: null,
        }
      : currentState;

    for (const effect of transaction.effects) {
      if (effect.is(setFocusModeEffect)) {
        nextState = {
          ...(nextState ?? INITIAL_FOCUS_STATE),
          enabled: effect.value,
          invalidated: false,
        };
      }
      if (effect.is(setFocusSectionsEffect)) {
        nextState = {
          ...(nextState ?? INITIAL_FOCUS_STATE),
          invalidated: false,
          sections: effect.value.sections,
          currentSection: effect.value.currentSection,
        };
      }
    }

    return nextState;
  },
});

/** Expose block replacements from state, which CM6 permits only here. */
const focusModeDecorations = EditorView.decorations.compute(
  [focusStateField],
  (editorState) =>
    buildDecorations(editorState, editorState.field(focusStateField)),
);

/**
 * Read-only CM6 decoration that collapses sections outside the current
 * chapter. The effects carry model state only; the editor document and the
 * user's selection are never changed by focus mode.
 */
export const focusModeViewPlugin = [focusStateField, focusModeDecorations];

/** Enable or disable focus decoration on one live CM6 editor. */
export function setFocusModeDecoration(editor: unknown, enabled: boolean): void {
  const view = codeMirrorView(editor);
  if (view === null) return;
  view.dispatch({ effects: setFocusModeEffect.of(enabled) });
}

/** Whether the live CM6 field currently treats the next toggle as disable. */
export function isFocusModeDecorationEnabled(editor: unknown): boolean {
  const view = codeMirrorView(editor);
  if (view === null) return false;
  const state = view.state.field(focusStateField, false);
  return state?.enabled === true && state.invalidated === false;
}

/**
 * Provide the note's current sections for folding. Passing `null` as the
 * current section means no reader location is known, so nothing is folded.
 */
export function setFocusSectionsDecoration(
  editor: unknown,
  sections: readonly BookNoteSection[],
  currentSection: BookNoteSection | null,
): void {
  const view = codeMirrorView(editor);
  if (view === null) return;
  view.dispatch({
    effects: setFocusSectionsEffect.of({ sections, currentSection }),
  });
}

function buildDecorations(
  editorState: EditorState,
  state: FocusState,
): DecorationSet {
  if (state.enabled === false || state.currentSection === null) {
    return Decoration.none;
  }

  const folded = state.sections.flatMap((section, index) =>
    section.chapter === state.currentSection?.chapter
      ? []
      : [{ section, index }],
  );
  if (folded.length === 0) return Decoration.none;

  const decorations: Range<Decoration>[] = [];
  let runCount = 0;
  let runStart = 0;
  let runEnd = 0;
  let previousIndex: number | null = null;

  const finishRun = () => {
    if (runCount === 0) return;
    decorations.push(
      Decoration.replace({
        widget: new FoldedSectionWidget(runCount),
      }).range(runStart, runEnd),
    );
  };

  for (const { section, index } of folded) {
    const range = sectionRange(editorState, section);
    if (range === null) {
      finishRun();
      runCount = 0;
      previousIndex = null;
      continue;
    }
    if (
      runCount > 0 &&
      (previousIndex === null ||
        index !== previousIndex + 1 ||
        range.from < runEnd)
    ) {
      finishRun();
      runCount = 0;
    }
    if (runCount === 0) {
      runStart = range.from;
    }
    runCount += 1;
    runEnd = range.to;
    previousIndex = index;
  }
  finishRun();
  return Decoration.set(decorations, true);
}

function sectionRange(
  editorState: EditorState,
  section: BookNoteSection,
): { from: number; to: number } | null {
  const startLine = Math.max(section.headingLine, section.bodyRange.start, 0);
  const endLine = Math.min(section.bodyRange.end, editorState.doc.lines - 1);
  if (startLine > endLine) return null;
  const from = editorState.doc.line(startLine + 1).from;
  const to = editorState.doc.line(endLine + 1).to;
  if (from === to) return null;
  return { from, to };
}
