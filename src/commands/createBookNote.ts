import { Notice, TFile } from "obsidian";
import type ObservationCarPlugin from "../main";
import { EpubView } from "../readers/EpubView";
import { createOrOpenBookNote } from "./bookNoteCreation";

export const CREATE_BOOK_NOTE_COMMAND_ID =
  "create-book-note-for-current-book";

/** Register F1.5's explicit-only note creation command. */
export function registerCreateBookNoteCommand(
  plugin: ObservationCarPlugin,
): void {
  plugin.addCommand({
    id: CREATE_BOOK_NOTE_COMMAND_ID,
    name: "Create book note for current book",
    icon: "book-open",
    checkCallback: (checking) => {
      const book = currentBook(plugin);
      if (book === null) return false;

      if (checking === false) {
        void runCreateOrOpenBookNoteCommand(plugin, book);
      }
      return true;
    },
  });
}

function currentBook(plugin: ObservationCarPlugin): TFile | null {
  return plugin.app.workspace.getActiveViewOfType(EpubView)?.file ?? null;
}

/**
 * The command callback's error boundary. Keeping every write below this
 * explicit invocation is the PRD §7 zero-implicit-writes guarantee.
 */
async function runCreateOrOpenBookNoteCommand(
  plugin: ObservationCarPlugin,
  book: TFile,
): Promise<void> {
  try {
    await createOrOpenBookNote(plugin, book);
  } catch (error) {
    console.error("[observation-car] could not create book note", error);
    new Notice(
      "Could not create book note. Check the developer console for details.",
    );
  }
}
