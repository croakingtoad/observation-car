import { Plugin } from "obsidian";
// The book-note model ships with the plugin: anchor.ts depends on epub.js,
// which Obsidian does not provide, so it is bundled (DP-003).
import "./model/anchor";

/**
 * Observation Car — plugin entry point.
 *
 * F1.1 scaffold only: an empty-but-loadable plugin. Readers, the book-note
 * model, scroll-sync, Booklore, and settings are added by the follow-up
 * issues (LOCO-22 through LOCO-25 and the E002+ issues).
 */
export default class ObservationCarPlugin extends Plugin {
  async onload(): Promise<void> {}

  onunload(): void {}
}
