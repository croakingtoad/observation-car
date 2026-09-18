import type { App } from "obsidian";
import type { ObservationCarSettings } from "../settings";
import {
  DOWNLOAD_INDEX_KEY,
  readDownloadIndex,
  type BookloreDownloadIndex,
} from "./bookDownload";
import { BookNoteOpeningDownloader } from "./bookNoteOpening";

interface BookloreDownloadHost {
  app: App;
  settings: ObservationCarSettings;
  loadData(): Promise<unknown>;
  updateSettings(patch: Partial<ObservationCarSettings>): Promise<void>;
}

type SettingsWithDownloadIndex = ObservationCarSettings & {
  [DOWNLOAD_INDEX_KEY]: BookloreDownloadIndex;
};

const registeredDownloaders = new WeakMap<object, BookNoteOpeningDownloader>();

/**
 * Register the F5.5 service and preserve its index through the plugin's
 * existing settings-only save path without changing the settings model.
 */
export async function registerBookloreDownloads(
  host: BookloreDownloadHost,
): Promise<BookNoteOpeningDownloader> {
  const index = readDownloadIndex(await host.loadData());
  attachIndex(host.settings, index);

  const downloader = new BookNoteOpeningDownloader({
    host,
    app: host.app,
    settings: () => host.settings,
    initialIndex: index,
    saveIndex: async (nextIndex) => {
      attachIndex(host.settings, nextIndex);
      // An empty settings patch persists the full enumerable settings object
      // through the plugin's single data.json writer, including this index.
      await host.updateSettings({});
    },
  });
  registeredDownloaders.set(host, downloader);
  return downloader;
}

/** Look up the service registered during plugin load for F5.4/F5.7 callers. */
export function getBookloreDownloader(
  host: object,
): BookNoteOpeningDownloader | undefined {
  return registeredDownloaders.get(host);
}

function attachIndex(
  settings: ObservationCarSettings,
  index: BookloreDownloadIndex,
): void {
  (settings as SettingsWithDownloadIndex)[DOWNLOAD_INDEX_KEY] = index;
}
