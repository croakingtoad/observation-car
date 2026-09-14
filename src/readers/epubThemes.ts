/**
 * Theme glue for the EPUB view (F2.1, PRD §6 E002).
 *
 * Forked from `src/epub-themes.ts` in vinceRV/obsidian-epub-reader (MIT)
 * at commit 67e5edbfee12cb09ba3c7216442d251196ff806f — see
 * `VENDOR_NOTICE.md`. The view's iframe re-styles from Obsidian CSS
 * custom properties whenever the app theme class changes.
 *
 * One fix over upstream: `destroy()` — upstream's MutationObserver on
 * `document.body` outlived the view, so a theme toggle after closing the
 * reader kept re-styling a destroyed rendition.
 */
import { type Rendition } from "epubjs";

export class EpubThemes {
  private readonly rendition: Rendition;
  private readonly observer: MutationObserver;

  constructor(rendition: Rendition) {
    this.rendition = rendition;
    this.observer = new MutationObserver(() => {
      this.applyTheme();
    });
    this.observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    this.applyTheme();
  }

  /** Release the observer; call when the reader is disposed. */
  destroy(): void {
    this.observer.disconnect();
  }

  private applyTheme(): void {
    const bgColor = this.getCssVar("--background-primary", "#fff");
    const fgColor = this.getCssVar("--text-normal", "#222");
    const linkColor = this.getCssVar("--link-color", "#0077cc");
    const fontFamily = this.getCssVar("--font-text", "sans-serif");

    this.registerTheme("obsidian", bgColor, fgColor, linkColor, fontFamily);
    this.rendition.themes.select("obsidian");
  }

  private registerTheme(
    name: string,
    bg: string,
    fg: string,
    link: string,
    font: string,
  ): void {
    this.rendition.themes.register(name, {
      body: {
        background: bg,
        color: fg,
        "font-family": font,
      },
      a: {
        color: link,
      },
    });
  }

  private getCssVar(name: string, fallback: string): string {
    const value = getComputedStyle(document.body).getPropertyValue(name).trim();
    return `${value || fallback} !important`;
  }
}
