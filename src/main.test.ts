import { describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import manifest from "../manifest.json";
import ObservationCarPlugin from "./main";
import { DEFAULT_SETTINGS } from "./settings";

vi.mock("obsidian", () => {
  class Plugin {
    app: App;

    constructor(app: App) {
      this.app = app;
    }

    async loadData(): Promise<unknown> {
      return undefined;
    }

    async saveData(_data: unknown): Promise<void> {}

    addSettingTab(): void {}
    registerView(): void {}
    registerExtensions(): void {}
    registerEvent(): void {}
  }

  return {
    App: class {},
    FileView: class {},
    ItemView: class {},
    Notice: class {},
    Plugin,
    PluginSettingTab: class {
      constructor(_app: App, _plugin: Plugin) {}
    },
    Setting: class {},
    TFile: class {},
  };
});

const FIRST_CFI = "#epubcfi(/6/2!/4/2/1:0)";
const SECOND_CFI = "#epubcfi(/6/8!/4/2/1:0)";

interface PluginHarness {
  readonly plugin: ObservationCarPlugin;
  readonly saves: unknown[];
}

function makePlugin(stored: unknown = undefined): PluginHarness {
  const app = {
    metadataCache: {
      getFileCache: () => null,
      on: () => ({}),
    },
    vault: {
      getMarkdownFiles: () => [],
    },
  } as unknown as App;
  const plugin = new ObservationCarPlugin(app, {} as PluginManifest);
  const saves: unknown[] = [];
  vi.spyOn(plugin, "loadData").mockResolvedValue(stored);
  vi.spyOn(plugin, "saveData").mockImplementation(async (data: unknown) => {
    saves.push(JSON.parse(JSON.stringify(data)) as unknown);
  });
  return { plugin, saves };
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

describe("manifest.json", () => {
  it("runs on mobile (isDesktopOnly is false)", () => {
    expect(manifest.isDesktopOnly).toBe(false);
  });

  it("targets a supported Obsidian version (minAppVersion >= 1.7.2)", () => {
    expect(compareVersions(manifest.minAppVersion, "1.7.2")).toBeGreaterThanOrEqual(0);
  });
});

describe("F2.4 plugin host persistence", () => {
  it("round-trips a remembered CFI through the serialized data.json shape", async () => {
    const firstLoad = makePlugin();
    await firstLoad.plugin.onload();

    await firstLoad.plugin.rememberEpubLocation("Books/One.epub", FIRST_CFI);

    expect(firstLoad.plugin.getLastEpubLocation("Books/One.epub")).toBe(FIRST_CFI);
    expect(firstLoad.saves).toHaveLength(1);

    const reload = makePlugin(firstLoad.saves[0]);
    await reload.plugin.onload();
    expect(reload.plugin.getLastEpubLocation("Books/One.epub")).toBe(FIRST_CFI);
  });

  it("suppresses only an identical location rewrite", async () => {
    const { plugin, saves } = makePlugin();
    await plugin.onload();

    await plugin.rememberEpubLocation("Books/One.epub", FIRST_CFI);
    await plugin.rememberEpubLocation("Books/One.epub", FIRST_CFI);
    expect(saves).toHaveLength(1);

    await plugin.rememberEpubLocation("Books/One.epub", SECOND_CFI);
    expect(saves).toHaveLength(2);
    expect(plugin.getLastEpubLocation("Books/One.epub")).toBe(SECOND_CFI);
  });

  it("preserves flat settings and other book keys without persisting note content", async () => {
    const noteContent = "## Private reading note\nThis belongs in the vault.";
    const { plugin, saves } = makePlugin({
      ...DEFAULT_SETTINGS,
      booksFolder: "Library/Books",
      opdsUsername: "reader",
      epubLastLocations: {
        "Library/Other.epub": FIRST_CFI,
      },
      noteContent,
    });
    await plugin.onload();

    await plugin.rememberEpubLocation("Library/New.epub", SECOND_CFI);

    expect(saves).toEqual([
      {
        ...DEFAULT_SETTINGS,
        booksFolder: "Library/Books",
        opdsUsername: "reader",
        epubLastLocations: {
          "Library/Other.epub": FIRST_CFI,
          "Library/New.epub": SECOND_CFI,
        },
      },
    ]);
    expect(JSON.stringify(saves[0])).not.toContain(noteContent);
  });
});
