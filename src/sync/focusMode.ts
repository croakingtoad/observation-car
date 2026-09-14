import {
  isFocusModeDecorationEnabled,
  setFocusModeDecoration,
  setFocusSectionsDecoration,
} from "./focusModeDecoration";
import type { BookNote, BookNoteSection } from "../model/bookNote";
import { codeMirrorView } from "./codeMirrorView";
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
    bookNote: BookNote | null = null,
    currentSection: BookNoteSection | null = null,
  ): void {
    const state = this.editors.get(editor) ?? {
      bookNote: null,
      currentSection: null,
    };
    const enabled = !isFocusModeDecorationEnabled(editor);
    const next = {
      bookNote:
        bookNote !== null && bookNote.sections.length > 0
          ? bookNote
          : state.bookNote,
      currentSection: currentSection ?? state.currentSection,
    };
    this.editors.set(editor, next);
    setFocusModeDecoration(editor, enabled);
    apply(editor, next);
  }

  /** Set the current parse; enables folding only for enabled notes. */
  setBookNote(editor: ScrollEditor, bookNote: BookNote): void {
    const state = this.editors.get(editor);
    if (state === undefined) return;
    const next = { ...state, bookNote };
    this.editors.set(editor, next);
    apply(editor, next);
  }

  /** Set the location's matching section for this enabled note. */
  setCurrentSection(
    editor: ScrollEditor,
    currentSection: BookNoteSection | null,
  ): void {
    const state = this.editors.get(editor);
    if (state === undefined) return;
    const next = { ...state, currentSection };
    this.editors.set(editor, next);
    apply(editor, next);
  }

  /** Turn focus mode off and remove its decoration for this editor. */
  reset(editor: ScrollEditor): void {
    this.editors.delete(editor);
    setFocusModeDecoration(editor, false);
    setFocusSectionsDecoration(editor, [], null);
  }
}

interface FocusModeEditor {
  readonly bookNote: BookNote | null;
  readonly currentSection: BookNoteSection | null;
  comparedBookNote?: BookNote;
  comparedDocument?: object;
  documentMatchesSource?: boolean;
}

function apply(
  editorReference: ScrollEditor,
  next: FocusModeEditor,
): void {
  if (next.bookNote === null || !bookNoteMatchesDocument(editorReference, next)) {
    return;
  }
  setFocusSectionsDecoration(
    editorReference,
    next.bookNote.sections,
    next.currentSection,
  );
}

function bookNoteMatchesDocument(
  editor: ScrollEditor,
  state: FocusModeEditor,
): boolean {
  const bookNote = state.bookNote;
  if (bookNote === null) return false;
  const cm = codeMirrorView(editor);
  if (cm === null) return true;
  if (
    state.comparedBookNote === bookNote &&
    state.comparedDocument === cm.state.doc
  ) {
    return state.documentMatchesSource === true;
  }
  const matches =
    cm.state.doc.length === bookNote.sourceText.length &&
    cm.state.doc.toString() === bookNote.sourceText;
  state.comparedBookNote = bookNote;
  state.comparedDocument = cm.state.doc;
  state.documentMatchesSource = matches;
  return matches;
}
