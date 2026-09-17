import { MarkdownView, type Editor } from "obsidian";

interface EditorLookupHost {
  readonly app: {
    readonly workspace: {
      getLeavesOfType(viewType: string): readonly {
        readonly view: unknown;
      }[];
    };
  };
}

/**
 * Shared live-editor lookup: prefer the focused editor, else the first
 * matching leaf, else `null`. This keeps F4.6's write/focus target on
 * the same pane as focus mode and scroll-sync when a note is open more
 * than once, without retaining the view.
 */
export function findOpenEditor(
  host: EditorLookupHost,
  notePath: string,
): Editor | null {
  let fallback: Editor | null = null;
  for (const leaf of host.app.workspace.getLeavesOfType("markdown")) {
    if (
      leaf.view instanceof MarkdownView &&
      leaf.view.file?.path === notePath
    ) {
      if (leaf.view.editor.hasFocus()) return leaf.view.editor;
      fallback ??= leaf.view.editor;
    }
  }
  return fallback;
}
