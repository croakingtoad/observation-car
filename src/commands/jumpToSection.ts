import { Notice, type Editor } from "obsidian";
import type ObservationCarPlugin from "../main";
import { parseBookNote, type BookNoteSection } from "../model/bookNote";
import type { Reader } from "../sync/ReaderRegistry";

export const JUMP_TO_SECTION_COMMAND_ID = "jump-book-to-this-section";

/** Register F4.7's editor-cursor navigation command. */
export function registerJumpToSectionCommand(
  plugin: ObservationCarPlugin,
): void {
  plugin.addCommand({
    id: JUMP_TO_SECTION_COMMAND_ID,
    name: "Jump book to this section",
    icon: "locate-fixed",
    editorCallback: (editor, context) => {
      const notePath = context.file?.path;
      if (notePath === undefined) {
        new Notice("Open a book note before jumping to one of its sections.");
        return;
      }
      void jumpToCursorSection(plugin, editor, notePath);
    },
  });
}

async function jumpToCursorSection(
  plugin: ObservationCarPlugin,
  editor: Editor,
  notePath: string,
): Promise<void> {
  try {
    const bookNote = parseBookNote(editor.getValue(), {
      anchorHeadingLevel: plugin.settings.anchorHeadingLevel,
      resolveLink: (linkpath) =>
        plugin.app.metadataCache.getFirstLinkpathDest(linkpath, notePath)
          ?.path ?? null,
    });
    const section = findEnclosingSection(
      bookNote.sections,
      editor.getCursor().line,
    );
    if (section === undefined) {
      new Notice("The cursor is not inside an anchored book-note section.");
      return;
    }

    const pairing = plugin.getReaderPairingForNote(notePath);
    if (pairing === undefined) {
      new Notice(
        "Open the book paired with this note before jumping to its section.",
      );
      return;
    }
    if (canOpenFragment(pairing.reader) === false) {
      new Notice("The paired reader cannot open anchored sections.");
      return;
    }

    await pairing.reader.openAtFragment(section.fragment);
  } catch (error) {
    console.error(
      "[observation-car] could not jump book to note section",
      error,
    );
    new Notice(
      "Could not jump to this section. Check the developer console for details.",
    );
  }
}

/** Find the section whose inclusive body range contains an editor line. */
export function findEnclosingSection(
  sections: readonly BookNoteSection[],
  line: number,
): BookNoteSection | undefined {
  return sections.find(
    (section) =>
      section.bodyRange.start <= line && line <= section.bodyRange.end,
  );
}

interface FragmentReader extends Reader {
  openAtFragment(fragment: string): Promise<void>;
}

function canOpenFragment(reader: Reader): reader is FragmentReader {
  return (
    "openAtFragment" in reader &&
    typeof reader.openAtFragment === "function"
  );
}
