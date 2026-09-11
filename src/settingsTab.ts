import { App, PluginSettingTab, Setting } from "obsidian";
import type ObservationCarPlugin from "./main";
import {
  ANCHOR_HEADING_LEVEL_MAX,
  ANCHOR_HEADING_LEVEL_MIN,
  DEFAULT_NOTE_TEMPLATE,
  OPDS_CREDENTIALS_WARNING,
  PDF_CHAPTER_WINDOW_MAX,
  PDF_CHAPTER_WINDOW_MIN,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  clampInt,
  normalizeBaseUrl,
  normalizeFolderPath,
} from "./settings";

/**
 * F1.4 — the Observation Car settings tab.
 *
 * Every control writes through `ObservationCarPlugin.updateSettings`, which
 * persists to `data.json`. Sanitization happens here at the edge so the
 * stored value is always the one the readers and sync layers will read.
 *
 * Secret hygiene: the OPDS username and password are stored in plaintext by
 * design (PRD §5.4), which is why `OPDS_CREDENTIALS_WARNING` sits above the
 * fields. Neither value may ever be logged or written into a note — future
 * features must keep that true (enforced by src/settings.test.ts).
 */
export class ObservationCarSettingTab extends PluginSettingTab {
  plugin: ObservationCarPlugin;

  constructor(app: App, plugin: ObservationCarPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.settings;

    containerEl.createEl("h4", { text: "Vault layout" });

    new Setting(containerEl)
      .setName("Books folder")
      .setDesc("Where downloaded EPUBs and PDFs are stored in the vault.")
      .addText((text) => {
        text
          .setPlaceholder("Books")
          .setValue(settings.booksFolder)
          .onChange(async (value) => {
            const folder = normalizeFolderPath(value);
            if (folder.length === 0) {
              return; // keep the last valid folder
            }
            await this.plugin.updateSettings({ booksFolder: folder });
          });
      });

    new Setting(containerEl)
      .setName("Notes folder")
      .setDesc("Where book notes are stored, one note per book.")
      .addText((text) => {
        text
          .setPlaceholder("Reading")
          .setValue(settings.notesFolder)
          .onChange(async (value) => {
            const folder = normalizeFolderPath(value);
            if (folder.length === 0) {
              return; // keep the last valid folder
            }
            await this.plugin.updateSettings({ notesFolder: folder });
          });
      });

    new Setting(containerEl)
      .setName("Anchor heading level")
      .setDesc("Heading level that marks an anchored section in a book note.")
      .addDropdown((dropdown) => {
        for (let level = ANCHOR_HEADING_LEVEL_MIN; level <= ANCHOR_HEADING_LEVEL_MAX; level += 1) {
          dropdown.addOption(String(level), `H${level}`);
        }
        dropdown
          .setValue(String(settings.anchorHeadingLevel))
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              anchorHeadingLevel: clampInt(
                Number(value),
                ANCHOR_HEADING_LEVEL_MIN,
                ANCHOR_HEADING_LEVEL_MAX,
              ),
            });
          });
      });

    new Setting(containerEl)
      .setName("Note template")
      .setDesc(
        "Frontmatter written when a new book note is created. Placeholders: " +
          "{{source}}, {{format}}, {{title}}, {{author}}.",
      )
      .addTextArea((area) => {
        area
          .setPlaceholder(DEFAULT_NOTE_TEMPLATE)
          .setValue(settings.noteTemplate)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ noteTemplate: value });
          });
      });

    new Setting(containerEl)
      .setName("Focus mode by default")
      .setDesc(
        "Fold sections outside the current chapter when a book note opens beside its reader.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(settings.focusModeDefault)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ focusModeDefault: value });
          });
      });

    containerEl.createEl("h4", { text: "PDF" });

    new Setting(containerEl)
      .setName("Chapter window (± pages)")
      .setDesc(
        "Fallback chapter size for PDFs without an outline: the current chapter " +
          "spans the current page plus or minus this many pages.",
      )
      .addSlider((slider) => {
        slider
          .setLimits(PDF_CHAPTER_WINDOW_MIN, PDF_CHAPTER_WINDOW_MAX, 1)
          .setValue(settings.pdfChapterWindowPages)
          .setDynamicTooltip()
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              pdfChapterWindowPages: clampInt(
                value,
                PDF_CHAPTER_WINDOW_MIN,
                PDF_CHAPTER_WINDOW_MAX,
              ),
            });
          });
      });

    containerEl.createEl("h4", { text: "Split ratios" });

    new Setting(containerEl)
      .setName("Read mode: reader width")
      .setDesc(
        "Reader's share of the split when the note opens in read mode; the note " +
          "gets the rest. Default 60/40.",
      )
      .addSlider((slider) => {
        slider
          .setLimits(SPLIT_RATIO_MIN, SPLIT_RATIO_MAX, 1)
          .setValue(settings.splitReadRatioPercent)
          .setDynamicTooltip()
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              splitReadRatioPercent: clampInt(value, SPLIT_RATIO_MIN, SPLIT_RATIO_MAX),
            });
          });
      });

    new Setting(containerEl)
      .setName("Write mode: reader width")
      .setDesc(
        "Reader's share of the split when the note opens in write mode; the note " +
          "gets the rest. Default 40/60.",
      )
      .addSlider((slider) => {
        slider
          .setLimits(SPLIT_RATIO_MIN, SPLIT_RATIO_MAX, 1)
          .setValue(settings.splitWriteRatioPercent)
          .setDynamicTooltip()
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              splitWriteRatioPercent: clampInt(value, SPLIT_RATIO_MIN, SPLIT_RATIO_MAX),
            });
          });
      });

    containerEl.createEl("h4", { text: "Booklore (OPDS)" });

    containerEl.createEl("div", {
      cls: "oc-settings-warning",
      text: OPDS_CREDENTIALS_WARNING,
    });

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("Base URL of your self-hosted Booklore instance.")
      .addText((text) => {
        text
          .setPlaceholder("https://booklore.example")
          .setValue(settings.bookloreBaseUrl)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              bookloreBaseUrl: normalizeBaseUrl(value),
            });
          });
      });

    new Setting(containerEl)
      .setName("OPDS username")
      .setDesc("OPDS account for the Booklore instance — stored in plaintext, see warning above.")
      .addText((text) => {
        text
          .setPlaceholder("opds-user")
          .setValue(settings.opdsUsername)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ opdsUsername: value });
          });
      });

    new Setting(containerEl)
      .setName("OPDS password")
      .setDesc("Stored in plaintext in data.json — see warning above.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(settings.opdsPassword)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ opdsPassword: value });
          });
      });
  }
}
