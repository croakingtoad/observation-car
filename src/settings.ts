/**
 * F1.4 — Observation Car settings model.
 *
 * Deliberately free of `obsidian` imports so it can be unit-tested in Node.
 * The Obsidian-side wiring lives in `main.ts` (load from / save to
 * `data.json`) and `settingsTab.ts` (the tab UI).
 *
 * The OPDS username and password live in `data.json` in plaintext by design
 * (PRD §5.4). The tab must keep `OPDS_CREDENTIALS_WARNING` visible next to
 * those fields, and no code path may ever write either value into a note
 * or log it.
 */

export interface ObservationCarSettings {
  /** Vault folder holding downloaded EPUB/PDF files. */
  booksFolder: string;
  /** Vault folder holding book notes, one per book. */
  notesFolder: string;
  /** Heading level (1–6) that marks an anchored section in a book note. */
  anchorHeadingLevel: number;
  /** Frontmatter + opening content written when a new book note is created. */
  noteTemplate: string;
  /** Whether focus mode starts on when a book note opens beside its reader. */
  focusModeDefault: boolean;
  /**
   * F2.2 — EPUB reader flow mode. Persisted as a global plugin setting;
   * per-book state is F2.4's job (LOCO-29).
   */
  epubFlowMode: EpubFlowMode;
  /**
   * Fallback chapter window (in pages, ± each side) for PDFs without an
   * outline. Default ±10.
   */
  pdfChapterWindowPages: number;
  /** Reader's share of the split, in percent, in read mode (default 60/40). */
  splitReadRatioPercent: number;
  /** Reader's share of the split, in percent, in write mode (default 40/60). */
  splitWriteRatioPercent: number;
  /** Base URL of the self-hosted Booklore instance. */
  bookloreBaseUrl: string;
  /** OPDS account username for the Booklore instance. */
  opdsUsername: string;
  /** OPDS account password for the Booklore instance (plaintext in data.json). */
  opdsPassword: string;
}

export const ANCHOR_HEADING_LEVEL_MIN = 1;
export const ANCHOR_HEADING_LEVEL_MAX = 6;
export const PDF_CHAPTER_WINDOW_MIN = 1;
export const PDF_CHAPTER_WINDOW_MAX = 100;
export const SPLIT_RATIO_MIN = 5;
export const SPLIT_RATIO_MAX = 95;

/** F2.2 — the EPUB reader's flow modes (PRD §6 E002). */
export type EpubFlowMode = "paginated" | "scrolled";

/**
 * Frontmatter shape from PRD §5.2 with placeholders that note-creation
 * features (F1.5, F5.6) replace. Booklore-specific keys are seeded by F5.6,
 * not baked into the template.
 */
export const DEFAULT_NOTE_TEMPLATE = `---
type: book-note
source: "{{source}}"
format: {{format}}
title: {{title}}
author: {{author}}
---
`;

/** Shown in the settings tab next to the OPDS username/password fields. */
export const OPDS_CREDENTIALS_WARNING =
  "The OPDS username and password are stored in plaintext in data.json " +
  "(.obsidian/plugins/observation-car/data.json) on this machine. Use a " +
  "dedicated OPDS account: anyone who can read the vault folder can read " +
  "these credentials.";

export const DEFAULT_SETTINGS: ObservationCarSettings = {
  booksFolder: "Books",
  notesFolder: "Reading",
  anchorHeadingLevel: 2,
  noteTemplate: DEFAULT_NOTE_TEMPLATE,
  focusModeDefault: false,
  epubFlowMode: "paginated",
  pdfChapterWindowPages: 10,
  splitReadRatioPercent: 60,
  splitWriteRatioPercent: 40,
  bookloreBaseUrl: "",
  opdsUsername: "",
  opdsPassword: "",
};

/** Round and clamp into [min, max]; non-finite input falls back to min. */
export function clampInt(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) {
    return min;
  }
  return Math.min(max, Math.max(min, rounded));
}

/** Trim a vault folder path, collapse duplicate slashes, drop leading/trailing slashes. */
export function normalizeFolderPath(value: string): string {
  return value.trim().replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Trim a base URL and drop a trailing slash. */
export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * Merge stored `data.json` content over the defaults, validating each field.
 * Unknown keys are dropped; malformed values fall back to the default so a
 * hand-edited or corrupt data.json can never take the plugin down. The
 * password is copied through untouched — never trim or transform a secret.
 */
export function mergeSettings(stored: unknown): ObservationCarSettings {
  const settings: ObservationCarSettings = { ...DEFAULT_SETTINGS };
  if (stored === null || typeof stored !== "object") {
    return settings;
  }
  const partial = stored as Record<string, unknown>;
  if (typeof partial.booksFolder === "string") {
    settings.booksFolder = normalizeFolderPath(partial.booksFolder);
  }
  if (typeof partial.notesFolder === "string") {
    settings.notesFolder = normalizeFolderPath(partial.notesFolder);
  }
  if (typeof partial.anchorHeadingLevel === "number") {
    settings.anchorHeadingLevel = clampInt(
      partial.anchorHeadingLevel,
      ANCHOR_HEADING_LEVEL_MIN,
      ANCHOR_HEADING_LEVEL_MAX,
    );
  }
  if (typeof partial.noteTemplate === "string") {
    settings.noteTemplate = partial.noteTemplate;
  }
  if (typeof partial.focusModeDefault === "boolean") {
    settings.focusModeDefault = partial.focusModeDefault;
  }
  // Whitelist check, not a string passthrough: anything outside the two
  // modes falls back to the default (a hand-edited data.json is legal input).
  if (
    typeof partial.epubFlowMode === "string" &&
    (partial.epubFlowMode === "paginated" || partial.epubFlowMode === "scrolled")
  ) {
    settings.epubFlowMode = partial.epubFlowMode;
  }
  if (typeof partial.pdfChapterWindowPages === "number") {
    settings.pdfChapterWindowPages = clampInt(
      partial.pdfChapterWindowPages,
      PDF_CHAPTER_WINDOW_MIN,
      PDF_CHAPTER_WINDOW_MAX,
    );
  }
  if (typeof partial.splitReadRatioPercent === "number") {
    settings.splitReadRatioPercent = clampInt(
      partial.splitReadRatioPercent,
      SPLIT_RATIO_MIN,
      SPLIT_RATIO_MAX,
    );
  }
  if (typeof partial.splitWriteRatioPercent === "number") {
    settings.splitWriteRatioPercent = clampInt(
      partial.splitWriteRatioPercent,
      SPLIT_RATIO_MIN,
      SPLIT_RATIO_MAX,
    );
  }
  if (typeof partial.bookloreBaseUrl === "string") {
    settings.bookloreBaseUrl = normalizeBaseUrl(partial.bookloreBaseUrl);
  }
  if (typeof partial.opdsUsername === "string") {
    settings.opdsUsername = partial.opdsUsername;
  }
  if (typeof partial.opdsPassword === "string") {
    settings.opdsPassword = partial.opdsPassword;
  }
  return settings;
}
