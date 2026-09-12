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
 * - Clipboard writes are awaited and the button flash reflects the write's
 *   actual outcome (✔ on success, ✖ with the reason on reject).
 * - The TOC/selection setup promises no longer go unhandled: a book whose
 *   `loaded.navigation` or `loaded.metadata` rejects reports a readable
 *   error in the viewer instead of leaving the panel silently absent.
 */
import { type Book, type Contents, type Rendition } from "epubjs";
import type Locations from "epubjs/types/locations";
import { type Location } from "epubjs/types/rendition";
import { buildEpubCfiFragment } from "../model/anchor";

export class EpubNavigationTools {
  private tocPanel: HTMLDivElement | null = null;
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
    void this.createTocPanel(viewerEl).catch((error: unknown) =>
      this.reportSetupFailure(viewerEl, "Table of contents", error),
    );
    this.addKeyListeners();
    void this.addSelectionListener(viewerEl).catch((error: unknown) =>
      this.reportSetupFailure(viewerEl, "Selection copying", error),
    );

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

    this.tocPanel = document.createElement("div");
    this.tocPanel.className = "epub-toc-panel";
    viewerEl.appendChild(this.tocPanel);

    for (const item of navigation.toc) {
      const safeHref = this.sanitize(item.href);
      const safeLabel = this.sanitize(item.label);

      const tocLink = document.createElement("div");
      tocLink.className = "epub-toc-link";
      tocLink.dataset.href = safeHref;
      tocLink.dataset.label = safeLabel;

      const labelSpan = document.createElement("span");
      labelSpan.className = "epub-toc-label";
      labelSpan.textContent = safeLabel;

      const copyBtn = document.createElement("button");
      copyBtn.className = "epub-toc-copy";
      copyBtn.title = "Copy link";
      copyBtn.dataset.href = safeHref;
      copyBtn.dataset.label = safeLabel;
      copyBtn.tabIndex = -1;
      copyBtn.textContent = "🔗";
      copyBtn.onclick = (e) => void this.copyTocLink(e, bookTitle, safeHref, safeLabel);
      copyBtn.ariaLabel = `Copy link to ${safeLabel}`;

      tocLink.append(labelSpan, copyBtn);
      tocLink.onclick = () => void this.rendition.display(safeHref);
      this.tocPanel.appendChild(tocLink);
    }

    // Hide the TOC panel when the reader is clicked.
    this.rendition.on("rendered", (_section: unknown, contents: Contents) => {
      contents.document.addEventListener("mousedown", () => {
        this.toggleTocVisibility(false);
      });
    });
  }

  private async copyTocLink(e: Event, bookTitle: string, href: string, label: string): Promise<void> {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(
        `[[${this.bookPath}#${href}|${bookTitle}, ${label}]]`,
      );
    } catch (error) {
      this.flashCopyFailed(btn, error);
      return;
    }
    this.flashCopied(btn);
  }

  private async copyLinkToCFIToClipboard(e: Event, bookTitle: string, cfiRange: string): Promise<void> {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLButtonElement;
    try {
      const location = await this.locationNumber(cfiRange);
      const fragment = buildEpubCfiFragment(cfiRange);
      await navigator.clipboard.writeText(`[[${this.bookPath}${fragment}|${bookTitle}, loc. ${location}]]`);
    } catch (error) {
      this.flashCopyFailed(btn, error);
      return;
    }
    this.flashCopied(btn);
  }

  private async copyQuoteAndLinkToClipboard(
    e: Event,
    bookTitle: string,
    cfiRange: string,
    selection: Selection,
  ): Promise<void> {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLButtonElement;
    try {
      const location = await this.locationNumber(cfiRange);
      const fragment = buildEpubCfiFragment(cfiRange);
      const selectedText = selection ? selection.toString().trim() : "";
      const quote = selectedText ? `> ${selectedText}\n-- ` : "";
      const link = `[[${this.bookPath}${fragment}|${bookTitle}, loc. ${location}]]`;
      await navigator.clipboard.writeText(`${quote}${link}`);
    } catch (error) {
      this.flashCopyFailed(btn, error);
      return;
    }
    this.flashCopied(btn);
  }

  /**
   * A book whose navigation or metadata cannot be loaded degrades
   * visibly: the missing feature reports why, instead of the panel
   * being silently absent and the rejection left to the console.
   */
  private reportSetupFailure(viewerEl: HTMLElement, feature: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const notice = document.createElement("div");
    notice.className = "epub-setup-error";
    notice.textContent = `${feature} unavailable: ${message}`;
    viewerEl.appendChild(notice);
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
   * Visible, readable failure for a copy that did not land: the button
   * the user clicked shows ✖ and the reason on hover, for the same
   * window as the success flash.
   */
  private flashCopyFailed(btn: HTMLButtonElement, error: unknown): void {
    const originalText = btn.textContent;
    const originalTitle = btn.title;
    const message = error instanceof Error ? error.message : String(error);
    btn.textContent = "✖";
    btn.title = `Copy failed: ${message}`;
    setTimeout(() => {
      btn.textContent = originalText;
      btn.title = originalTitle;
    }, 1000);
  }

  /** Ultra-basic sanitization for hrefs/labels that land in link text. */
  private sanitize(str: string): string {
    return str.replace(/[^\x20-\x7E]+/g, "").trim();
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
