import { Notice } from "obsidian";
import type ObservationCarPlugin from "../main";
import { EpubView, EPUB_VIEW_TYPE } from "../readers/EpubView";

export const TOGGLE_BOOK_STYLESHEET_COMMAND_ID = "toggle-book-stylesheet";

/** Register the palette-only per-book stylesheet switch. */
export function registerToggleBookStylesheetCommand(
  plugin: ObservationCarPlugin,
): void {
  let mostRecentlyActiveView: EpubView | null = null;
  plugin.registerEvent(
    plugin.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf?.view instanceof EpubView && leaf.view.file !== null) {
        mostRecentlyActiveView = leaf.view;
      }
    }),
  );

  plugin.addCommand({
    id: TOGGLE_BOOK_STYLESHEET_COMMAND_ID,
    name: "Toggle book stylesheet for this book",
    callback: () => {
      const view = currentReader(plugin, mostRecentlyActiveView);
      if (view === null) {
        new Notice("Open a book in Observation Car first");
        return;
      }
      void toggleBookStylesheet(view);
    },
  });
}

/** Active reader first, then the most recently activated open reader. */
function currentReader(
  plugin: ObservationCarPlugin,
  mostRecentlyActiveView: EpubView | null,
): EpubView | null {
  const activeView = plugin.app.workspace.getActiveViewOfType(EpubView);
  if (activeView !== null && activeView.file !== null) {
    return activeView;
  }

  const openLeaves = plugin.app.workspace.getLeavesOfType(EPUB_VIEW_TYPE);
  if (
    mostRecentlyActiveView !== null &&
    mostRecentlyActiveView.file !== null &&
    openLeaves.some((leaf) => leaf.view === mostRecentlyActiveView)
  ) {
    return mostRecentlyActiveView;
  }
  for (const leaf of openLeaves) {
    if (leaf.view instanceof EpubView && leaf.view.file !== null) {
      return leaf.view;
    }
  }
  return null;
}

async function toggleBookStylesheet(view: EpubView): Promise<void> {
  try {
    await view.toggleBookStylesheet();
  } catch (error: unknown) {
    console.error("[observation-car] could not toggle book stylesheet", error);
    new Notice("Could not toggle the book stylesheet. Close and reopen the book to recover.");
  }
}
