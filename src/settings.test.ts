import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTE_TEMPLATE,
  DEFAULT_SETTINGS,
  OPDS_CREDENTIALS_WARNING,
  mergeSettings,
  normalizeBaseUrl,
  normalizeFolderPath,
} from "./settings";

const srcRoot = fileURLToPath(new URL(".", import.meta.url));

function readSourceFile(name: string): string {
  return readFileSync(join(srcRoot, name), "utf8");
}

function listSourceFiles(root: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relativeName = prefix + entry.name;
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(join(root, entry.name), relativeName + "/"));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(relativeName);
    }
  }
  return files;
}

describe("F1.4 settings defaults", () => {
  it("defaults the folders to Books/ and Reading/", () => {
    expect(DEFAULT_SETTINGS.booksFolder).toBe("Books");
    expect(DEFAULT_SETTINGS.notesFolder).toBe("Reading");
  });

  it("defaults the anchor heading level to H2", () => {
    expect(DEFAULT_SETTINGS.anchorHeadingLevel).toBe(2);
  });

  it("defaults the PDF chapter window to ±10 pages", () => {
    expect(DEFAULT_SETTINGS.pdfChapterWindowPages).toBe(10);
  });

  it("defaults the split ratios to 60/40 (read) and 40/60 (write)", () => {
    expect(DEFAULT_SETTINGS.splitReadRatioPercent).toBe(60);
    expect(DEFAULT_SETTINGS.splitWriteRatioPercent).toBe(40);
  });

  it("defaults focus mode off and leaves Booklore credentials empty", () => {
    expect(DEFAULT_SETTINGS.focusModeDefault).toBe(false);
    expect(DEFAULT_SETTINGS.bookloreBaseUrl).toBe("");
    expect(DEFAULT_SETTINGS.opdsUsername).toBe("");
    expect(DEFAULT_SETTINGS.opdsPassword).toBe("");
  });

  it("defaults the EPUB flow mode to paginated", () => {
    expect(DEFAULT_SETTINGS.epubFlowMode).toBe("paginated");
  });

  it("seeds the note template with the PRD §5.2 frontmatter and placeholders", () => {
    expect(DEFAULT_SETTINGS.noteTemplate).toBe(DEFAULT_NOTE_TEMPLATE);
    expect(DEFAULT_NOTE_TEMPLATE).toMatch(/^---\n/);
    expect(DEFAULT_NOTE_TEMPLATE).toContain("type: book-note");
    expect(DEFAULT_NOTE_TEMPLATE).toContain("{{source}}");
    expect(DEFAULT_NOTE_TEMPLATE).toContain("{{format}}");
    expect(DEFAULT_NOTE_TEMPLATE).toContain("{{title}}");
    expect(DEFAULT_NOTE_TEMPLATE).toContain("{{author}}");
  });
});

describe("F1.4 plaintext-storage warning", () => {
  it("names the plaintext storage and the data.json location", () => {
    expect(OPDS_CREDENTIALS_WARNING).toMatch(/plaintext/i);
    expect(OPDS_CREDENTIALS_WARNING).toMatch(/data\.json/);
  });

  it("is wired into the settings tab and the password field masks input", () => {
    const tabSource = readSourceFile("settingsTab.ts");
    expect(tabSource).toContain("OPDS_CREDENTIALS_WARNING");
    expect(tabSource).toContain('type = "password"');
  });
});

describe("F1.4 data.json persistence (mergeSettings)", () => {
  it("falls back to defaults for missing or malformed stored data", () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings("not-an-object")).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ booksFolder: 42, pdfChapterWindowPages: "ten" })).toEqual(
      DEFAULT_SETTINGS,
    );
  });

  it("round-trips stored settings, including the OPDS password, untouched", () => {
    const stored = {
      ...DEFAULT_SETTINGS,
      booksFolder: "/Library/Books//",
      opdsUsername: "opds-user",
      opdsPassword: "s3cret ",
      bookloreBaseUrl: "https://booklore.example/",
    };
    // Simulate a data.json write + reload.
    const reloaded = mergeSettings(JSON.parse(JSON.stringify(stored)));
    expect(reloaded.booksFolder).toBe("Library/Books");
    expect(reloaded.opdsUsername).toBe("opds-user");
    expect(reloaded.opdsPassword).toBe("s3cret ");
    expect(reloaded.bookloreBaseUrl).toBe("https://booklore.example");
  });

  it("clamps numeric fields into their valid ranges", () => {
    const merged = mergeSettings({
      anchorHeadingLevel: 9,
      pdfChapterWindowPages: 0,
      splitReadRatioPercent: 140,
      splitWriteRatioPercent: -5,
    });
    expect(merged.anchorHeadingLevel).toBe(6);
    expect(merged.pdfChapterWindowPages).toBe(1);
    expect(merged.splitReadRatioPercent).toBe(95);
    expect(merged.splitWriteRatioPercent).toBe(5);
  });

  it("keeps valid values from a partial stored object", () => {
    const merged = mergeSettings({ focusModeDefault: true, noteTemplate: "custom" });
    expect(merged.focusModeDefault).toBe(true);
    expect(merged.noteTemplate).toBe("custom");
    expect(merged.pdfChapterWindowPages).toBe(10);
  });

  it("round-trips a stored EPUB flow mode", () => {
    expect(mergeSettings({ epubFlowMode: "scrolled" }).epubFlowMode).toBe("scrolled");
    expect(mergeSettings({ epubFlowMode: "paginated" }).epubFlowMode).toBe("paginated");
  });

  it("falls back to paginated for flow modes outside the whitelist", () => {
    for (const bad of ["SCROLLED", "paginated ", "scroll", 42, true, null]) {
      expect(mergeSettings({ epubFlowMode: bad }).epubFlowMode).toBe("paginated");
    }
  });

  it("drops unknown keys from stored data", () => {
    const merged = mergeSettings({ unknownKey: 1, focusModeDefault: true });
    expect(merged).toEqual({ ...DEFAULT_SETTINGS, focusModeDefault: true });
  });
});

describe("F1.4 normalization helpers", () => {
  it("normalizes vault folder paths", () => {
    expect(normalizeFolderPath("  /Books//  ")).toBe("Books");
    expect(normalizeFolderPath("Library/Books")).toBe("Library/Books");
    expect(normalizeFolderPath("   ")).toBe("");
  });

  it("normalizes base URLs", () => {
    expect(normalizeBaseUrl(" https://booklore.example/ ")).toBe("https://booklore.example");
    expect(normalizeBaseUrl("")).toBe("");
  });
});

describe("F1.4 secret hygiene", () => {
  const credentialTerms = ["opdsPassword", "opdsUsername"];

  it("never passes credentials to console logging", () => {
    const files = listSourceFiles(srcRoot);
    for (const name of files) {
      const lines = readSourceFile(name).split("\n");
      lines.forEach((line, index) => {
        if (!/\bconsole\.(log|info|warn|error|debug|table)\b/.test(line)) {
          return;
        }
        for (let offset = -2; offset <= 2; offset++) {
          const windowIndex = index + offset;
          if (windowIndex < 0 || windowIndex >= lines.length) {
            continue;
          }
          for (const term of credentialTerms) {
            expect(
              lines[windowIndex],
              `${name}:${windowIndex + 1} logs a credential field within a console call`,
            ).not.toContain(term);
          }
        }
      });
    }
  });
});
