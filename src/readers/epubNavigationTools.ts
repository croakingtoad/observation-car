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
import type { EpubFlowMode } from "../settings";
import { TAP_SLOP_PX, decidePagingAction } from "./pagingGestures";

/**
 * F2.2 — flow-mode controls handed in by the view. The button shows the
 * reader's current mode; `onToggle` persists the other mode and re-renders
 * through the view's existing render path.
 */
export interface EpubFlowControls {
  /** Flow mode the current rendition was rendered with. */
  readonly mode: EpubFlowMode;
  /** Switch the reader to the other flow mode. */
  readonly onToggle: () => void;
}

/** A press in progress inside the rendered document (F2.2). */
interface PointerPress {
  startX: number;
  startY: number;
  /** pointerdown timeStamp, in the document's own time origin. */
  startStamp: number;
  /** Farthest the pointer has moved from the start, in px. */
  distance: number;
}

/** Attach F2.2 pointer paging to one rendered EPUB document. */
export function addPagingListeners(
  doc: Document,
  mode: EpubFlowMode,
  page: (direction: "prev" | "next") => void,
): void {
  // Scrolled mode is vertical: tap zones and horizontal swipe are inert,
  // so it needs neither pointer listeners nor a touch-action override.
  if (mode !== "paginated") {
    return;
  }

  // Keep native vertical pan while handing horizontal gestures to the
  // pointer handlers below.
  doc.documentElement.style.touchAction = "pan-y";

  let press: PointerPress | null = null;

  doc.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.button !== 0) {
      return; // primary button only; touch and pen report 0 too
    }
    press = {
      startX: event.clientX,
      startY: event.clientY,
      startStamp: event.timeStamp,
      distance: 0,
    };
  });

  doc.addEventListener("pointermove", (event: PointerEvent) => {
    if (press === null) {
      return;
    }
    const travelled = Math.hypot(event.clientX - press.startX, event.clientY - press.startY);
    if (travelled > press.distance) {
      press.distance = travelled;
    }
  });

  // A native pan or scroll cancels the press; it must not page.
  doc.addEventListener("pointercancel", () => {
    press = null;
  });

  doc.addEventListener("pointerup", (event: PointerEvent) => {
    if (press === null) {
      return;
    }
    const down = press;
    press = null;

    const selection = doc.defaultView?.getSelection();
    const hasSelection =
      selection !== null && selection !== undefined && selection.toString().length > 0;

    const deltaX = event.clientX - down.startX;
    const deltaY = event.clientY - down.startY;
    const distance = Math.max(down.distance, Math.hypot(deltaX, deltaY));
    const pageWidth = doc.body.clientWidth;
    const pageX = pageWidth > 0
      ? ((event.clientX % pageWidth) + pageWidth) % pageWidth
      : event.clientX;

    const action = decidePagingAction({
      flowMode: mode,
      hasSelection,
      deltaX,
      deltaY,
      distance,
      durationMs: event.timeStamp - down.startStamp,
      // epub.js makes the iframe/document span every column in a section,
      // while body.clientWidth remains one visible page. Reduce the
      // document-relative pointer coordinate into that page.
      endX: pageX,
      contentWidth: pageWidth,
    });

    if (action.kind === "page") {
      const ElementType = doc.defaultView?.Element;
      const endsOnLink =
        ElementType !== undefined &&
        event.target instanceof ElementType &&
        event.target.closest("a[href]") !== null;
      // epub.js owns link taps, but a swipe that happens to end over a
      // link is still a paging gesture.
      if (endsOnLink && distance <= TAP_SLOP_PX) {
        return;
      }
      page(action.direction);
    }
  });
}

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
    private readonly flow: EpubFlowControls | undefined,
  ) {
    this.copyPanel = this.createCopyPanel(viewerEl);
    this.createNavigationButton(viewerEl, "epub-nav-prev", "❮", () => this.rendition.prev());
    this.createNavigationButton(viewerEl, "epub-nav-next", "❯", () => this.rendition.next());
    this.createFlowButton(viewerEl);
    this.registerPagingListeners();
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

  /**
   * F2.2 — tap-zone and swipe paging. The gesture is decided by
   * `pagingGestures` (pure, unit-tested); this is the capture side.
   *
   * Listeners live on the rendered document — pointer events in the
   * iframe never reach the host element — and are torn down with the
   * rendition: a mode toggle or a second book in the same leaf destroys
   * the rendition, which destroys these documents with them.
   *
   * Zones are decided from the pointer's x inside the document, never
   * from an overlay div: an overlay over the page is exactly what swallows
   * text selection. A tap is ignored when a non-empty selection exists,
   * when the pointer moved past the slop, when the press was long, or
   * when it lands on an in-content link (epub.js owns those).
   */
  private registerPagingListeners(): void {
    const mode = this.flow?.mode;
    if (mode !== "paginated") {
      return;
    }

    this.rendition.on("rendered", (_section: unknown, view: { document: Document }) => {
      addPagingListeners(view.document, mode, (direction) => {
        void (direction === "next" ? this.rendition.next() : this.rendition.prev());
      });
    });
  }

  /**
   * F2.2 — flow-mode toggle in the reader's own chrome (the settings tab
   * is F1.4's enumeration; no command-palette entry until E006/E007).
   * The icon and label always describe the action available: in
   * paginated mode it offers scrolled, and vice versa.
   */
  private createFlowButton(viewerEl: HTMLElement): void {
    if (this.flow === undefined) {
      return;
    }
    const toScrolled = this.flow.mode === "paginated";
    const label = toScrolled ? "Switch to scrolled mode" : "Switch to paginated mode";
    const btn = document.createElement("button");
    btn.className = "epub-button epub-flow-button";
    btn.textContent = toScrolled ? "≡" : "▭";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.onclick = (e) => {
      e.stopPropagation();
      this.flow?.onToggle();
    };
    viewerEl.appendChild(btn);
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
      copyBtn.onclick = (e) => this.copyTocLink(e, bookTitle, safeHref, safeLabel);
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
