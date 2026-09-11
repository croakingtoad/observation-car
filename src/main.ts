import { Plugin } from "obsidian";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type ObservationCarSettings,
} from "./settings";
import { ObservationCarSettingTab } from "./settingsTab";

/**
 * Observation Car — plugin entry point.
 *
 * F1.1 scaffold + F1.4 settings: on load the settings are merged from
 * `data.json` and the settings tab is registered. Readers, the book-note
 * model, scroll-sync, and Booklore are added by the follow-up issues
 * (LOCO-22/23/25 and the E002+ issues) and read `this.settings`.
 */
export default class ObservationCarPlugin extends Plugin {
  settings: ObservationCarSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());
    this.addSettingTab(new ObservationCarSettingTab(this.app, this));
  }

  /**
   * Merge a partial update into the settings and persist them to data.json.
   * The only writer for plugin data; keep the OPDS credentials out of
   * anything else (notes, logs, events).
   */
  async updateSettings(patch: Partial<ObservationCarSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await this.saveData(this.settings);
  }

  onunload(): void {}
}
