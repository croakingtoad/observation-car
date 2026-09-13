import {
  normalizePath,
  requestUrl,
  TFolder,
  type App,
} from "obsidian";
import type { ObservationCarSettings } from "../settings";
import { basicAuthHeader } from "./opdsAuth";
import type { OpdsEntry, OpdsLink } from "./opdsTypes";

/** The key used for the F5.5 download index inside plugin data.json. */
export const DOWNLOAD_INDEX_KEY = "downloadIndex";

export interface BookloreDownloadRecord {
  vaultPath: string;
  /** OPDS entry timestamp used for the no-request unchanged fast path. */
  updated?: string;
  /** HTTP entity tag used for a conditional request when `updated` changes. */
  etag?: string;
}

export type BookloreDownloadIndex = Record<
  string,
  BookloreDownloadRecord
>;

export type BookDownloadStatus = "downloaded" | "unchanged";

export interface BookDownloadResult {
  status: BookDownloadStatus;
  vaultPath: string;
}

export interface BookDownloadTransportResult {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
}

export type BookDownloadTransport = (
  url: string,
  headers: Record<string, string>,
) => Promise<BookDownloadTransportResult>;

export type BookDownloadErrorKind =
  | "invalid-entry"
  | "unsupported-format"
  | "invalid-url"
  | "invalid-folder"
  | "auth"
  | "unreachable"
  | "http"
  | "folder-conflict";

export class BookDownloadError extends Error {
  readonly kind: BookDownloadErrorKind;
  readonly status?: number;

  constructor(
    kind: BookDownloadErrorKind,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "BookDownloadError";
    this.kind = kind;
    this.status = status;
  }
}

export interface BookloreDownloaderOptions {
  app: App;
  settings: () => ObservationCarSettings;
  initialIndex?: BookloreDownloadIndex;
  saveIndex: (index: BookloreDownloadIndex) => Promise<void>;
  transport?: BookDownloadTransport;
}

interface SupportedFormat {
  mediaType: "application/epub+zip" | "application/pdf";
  extension: "epub" | "pdf";
}

const SUPPORTED_FORMATS: Record<string, SupportedFormat> = {
  "application/epub+zip": {
    mediaType: "application/epub+zip",
    extension: "epub",
  },
  "application/pdf": {
    mediaType: "application/pdf",
    extension: "pdf",
  },
};

const WINDOWS_RESERVED_STEM =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_FILENAME_BYTES = 240;

const defaultTransport: BookDownloadTransport = async (url, headers) => {
  const response = await requestUrl({ url, headers, throw: false });
  // Obsidian exposes response bodies as properties, not fetch-style methods.
  return {
    status: response.status,
    headers: response.headers,
    arrayBuffer: response.arrayBuffer,
  };
};

/**
 * Turn an OPDS title into a filename safe on Windows, macOS/iOS, Linux,
 * and Android. The returned value includes the supplied extension.
 */
export function sanitizeBookFilename(
  title: string,
  extension: "epub" | "pdf",
): string {
  let stem = title
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .trim()
    .replace(/[ .-]+$/g, "");

  if (stem === "" || stem === "." || stem === "..") {
    stem = "Untitled";
  }
  if (WINDOWS_RESERVED_STEM.test(stem)) {
    stem = `_${stem}`;
  }

  const suffix = `.${extension}`;
  const byteLimit = MAX_FILENAME_BYTES - new TextEncoder().encode(suffix).length;
  stem = truncateUtf8(stem, byteLimit).replace(/[ .-]+$/g, "");
  if (stem === "") {
    stem = "Untitled";
  }
  return `${stem}${suffix}`;
}

/** Validate and copy an untrusted download index loaded from data.json. */
export function readDownloadIndex(data: unknown): BookloreDownloadIndex {
  const index: BookloreDownloadIndex = Object.create(null) as BookloreDownloadIndex;
  if (data === null || typeof data !== "object") {
    return index;
  }
  const candidate = (data as Record<string, unknown>)[DOWNLOAD_INDEX_KEY];
  if (candidate === null || typeof candidate !== "object") {
    return index;
  }

  for (const [bookloreId, rawRecord] of Object.entries(candidate)) {
    if (
      bookloreId === "" ||
      rawRecord === null ||
      typeof rawRecord !== "object"
    ) {
      continue;
    }
    const record = rawRecord as Record<string, unknown>;
    if (typeof record.vaultPath !== "string" || record.vaultPath === "") {
      continue;
    }
    const vaultPath = safeStoredVaultPath(record.vaultPath);
    if (vaultPath === null) continue;
    const normalizedRecord: BookloreDownloadRecord = { vaultPath };
    if (typeof record.updated === "string" && record.updated !== "") {
      normalizedRecord.updated = record.updated;
    }
    if (typeof record.etag === "string" && record.etag !== "") {
      normalizedRecord.etag = record.etag;
    }
    index[bookloreId] = normalizedRecord;
  }
  return index;
}

/**
 * Download supported Booklore acquisitions into the configured vault folder.
 * Calls are serialized so two simultaneous titles cannot choose the same path.
 */
export class BookloreDownloader {
  private readonly app: App;
  private readonly settings: () => ObservationCarSettings;
  private readonly saveIndex: (
    index: BookloreDownloadIndex,
  ) => Promise<void>;
  private readonly transport: BookDownloadTransport;
  private index: BookloreDownloadIndex;
  private lock: Promise<void> = Promise.resolve();

  constructor(options: BookloreDownloaderOptions) {
    this.app = options.app;
    this.settings = options.settings;
    this.saveIndex = options.saveIndex;
    this.transport = options.transport ?? defaultTransport;
    this.index = copyIndex(options.initialIndex ?? {});
  }

  getDownloadIndex(): BookloreDownloadIndex {
    return copyIndex(this.index);
  }

  async download(
    entry: Pick<OpdsEntry, "id" | "title" | "updated">,
    acquisition: Pick<OpdsLink, "href" | "type">,
  ): Promise<BookDownloadResult> {
    return this.runDownload(entry, acquisition, false);
  }

  /**
   * Re-fetch an indexed book even when its OPDS timestamp is unchanged.
   * The existing owned vault path is retained and replaced only after a
   * successful response, so a failed fetch leaves the current copy intact.
   */
  async redownload(
    entry: Pick<OpdsEntry, "id" | "title" | "updated">,
    acquisition: Pick<OpdsLink, "href" | "type">,
    replacementPath?: string,
  ): Promise<BookDownloadResult> {
    return this.runDownload(entry, acquisition, true, replacementPath);
  }

  private async runDownload(
    entry: Pick<OpdsEntry, "id" | "title" | "updated">,
    acquisition: Pick<OpdsLink, "href" | "type">,
    force: boolean,
    replacementPath?: string,
  ): Promise<BookDownloadResult> {
    const previous = this.lock;
    let release: (() => void) | undefined;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.downloadLocked(
        entry,
        acquisition,
        force,
        replacementPath,
      );
    } finally {
      release?.();
    }
  }

  private async downloadLocked(
    entry: Pick<OpdsEntry, "id" | "title" | "updated">,
    acquisition: Pick<OpdsLink, "href" | "type">,
    force: boolean,
    replacementPath?: string,
  ): Promise<BookDownloadResult> {
    if (entry.id.trim() === "") {
      throw new BookDownloadError(
        "invalid-entry",
        "The Booklore entry has no identifier.",
      );
    }
    const format = supportedFormat(acquisition.type);
    const url = checkedHttpUrl(acquisition.href);
    const existing = ownRecord(this.index, entry.id);
    const existingFilePresent =
      existing !== undefined &&
      (await this.app.vault.adapter.exists(existing.vaultPath));

    if (
      force === false &&
      existing !== undefined &&
      entry.updated !== "" &&
      existing.updated === entry.updated &&
      existingFilePresent
    ) {
      return { status: "unchanged", vaultPath: existing.vaultPath };
    }

    const settings = this.settings();
    const folder = normalizedFolder(settings.booksFolder);
    const headers = this.requestHeaders(url, format.mediaType, settings);
    if (
      force === false &&
      existing?.etag !== undefined &&
      existingFilePresent
    ) {
      headers["If-None-Match"] = existing.etag;
    }

    let response: BookDownloadTransportResult;
    try {
      response = await this.transport(url, headers);
    } catch {
      throw new BookDownloadError(
        "unreachable",
        "Could not download the book from Booklore.",
      );
    }

    if (
      response.status === 304 &&
      existing !== undefined &&
      existingFilePresent
    ) {
      const nextRecord: BookloreDownloadRecord = {
        ...existing,
        ...(entry.updated === "" ? {} : { updated: entry.updated }),
      };
      await this.updateIndex(entry.id, nextRecord);
      return { status: "unchanged", vaultPath: existing.vaultPath };
    }
    if (response.status === 401 || response.status === 403) {
      throw new BookDownloadError(
        "auth",
        "Booklore rejected the OPDS credentials.",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new BookDownloadError(
        "http",
        `Booklore answered with HTTP ${response.status}.`,
        response.status,
      );
    }

    await ensureVaultFolder(this.app, folder);
    const vaultPath = await this.chooseVaultPath(
      entry,
      format.extension,
      existing,
      folder,
      replacementPath,
    );
    await this.app.vault.adapter.writeBinary(
      vaultPath,
      response.arrayBuffer,
    );

    const etag = headerValue(response.headers, "etag");
    const nextRecord: BookloreDownloadRecord = { vaultPath };
    if (entry.updated !== "") {
      nextRecord.updated = entry.updated;
    }
    if (etag !== undefined && etag !== "") {
      nextRecord.etag = etag;
    }
    await this.updateIndex(entry.id, nextRecord);
    return { status: "downloaded", vaultPath };
  }

  private requestHeaders(
    url: string,
    mediaType: SupportedFormat["mediaType"],
    settings: ObservationCarSettings,
  ): Record<string, string> {
    const headers: Record<string, string> = { Accept: mediaType };
    if (
      sameOrigin(url, settings.bookloreBaseUrl) &&
      (settings.opdsUsername !== "" || settings.opdsPassword !== "")
    ) {
      headers.Authorization = basicAuthHeader(
        settings.opdsUsername,
        settings.opdsPassword,
      );
    }
    return headers;
  }

  private async chooseVaultPath(
    entry: Pick<OpdsEntry, "id" | "title">,
    extension: SupportedFormat["extension"],
    existing: BookloreDownloadRecord | undefined,
    folder: string,
    replacementPath?: string,
  ): Promise<string> {
    if (replacementPath !== undefined) {
      const normalized = safeStoredVaultPath(replacementPath);
      if (
        normalized === null ||
        normalized.toLowerCase().endsWith(`.${extension}`) === false ||
        (await this.app.vault.adapter.exists(normalized)) === false
      ) {
        throw new BookDownloadError(
          "invalid-entry",
          "The book note's vault copy no longer exists.",
        );
      }
      return normalized;
    }

    if (
      existing !== undefined &&
      existing.vaultPath.toLowerCase().endsWith(`.${extension}`) &&
      (await this.app.vault.adapter.exists(existing.vaultPath)) &&
      this.pathOwner(existing.vaultPath) === entry.id
    ) {
      return existing.vaultPath;
    }

    const filename = sanitizeBookFilename(entry.title, extension);
    const dot = filename.lastIndexOf(".");
    const stem = filename.slice(0, dot);
    const suffix = filename.slice(dot);
    let ordinal = 1;
    while (true) {
      const candidateName =
        ordinal === 1
          ? filename
          : collisionFilename(stem, suffix, ordinal);
      const candidate = joinVaultPath(folder, candidateName);
      if ((await this.app.vault.adapter.exists(candidate)) === false) {
        return candidate;
      }
      ordinal += 1;
    }
  }

  private pathOwner(vaultPath: string): string | undefined {
    for (const [bookloreId, record] of Object.entries(this.index)) {
      if (record.vaultPath === vaultPath) {
        return bookloreId;
      }
    }
    return undefined;
  }

  private async updateIndex(
    bookloreId: string,
    record: BookloreDownloadRecord,
  ): Promise<void> {
    const next = copyIndex(this.index);
    next[bookloreId] = { ...record };
    // Keep the in-memory ownership even if persistence fails, preventing a
    // retry in this session from silently choosing and writing another path.
    this.index = next;
    await this.saveIndex(copyIndex(next));
  }
}

function supportedFormat(type: string): SupportedFormat {
  const mediaType = type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const format = SUPPORTED_FORMATS[mediaType];
  if (format === undefined) {
    throw new BookDownloadError(
      "unsupported-format",
      "Only EPUB and PDF Booklore acquisitions can be downloaded.",
    );
  }
  return format;
}

function checkedHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return url.toString();
  } catch {
    throw new BookDownloadError(
      "invalid-url",
      "The Booklore acquisition URL is invalid.",
    );
  }
}

function sameOrigin(url: string, baseUrl: string): boolean {
  if (baseUrl.trim() === "") return false;
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function truncateUtf8(value: string, byteLimit: number): string {
  const encoder = new TextEncoder();
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).length;
    if (bytes + size > byteLimit) break;
    result += character;
    bytes += size;
  }
  return result;
}

function collisionFilename(
  stem: string,
  extension: string,
  ordinal: number,
): string {
  const marker = ` (${ordinal})`;
  const encoder = new TextEncoder();
  const stemLimit =
    MAX_FILENAME_BYTES -
    encoder.encode(marker).length -
    encoder.encode(extension).length;
  const fittedStem = truncateUtf8(stem, stemLimit).replace(/[ .-]+$/g, "");
  return `${fittedStem === "" ? "Untitled" : fittedStem}${marker}${extension}`;
}

function normalizedFolder(value: string): string {
  const portable = value.trim().replace(/\\/g, "/");
  if (
    portable.startsWith("/") ||
    portable.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new BookDownloadError(
      "invalid-folder",
      "The books folder must be a path inside the vault.",
    );
  }
  const normalized = normalizePath(value.trim());
  return normalized === "." ? "" : normalized.replace(/^\/+|\/+$/g, "");
}

function safeStoredVaultPath(value: string): string | null {
  const portable = value.replace(/\\/g, "/");
  if (
    portable.startsWith("/") ||
    portable.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }
  const normalized = normalizePath(value);
  return normalized === "" ? null : normalized;
}

function joinVaultPath(folder: string, filename: string): string {
  return normalizePath(folder === "" ? filename : `${folder}/${filename}`);
}

async function ensureVaultFolder(app: App, folder: string): Promise<void> {
  if (folder === "") return;

  let current = "";
  for (const segment of folder.split("/")) {
    current = joinVaultPath(current, segment);
    const existing = app.vault.getAbstractFileByPath(current);
    if (existing instanceof TFolder) continue;
    if (existing !== null) {
      throw new BookDownloadError(
        "folder-conflict",
        `Cannot create the books folder because ${current} is a file.`,
      );
    }
    await app.vault.createFolder(current);
  }
}

function ownRecord(
  index: BookloreDownloadIndex,
  bookloreId: string,
): BookloreDownloadRecord | undefined {
  return Object.prototype.hasOwnProperty.call(index, bookloreId)
    ? index[bookloreId]
    : undefined;
}

function copyIndex(index: BookloreDownloadIndex): BookloreDownloadIndex {
  const copy: BookloreDownloadIndex = Object.create(null) as BookloreDownloadIndex;
  for (const [bookloreId, record] of Object.entries(index)) {
    copy[bookloreId] = { ...record };
  }
  return copy;
}
