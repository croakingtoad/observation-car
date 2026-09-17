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
 * - The TOC drawer (F2.3) renders the full nested TOC with depth indent,
 *   passes labels and hrefs through without character stripping, handles
 *   `rendition.display()` rejections, and supports keyboard focus,
 *   Enter/Space activation, and Escape to close.
 */
import { type Book, type Contents, type Rendition } from "epubjs";
import type Locations from "epubjs/types/locations";
import { type Location } from "epubjs/types/rendition";
import { AnchorError, buildEpubCfiFragment } from "../model/anchor";
import type { NavItem } from "epubjs/types/navigation";
import { Notice } from "obsidian";
import { buildEpubSpineFragment } from "../model/anchor";
import type { EpubFlowMode } from "../settings";
import { TAP_SLOP_PX, decidePagingAction } from "./pagingGestures";

const EPUBCFI_WRAPPER = "epubcfi(";
const LOCATION_CHARACTERS_PER_BREAK = 1_000;
const COPY_FEEDBACK_DURATION_MS = 1_000;

interface EpubRenderedView {
  contents?: unknown;
  document: Document;
  iframe?: unknown;
  window: Window;
}

type EpubFrameElement = Element & Pick<HTMLIFrameElement, "contentDocument">;
type RenderedContents = EpubRenderedView;
type RenderedHandler = (
  section: unknown,
  contents: RenderedContents,
) => void;

function isEpubFrameElement(element: Element): element is EpubFrameElement {
  return element.localName === "iframe" && "contentDocument" in element;
}

function captureFrameElement(view: EpubRenderedView): EpubFrameElement | null {
  if (
    "contents" in view &&
    view.contents === undefined &&
    "iframe" in view &&
    view.iframe === undefined
  ) {
    return null;
  }
  const frameElement = view.window.frameElement;
  if (frameElement === null || !isEpubFrameElement(frameElement)) {
    throw new Error("epub.js rendered contents without an iframe frame element");
  }
  return frameElement;
}

function isDiscardedView(
  document: Document,
  frameElement: EpubFrameElement,
): boolean {
  return (
    frameElement.isConnected === false ||
    frameElement.contentDocument !== document
  );
}

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
  private readonly documents = new Map<Document, EpubFrameElement>();
  private destroyed = false;

  private readonly onRendered: RenderedHandler = (_section, contents) => {
    if (this.destroyed) {
      return;
    }
    const frameElement = captureFrameElement(contents);
    if (frameElement === null) {
      return;
    }
    this.pruneDiscardedDocuments();
    contents.document.addEventListener("keydown", this.onKeyDown);
    this.documents.set(contents.document, frameElement);

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
    for (const document of this.documents.keys()) {
      document.removeEventListener("keydown", this.onKeyDown);
    }
    this.documents.clear();
  }

  private pruneDiscardedDocuments(): void {
    for (const [document, frameElement] of this.documents) {
      if (isDiscardedView(document, frameElement)) {
        document.removeEventListener("keydown", this.onKeyDown);
        this.documents.delete(document);
      }
    }
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


/**
 * The spine component (before "!") of a CFI, with or without the
 * `epubcfi(...)` wrapper — the section the CFI points into.
 */
function sectionOfCfi(cfi: string): string {
  const bare = cfi.startsWith(EPUBCFI_WRAPPER)
    ? cfi.slice(EPUBCFI_WRAPPER.length)
    : cfi;
  const separator = bare.indexOf("!");
  return separator === -1 ? bare : bare.slice(0, separator);
}

/**
 * Retains the rendition's current selection so the view can answer
 * `getSelection()` (PRD §8 Reader contract).
 *
 * The rendition only ever emits `selected` for a non-collapsed range —
 * it never reports a collapse — so clearing is owned here, from four
 * directions:
 *
 * - `setSelected` records a real selection and clears on an empty CFI
 *   or whitespace-only text
 *   (defensive; the selected handler also forwards an unreadable
 *   selection this way),
 * - `clear` drops it when the user collapses the selection in the
 *   iframe (tap-away), when epub.js renders a fresh view, or when the
 *   book is disposed,
 * - `clearUnlessInLocation` drops it when the rendition reports a
 *   location in another section,
 * - `getSelection` validates the actual iframe element captured with
 *   the selection and drops the state if that element was detached.
 */
export class EpubSelectionTracker {
  private selection: {
    text: string;
    cfiRange: string;
    frameElement: Element | null;
  } | null = null;

  /** Record a `selected` event; an empty CFI or blank text clears. */
  setSelected(cfiRange: string, text: string, contents: Contents): void {
    const trimmed = text.trim();
    if (cfiRange.length === 0 || trimmed.length === 0) {
      this.clear();
      return;
    }
    this.selection = {
      text: trimmed,
      cfiRange,
      frameElement: contents.window.frameElement ?? null,
    };
  }

  /** Drop the selection: collapse in the iframe, page away, dispose. */
  clear(): void {
    this.selection = null;
  }

  /**
   * Drop the selection when the rendition moved to another section.
   * `displayedCfi` is the CFI of the newly reported location; a
   * relocation within the same section (a scroll in a fixed-layout
   * book) keeps it.
   */
  clearUnlessInLocation(displayedCfi: string): void {
    const selection = this.selection;
    if (selection === null) {
      return;
    }
    if (sectionOfCfi(selection.cfiRange) !== sectionOfCfi(displayedCfi)) {
      this.clear();
    }
  }

  /**
   * PRD §8 Reader contract: `{text, fragment}` for the current
   * selection, `null` when there is no selection. A malformed CFI
   * resolves to `null` rather than a throw, so F4.6 "new note here"
   * can never crash on a bad selection.
   */
  getSelection(): { text: string; fragment: string } | null {
    const selection = this.selection;
    if (selection === null) {
      return null;
    }
    if (selection.frameElement !== null && selection.frameElement.isConnected === false) {
      // The actual iframe that held the selection left the host DOM.
      this.clear();
      return null;
    }
    try {
      return {
        text: selection.text,
        fragment: buildEpubCfiFragment(selection.cfiRange),
      };
    } catch (error) {
      if (error instanceof AnchorError) {
        return null;
      }
      throw error;
    }
  }
}

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

/** Host actions exposed in the reader's own toolbar. */
export interface EpubReaderActions {
  readonly onNewNote: () => void;
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
): () => void {
  // Scrolled mode is vertical: tap zones and horizontal swipe are inert,
  // so it needs neither pointer listeners nor a touch-action override.
  if (mode !== "paginated") {
    return () => {};
  }

  // Keep native vertical pan while handing horizontal gestures to the
  // pointer handlers below.
  doc.documentElement.style.touchAction = "pan-y";

  let press: PointerPress | null = null;

  const downHandler = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return; // primary button only; touch and pen report 0 too
    }
    press = {
      startX: event.clientX,
      startY: event.clientY,
      startStamp: event.timeStamp,
      distance: 0,
    };
  };

  const moveHandler = (event: PointerEvent): void => {
    if (press === null) {
      return;
    }
    const travelled = Math.hypot(event.clientX - press.startX, event.clientY - press.startY);
    if (travelled > press.distance) {
      press.distance = travelled;
    }
  };

  // A native pan or scroll cancels the press; it must not page.
  const cancelHandler = (): void => {
    press = null;
  };

  const upHandler = (event: PointerEvent): void => {
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
    const pageWidth = Math.min(doc.body.clientWidth, doc.documentElement.clientWidth);
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
      // Reflowable sections expand the document across every column while
      // body.clientWidth remains one page/spread. Fixed-layout sections do
      // the inverse: the body keeps its intrinsic width while the document
      // is the scaled viewport. The narrower box is the visible paging unit.
      // Reduce the document-relative pointer coordinate into that unit.
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
  };

  doc.addEventListener("pointerdown", downHandler);
  doc.addEventListener("pointermove", moveHandler);
  doc.addEventListener("pointercancel", cancelHandler);
  doc.addEventListener("pointerup", upHandler);

  const remove = (): void => {
    doc.removeEventListener("pointerdown", downHandler);
    doc.removeEventListener("pointermove", moveHandler);
    doc.removeEventListener("pointercancel", cancelHandler);
    doc.removeEventListener("pointerup", upHandler);
    doc.documentElement.style.removeProperty("touch-action");
  };

  return remove;
}

type PagingListeners = {
  document: Document;
  frameElement: EpubFrameElement;
  remove: () => void;
};

type DocumentListeners = {
  frameElement: EpubFrameElement;
  listeners: Map<string, Set<EventListener>>;
};

const FONT_SIZE_DEFAULT = 100;
const FONT_SIZE_MIN = 80;
const FONT_SIZE_MAX = 180;
const FONT_SIZE_STEP = 10;
const FONT_SIZE_STORAGE_PREFIX = "observation-car:epub-font-size:";

/** Per-book font-size control that applies to current and future EPUB sections. */
export class EpubFontSizeStepper {
  private readonly storageKey: string;
  private readonly container: HTMLDivElement;
  private readonly decreaseButton: HTMLButtonElement;
  private readonly increaseButton: HTMLButtonElement;
  private readonly valueOutput: HTMLOutputElement;
  private currentValue: number;

  constructor(viewerEl: HTMLElement, bookPath: string, private readonly rendition: Rendition) {
    this.storageKey = `${FONT_SIZE_STORAGE_PREFIX}${bookPath}`;
    this.currentValue = this.readStoredValue();

    this.container = document.createElement("div");
    this.container.className = "epub-font-size-stepper";
    this.container.setAttribute("role", "group");
    this.container.ariaLabel = "Reader font size";

    this.decreaseButton = this.createButton(
      "epub-font-size-decrease",
      "Decrease reader font size",
      "A−",
      -FONT_SIZE_STEP,
    );
    this.valueOutput = document.createElement("output");
    this.valueOutput.className = "epub-font-size-value";
    this.valueOutput.ariaLabel = "Reader font size";
    this.valueOutput.setAttribute("aria-live", "polite");
    this.increaseButton = this.createButton(
      "epub-font-size-increase",
      "Increase reader font size",
      "A+",
      FONT_SIZE_STEP,
    );

    this.container.append(this.decreaseButton, this.valueOutput, this.increaseButton);
    viewerEl.appendChild(this.container);
    this.applyValue();
  }

  /** Remove the toolbar controls and their handlers with the reader. */
  destroy(): void {
    this.decreaseButton.onclick = null;
    this.increaseButton.onclick = null;
    this.container.remove();
  }

  private createButton(
    className: string,
    label: string,
    text: string,
    delta: number,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `epub-button epub-font-size-button ${className}`;
    button.title = label;
    button.ariaLabel = label;
    button.textContent = text;
    button.onclick = (event) => {
      event.stopPropagation();
      this.currentValue = Math.min(
        FONT_SIZE_MAX,
        Math.max(FONT_SIZE_MIN, this.currentValue + delta),
      );
      this.writeStoredValue();
      this.applyValue();
    };
    return button;
  }

  private readStoredValue(): number {
    try {
      const value = Number.parseInt(localStorage.getItem(this.storageKey) ?? "", 10);
      if (
        Number.isFinite(value) &&
        value >= FONT_SIZE_MIN &&
        value <= FONT_SIZE_MAX &&
        (value - FONT_SIZE_MIN) % FONT_SIZE_STEP === 0
      ) {
        return value;
      }
    } catch {
      // Storage can be unavailable in restricted webviews; keep the control functional in-memory.
    }
    return FONT_SIZE_DEFAULT;
  }

  private writeStoredValue(): void {
    try {
      localStorage.setItem(this.storageKey, String(this.currentValue));
    } catch {
      // See readStoredValue: persistence is optional when the webview denies storage.
    }
  }

  private applyValue(): void {
    const value = `${this.currentValue}%`;
    this.rendition.themes.override("font-size", value, true);
    this.valueOutput.value = value;
    this.decreaseButton.disabled = this.currentValue === FONT_SIZE_MIN;
    this.increaseButton.disabled = this.currentValue === FONT_SIZE_MAX;
  }
}

export class EpubNavigationTools {
  private tocPanel: HTMLDivElement | null = null;
  private tocButton: HTMLButtonElement | null = null;
  private isTocOpen = false;
  private readonly copyPanel: HTMLDivElement;
  private locations: Promise<Locations> | null = null;
  private currentLocation: Location | null = null;
  private needsCorrection = false;
  private destroyed = false;
  private readonly keyBridge: EpubKeyBridge;
  private readonly fontSizeStepper: EpubFontSizeStepper;
  private readonly onNewNoteClick = (event: MouseEvent): void => {
    event.stopPropagation();
    this.actions?.onNewNote();
  };
  private bookTitle: Promise<string> | null = null;
  private readonly documentListeners = new Map<Document, DocumentListeners>();
  private readonly hostKeyListeners = new Set<{
    target: HTMLElement;
    type: string;
    listener: EventListener;
  }>();
  private readonly pagingListeners = new Set<PagingListeners>();

  private readonly onRelocated = (loc: Location): void => {
    // The selection's section may no longer be on screen (page
    // turn); a same-section relocation (scroll) keeps it.
    this.selectionTracker.clearUnlessInLocation(loc.start.cfi);
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

  private readonly onRendered = (
    _section: unknown,
    contents: EpubRenderedView,
  ): void => {
    if (this.destroyed) {
      return;
    }

    const frameElement = captureFrameElement(contents);
    if (frameElement === null) {
      return;
    }
    this.pruneDiscardedViewListeners();

    // A rendered view has no selection yet. In particular, epub.js
    // destroys and replaces the iframe on resize before relocating
    // to the same CFI, so relocation alone cannot detect this clear.
    this.selectionTracker.clear();

    // The rendition never emits `selected` for a collapsed range,
    // so a tap-away inside the book is caught on the iframe's own
    // selectionchange to clear the retained selection (F2.6).
    const selectionChangeHandler = () => {
      this.onIframeSelectionChange(contents);
    };
    contents.document.addEventListener("selectionchange", selectionChangeHandler);
    this.addDocumentListener(
      contents.document,
      frameElement,
      "selectionchange",
      selectionChangeHandler,
    );

    // Keep focus on the iframe so page keys keep working.
    (contents.document.body as HTMLElement).setAttribute("tabindex", "0");
    (contents.document.body as HTMLElement).focus();
  };

  private readonly onTocRendered = (
    _section: unknown,
    contents: Contents,
  ): void => {
    if (this.destroyed) {
      return;
    }

    const frameElement = captureFrameElement(contents);
    if (frameElement === null) {
      return;
    }
    contents.document.addEventListener("mousedown", this.onDocumentMouseDown);
    this.addDocumentListener(
      contents.document,
      frameElement,
      "mousedown",
      this.onDocumentMouseDown,
    );
  };

  private readonly onPageRendered = (
    _section: unknown,
    view: EpubRenderedView,
  ): void => {
    if (this.destroyed || this.flow?.mode !== "paginated") {
      return;
    }

    const frameElement = captureFrameElement(view);
    if (frameElement === null) {
      return;
    }
    this.pruneDiscardedViewListeners();

    const removePagingListeners = addPagingListeners(
      view.document,
      this.flow.mode,
      (direction) => {
        if (this.destroyed) {
          return;
        }
        void (direction === "next" ? this.rendition.next() : this.rendition.prev());
      },
    );
    this.pagingListeners.add({
      document: view.document,
      frameElement,
      remove: removePagingListeners,
    });
  };

  private readonly onSelected = (cfiRange: string, contents: Contents): void => {
    void this.showSelection(cfiRange, contents);
  };

  private readonly onDocumentMouseDown = (): void => {
    this.toggleTocVisibility(false);
  };

  constructor(
    viewerEl: HTMLElement,
    private readonly bookPath: string,
    private readonly book: Book,
    private readonly rendition: Rendition,
    private readonly selectionTracker: EpubSelectionTracker,
    private readonly flow?: EpubFlowControls,
    private readonly actions?: EpubReaderActions,
    activateView: () => void = () => undefined,
  ) {
    this.copyPanel = this.createCopyPanel(viewerEl);
    this.fontSizeStepper = new EpubFontSizeStepper(viewerEl, bookPath, rendition);
    this.createNavigationButton(viewerEl, "epub-nav-prev", "❮", () => this.rendition.prev());
    this.createNavigationButton(viewerEl, "epub-nav-next", "❯", () => this.rendition.next());
    void this.createTocPanel(viewerEl).catch((error: unknown) =>
      this.reportSetupFailure(viewerEl, "Table of contents", error),
    );
    this.createFlowButton(viewerEl);
    this.createNewNoteButton(viewerEl);
    this.keyBridge = new EpubKeyBridge(
      rendition,
      viewerEl.ownerDocument,
      (key) => this.pageKeyJump(key),
      activateView,
    );
    this.bookTitle = this.book.loaded.metadata
      .then((metadata) => metadata.title)
      .catch(() => "Untitled");
    void this.addSelectionListener().catch((error: unknown) =>
      this.reportSetupFailure(viewerEl, "Selection copying", error),
    );

    // Pane/layout changes make epub.js reflow and report a fresh
    // location; re-display the one we had so the page does not jump.
    this.rendition.on("relocated", this.onRelocated);
    this.rendition.on("resized", this.onResized);
    this.rendition.on("rendered", this.onRendered);
    this.rendition.on("rendered", this.onPageRendered);
  }

  /** Release host/iframe listeners before this rendition is replaced. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.fontSizeStepper.destroy();
    this.keyBridge.destroy();
    for (const { target, type, listener } of this.hostKeyListeners) {
      target.removeEventListener(type, listener);
    }
    this.hostKeyListeners.clear();
    this.rendition.off("relocated", this.onRelocated);
    this.rendition.off("resized", this.onResized);
    this.rendition.off("rendered", this.onRendered);
    this.rendition.off("rendered", this.onTocRendered);
    this.rendition.off("rendered", this.onPageRendered);
    this.rendition.off("selected", this.onSelected);

    for (const [document, viewListeners] of this.documentListeners) {
      for (const [type, handlers] of viewListeners.listeners) {
        for (const handler of handlers) {
          document.removeEventListener(type, handler);
        }
      }
    }
    this.documentListeners.clear();
    for (const pagingListener of this.pagingListeners) {
      pagingListener.remove();
    }
    this.pagingListeners.clear();
  }

  private addDocumentListener(
    document: Document,
    frameElement: EpubFrameElement,
    type: string,
    handler: EventListener,
  ): void {
    const listeners = this.documentListeners.get(document)?.listeners ?? new Map();
    listeners.set(type, (listeners.get(type) ?? new Set()).add(handler));
    this.documentListeners.set(document, { frameElement, listeners });
  }

  private pruneDiscardedViewListeners(): void {
    for (const [document, viewListeners] of this.documentListeners) {
      if (isDiscardedView(document, viewListeners.frameElement)) {
        for (const [type, handlers] of viewListeners.listeners) {
          for (const handler of handlers) {
            document.removeEventListener(type, handler);
          }
        }
        this.documentListeners.delete(document);
      }
    }

    for (const pagingListener of this.pagingListeners) {
      if (
        isDiscardedView(
          pagingListener.document,
          pagingListener.frameElement,
        )
      ) {
        pagingListener.remove();
        this.pagingListeners.delete(pagingListener);
      }
    }
  }

  /**
   * Clear the retained selection once the user collapses it inside
   * the book (tap-away, Escape, re-tap): epub.js only emits `selected`
   * for a non-collapsed range, so the collapse reaches us here, on the
   * iframe, not through the rendition.
   */
  private onIframeSelectionChange(contents: EpubRenderedView): void {
    const selection = contents.window.getSelection();
    const active =
      selection !== null &&
      selection.rangeCount > 0 &&
      selection.getRangeAt(0).collapsed === false;
    if (active === false) {
      this.selectionTracker.clear();
    }
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

  /** F4.6 — add an anchored section without leaving reader chrome. */
  private createNewNoteButton(viewerEl: HTMLElement): void {
    if (this.actions === undefined) return;
    const button = document.createElement("button");
    button.className = "epub-button epub-new-note-button";
    button.textContent = "+";
    button.title = "New note here";
    button.setAttribute("aria-label", "New note here");
    button.onclick = this.onNewNoteClick;
    viewerEl.appendChild(button);
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
      await this.rendition.display(tocItems[targetIdx].href);
    }
  }

  private async addSelectionListener(): Promise<void> {
    await this.book.loaded.metadata;
    if (this.destroyed) {
      return;
    }
    this.rendition.on("selected", this.onSelected);
  }

  private async showSelection(cfiRange: string, contents: Contents): Promise<void> {
    if (this.destroyed) {
      return;
    }
    const title = (await this.bookTitle) ?? "Untitled";
    if (this.destroyed) {
      return;
    }
    const viewerEl = this.copyPanel.parentElement;
    if (viewerEl === null) {
      return;
    }
    const selection = contents.window.getSelection();
    if (cfiRange.length === 0 || selection === null || selection.rangeCount === 0) {
      this.selectionTracker.clear();
      return;
    }
    this.selectionTracker.setSelected(cfiRange, selection.toString(), contents);

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
    this.tocButton = tocButton;

    this.tocPanel = document.createElement("div");
    this.tocPanel.className = "epub-toc-panel";
    this.tocPanel.setAttribute("role", "navigation");
    this.tocPanel.setAttribute("aria-label", "Table of contents");
    // Starts closed; keep it out of the tab order until opened.
    this.tocPanel.inert = true;
    viewerEl.appendChild(this.tocPanel);

    for (const entry of flattenToc(navigation.toc)) {
      this.tocPanel.appendChild(this.createTocRow(entry, bookTitle));
    }

    // Escape closes the drawer while it is open and returns focus to the
    // toggle so keyboard users are not left on an off-screen element.
    const KeyboardEventConstructor =
      viewerEl.ownerDocument.defaultView?.KeyboardEvent ?? KeyboardEvent;
    const tocKeydownListener = (event: Event): void => {
      if (!(event instanceof KeyboardEventConstructor)) {
        return;
      }
      if (event.key === "Escape" && this.isTocOpen) {
        event.preventDefault();
        event.stopPropagation();
        this.toggleTocVisibility(false);
        this.tocButton?.focus();
      }
    };
    viewerEl.addEventListener("keydown", tocKeydownListener);
    this.hostKeyListeners.add({ target: viewerEl, type: "keydown", listener: tocKeydownListener });

    // Hide the TOC panel when the reader is clicked.
    this.rendition.on("rendered", this.onTocRendered);
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
    copyBtn.onclick = (e) => void this.copyTocLink(e, bookTitle, href, label);
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

  private async copyTocLink(
    e: Event,
    bookTitle: string,
    href: string,
    label: string,
  ): Promise<void> {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLButtonElement;
    let fragment: string;
    try {
      fragment = buildEpubSpineFragment(href);
    } catch {
      new Notice(
        "Could not copy link: this table-of-contents entry uses a subchapter fragment that reading-note links do not support.",
      );
      return;
    }
    const safeLabel = label.replaceAll("|", "｜").replaceAll("]", "］");
    try {
      await navigator.clipboard.writeText(
        `[[${this.bookPath}${fragment}|${bookTitle}, ${safeLabel}]]`,
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
        await this.book.locations.generate(LOCATION_CHARACTERS_PER_BREAK);
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
    }, COPY_FEEDBACK_DURATION_MS);
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
    }, COPY_FEEDBACK_DURATION_MS);
  }

  /**
   * Collapse consecutive whitespace and trim. Preserves accents and non-Latin
   * scripts, so it is safe for display labels.
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
    // The transform only hides the drawer visually; inert is what removes
    // its tab stops from keyboard order and the accessibility tree.
    this.tocPanel.inert = !shouldShow;
    this.copyPanel.classList.toggle("open", false);
    this.isTocOpen = shouldShow;
  }
}
