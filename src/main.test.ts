import { describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import manifest from "../manifest.json";
import ObservationCarPlugin from "./main";
import { DEFAULT_SETTINGS } from "./settings";

vi.mock("obsidian", () => {
  class Plugin {
    app: App;
    readonly registeredCleanups: Array<() => void> = [];

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
    register(cleanup: () => void): void {
      this.registeredCleanups.push(cleanup);
    }
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
  readonly plugin: ObservationCarPlugin & {
    readonly registeredCleanups: Array<() => void>;
  };
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
    workspace: {
      openLinkText: vi.fn(),
    },
  } as unknown as App;
  const plugin = new ObservationCarPlugin(app, {} as PluginManifest) as
    PluginHarness["plugin"];
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
  it("installs the EPUB link handler and registers its cleanup during load", async () => {
    const { plugin } = makePlugin();
    const originalOpenLinkText = plugin.app.workspace.openLinkText;

    await plugin.onload();

    expect(plugin.app.workspace.openLinkText).not.toBe(originalOpenLinkText);
    expect(plugin.registeredCleanups).toHaveLength(1);
    plugin.registeredCleanups[0]();
    expect(plugin.app.workspace.openLinkText).toBe(originalOpenLinkText);
  });

  it("writes a fresh snapshot when state changes during an in-flight save", async () => {
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const { plugin, saves } = makePlugin();
    vi.mocked(plugin.saveData).mockImplementation(async (data: unknown) => {
      saves.push(JSON.parse(JSON.stringify(data)) as unknown);
      if (saves.length === 1) {
        await firstSaveGate;
      }
    });
    await plugin.onload();

    const firstRemember = plugin.rememberEpubLocation(
      "Books/One.epub",
      FIRST_CFI,
    );
    await vi.waitFor(() => expect(saves).toHaveLength(1));
    const secondRemember = plugin.rememberEpubLocation(
      "Books/Two.epub",
      SECOND_CFI,
    );

    if (releaseFirstSave === undefined) {
      throw new Error("The first save did not start");
    }
    releaseFirstSave();
    await Promise.all([firstRemember, secondRemember]);

    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({
      epubLastLocations: {
        "Books/One.epub": FIRST_CFI,
        "Books/Two.epub": SECOND_CFI,
      },
    });
  });

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
    expect(JSON.stringify(saves[0])).not.toContain(
      JSON.stringify(noteContent).slice(1, -1),
    );
  });
});
