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
 */
import { type Book, type Contents, type Rendition } from "epubjs";
import type Locations from "epubjs/types/locations";
import { type Location } from "epubjs/types/rendition";
import { buildEpubCfiFragment } from "../model/anchor";

type RenderedContents = Pick<Contents, "document">;
type RenderedHandler = (
  section: unknown,
  contents: RenderedContents,
) => void;

export interface EpubKeyBridgeRendition {
  on(event: "rendered", handler: RenderedHandler): unknown;
  off(event: "rendered", handler: RenderedHandler): unknown;
  prev(): Promise<void>;
  next(): Promise<void>;
}

const forwardedKeyEvents = new WeakSet<KeyboardEvent>();

function hasClosest(
  target: EventTarget | null,
): target is EventTarget & { closest(selectors: string): Element | null } {
  return target !== null && "closest" in target && typeof target.closest === "function";
}

/**
 * Relays keys out of epub.js's iframe while retaining reader-owned paging.
 * The original iframe event keeps its default unless the host handles and
 * cancels the relay, so browser-native actions such as copy run only once.
 */
export class EpubKeyBridge {
  private readonly documents = new Set<Document>();
  private destroyed = false;

  private readonly onRendered: RenderedHandler = (_section, contents) => {
    if (this.destroyed) {
      return;
    }
    contents.document.addEventListener("keydown", this.onKeyDown);
    this.documents.add(contents.document);

    // Keep focus on the iframe so page keys keep working.
    contents.document.body?.setAttribute("tabindex", "0");
    contents.document.body?.focus();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.destroyed || forwardedKeyEvents.has(event)) {
      return;
    }
    if (event.key === "ArrowLeft") {
      void this.rendition.prev();
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowRight") {
      void this.rendition.next();
      event.preventDefault();
      return;
    }
    if (event.key === "PageUp" || event.key === "PageDown") {
      void this.pageKeyJump(event.key);
      event.preventDefault();
      return;
    }

    // Keep browser-native interactions in the iframe. In particular, copy
    // must operate on the book selection rather than also invoking a host
    // binding for the same gesture.
    const isCopy =
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === "c";
    const isInteractiveTarget =
      hasClosest(event.target) &&
      event.target.closest(
        "a, button, input, textarea, select, [contenteditable]:not([contenteditable='false'])",
      ) !== null;

    // Scripted EPUB content can deliberately consume a key before it reaches
    // the document. Do not also fire an Obsidian hotkey in that case.
    if (isCopy || isInteractiveTarget || event.defaultPrevented) {
      return;
    }
    this.beforeForward();
    this.forwardToHost(event);
  };

  constructor(
    private readonly rendition: EpubKeyBridgeRendition,
    private readonly hostDocument: Document,
    private readonly pageKeyJump: (
      key: "PageUp" | "PageDown",
    ) => void | Promise<void>,
    private readonly beforeForward: () => void = () => undefined,
  ) {
    this.rendition.on("rendered", this.onRendered);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.rendition.off("rendered", this.onRendered);
    for (const document of this.documents) {
      document.removeEventListener("keydown", this.onKeyDown);
    }
    this.documents.clear();
  }

  private forwardToHost(event: KeyboardEvent): void {
    const KeyboardEventConstructor = this.hostDocument.defaultView?.KeyboardEvent;
    if (KeyboardEventConstructor === undefined) {
      return;
    }
    const forwarded = new KeyboardEventConstructor(event.type, {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      repeat: event.repeat,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
    });
    // KeyboardEventInit omits this legacy field, but Obsidian and user
    // hotkeys can still inspect it.
    Object.defineProperty(forwarded, "keyCode", { value: event.keyCode });
    forwardedKeyEvents.add(forwarded);

    if (!this.hostDocument.dispatchEvent(forwarded)) {
      event.preventDefault();
    }
  }
}

export class EpubNavigationTools {
  private tocPanel: HTMLDivElement | null = null;
  private isTocOpen = false;
  private readonly copyPanel: HTMLDivElement;
  private locations: Promise<Locations> | null = null;
  private currentLocation: Location | null = null;
  private needsCorrection = false;
  private destroyed = false;
  private readonly keyBridge: EpubKeyBridge;
  private readonly renderedDocuments = new Set<Document>();
  private readonly bookTitle: Promise<string>;

  private readonly onRelocated = (loc: Location): void => {
    if (this.needsCorrection) {
      this.needsCorrection = false;
      void this.rendition.display(this.currentLocation?.start.cfi);
    } else {
      this.currentLocation = loc;
    }
  };

  private readonly onResized = (): void => {
    this.needsCorrection = true;
  };

  private readonly onRendered = (_section: unknown, contents: Contents): void => {
    if (this.destroyed) {
      return;
    }
    contents.document.addEventListener("mousedown", this.onDocumentMouseDown);
    this.renderedDocuments.add(contents.document);
  };

  private readonly onDocumentMouseDown = (): void => {
    this.toggleTocVisibility(false);
  };

  private readonly onSelected = (cfiRange: string, contents: Contents): void => {
    void this.showSelection(cfiRange, contents);
  };

  constructor(
    private readonly viewerEl: HTMLElement,
    private readonly bookPath: string,
    private readonly book: Book,
    private readonly rendition: Rendition,
    activateView: () => void,
  ) {
    this.bookTitle = this.book.loaded.metadata.then((metadata) => metadata.title);
    this.copyPanel = this.createCopyPanel(this.viewerEl);
    this.createNavigationButton(this.viewerEl, "epub-nav-prev", "❮", () => this.rendition.prev());
    this.createNavigationButton(this.viewerEl, "epub-nav-next", "❯", () => this.rendition.next());
    void this.createTocPanel(this.viewerEl);
    this.keyBridge = new EpubKeyBridge(
      this.rendition,
      this.viewerEl.ownerDocument,
      (key) => this.pageKeyJump(key),
      activateView,
    );

    // Pane/layout changes make epub.js reflow and report a fresh
    // location; re-display the one we had so the page does not jump.
    this.rendition.on("relocated", this.onRelocated);
    this.rendition.on("resized", this.onResized);
    this.rendition.on("rendered", this.onRendered);
    this.rendition.on("selected", this.onSelected);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.keyBridge.destroy();
    this.rendition.off("relocated", this.onRelocated);
    this.rendition.off("resized", this.onResized);
    this.rendition.off("rendered", this.onRendered);
    this.rendition.off("selected", this.onSelected);
    for (const document of this.renderedDocuments) {
      document.removeEventListener("mousedown", this.onDocumentMouseDown);
    }
    this.renderedDocuments.clear();
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

  private async showSelection(cfiRange: string, contents: Contents): Promise<void> {
    if (cfiRange.length === 0) {
      return;
    }
    const selection = contents.window.getSelection();
    if (selection === null || selection.rangeCount === 0) {
      return;
    }
    const title = await this.bookTitle;
    if (this.destroyed) {
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const iframeRect = contents.document.defaultView?.frameElement?.getBoundingClientRect();
    const viewerRect = this.viewerEl.getBoundingClientRect();
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
    if (this.destroyed) {
      return;
    }
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
      copyBtn.onclick = (e) => this.copyTocLink(e, bookTitle, safeHref, safeLabel);
      copyBtn.ariaLabel = `Copy link to ${safeLabel}`;

      tocLink.append(labelSpan, copyBtn);
      tocLink.onclick = () => void this.rendition.display(safeHref);
      this.tocPanel.appendChild(tocLink);
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
