import { setFocusModeDecoration, setFocusSectionsDecoration } from "./focusModeDecoration";
import type { BookNoteSection } from "../model/bookNote";
import type { ScrollEditor } from "./scrollSync";

/**
 * Read-only focus-mode state for open paired notes. The decoration itself
 * lives in each editor's CM6 extension, so this map never edits a note and
 * a closed reader leaves no stale decoration behind.
 */
export class FocusModeController {
  private readonly editors = new WeakMap<ScrollEditor, FocusModeEditor>();

  /** One enabled note/editor pair; sections and location update separately. */
  toggle(editor: ScrollEditor): void {
    const state = this.editors.get(editor) ?? {
      enabled: false,
      sections: [],
      currentSection: null,
    };
    this.editors.set(editor, { ...state, enabled: !state.enabled });
    apply(editor, this.editors.get(editor) ?? null);
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
  readonly enabled: boolean;
  readonly sections: readonly BookNoteSection[];
  readonly currentSection: BookNoteSection | null;
}

function apply(
  editorReference: ScrollEditor,
  next: FocusModeEditor | null,
): void {
  if (next === null) return;
  setFocusModeDecoration(editorReference, next.enabled);
  setFocusSectionsDecoration(editorReference, next.sections, next.currentSection);
}
