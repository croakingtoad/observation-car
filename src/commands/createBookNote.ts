import { Notice, normalizePath, TFile, TFolder } from "obsidian";
import type ObservationCarPlugin from "../main";
import { EpubView, EPUB_VIEW_TYPE } from "../readers/EpubView";

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
    callback: () => {
      void resolveAndCreateBookNote(plugin);
    },
  });
}

type BookResolution =
  | { kind: "book"; book: TFile }
  | { kind: "none" }
  | { kind: "ambiguous"; books: TFile[] };

async function resolveAndCreateBookNote(
  plugin: ObservationCarPlugin,
): Promise<void> {
  try {
    const resolution = await currentBook(plugin);
    if (resolution.kind === "none") {
      new Notice("Open a book in Observation Car first");
      return;
    }
    if (resolution.kind === "ambiguous") {
      const titles = resolution.books
        .map((book) => book.basename)
        .join(", ");
      new Notice(
        `Multiple books are open: ${titles}. Click the book you want, then run Create book note again.`,
      );
      return;
    }
    await createOrOpenBookNote(plugin, resolution.book);
  } catch (error) {
    console.error("[observation-car] could not resolve the current book", error);
    new Notice("Could not create book note. Check the developer console for details.");
  }
}

async function currentBook(
  plugin: ObservationCarPlugin,
): Promise<BookResolution> {
  const activeBook = plugin.app.workspace.getActiveViewOfType(EpubView)?.file;
  if (activeBook !== null && activeBook !== undefined) {
    return { kind: "book", book: activeBook };
  }

  const mostRecentLeaf = plugin.app.workspace.getMostRecentLeaf();
  if (mostRecentLeaf !== null) {
    await mostRecentLeaf.loadIfDeferred();
    const mostRecentBook =
      mostRecentLeaf.view instanceof EpubView
        ? mostRecentLeaf.view.file
        : null;
    if (mostRecentBook !== null) {
      return { kind: "book", book: mostRecentBook };
    }
  }

  const openLeaves = plugin.app.workspace
    .getLeavesOfType(EPUB_VIEW_TYPE)
    .filter((leaf) => leaf.getViewState().type === EPUB_VIEW_TYPE);
  if (openLeaves.length === 0) {
    return { kind: "none" };
  }
  if (openLeaves.length > 1) {
    const books: TFile[] = [];
    for (const leaf of openLeaves) {
      await leaf.loadIfDeferred();
      const book = leaf.view instanceof EpubView ? leaf.view.file : null;
      if (book !== null) books.push(book);
    }
    if (books.length > 1) return { kind: "ambiguous", books };
    if (books.length === 1) return { kind: "book", book: books[0] };
    return { kind: "none" };
  }

  const leaf = openLeaves[0];
  await leaf.loadIfDeferred();
  const book = leaf.view instanceof EpubView ? leaf.view.file : null;
  return book === null ? { kind: "none" } : { kind: "book", book };
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
    const note = await getOrCreateBookNote(plugin, book);
    await openBookNote(plugin, note);
  } catch (error) {
    console.error("[observation-car] could not create book note", error);
    new Notice("Could not create book note. Check the developer console for details.");
  }
}

/** F1.5's sole note-creation path, shared by later reader commands. */
export async function getOrCreateBookNote(
  plugin: ObservationCarPlugin,
  book: TFile,
): Promise<TFile> {
  const folderPath = normalizePath(plugin.settings.notesFolder);
  const notePath = normalizePath(
    folderPath === ""
      ? `${book.basename}.md`
      : `${folderPath}/${book.basename}.md`,
  );
  const existing = plugin.app.vault.getAbstractFileByPath(notePath);
  if (existing instanceof TFile) return existing;
  if (existing !== null) {
    throw new Error(`A folder already exists at ${notePath}`);
  }

  await ensureFolder(plugin, folderPath);
  // F1.2 resolves vault-path wikilinks regardless of the user's link style.
  const source = `[[${book.path}]]`;
  const content = renderTemplate(plugin.settings.noteTemplate, {
    source,
    format: book.extension.toLowerCase(),
    title: book.basename,
    author: "",
  });

  try {
    return await plugin.app.vault.create(notePath, content);
  } catch (error) {
    // Two quick invocations may race between lookup and create. The loser
    // returns the winner, never overwriting it.
    const racedNote = plugin.app.vault.getAbstractFileByPath(notePath);
    if (racedNote instanceof TFile) return racedNote;
    throw error;
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
  const workspace = plugin.app.workspace;
  const markdownLeaves = workspace.getLeavesOfType("markdown");
  const matchingLeaf = markdownLeaves.find((leaf) =>
    leafMatchesNote(leaf, note),
  );
  if (matchingLeaf !== undefined) {
    await workspace.revealLeaf(matchingLeaf);
    return;
  }

  const splitLeaf = workspace.getLeaf("split", "vertical");
  await splitLeaf.openFile(note);
}

function leafMatchesNote(
  leaf: { getViewState(): { type?: string }; view?: unknown },
  note: TFile,
): boolean {
  if (leaf.getViewState().type !== "markdown") return false;
  const view = leaf.view as { file?: { path?: string } | null } | null;
  return view?.file?.path === note.path;
}


interface TemplateValues {
  source: string;
  format: string;
  title: string;
  author: string;
}

/** Replace every supported placeholder with a YAML-safe scalar. */
function renderTemplate(template: string, values: TemplateValues): string {
  return template.replace(
    /(["']?){{(source|format|title|author)}}\1/g,
    (placeholder, quote: string, name: string): string => {
      if (name === "format") {
        return quote === ""
          ? values.format
          : `${quote}${values.format}${quote}`;
      }

      let value: string;
      switch (name) {
        case "source":
          value = values.source;
          break;
        case "title":
          value = values.title;
          break;
        case "author":
          value = values.author;
          break;
        default:
          return placeholder;
      }
      return quote === "'"
        ? `'${value.replaceAll("'", "''")}'`
        : JSON.stringify(value);
    },
  );
}
