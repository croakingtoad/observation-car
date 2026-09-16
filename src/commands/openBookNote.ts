import { Notice, TFile, type WorkspaceLeaf } from "obsidian";
import type ObservationCarPlugin from "../main";
import { getOrCreateBookNote } from "./createBookNote";

export const OPEN_BOOK_NOTE_COMMAND_ID = "open-book-note-beside-reader";

/** Register F4.2's command against ReaderRegistry's leaf identity. */
export function registerOpenBookNoteCommand(
  plugin: ObservationCarPlugin,
): void {
  plugin.addCommand({
    id: OPEN_BOOK_NOTE_COMMAND_ID,
    name: "Open book note beside reader",
    icon: "book-open-text",
    checkCallback: (checking) => {
      const readerLeaf = recentReaderLeaf(plugin);
      if (readerLeaf === null) return false;
      if (checking === false) {
        void openBookNoteBesideReader(plugin, readerLeaf);
      }
      return true;
    },
  });
}

/** Auto-open entry point; errors are contained at this event boundary. */
export async function openBookNoteBesideRecentReader(
  plugin: ObservationCarPlugin,
  openedBook?: TFile,
): Promise<void> {
  const readerLeaf = recentReaderLeaf(plugin);
  if (readerLeaf === null) return;
  if (
    openedBook !== undefined &&
    plugin.getReaderForLeaf(readerLeaf)?.file !== openedBook
  ) {
    return;
  }
  await openBookNoteBesideReader(plugin, readerLeaf);
}

function recentReaderLeaf(
  plugin: ObservationCarPlugin,
): WorkspaceLeaf | null {
  const { workspace } = plugin.app;
  const leaf = workspace.getMostRecentLeaf(workspace.rootSplit);
  if (leaf === null || leaf.getRoot() !== workspace.rootSplit) return null;
  return plugin.getReaderForLeaf(leaf) === undefined ? null : leaf;
}

async function openBookNoteBesideReader(
  plugin: ObservationCarPlugin,
  readerLeaf: WorkspaceLeaf,
): Promise<void> {
  try {
    const reader = plugin.getReaderForLeaf(readerLeaf);
    if (reader?.file === null || reader === undefined) return;

    const pairing = plugin.getReaderPairingForLeaf(readerLeaf);
    const pairedFile =
      pairing === undefined
        ? null
        : plugin.app.vault.getAbstractFileByPath(pairing.notePath);
    const note =
      pairedFile instanceof TFile
        ? pairedFile
        : await getOrCreateBookNote(plugin, reader.file);

    const noteLeaf = plugin.app.workspace.createLeafBySplit(
      readerLeaf,
      "vertical",
    );
    if (noteLeaf.getRoot() !== plugin.app.workspace.rootSplit) {
      noteLeaf.detach();
      throw new Error("The book-note split was created outside the main area");
    }
    await noteLeaf.openFile(note);
  } catch (error) {
    console.error("[observation-car] could not open book note", error);
    new Notice("Could not open book note. Check the developer console for details.");
  }
}
