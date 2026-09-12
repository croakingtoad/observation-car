import { Notice, normalizePath, TFile, TFolder } from "obsidian";
import type ObservationCarPlugin from "../main";
import { EpubView } from "../readers/EpubView";

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
        void createOrOpenBookNote(plugin, book);
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
async function createOrOpenBookNote(
  plugin: ObservationCarPlugin,
  book: TFile,
): Promise<void> {
  try {
    const folderPath = normalizePath(plugin.settings.notesFolder);
    const notePath = normalizePath(
      folderPath === ""
        ? `${book.basename}.md`
        : `${folderPath}/${book.basename}.md`,
    );
    const existing = plugin.app.vault.getAbstractFileByPath(notePath);
    if (existing instanceof TFile) {
      await openBookNote(plugin, existing);
      return;
    }
    if (existing !== null) {
      throw new Error(`A folder already exists at ${notePath}`);
    }

    await ensureFolder(plugin, folderPath);
    const source = plugin.app.fileManager.generateMarkdownLink(
      book,
      notePath,
    );
    const content = renderTemplate(plugin.settings.noteTemplate, {
      source,
      format: book.extension.toLowerCase(),
      title: book.basename,
      author: "",
    });

    let note: TFile;
    try {
      note = await plugin.app.vault.create(notePath, content);
    } catch (error) {
      // Two quick invocations may race between lookup and create. The
      // loser must open the winner, never overwrite it.
      const racedNote = plugin.app.vault.getAbstractFileByPath(notePath);
      if (racedNote instanceof TFile) {
        await openBookNote(plugin, racedNote);
        return;
      }
      throw error;
    }
    await openBookNote(plugin, note);
  } catch (error) {
    console.error("[observation-car] could not create book note", error);
    new Notice("Could not create book note. Check the developer console for details.");
  }
}

async function ensureFolder(
  plugin: ObservationCarPlugin,
  folderPath: string,
): Promise<void> {
  if (folderPath === "") return;

  let currentPath = "";
  for (const segment of folderPath.split("/")) {
    currentPath = currentPath === "" ? segment : `${currentPath}/${segment}`;
    const existing = plugin.app.vault.getAbstractFileByPath(currentPath);
    if (existing instanceof TFolder) continue;
    if (existing !== null) {
      throw new Error(`A file already exists at ${currentPath}`);
    }
    await plugin.app.vault.createFolder(currentPath);
  }
}

async function openBookNote(
  plugin: ObservationCarPlugin,
  note: TFile,
): Promise<void> {
  const leaf = plugin.app.workspace.getLeaf("split", "vertical");
  await leaf.openFile(note);
}

interface TemplateValues {
  source: string;
  format: string;
  title: string;
  author: string;
}

/** Replace every supported placeholder with a YAML-safe scalar. */
function renderTemplate(template: string, values: TemplateValues): string {
  let rendered = template;
  rendered = replaceStringPlaceholder(rendered, "source", values.source);
  rendered = rendered.replaceAll("{{format}}", values.format);
  rendered = replaceStringPlaceholder(rendered, "title", values.title);
  rendered = replaceStringPlaceholder(rendered, "author", values.author);
  return rendered;
}

function replaceStringPlaceholder(
  template: string,
  name: "source" | "title" | "author",
  value: string,
): string {
  const placeholder = `{{${name}}}`;
  const doubleQuoted = `"${placeholder}"`;
  const singleQuoted = `'${placeholder}'`;
  return template
    .replaceAll(doubleQuoted, JSON.stringify(value))
    .replaceAll(singleQuoted, `'${value.replaceAll("'", "''")}'`)
    .replaceAll(placeholder, JSON.stringify(value));
}
