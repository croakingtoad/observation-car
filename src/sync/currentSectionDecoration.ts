import { StateEffect } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { BookNoteSection } from "../model/bookNote";

interface DocumentRange {
  readonly from: number;
  readonly to: number;
}

const setCurrentSectionEffect = StateEffect.define<DocumentRange | null>();
const currentLine = Decoration.line({ class: "oc-current" });

class CurrentSectionViewPlugin {
  decorations: DecorationSet = Decoration.none;
  private range: DocumentRange | null = null;

  update(update: ViewUpdate): void {
    let nextRange = this.range;
    let changed = false;

    if (update.docChanged && nextRange !== null) {
      nextRange = {
        from: update.changes.mapPos(nextRange.from, -1),
        to: update.changes.mapPos(nextRange.to, 1),
      };
      changed = true;
    }

    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (effect.is(setCurrentSectionEffect)) {
          nextRange = effect.value;
          changed = true;
        }
      }
    }

    if (changed) {
      this.range = nextRange;
      this.decorations = buildDecorations(update.view, nextRange);
    }
  }
}

/**
 * Read-only CM6 extension that paints the current anchor section.
 *
 * The effect carries document positions rather than markdown changes, so
 * applying or clearing the highlight never mutates the note or selection.
 */
export const currentSectionViewPlugin = ViewPlugin.fromClass(
  CurrentSectionViewPlugin,
  { decorations: (plugin) => plugin.decorations },
);

/** Apply one section highlight to a live CM6 editor, or clear it with null. */
export function setCurrentSectionDecoration(
  editor: unknown,
  section: BookNoteSection | null,
): boolean {
  const view = codeMirrorView(editor);
  if (view === null) return false;

  view.dispatch({
    effects: setCurrentSectionEffect.of(
      section === null ? null : sectionRange(view, section),
    ),
  });
  return true;
}

function sectionRange(
  view: EditorView,
  section: BookNoteSection,
): DocumentRange | null {
  const startLine = Math.max(section.headingLine, section.bodyRange.start, 0);
  const endLine = Math.min(
    section.bodyRange.end,
    view.state.doc.lines - 1,
  );
  if (startLine > endLine) return null;
  return {
    from: view.state.doc.line(startLine + 1).from,
    to: view.state.doc.line(endLine + 1).to,
  };
}

function buildDecorations(
  view: EditorView,
  range: DocumentRange | null,
): DecorationSet {
  if (range === null) return Decoration.none;

  const document = view.state.doc;
  const from = Math.min(Math.max(range.from, 0), document.length);
  const to = Math.min(Math.max(range.to, from), document.length);
  const decorations = [];
  let line = document.lineAt(from);
  for (;;) {
    decorations.push(currentLine.range(line.from));
    if (line.to >= to || line.number >= document.lines) break;
    line = document.line(line.number + 1);
  }
  return Decoration.set(decorations, true);
}

function codeMirrorView(editor: unknown): EditorView | null {
  if (typeof editor !== "object" || editor === null || !("cm" in editor)) {
    return null;
  }
  const cm: unknown = editor.cm;
  return cm instanceof EditorView ? cm : null;
}
