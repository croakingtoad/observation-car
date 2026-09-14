import {
  MarkdownView,
  Notice,
  TFile,
  type Editor,
  type EditorPosition,
  type WorkspaceLeaf,
} from "obsidian";
import type ObservationCarPlugin from "../main";
import { parseBookNote, type BookNoteSection } from "../model/bookNote";
import { sortSectionsByBookPosition } from "../model/sortBookNoteSections";
import type {
  Reader,
  ReaderLocation,
  ReaderPairing,
} from "../sync/ReaderRegistry";

export const NEW_NOTE_HERE_COMMAND_ID = "new-note-here";

const EXCERPT_CHARACTER_LIMIT = 60;

interface ReaderSelection {
  readonly text: string;
  readonly fragment: string;
}

interface LocationReader extends Reader {
  getLocation(): ReaderLocation | null;
}

interface SelectionReader extends Reader {
  getSelection(): ReaderSelection | null;
}

/** Register F4.6 for the command palette, default Alt+N, and mobile toolbar. */
export function registerNewNoteHereCommand(
  plugin: ObservationCarPlugin,
): void {
  plugin.addCommand({
    id: NEW_NOTE_HERE_COMMAND_ID,
    name: "New note here",
    icon: "square-pen",
    hotkeys: [{ modifiers: ["Alt"], key: "N" }],
    checkCallback: (checking) => {
      const pairing = mostRecentPairing(plugin);
      if (pairing === undefined) return false;
      if (checking === false) {
        void addNoteAtPairing(plugin, pairing);
      }
      return true;
    },
  });
}

/** Reader-toolbar entry point, pinned to the leaf whose button was pressed. */
export async function newNoteHereFromReader(
  plugin: ObservationCarPlugin,
  readerLeaf: WorkspaceLeaf,
): Promise<void> {
  const pairing = plugin.getReaderPairingForLeaf(readerLeaf);
  if (pairing === undefined) {
    new Notice("Open or create this book's note before adding a section.");
    return;
  }
  await addNoteAtPairing(plugin, pairing);
}

/**
 * Resolve the pairing behind the most recent main-area leaf, whether the
 * user is on the reader or its note. Shared by cross-pane commands that
 * operate on the active reader/note pair.
 */
export function activePairing(
  plugin: ObservationCarPlugin,
): ReaderPairing | undefined {
  return mostRecentPairing(plugin);
}

function mostRecentPairing(
  plugin: ObservationCarPlugin,
): ReaderPairing | undefined {
  const { workspace } = plugin.app;
  const leaf = workspace.getMostRecentLeaf(workspace.rootSplit);
  if (leaf === null || leaf.getRoot() !== workspace.rootSplit) {
    return undefined;
  }
  const readerPairing = plugin.getReaderPairingForLeaf(leaf);
  if (readerPairing !== undefined) return readerPairing;
  if (leaf.view instanceof MarkdownView && leaf.view.file !== null) {
    return plugin.getReaderPairingForNote(leaf.view.file.path);
  }
  return undefined;
}

async function addNoteAtPairing(
  plugin: ObservationCarPlugin,
  pairing: ReaderPairing,
): Promise<void> {
  try {
    if (canGetLocation(pairing.reader) !== true) {
      new Notice("This reader cannot report its current location.");
      return;
    }
    const location = pairing.reader.getLocation();
    if (location === null) {
      new Notice("No anchorable reader location is available yet.");
      return;
    }
    const rawSelection = canGetSelection(pairing.reader)
      ? pairing.reader.getSelection()
      : null;
    const selection = rawSelection?.text.trim() === "" ? null : rawSelection;
    const editor = await findOrOpenEditor(plugin, pairing);
    insertOrJump(plugin, editor, pairing.notePath, location, selection);
  } catch (error) {
    console.error("[observation-car] could not add note at reader location", error);
    new Notice("Could not add an anchored section to the paired book note.");
  }
}

function canGetLocation(reader: Reader): reader is LocationReader {
  return "getLocation" in reader && typeof reader.getLocation === "function";
}

function canGetSelection(reader: Reader): reader is SelectionReader {
  return "getSelection" in reader && typeof reader.getSelection === "function";
}

async function findOrOpenEditor(
  plugin: ObservationCarPlugin,
  pairing: ReaderPairing,
): Promise<Editor> {
  for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
    if (
      leaf.view instanceof MarkdownView &&
      leaf.view.file?.path === pairing.notePath
    ) {
      return leaf.view.editor;
    }
  }

  const noteFile = plugin.app.vault.getAbstractFileByPath(pairing.notePath);
  if (noteFile instanceof TFile === false) {
    throw new Error(`The paired book note no longer exists: ${pairing.notePath}`);
  }
  const noteLeaf = plugin.app.workspace.createLeafBySplit(
    pairing.leaf,
    "vertical",
  );
  if (noteLeaf.getRoot() !== plugin.app.workspace.rootSplit) {
    noteLeaf.detach();
    throw new Error("The book-note split was created outside the main area");
  }
  await noteLeaf.openFile(noteFile);
  if (noteLeaf.view instanceof MarkdownView === false) {
    throw new Error("The paired book note did not open in a Markdown editor");
  }
  return noteLeaf.view.editor;
}

function insertOrJump(
  plugin: ObservationCarPlugin,
  editor: Editor,
  notePath: string,
  location: ReaderLocation,
  selection: ReaderSelection | null,
): void {
  const text = editor.getValue();
  const parse = (markdown: string) =>
    parseBookNote(markdown, {
      anchorHeadingLevel: plugin.settings.anchorHeadingLevel,
      resolveLink: (linkpath) =>
        plugin.app.metadataCache.getFirstLinkpathDest(linkpath, notePath)?.path ??
        null,
    });
  const bookNote = parse(text);
  const fragment = selection?.fragment ?? location.fragment;
  const existing = bookNote.sections.find(
    (section) => section.fragment === stripHash(fragment),
  );
  if (existing !== undefined) {
    focusSection(editor, existing);
    return;
  }

  const source = bookNote.frontmatter.source;
  if (source === null) {
    throw new Error("The paired note has no source in its frontmatter");
  }
  const appended = appendSection(
    text,
    renderSection(
      source,
      fragment,
      location.label,
      selection,
      plugin.settings.anchorHeadingLevel,
      lineEnding(text),
    ),
  );
  const appendedNote = parse(appended);
  const sorted = sortSectionsByBookPosition(appended, appendedNote.sections);
  const inserted = parse(sorted).sections.find(
    (section) => section.fragment === stripHash(fragment),
  );
  if (inserted === undefined) {
    throw new Error(`The new anchor could not be parsed: ${fragment}`);
  }

  editor.setValue(sorted);
  const bodyLine =
    inserted.headingLine + 1 + (selection === null ? 0 : quoteLineCount(selection.text));
  focusEditorAt(editor, { line: bodyLine, ch: 0 });
}

function focusSection(editor: Editor, section: BookNoteSection): void {
  focusEditorAt(editor, { line: section.headingLine, ch: 0 });
}

function focusEditorAt(editor: Editor, position: EditorPosition): void {
  editor.setCursor(position);
  editor.scrollIntoView({ from: position, to: position }, true);
  editor.focus();
}

function renderSection(
  source: string,
  fragment: string,
  chapterLabel: string,
  selection: ReaderSelection | null,
  headingLevel: number,
  eol: string,
): string {
  const detail = selection === null ? "note" : excerpt(selection.text);
  const alias = safeAlias(`${collapseWhitespace(chapterLabel)} — ${detail}`);
  const heading = `${"#".repeat(headingLevel)} [[${source}${withHash(fragment)}|${alias}]]`;
  if (selection === null) return `${heading}${eol}${eol}`;
  const quote = normalizedSelectionLines(selection.text)
    .map((line) => `> ${line}`)
    .join(eol);
  return `${heading}${eol}${quote}${eol}${eol}`;
}

function appendSection(text: string, section: string): string {
  if (text.length === 0) return section;
  const eol = lineEnding(text);
  if (text.endsWith(`${eol}${eol}`)) return text + section;
  return text.endsWith(eol) ? text + eol + section : text + eol + eol + section;
}

function lineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function normalizedSelectionLines(text: string): string[] {
  return text.trim().replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

function quoteLineCount(text: string): number {
  return normalizedSelectionLines(text).length;
}

function excerpt(text: string): string {
  const collapsed = collapseWhitespace(text);
  const characters = Array.from(collapsed);
  return characters.length <= EXCERPT_CHARACTER_LIMIT
    ? collapsed
    : `${characters.slice(0, EXCERPT_CHARACTER_LIMIT - 1).join("")}…`;
}

function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function safeAlias(alias: string): string {
  return alias
    .replaceAll("|", "｜")
    .replaceAll("[", "［")
    .replaceAll("]", "］");
}

function withHash(fragment: string): string {
  return fragment.startsWith("#") ? fragment : `#${fragment}`;
}

function stripHash(fragment: string): string {
  return fragment.startsWith("#") ? fragment.slice(1) : fragment;
}
