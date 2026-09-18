import { MarkdownView, Notice } from "obsidian";
import { getBookloreDownloader } from "../booklore/bookDownloadRegistration";
import { OpdsClient } from "../booklore/opdsClient";
import type { OpdsEntry, OpdsFeed, OpdsLink } from "../booklore/opdsTypes";
import type ObservationCarPlugin from "../main";
import type { BookNote } from "../model/bookNote";

export const REDOWNLOAD_FROM_BOOKLORE_COMMAND_ID =
  "redownload-from-booklore";
export const BOOKLORE_ALL_BOOKS_CATALOG_ID = "urn:booklore:catalog:all";

/** Register F5.7's explicit refresh for the currently open book note. */
export function registerRedownloadFromBookloreCommand(
  plugin: ObservationCarPlugin,
): void {
  let requestEpoch = 0;
  let disposed = false;
  let inFlight = false;
  plugin.register(() => {
    disposed = true;
    requestEpoch += 1;
  });

  plugin.addCommand({
    id: REDOWNLOAD_FROM_BOOKLORE_COMMAND_ID,
    name: "Re-download from Booklore",
    icon: "refresh-cw",
    checkCallback: (checking) => {
      const note = currentBookNote(plugin);
      if (note === null) return false;

      if (checking === false && inFlight === false) {
        const epoch = ++requestEpoch;
        inFlight = true;
        const stale = (): boolean =>
          disposed || epoch !== requestEpoch;
        const run = async (): Promise<void> => {
          try {
            await redownloadOpenBook(plugin, note, stale);
          } finally {
            if (epoch === requestEpoch) inFlight = false;
          }
        };
        void run();
      }
      return true;
    },
  });
}

function currentBookNote(plugin: ObservationCarPlugin): BookNote | null {
  const file = plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file;
  if (file === null || file === undefined) return null;
  return plugin.getBookNote(file.path) ?? null;
}

async function redownloadOpenBook(
  plugin: ObservationCarPlugin,
  note: BookNote,
  stale: () => boolean,
): Promise<void> {
  const id = normalizeBookloreId(note.frontmatter.data["booklore_id"]);
  if (id === null) {
    new Notice("This book note has no valid booklore_id.");
    return;
  }

  const downloader = getBookloreDownloader(plugin);
  if (downloader === undefined) {
    new Notice("The Booklore download service is not ready.");
    return;
  }

  try {
    const replacementPath = await resolveReplacementPath(
      plugin,
      downloader.getDownloadIndex(),
      id.canonical,
      note.frontmatter.source,
    );
    if (replacementPath === null) {
      new Notice(
        `Could not re-download booklore_id ${id.display}: this note does not identify an existing vault book.`,
      );
      return;
    }

    const client = new OpdsClient({ settings: () => plugin.settings });
    const entry = await findBookloreEntry(client, id.canonical);
    if (stale()) return;
    if (entry === null) {
      new Notice(
        `Booklore has no book matching booklore_id ${id.display}. The ID may be stale.`,
      );
      return;
    }

    const acquisition = acquisitionForFormat(entry, note.frontmatter.format);
    if (acquisition === null) {
      const format = note.frontmatter.format?.toUpperCase() ?? "matching";
      new Notice(`Booklore has no ${format} download for this book.`);
      return;
    }

    const result = await downloader.redownload(
      entry,
      acquisition,
      replacementPath,
    );
    if (stale()) return;
    new Notice(`Re-downloaded ${result.vaultPath} from Booklore.`);
  } catch (error) {
    if (stale()) return;
    console.error("[observation-car] could not re-download from Booklore", error);
    const message =
      error instanceof Error ? error.message : "Unknown error.";
    new Notice(`Could not re-download from Booklore: ${message}`);
  }
}

async function resolveReplacementPath(
  plugin: ObservationCarPlugin,
  index: Record<string, { vaultPath: string }>,
  bookloreId: string,
  noteSource: string | null,
): Promise<string | null | undefined> {
  const indexedPath = index[bookloreId]?.vaultPath;
  if (
    indexedPath !== undefined &&
    (await plugin.app.vault.adapter.exists(indexedPath))
  ) {
    return undefined;
  }
  if (
    noteSource !== null &&
    (await plugin.app.vault.adapter.exists(noteSource))
  ) {
    return noteSource;
  }
  return null;
}

interface CatalogClient {
  getRootFeed(): Promise<OpdsFeed>;
  fetchFeed(url: string): Promise<OpdsFeed>;
}

/** Resolve an OPDS entry by its stable Booklore urn across catalog pages. */
export async function findBookloreEntry(
  client: CatalogClient,
  canonicalId: string,
): Promise<OpdsEntry | null> {
  const root = await client.getRootFeed();
  const catalogUrl = root.entries.find(
    (entry) => entry.id === BOOKLORE_ALL_BOOKS_CATALOG_ID,
  )?.navigation?.href;
  if (catalogUrl === undefined) {
    throw new Error("Booklore did not advertise its book catalog.");
  }

  const visited = new Set<string>();
  let pageUrl: string | null = catalogUrl;
  while (pageUrl !== null) {
    if (visited.has(pageUrl)) {
      throw new Error("Booklore returned a catalog pagination loop.");
    }
    visited.add(pageUrl);
    const page = await client.fetchFeed(pageUrl);
    const match = page.entries.find((entry) => entry.id === canonicalId);
    if (match !== undefined) return match;
    pageUrl = page.pagination.next;
  }
  return null;
}

function acquisitionForFormat(
  entry: OpdsEntry,
  format: BookNote["frontmatter"]["format"],
): OpdsLink | null {
  const mediaType =
    format === "epub"
      ? "application/epub+zip"
      : format === "pdf"
        ? "application/pdf"
        : null;
  if (mediaType === null) return null;
  return (
    entry.acquisitions.find(
      (link) => link.type.split(";", 1)[0]?.trim().toLowerCase() === mediaType,
    ) ?? null
  );
}

function normalizeBookloreId(
  value: unknown,
): { canonical: string; display: string } | null {
  let display: string;
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) === false || value < 0) return null;
    display = String(value);
  } else if (typeof value === "string") {
    display = value.trim();
    if (display === "") return null;
  } else {
    return null;
  }

  const prefix = "urn:booklore:book:";
  return {
    canonical: display.startsWith(prefix) ? display : `${prefix}${display}`,
    display: display.startsWith(prefix) ? display.slice(prefix.length) : display,
  };
}
