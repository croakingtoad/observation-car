// @vitest-environment jsdom

import type { Rendition } from "epubjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EpubFontSizeStepper } from "./epubNavigationTools";
import { EpubThemes } from "./epubThemes";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("EpubThemes", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
  });

  it("applies Obsidian font and colour variables in light and dark themes", async () => {
    const register = vi.fn();
    const select = vi.fn();
    const rendition = { themes: { register, select } } as unknown as Rendition;
    const css = document.body.style;
    css.setProperty("--background-primary", "#fafafa");
    css.setProperty("--text-normal", "#202020");
    css.setProperty("--link-color", "#315efb");
    css.setProperty("--font-text", "Inter, sans-serif");

    const themes = new EpubThemes(rendition);

    expect(register).toHaveBeenLastCalledWith("obsidian", {
      body: {
        background: "#fafafa !important",
        color: "#202020 !important",
        "font-family": "Inter, sans-serif !important",
      },
      a: { color: "#315efb !important" },
    });
    expect(select).toHaveBeenLastCalledWith("obsidian");

    css.setProperty("--background-primary", "#171717");
    css.setProperty("--text-normal", "#dcddde");
    css.setProperty("--link-color", "#7f9cff");
    document.body.classList.add("theme-dark");

    await vi.waitFor(() => {
      expect(register).toHaveBeenLastCalledWith("obsidian", {
        body: {
          background: "#171717 !important",
          color: "#dcddde !important",
          "font-family": "Inter, sans-serif !important",
        },
        a: { color: "#7f9cff !important" },
      });
    });
    themes.destroy();
  });
});

describe("EpubFontSizeStepper", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("changes font size with accessible toolbar buttons and persists it per book", () => {
    const override = vi.fn();
    const rendition = { themes: { override } } as unknown as Rendition;
    const viewer = document.createElement("div");
    new EpubFontSizeStepper(viewer, "Library/Dune.epub", rendition);

    expect(override).toHaveBeenLastCalledWith("font-size", "100%", true);
    const increase = viewer.querySelector<HTMLButtonElement>(".epub-font-size-increase");
    const decrease = viewer.querySelector<HTMLButtonElement>(".epub-font-size-decrease");
    const value = viewer.querySelector<HTMLOutputElement>(".epub-font-size-value");
    expect(increase?.ariaLabel).toBe("Increase reader font size");
    expect(decrease?.ariaLabel).toBe("Decrease reader font size");

    increase?.click();
    increase?.click();

    expect(override).toHaveBeenLastCalledWith("font-size", "120%", true);
    expect(value?.value).toBe("120%");

    const secondOverride = vi.fn();
    new EpubFontSizeStepper(
      document.createElement("div"),
      "Library/Dune.epub",
      { themes: { override: secondOverride } } as unknown as Rendition,
    );
    expect(secondOverride).toHaveBeenLastCalledWith("font-size", "120%", true);

    const otherBookOverride = vi.fn();
    new EpubFontSizeStepper(
      document.createElement("div"),
      "Library/Kindred.epub",
      { themes: { override: otherBookOverride } } as unknown as Rendition,
    );
    expect(otherBookOverride).toHaveBeenLastCalledWith("font-size", "100%", true);
  });

  it("stops at the supported minimum and maximum", () => {
    const rendition = { themes: { override: vi.fn() } } as unknown as Rendition;
    const viewer = document.createElement("div");
    new EpubFontSizeStepper(viewer, "book.epub", rendition);
    const increase = viewer.querySelector<HTMLButtonElement>(".epub-font-size-increase");
    const decrease = viewer.querySelector<HTMLButtonElement>(".epub-font-size-decrease");

    for (let index = 0; index < 10; index += 1) {
      increase?.click();
    }
    expect(increase?.disabled).toBe(true);

    for (let index = 0; index < 20; index += 1) {
      decrease?.click();
    }
    expect(decrease?.disabled).toBe(true);
  });
});
