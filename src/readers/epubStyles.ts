/**
 * Loads EPUB-owned styles without asking Obsidian's iframe CSP to fetch a
 * blob: stylesheet. Asset URLs inside the CSS still use epub.js's normal
 * replacement table, so images and embedded fonts keep their working URLs.
 */

const ORIGINAL_HREF_ATTRIBUTE = "data-observation-car-stylesheet-href";
const ARCHIVE_ORIGIN = "https://observation-car.invalid";

type EpubStylesHookHandler = (...args: never[]) => unknown;

export interface EpubStylesHook {
  register(handler: EpubStylesHookHandler): void;
  deregister(handler: EpubStylesHookHandler): void;
}

export interface EpubStylesSection {
  url: string;
}

export interface EpubStylesContents {
  document: Document;
  sectionIndex: number;
  addStylesheetCss(css: string, key: string): boolean | Promise<boolean>;
}

export interface EpubStylesBook {
  archive: {
    getText(path: string): Promise<string>;
  };
  resources: {
    substitute(css: string, path: string): string;
  };
  spine: {
    get(index: number): EpubStylesSection;
    hooks: {
      content: EpubStylesHook;
    };
  };
}

export interface EpubStylesRendition {
  hooks: {
    content: EpubStylesHook;
  };
}

function stylesheetLinks(document: Document): HTMLLinkElement[] {
  return [...document.querySelectorAll<HTMLLinkElement>("link[rel~='stylesheet']")];
}

function resolveArchivePath(sectionPath: string, stylesheetHref: string): string | null {
  try {
    const sectionUrl = new URL(sectionPath, `${ARCHIVE_ORIGIN}/`);
    const stylesheetUrl = new URL(stylesheetHref, sectionUrl);
    if (stylesheetUrl.origin !== ARCHIVE_ORIGIN) {
      return null;
    }
    return stylesheetUrl.pathname;
  } catch {
    return null;
  }
}

function stylesheetKey(path: string): string {
  return `observation-car-book-${encodeURIComponent(path)}`;
}

export class EpubStyles {
  private destroyed = false;

  /**
   * Runs before epub.js serializes the section into srcdoc. Moving href to
   * inert data prevents Chromium from seeing the blob: link before the later
   * rendition content hook has a chance to inline it.
   */
  private readonly preserveStylesheetHrefs = (document: Document): void => {
    if (this.destroyed) {
      return;
    }
    for (const link of stylesheetLinks(document)) {
      const originalHref =
        link.getAttribute(ORIGINAL_HREF_ATTRIBUTE) ?? link.getAttribute("href");
      if (originalHref === null) {
        continue;
      }
      link.setAttribute(ORIGINAL_HREF_ATTRIBUTE, originalHref);
      link.removeAttribute("href");
    }
  };

  private readonly inlineStylesheets = async (
    contents: EpubStylesContents,
  ): Promise<void> => {
    if (this.destroyed) {
      return;
    }
    const section = this.book.spine.get(contents.sectionIndex);
    const injectedPaths = new Set<string>();

    for (const link of stylesheetLinks(contents.document)) {
      const href =
        link.getAttribute(ORIGINAL_HREF_ATTRIBUTE) ?? link.getAttribute("href");
      if (href === null) {
        continue;
      }
      const archivePath = resolveArchivePath(section.url, href);
      if (archivePath === null) {
        continue;
      }
      if (injectedPaths.has(archivePath)) {
        link.remove();
        continue;
      }

      try {
        const css = await this.book.archive.getText(archivePath);
        if (this.destroyed) {
          return;
        }
        const replacedCss = this.book.resources.substitute(css, archivePath);
        await contents.addStylesheetCss(replacedCss, stylesheetKey(archivePath));
        if (this.destroyed) {
          return;
        }
        injectedPaths.add(archivePath);
        link.remove();
      } catch (error) {
        console.error(`Failed to inline EPUB stylesheet: ${archivePath}`, error);
      }
    }
  };

  constructor(
    private readonly book: EpubStylesBook,
    private readonly rendition: EpubStylesRendition,
  ) {
    this.book.spine.hooks.content.register(this.preserveStylesheetHrefs);
    this.rendition.hooks.content.register(this.inlineStylesheets);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.book.spine.hooks.content.deregister(this.preserveStylesheetHrefs);
    this.rendition.hooks.content.deregister(this.inlineStylesheets);
  }
}
