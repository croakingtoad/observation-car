/**
 * Loads EPUB-owned styles without asking Obsidian's iframe CSP to fetch a
 * blob: stylesheet. Asset URLs inside the CSS still use epub.js's normal
 * replacement table, so images and embedded fonts keep their working URLs.
 */

const HREF_INDEX_ATTRIBUTE = "data-observation-car-stylesheet-index";
const ARCHIVE_ORIGIN = "https://observation-car.invalid";

type EpubStylesHookHandler = (...args: never[]) => unknown;

export interface EpubStylesHook {
  register(handler: EpubStylesHookHandler): void;
  deregister(handler: EpubStylesHookHandler): void;
}

export interface EpubStylesSection {
  index: number;
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

function resolveArchivePath(
  sectionPath: string,
  stylesheetHref: string,
): string | null {
  const sectionUrl = new URL(sectionPath, `${ARCHIVE_ORIGIN}/`);
  const stylesheetUrl = new URL(stylesheetHref, sectionUrl);
  if (stylesheetUrl.origin !== ARCHIVE_ORIGIN) {
    return null;
  }
  return stylesheetUrl.pathname;
}

function stylesheetKey(path: string): string {
  return `observation-car-book-${encodeURIComponent(path)}`;
}

export class EpubStyles {
  private destroyed = false;
  private readonly stylesheetHrefsBySection = new Map<
    number,
    ReadonlyMap<number, string>
  >();

  /**
   * Runs before epub.js serializes the section into srcdoc. Original hrefs
   * stay outside that serialized string because epub.js replaces matching
   * resource paths globally, including values in data attributes.
   */
  private readonly preserveStylesheetHrefs = (
    document: Document,
    section: EpubStylesSection,
  ): void => {
    if (this.destroyed) {
      return;
    }
    const existingHrefs = this.stylesheetHrefsBySection.get(section.index);
    const hrefs = new Map<number, string>();
    for (const [index, link] of stylesheetLinks(document).entries()) {
      const originalHref = link.getAttribute("href") ?? existingHrefs?.get(index);
      if (originalHref === null) {
        continue;
      }
      if (originalHref === undefined) {
        continue;
      }
      hrefs.set(index, originalHref);
      link.setAttribute(HREF_INDEX_ATTRIBUTE, String(index));
      link.removeAttribute("href");
    }
    this.stylesheetHrefsBySection.set(section.index, hrefs);
  };

  private readonly inlineStylesheets = async (
    contents: EpubStylesContents,
  ): Promise<void> => {
    if (this.destroyed) {
      return;
    }
    const section = this.book.spine.get(contents.sectionIndex);
    const sectionHrefs = this.stylesheetHrefsBySection.get(section.index);
    const injectedPaths = new Set<string>();

    for (const link of stylesheetLinks(contents.document)) {
      const rawIndex = link.getAttribute(HREF_INDEX_ATTRIBUTE);
      const index = rawIndex === null ? Number.NaN : Number(rawIndex);
      const href =
        (Number.isInteger(index) && index >= 0
          ? sectionHrefs?.get(index)
          : undefined) ?? link.getAttribute("href");
      if (href === null || href === undefined) {
        console.error(
          `Failed to inline EPUB stylesheet in section ${section.url}: missing original href for ${rawIndex ?? "untagged link"}`,
        );
        continue;
      }

      let archivePath: string | null;
      try {
        archivePath = resolveArchivePath(section.url, href);
      } catch (error) {
        console.error(
          `Failed to resolve EPUB stylesheet in section ${section.url}: ${href}`,
          error,
        );
        continue;
      }
      if (archivePath === null) {
        console.error(
          `Failed to resolve EPUB stylesheet in section ${section.url}: ${href}`,
        );
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
    this.stylesheetHrefsBySection.clear();
    this.book.spine.hooks.content.deregister(this.preserveStylesheetHrefs);
    this.rendition.hooks.content.deregister(this.inlineStylesheets);
  }
}
