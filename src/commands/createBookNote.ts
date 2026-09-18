import { Notice, TFile, type WorkspaceLeaf } from "obsidian";
import type ObservationCarPlugin from "../main";
import { EpubView, EPUB_VIEW_TYPE } from "../readers/EpubView";
import { getOrCreateBookNote } from "./bookNoteCreation";

export { getOrCreateBookNote } from "./bookNoteCreation";

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

/**
 * `leaf` is the reader the book was resolved from, carried alongside the
 * book so the note pane opens beside *that* reader. It is null only when
 * the resolution came from an active view with no leaf to read.
 */
type BookResolution =
  | { kind: "book"; book: TFile; leaf: WorkspaceLeaf | null }
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
    await runCreateOrOpenBookNoteCommand(
      plugin,
      resolution.book,
      resolution.leaf,
    );
  } catch (error) {
    console.error("[observation-car] could not resolve the current book", error);
    new Notice("Could not create book note. Check the developer console for details.");
  }
}

async function currentBook(
  plugin: ObservationCarPlugin,
): Promise<BookResolution> {
  const activeView = plugin.app.workspace.getActiveViewOfType(EpubView);
  const activeBook = activeView?.file;
  if (activeBook !== null && activeBook !== undefined) {
    return { kind: "book", book: activeBook, leaf: activeView?.leaf ?? null };
  }

  const mostRecentLeaf = plugin.app.workspace.getMostRecentLeaf();
  if (mostRecentLeaf !== null) {
    await mostRecentLeaf.loadIfDeferred();
    const mostRecentBook =
      mostRecentLeaf.view instanceof EpubView
        ? mostRecentLeaf.view.file
        : null;
    if (mostRecentBook !== null) {
      return { kind: "book", book: mostRecentBook, leaf: mostRecentLeaf };
    }
  }

  const openLeaves = plugin.app.workspace
    .getLeavesOfType(EPUB_VIEW_TYPE)
    .filter((leaf) => leaf.getViewState().type === EPUB_VIEW_TYPE);
  if (openLeaves.length === 0) {
    return { kind: "none" };
  }
  if (openLeaves.length > 1) {
    const found: { book: TFile; leaf: WorkspaceLeaf }[] = [];
    for (const leaf of openLeaves) {
      await leaf.loadIfDeferred();
      const book = leaf.view instanceof EpubView ? leaf.view.file : null;
      if (book !== null) found.push({ book, leaf });
    }
    if (found.length > 1) {
      return { kind: "ambiguous", books: found.map((entry) => entry.book) };
    }
    const only = found[0];
    if (only !== undefined) {
      return { kind: "book", book: only.book, leaf: only.leaf };
    }
    return { kind: "none" };
  }

  const leaf = openLeaves[0];
  await leaf.loadIfDeferred();
  const book = leaf.view instanceof EpubView ? leaf.view.file : null;
  return book === null ? { kind: "none" } : { kind: "book", book, leaf };
}

/**
 * The command callback's error boundary. Keeping every write below this
 * explicit invocation is the PRD §7 zero-implicit-writes guarantee.
 */
async function runCreateOrOpenBookNoteCommand(
  plugin: ObservationCarPlugin,
  book: TFile,
  readerLeaf: WorkspaceLeaf | null,
): Promise<void> {
  try {
    const note = await getOrCreateBookNote(plugin, book);
    await plugin.openBookNotePane(readerLeaf, note);
  } catch (error) {
    console.error("[observation-car] could not create book note", error);
    new Notice(
      "Could not create book note. Check the developer console for details.",
    );
  }
}
