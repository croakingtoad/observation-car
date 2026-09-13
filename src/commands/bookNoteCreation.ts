import { normalizePath, TFile, TFolder, type App } from "obsidian";
import type { ObservationCarSettings } from "../settings";

export interface BookloreNoteSeed {
  title: string;
  author: string;
  bookloreId: number;
  bookloreUrl: string;
  /** Vault path of a saved cover, without wikilink syntax. */
  coverPath?: string;
}

export interface BookNoteCreationHost {
  app: App;
  settings: ObservationCarSettings;
}

/**
 * Create F1.5's note, or open the existing note without changing it.
 * F5.6 supplies `booklore` so the same race-safe creation and split-opening
 * seam can add the catalog metadata without duplicating note handling.
 */
export async function createOrOpenBookNote(
  plugin: BookNoteCreationHost,
  book: TFile,
  booklore?: BookloreNoteSeed,
): Promise<TFile> {
  const folderPath = normalizePath(plugin.settings.notesFolder);
  const notePath = normalizePath(
    folderPath === ""
      ? `${book.basename}.md`
      : `${folderPath}/${book.basename}.md`,
  );
  const existing = plugin.app.vault.getAbstractFileByPath(notePath);
  if (existing instanceof TFile) {
    await openBookNote(plugin, existing);
    return existing;
  }
  if (existing !== null) {
    throw new Error(`A folder already exists at ${notePath}`);
  }

  await ensureFolder(plugin, folderPath);
  // F1.2 emits a wikilink directly instead of adapting to the user's link style.
  const source = `[[${book.path}]]`;
  let content = renderTemplate(plugin.settings.noteTemplate, {
    source,
    format: book.extension.toLowerCase(),
    title: booklore?.title ?? book.basename,
    author: booklore?.author ?? "",
  });
  if (booklore !== undefined) {
    content = seedBookloreFrontmatter(content, {
      type: "book-note",
      source,
      format: book.extension.toLowerCase(),
      title: booklore.title,
      author: booklore.author,
      booklore_id: booklore.bookloreId,
      booklore_url: booklore.bookloreUrl,
      cover:
        booklore.coverPath === undefined
          ? ""
          : `[[${normalizePath(booklore.coverPath)}]]`,
    });
  }

  let note: TFile;
  try {
    note = await plugin.app.vault.create(notePath, content);
  } catch (error) {
    // Two quick invocations may race between lookup and create. The
    // loser must open the winner, never overwrite it.
    const racedNote = plugin.app.vault.getAbstractFileByPath(notePath);
    if (racedNote instanceof TFile) {
      await openBookNote(plugin, racedNote);
      return racedNote;
    }
    throw error;
  }
  await openBookNote(plugin, note);
  return note;
}

async function ensureFolder(
  plugin: BookNoteCreationHost,
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
  plugin: BookNoteCreationHost,
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

interface BookloreFrontmatter {
  type: "book-note";
  source: string;
  format: string;
  title: string;
  author: string;
  booklore_id: number;
  booklore_url: string;
  cover: string;
}

const BOOKLORE_FRONTMATTER_KEYS = new Set<keyof BookloreFrontmatter>([
  "type",
  "source",
  "format",
  "title",
  "author",
  "booklore_id",
  "booklore_url",
  "cover",
]);

/** Merge the canonical PRD §5.2 fields while preserving template extras/body. */
function seedBookloreFrontmatter(
  content: string,
  values: BookloreFrontmatter,
): string {
  const lines = content.split(/\r?\n/);
  const closing =
    lines[0] === "---"
      ? lines.findIndex((line, index) => index > 0 && line === "---")
      : -1;
  const existing = closing === -1 ? [] : lines.slice(1, closing);
  const body = closing === -1 ? lines : lines.slice(closing + 1);
  const preserved = existing.filter((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(line);
    return (
      match === null ||
      BOOKLORE_FRONTMATTER_KEYS.has(
        match[1] as keyof BookloreFrontmatter,
      ) === false
    );
  });
  const canonical = [
    `type: ${values.type}`,
    `source: ${yamlString(values.source)}`,
    `format: ${values.format}`,
    `title: ${yamlString(values.title)}`,
    `author: ${yamlString(values.author)}`,
    `booklore_id: ${values.booklore_id}`,
    `booklore_url: ${yamlString(values.booklore_url)}`,
    `cover: ${yamlString(values.cover)}`,
  ];
  return ["---", ...canonical, ...preserved, "---", ...body].join("\n");
}

function yamlString(value: string): string {
  return JSON.stringify(value);
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
