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
      epubStylesheetModes: {
        "Library/Styled.epub": "book",
      },
    });

    expect(loaded.settings.booksFolder).toBe("Library/Books");
    expect(loaded.epubLastLocations).toEqual({
      "Library/One.epub": FIRST_CFI,
      "Library/Two.epub": SECOND_CFI,
    });
    expect(loaded.epubStylesheetModes).toEqual({
      "Library/Styled.epub": "book",
    });
  });

  it("falls back safely when stored plugin data is absent or malformed", () => {
    expect(loadPluginData(undefined)).toEqual({
      settings: DEFAULT_SETTINGS,
      epubLastLocations: {},
      epubStylesheetModes: {},
    });
    expect(loadPluginData({ epubLastLocations: [] }).epubLastLocations).toEqual({});
    expect(
      loadPluginData({
        epubStylesheetModes: {
          "Books/Book.epub": "book",
          "Books/Default.epub": "theme",
          "Books/Invalid.epub": "sepia",
          "": "book",
        },
      }).epubStylesheetModes,
    ).toEqual({
      "Books/Book.epub": "book",
    });
  });

  it("serializes settings, locations, and per-book stylesheet modes", () => {
    const serialized = serializePluginData(
      DEFAULT_SETTINGS,
      { "Books/One.epub": FIRST_CFI },
      { "Books/Styled.epub": "book" },
    );

    expect(serialized).toEqual({
      ...DEFAULT_SETTINGS,
      epubLastLocations: { "Books/One.epub": FIRST_CFI },
      epubStylesheetModes: { "Books/Styled.epub": "book" },
    });
    expect(Object.keys(serialized).sort()).toEqual(
      [
        ...Object.keys(DEFAULT_SETTINGS),
        "epubLastLocations",
        "epubStylesheetModes",
      ].sort(),
    );
  });
});
