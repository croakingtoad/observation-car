import { parseFragment } from "./model/anchor";
import {
  mergeSettings,
  type ObservationCarSettings,
} from "./settings";

export interface ObservationCarPluginData {
  readonly settings: ObservationCarSettings;
  readonly epubLastLocations: Record<string, string>;
}

export type ObservationCarStoredData = ObservationCarSettings & {
  epubLastLocations: Record<string, string>;
};

/** Load the flat, backward-compatible data.json shape and validate CFIs. */
export function loadPluginData(stored: unknown): ObservationCarPluginData {
  return {
    settings: mergeSettings(stored),
    epubLastLocations: loadEpubLastLocations(stored),
  };
}

/** Build the complete data.json payload. No note content belongs here. */
export function serializePluginData(
  settings: ObservationCarSettings,
  epubLastLocations: Readonly<Record<string, string>>,
): ObservationCarStoredData {
  return {
    ...settings,
    epubLastLocations: { ...epubLastLocations },
  };
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
