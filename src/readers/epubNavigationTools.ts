/**
 * On-screen navigation glue for the EPUB view (F2.1, PRD §6 E002).
 *
 * Forked from `src/epub-navigation-tools.ts` in
 * vinceRV/obsidian-epub-reader (MIT) at commit
 * 67e5edbfee12cb09ba3c7216442d251196ff806f — see `VENDOR_NOTICE.md`.
 *
 * Adaptations over upstream:
 * - Copied links use the project's anchor grammar (F1.3): `#epubcfi(...)`
 *   for CFI positions and `#<href>` for spine items, replacing upstream's
 *   `#cfi=` / `#href=` parameters.
 * - The location table (`book.locations.generate`, seconds-scale) is
 *   produced on first copy instead of eagerly in the constructor, keeping
 *   it out of the open path (PRD §7 open budget).
 * - `navigateToLocation` (the entry point of upstream's `openLinkText`
 *   patch) and the highlight state it owned are dropped; F2.7/F2.9
 *   re-add navigation through the Reader contract's `openAtFragment`.
 * - `hasFocus` is dropped: its only caller was an upstream view hook that
 *   nothing in Obsidian invokes; the relocated/resized correction below
 *   still carries the pane-resize recovery.
 * - The TOC drawer (F2.3) renders the full nested TOC with depth indent,
 *   passes labels and hrefs through without character stripping, handles
 *   `rendition.display()` rejections, and supports keyboard focus,
 *   Enter/Space activation, and Escape to close.
 */
import { type Book, type Contents, type Rendition } from "epubjs";
import type Locations from "epubjs/types/locations";
import { type Location } from "epubjs/types/rendition";
import type { NavItem } from "epubjs/types/navigation";
import { buildEpubCfiFragment } from "../model/anchor";

/** A single flattened TOC entry with its depth in the source tree. */
export interface TocEntry {
  href: string;
  label: string;
  depth: number;
}

/**
 * Flatten a nested EPUB navigation TOC into a single list, preserving
 * document order and recording each entry's depth for indentation.
 *
 * Labels and hrefs are returned exactly as epub.js provides them - no
 * character stripping - so callers can normalize labels for display and
 * pass hrefs straight to `rendition.display()`.
 */
export function flattenToc(items: readonly NavItem[], depth = 0): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const item of items) {
    entries.push({ href: item.href, label: item.label, depth });
    if (item.subitems !== undefined && item.subitems.length > 0) {
      entries.push(...flattenToc(item.subitems, depth + 1));
    }
  }
  return entries;
}

export class EpubNavigationTools {
  private tocPanel: HTMLDivElement | null = null;
  private tocButton: HTMLButtonElement | null = null;
  private isTocOpen = false;
  private readonly copyPanel: HTMLDivElement;
  private locations: Promise<Locations> | null = null;
  private currentLocation: Location | null = null;
  private needsCorrection = false;

  constructor(
    viewerEl: HTMLElement,
    private readonly bookPath: string,
    private readonly book: Book,
    private readonly rendition: Rendition,
  ) {
    this.copyPanel = this.createCopyPanel(viewerEl);
    this.createNavigationButton(viewerEl, "epub-nav-prev", "❮", () => this.rendition.prev());
    this.createNavigationButton(viewerEl, "epub-nav-next", "❯", () => this.rendition.next());
    void this.createTocPanel(viewerEl);
    this.addKeyListeners();
    void this.addSelectionListener(viewerEl);

    // Pane/layout changes make epub.js reflow and report a fresh
    // location; re-display the one we had so the page does not jump.
    this.rendition.on("relocated", (loc: Location) => {
      if (this.needsCorrection) {
        this.needsCorrection = false;
        void this.rendition.display(this.currentLocation?.start.cfi);
      } else {
        this.currentLocation = loc;
      }
    });
    this.rendition.on("resized", () => {
      this.needsCorrection = true;
    });
  }

  private addKeyListeners(): void {
    this.rendition.on("rendered", (_section: unknown, contents: Contents) => {
      contents.document.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "ArrowLeft") {
          void this.rendition.prev();
          event.preventDefault();
        } else if (event.key === "ArrowRight") {
          void this.rendition.next();
          event.preventDefault();
        } else if (event.key === "PageUp" || event.key === "PageDown") {
          void this.pageKeyJump(event.key);
          event.preventDefault();
        }
      });

      // Keep focus on the iframe so page keys keep working.
      (contents.document.body as HTMLElement).setAttribute("tabindex", "0");
      (contents.document.body as HTMLElement).focus();
    });
  }

  /** Chapter-level jump: PageUp = next chapter, PageDown = previous. */
  private async pageKeyJump(key: string): Promise<void> {
    const toc = await this.book.loaded.navigation;
    const currentHref = this.rendition.location?.start?.href;
    const tocItems = toc.toc;
    const idx = tocItems.findIndex((item) => this.sanitize(item.href) === this.sanitize(currentHref ?? ""));
    let targetIdx = -1;
    if (key === "PageUp" && idx < tocItems.length - 1) {
      targetIdx = idx + 1;
    } else if (key === "PageDown" && idx > 0) {
      targetIdx = idx - 1;
    }
    if (targetIdx !== -1) {
      await this.rendition.display(this.sanitize(tocItems[targetIdx].href));
    }
  }

  private async addSelectionListener(viewerEl: HTMLElement): Promise<void> {
    const metadata = await this.book.loaded.metadata;
    const title = metadata.title;

    this.rendition.on("selected", (cfiRange: string, contents: Contents) => {
      if (cfiRange.length === 0) {
        return;
      }
      const selection = contents.window.getSelection();
      if (selection === null || selection.rangeCount === 0) {
        return;
      }

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const iframeRect = contents.document.defaultView?.frameElement?.getBoundingClientRect();
      const viewerRect = viewerEl.getBoundingClientRect();
      let left: number;
      let top: number;

      if (iframeRect) {
        left = rect.left + iframeRect.left - viewerRect.left;
        top = rect.bottom + iframeRect.top - viewerRect.top + 2;
      } else {
        left = rect.left - viewerRect.left;
        top = rect.bottom - viewerRect.top + 2;
      }
      this.copyPanel.style.left = `${left}px`;
      this.copyPanel.style.top = `${top}px`;

      this.setCopyHandler(".epub-cfi-copy", (e) =>
        void this.copyLinkToCFIToClipboard(e, title, cfiRange),
      );
      this.setCopyHandler(".epub-cfi-quote", (e) =>
        void this.copyQuoteAndLinkToClipboard(e, title, cfiRange, selection),
      );
      this.copyPanel.classList.add("open");
    });
  }

  private createCopyPanel(viewerEl: HTMLElement): HTMLDivElement {
    const copyPanel = document.createElement("div");
    copyPanel.className = "epub-cfi-popup";
    this.createCopyButton(copyPanel, "epub-cfi-copy", "Copy link to this location", "🗎");
    this.createCopyButton(copyPanel, "epub-cfi-quote", "Copy quote and link to this location", "❝");
    viewerEl.appendChild(copyPanel);
    return copyPanel;
  }

  private createNavigationButton(
    viewerEl: HTMLElement,
    className: string,
    text: string,
    handler: () => Promise<void>,
  ): void {
    const btn = document.createElement("button");
    btn.className = `epub-button epub-nav-btn ${className}`;
    btn.textContent = text;
    btn.onclick = (e) => {
      e.stopPropagation();
      this.toggleTocVisibility(false);
      void handler();
    };
    viewerEl.append(btn);
  }

  private async createTocPanel(viewerEl: HTMLElement): Promise<void> {
    const [navigation, metadata] = await Promise.all([
      this.book.loaded.navigation,
      this.book.loaded.metadata,
    ]);
    const bookTitle = metadata.title;

    const tocButton = document.createElement("button");
    tocButton.className = "epub-button epub-toc-button";
    tocButton.title = "Show Table of Contents";
    tocButton.textContent = "☰";
    tocButton.onclick = () => this.toggleTocVisibility();
    viewerEl.appendChild(tocButton);
    this.tocButton = tocButton;

    this.tocPanel = document.createElement("div");
    this.tocPanel.className = "epub-toc-panel";
    this.tocPanel.setAttribute("role", "navigation");
    this.tocPanel.setAttribute("aria-label", "Table of contents");
    viewerEl.appendChild(this.tocPanel);

    for (const entry of flattenToc(navigation.toc)) {
      this.tocPanel.appendChild(this.createTocRow(entry, bookTitle));
    }

    // Escape closes the drawer while it is open and returns focus to the
    // toggle so keyboard users are not left on an off-screen element.
    viewerEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape" && this.isTocOpen) {
        event.preventDefault();
        event.stopPropagation();
        this.toggleTocVisibility(false);
        this.tocButton?.focus();
      }
    });

    // Hide the TOC panel when the reader is clicked.
    this.rendition.on("rendered", (_section: unknown, contents: Contents) => {
      contents.document.addEventListener("mousedown", () => {
        this.toggleTocVisibility(false);
      });
    });
  }

  /** Build one TOC row (label + copy button) for a flattened entry. */
  private createTocRow(entry: TocEntry, bookTitle: string): HTMLDivElement {
    const label = this.sanitize(entry.label);
    const href = entry.href;

    const row = document.createElement("div");
    row.className = "epub-toc-link";
    row.dataset.href = href;
    row.dataset.label = label;
    row.style.setProperty("--toc-depth", String(entry.depth));
    row.onclick = () => void this.jumpToEntry(entry);

    const labelSpan = document.createElement("span");
    labelSpan.className = "epub-toc-label";
    labelSpan.textContent = label;
    labelSpan.setAttribute("role", "link");
    labelSpan.tabIndex = 0;
    labelSpan.setAttribute("aria-label", label);
    labelSpan.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void this.jumpToEntry(entry);
      }
    });

    const copyBtn = document.createElement("button");
    copyBtn.className = "epub-toc-copy";
    copyBtn.title = "Copy link";
    copyBtn.dataset.href = href;
    copyBtn.dataset.label = label;
    copyBtn.tabIndex = -1;
    copyBtn.textContent = "🔗";
    copyBtn.onclick = (e) => this.copyTocLink(e, bookTitle, href, label);
    copyBtn.ariaLabel = `Copy link to ${label}`;

    row.append(labelSpan, copyBtn);
    return row;
  }

  /**
   * Jump to a TOC entry. The drawer closes only after `rendition.display()`
   * resolves; a rejection is surfaced (never left unhandled) and the drawer
   * stays open so the user can retry.
   */
  private async jumpToEntry(entry: TocEntry): Promise<void> {
    try {
      await this.rendition.display(entry.href);
      this.toggleTocVisibility(false);
    } catch (error) {
      console.warn(`[Observation Car] Could not open TOC entry "${entry.label}":`, error);
    }
  }

  private copyTocLink(e: Event, bookTitle: string, href: string, label: string): void {
    e.stopPropagation();
    void navigator.clipboard.writeText(
      `[[${this.bookPath}#${href}|${bookTitle}, ${label}]]`,
    );
    this.flashCopied(e.currentTarget as HTMLButtonElement);
  }

  private async copyLinkToCFIToClipboard(e: Event, bookTitle: string, cfiRange: string): Promise<void> {
    e.stopPropagation();
    const location = await this.locationNumber(cfiRange);
    const fragment = buildEpubCfiFragment(cfiRange);
    void navigator.clipboard.writeText(`[[${this.bookPath}${fragment}|${bookTitle}, loc. ${location}]]`);
    this.flashCopied(e.currentTarget as HTMLButtonElement);
  }

  private async copyQuoteAndLinkToClipboard(
    e: Event,
    bookTitle: string,
    cfiRange: string,
    selection: Selection,
  ): Promise<void> {
    e.stopPropagation();
    const location = await this.locationNumber(cfiRange);
    const fragment = buildEpubCfiFragment(cfiRange);
    const selectedText = selection ? selection.toString().trim() : "";
    const quote = selectedText ? `> ${selectedText}\n-- ` : "";
    const link = `[[${this.bookPath}${fragment}|${bookTitle}, loc. ${location}]]`;
    void navigator.clipboard.writeText(`${quote}${link}`);
    this.flashCopied(e.currentTarget as HTMLButtonElement);
  }

  /**
   * Location ordinal for copied-link labels. The table is generated on
   * first use — that first call pays the seconds-scale cost, later
   * calls are O(1).
   */
  private async locationNumber(cfi: string): Promise<number> {
    const locations = await this.ensureLocations();
    // The 0.3.93 .d.ts types this as the DOM global `Location` (the
    // symbol is never imported in that file); at runtime it returns the
    // integer location index.
    return locations.locationFromCfi(cfi) as unknown as number;
  }

  private ensureLocations(): Promise<Locations> {
    if (this.locations === null) {
      this.locations = (async () => {
        await this.book.ready;
        await this.book.locations.generate(1000);
        return this.book.locations;
      })();
    }
    return this.locations;
  }

  private createCopyButton(copyPanel: HTMLDivElement, className: string, title: string, icon: string): void {
    const btn = document.createElement("button");
    btn.className = `epub-button epub-cfi-popup-btn ${className}`;
    btn.title = title;
    btn.textContent = icon;
    copyPanel.appendChild(btn);
  }

  private flashCopied(btn: HTMLButtonElement): void {
    const original = btn.textContent;
    btn.textContent = "✔";
    setTimeout(() => {
      btn.textContent = original;
    }, 1000);
  }

  /**
   * Collapse consecutive whitespace and trim. Preserves accents and non-Latin
   * scripts, so it is safe for display labels. Hrefs are never stripped - they
   * are passed to `rendition.display()` exactly as epub.js provides them.
   */
  private sanitize(str: string): string {
    return str.replace(/\s+/g, " ").trim();
  }

  private setCopyHandler(className: string, handler: (e: Event) => void): void {
    const copyBtn = this.copyPanel.querySelector(className) as HTMLButtonElement;
    copyBtn.onclick = handler;
  }

  private toggleTocVisibility(show?: boolean): void {
    if (this.tocPanel === null) {
      return;
    }
    const shouldShow = show !== undefined ? show : !this.isTocOpen;
    this.tocPanel.classList.toggle("open", shouldShow);
    this.copyPanel.classList.toggle("open", false);
    this.isTocOpen = shouldShow;
  }
}
