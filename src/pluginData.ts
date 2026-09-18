import { parseFragment } from "./model/anchor";
import {
  mergeSettings,
  type ObservationCarSettings,
} from "./settings";
import type { EpubStylesheetMode } from "./readers/epubStyles";

export interface ObservationCarPluginData {
  readonly settings: ObservationCarSettings;
  readonly epubLastLocations: Record<string, string>;
  readonly epubStylesheetModes: Record<string, EpubStylesheetMode>;
}

export type ObservationCarStoredData = ObservationCarSettings & {
  epubLastLocations: Record<string, string>;
  epubStylesheetModes: Record<string, EpubStylesheetMode>;
};

/** Load the flat, backward-compatible data.json shape and validate CFIs. */
export function loadPluginData(stored: unknown): ObservationCarPluginData {
  return {
    settings: mergeSettings(stored),
    epubLastLocations: loadEpubLastLocations(stored),
    epubStylesheetModes: loadEpubStylesheetModes(stored),
  };
}

/** Build the complete data.json payload. No note content belongs here. */
export function serializePluginData(
  settings: ObservationCarSettings,
  epubLastLocations: Readonly<Record<string, string>>,
  epubStylesheetModes: Readonly<Record<string, EpubStylesheetMode>>,
): ObservationCarStoredData {
  return {
    ...settings,
    epubLastLocations: { ...epubLastLocations },
    epubStylesheetModes: { ...epubStylesheetModes },
  };
}

function loadEpubStylesheetModes(
  stored: unknown,
): Record<string, EpubStylesheetMode> {
  if (
    isRecord(stored) === false ||
    isRecord(stored.epubStylesheetModes) === false
  ) {
    return {};
  }

  const validEntries = Object.entries(stored.epubStylesheetModes).filter(
    (entry): entry is [string, EpubStylesheetMode] => {
      const [path, mode] = entry;
      return path.length > 0 && mode === "book";
    },
  );
  return Object.fromEntries(validEntries);
}

function loadEpubLastLocations(stored: unknown): Record<string, string> {
  if (isRecord(stored) === false || isRecord(stored.epubLastLocations) === false) {
    return {};
  }

  const validEntries: Array<[string, string]> = [];
  for (const [path, fragment] of Object.entries(stored.epubLastLocations)) {
    if (path.length === 0 || typeof fragment !== "string") {
      continue;
    }
    try {
      if (
        fragment.startsWith("#") &&
        parseFragment(fragment).kind === "epub-cfi"
      ) {
        validEntries.push([path, fragment]);
      }
    } catch {
      // Hand-edited data.json is legal input; malformed locations are ignored.
    }
  }
  return Object.fromEntries(validEntries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}
