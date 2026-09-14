import {
  isFocusModeDecorationEnabled,
  setFocusModeDecoration,
  setFocusSectionsDecoration,
} from "./focusModeDecoration";
import type { BookNoteSection } from "../model/bookNote";
import type { ScrollEditor } from "./scrollSync";

/**
 * Read-only focus-mode state for open paired notes. The decoration itself
 * lives in each editor's CM6 extension, so this map never edits a note and
 * a closed reader leaves no stale decoration behind.
 */
export class FocusModeController {
  private readonly editors = new WeakMap<ScrollEditor, FocusModeEditor>();

  /**
   * One enabled note/editor pair. Pass the live pairing state when it is
   * available so a first press can fold immediately, before any location
   * event has had a chance to arrive after the toggle.
   */
  toggle(
    editor: ScrollEditor,
    sections: readonly BookNoteSection[] = [],
    currentSection: BookNoteSection | null = null,
  ): void {
    const state = this.editors.get(editor) ?? {
      sections: [],
      currentSection: null,
    };
    const enabled = !isFocusModeDecorationEnabled(editor);
    const next = {
      sections: sections.length > 0 ? sections : state.sections,
      currentSection: currentSection ?? state.currentSection,
    };
    this.editors.set(editor, next);
    setFocusModeDecoration(editor, enabled);
    apply(editor, next);
  }

  /** Set the cached sections; enables folding only for enabled notes. */
  setSections(editor: ScrollEditor, sections: readonly BookNoteSection[]): void {
    const state = this.editors.get(editor);
    if (state === undefined) return;
    this.editors.set(editor, { ...state, sections });
    apply(editor, this.editors.get(editor) ?? null);
  }

  /** Set the location's matching section for this enabled note. */
  setCurrentSection(
    editor: ScrollEditor,
    currentSection: BookNoteSection | null,
  ): void {
    const state = this.editors.get(editor);
    if (state === undefined) return;
    this.editors.set(editor, { ...state, currentSection });
    apply(editor, this.editors.get(editor) ?? null);
  }

  /** Turn focus mode off and remove its decoration for this editor. */
  reset(editor: ScrollEditor): void {
    this.editors.delete(editor);
    setFocusModeDecoration(editor, false);
    setFocusSectionsDecoration(editor, [], null);
  }
}

interface FocusModeEditor {
  readonly sections: readonly BookNoteSection[];
  readonly currentSection: BookNoteSection | null;
}

function apply(
  editorReference: ScrollEditor,
  next: FocusModeEditor | null,
): void {
  if (next === null) return;
  setFocusSectionsDecoration(editorReference, next.sections, next.currentSection);
}
