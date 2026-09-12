import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import { loadPluginData, serializePluginData } from "./pluginData";

const FIRST_CFI = "#epubcfi(/6/2!/4/2/1:0)";
const SECOND_CFI = "#epubcfi(/6/8!/4/2/1:0)";

describe("F2.4 plugin data", () => {
  it("loads a validated last CFI for each book path alongside settings", () => {
    const loaded = loadPluginData({
      booksFolder: "Library/Books",
      epubLastLocations: {
        "Library/One.epub": FIRST_CFI,
        "Library/Two.epub": SECOND_CFI,
        "Library/Not-A-Cfi.epub": "chapter.xhtml",
        "Library/Not-A-String.epub": 42,
      },
    });

    expect(loaded.settings.booksFolder).toBe("Library/Books");
    expect(loaded.epubLastLocations).toEqual({
      "Library/One.epub": FIRST_CFI,
      "Library/Two.epub": SECOND_CFI,
    });
  });

  it("falls back safely when stored plugin data is absent or malformed", () => {
    expect(loadPluginData(undefined)).toEqual({
      settings: DEFAULT_SETTINGS,
      epubLastLocations: {},
    });
    expect(loadPluginData({ epubLastLocations: [] }).epubLastLocations).toEqual({});
  });

  it("serializes only settings and the per-book location map", () => {
    const serialized = serializePluginData(DEFAULT_SETTINGS, {
      "Books/One.epub": FIRST_CFI,
    });

    expect(serialized).toEqual({
      ...DEFAULT_SETTINGS,
      epubLastLocations: { "Books/One.epub": FIRST_CFI },
    });
    expect(Object.keys(serialized).sort()).toEqual(
      [...Object.keys(DEFAULT_SETTINGS), "epubLastLocations"].sort(),
    );
  });
});
