import { EditorView } from "@codemirror/view";

/** Narrow Obsidian's runtime `editor.cm` seam to a live CM6 view. */
export function codeMirrorView(editor: unknown): EditorView | null {
  if (typeof editor !== "object" || editor === null || !("cm" in editor)) {
    return null;
  }
  const cm: unknown = editor.cm;
  return cm instanceof EditorView ? cm : null;
}
