import { normalizePath, TFile, type App } from "obsidian";
import {
  createOrOpenBookNote,
  type BookloreNoteSeed,
} from "../commands/bookNoteCreation";
import {
  normalizeBaseUrl,
  type ObservationCarSettings,
} from "../settings";
import {
  BookloreDownloader,
  type BookDownloadResult,
  type BookloreDownloaderOptions,
} from "./bookDownload";
import type { OpdsEntry, OpdsLink } from "./opdsTypes";

type DownloadEntry = Pick<
  OpdsEntry,
  "id" | "title" | "updated" | "authors"
>;
type DownloadLink = Pick<OpdsLink, "href" | "type">;

export interface BookNoteOpeningHost {
  app: App;
  settings: ObservationCarSettings;
}

export interface BookNoteOpeningDownloaderOptions
  extends BookloreDownloaderOptions {
  host: BookNoteOpeningHost;
}

/**
 * F5.6's adapter around the F5.5 downloader. No UI in this consolidated base
 * invokes `download` yet; it preserves the signature F5.4's separately landed
 * UI calls with complete OPDS objects while adding note seeding and the
 * reader/note split after the vault write.
 */
export class BookNoteOpeningDownloader extends BookloreDownloader {
  private readonly host: BookNoteOpeningHost;

  constructor(options: BookNoteOpeningDownloaderOptions) {
    super(options);
    this.host = options.host;
  }

  override async download(
    entry: DownloadEntry,
    acquisition: DownloadLink,
  ): Promise<BookDownloadResult> {
    const result = await super.download(entry, acquisition);
    const authors = authorsOf(entry);
    const seed = seedFromEntry(this.host, entry, authors);
    await openDownloadedBookAndNote(this.host, result.vaultPath, seed);
    return result;
  }
}

function authorsOf(entry: DownloadEntry): string[] {
  const authors: unknown = "authors" in entry ? entry.authors : undefined;
  if (isStringArray(authors) === false) {
    throw new Error("The Booklore entry has no usable author metadata.");
  }
  return authors;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "string")
  );
}

function seedFromEntry(
  host: BookNoteOpeningHost,
  entry: DownloadEntry,
  authors: string[],
): BookloreNoteSeed {
  const match = /^urn:booklore:book:(\d+)$/.exec(entry.id.trim());
  const numericId = match === null ? Number.NaN : Number(match[1]);
  if (Number.isSafeInteger(numericId) === false) {
    throw new Error(
      `The Booklore entry has an invalid book identifier: ${entry.id}`,
    );
  }
  const baseUrl = normalizeBaseUrl(host.settings.bookloreBaseUrl);
  if (baseUrl === "") {
    throw new Error("No Booklore base URL is set.");
  }
  return {
    title: entry.title,
    // Preserve every source string, in feed order, without name normalization.
    author: authors.join(", "),
    bookloreId: numericId,
    bookloreUrl: `${baseUrl}/book/${numericId}`,
  };
}

async function openDownloadedBookAndNote(
  host: BookNoteOpeningHost,
  vaultPath: string,
  seed: BookloreNoteSeed,
): Promise<void> {
  const normalizedPath = normalizePath(vaultPath);
  const book = host.app.vault.getAbstractFileByPath(normalizedPath);
  if (book instanceof TFile === false) {
    throw new Error(
      `The downloaded book is not available at ${normalizedPath}`,
    );
  }

  const readerLeaf = host.app.workspace.getLeaf("tab");
  await readerLeaf.openFile(book);
  await createOrOpenBookNote(host, book, seed);
}
