import type { Book } from "epubjs";
import { JSDOM } from "jsdom";
import type { Command, TFile, WorkspaceLeaf } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  createEpub: vi.fn(),
  readBinary: vi.fn(),
  app: undefined as unknown,
  setActiveLeaf: vi.fn(),
  noticeMessages: [] as string[],
}));

vi.mock("epubjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("epubjs")>();
  return { ...actual, default: runtime.createEpub };
});

vi.mock("obsidian", () => {
  class FileView {
    readonly app: unknown;
    readonly leaf: unknown;
    readonly contentEl: HTMLElement & {
      createDiv(options?: { cls?: string }): HTMLDivElement;
      empty(): void;
    };

    constructor(leaf: unknown) {
      this.app = runtime.app;
      this.leaf = leaf;
      const contentEl = document.createElement("div") as FileView["contentEl"];
      contentEl.createDiv = (options = {}) => {
        const child = document.createElement("div");
        const classNames = typeof options === "string" ? options : options.cls;
        const cls = Array.isArray(classNames) ? classNames.join(" ") : classNames;
        if (cls !== undefined) {
          child.className = cls;
        }
        contentEl.append(child);
        return child;
      };
      contentEl.empty = () => contentEl.replaceChildren();
      this.contentEl = contentEl;
    }
  }

  class TFile {}
  class TFolder {}
  class Notice {
    constructor(message: string) {
      runtime.noticeMessages.push(message);
    }
  }

  const normalizePath = (path: string): string =>
    path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\//, "");

  return { FileView, Notice, TFile, TFolder, normalizePath };
});

import { registerCreateBookNoteCommand } from "../commands/createBookNote";
import type ObservationCarPlugin from "../main";
import {
  EpubKeyBridge,
  type EpubKeyBridgeRendition,
} from "./epubNavigationTools";

type RenderedHandler = Parameters<EpubKeyBridgeRendition["on"]>[1];
type RenditionHandler = (...args: never[]) => unknown;

class FakeRendition implements EpubKeyBridgeRendition {
  readonly prev = vi.fn(async (): Promise<void> => undefined);
  readonly next = vi.fn(async (): Promise<void> => undefined);
  readonly destroy = vi.fn();
  readonly themes = {
    register: vi.fn(),
    select: vi.fn(),
  };
  readonly location = { start: { href: "chapter.xhtml" } };
  readonly display = vi.fn(async (): Promise<void> => {
    if (this.document !== undefined) {
      this.render(this.document);
    }
  });
  private readonly handlers = new Map<string, Set<RenditionHandler>>();
  private readonly removedHandlers = new Map<string, RenditionHandler[]>();

  constructor(private readonly document?: Document) {}

  on(event: "rendered", handler: RenderedHandler): void;
  on(event: string, handler: RenditionHandler): void;
  on(event: string, handler: RenditionHandler): void {
    let handlers = this.handlers.get(event);
    if (handlers === undefined) {
      handlers = new Set();
      this.handlers.set(event, handlers);
    }
    handlers.add(handler);
  }

  off(event: "rendered", handler: RenderedHandler): void;
  off(event: string, handler: RenditionHandler): void;
  off(event: string, handler: RenditionHandler): void {
    this.handlers.get(event)?.delete(handler);
    let removals = this.removedHandlers.get(event);
    if (removals === undefined) {
      removals = [];
      this.removedHandlers.set(event, removals);
    }
    removals.push(handler);
  }

  render(document: Document): void {
    for (const handler of this.handlers.get("rendered") ?? []) {
      (handler as RenderedHandler)({}, { document });
    }
  }

  activeHandlerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  removedHandlerCount(event: string): number {
    return this.removedHandlers.get(event)?.length ?? 0;
  }
}

interface ListenerRegistration {
  type: string;
  listener: EventListenerOrEventListenerObject;
  capture: boolean;
}

function captureOption(options?: boolean | EventListenerOptions): boolean {
  return typeof options === "boolean" ? options : (options?.capture ?? false);
}

function trackEventListeners(target: Document): {
  activeCount(type: string): number;
  removedCount(type: string): number;
} {
  const active: ListenerRegistration[] = [];
  const removed: ListenerRegistration[] = [];
  const nativeAdd = target.addEventListener.bind(target);
  const nativeRemove = target.removeEventListener.bind(target);

  vi.spyOn(target, "addEventListener").mockImplementation(
    (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void => {
      nativeAdd(type, listener, options);
      active.push({ type, listener, capture: captureOption(options) });
    },
  );
  vi.spyOn(target, "removeEventListener").mockImplementation(
    (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ): void => {
      nativeRemove(type, listener, options);
      const registration = {
        type,
        listener,
        capture: captureOption(options),
      };
      removed.push(registration);
      const index = active.findIndex(
        (candidate) =>
          candidate.type === registration.type &&
          candidate.listener === registration.listener &&
          candidate.capture === registration.capture,
      );
      if (index !== -1) {
        active.splice(index, 1);
      }
    },
  );

  return {
    activeCount: (type) => active.filter((listener) => listener.type === type).length,
    removedCount: (type) => removed.filter((listener) => listener.type === type).length,
  };
}

function fakeBook(title: string, rendition: FakeRendition): Book {
  return {
    loaded: {
      metadata: Promise.resolve({ title }),
      navigation: Promise.resolve({ toc: [] }),
    },
    ready: Promise.resolve(),
    locations: {
      generate: vi.fn(async (): Promise<void> => undefined),
      locationFromCfi: vi.fn(),
    },
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
  } as unknown as Book;
}

function bookFile(path: string): TFile {
  const name = path.split("/").at(-1) ?? path;
  const extension = name.split(".").at(-1) ?? "";
  return {
    path,
    name,
    extension,
    basename: name.slice(0, -(extension.length + 1)),
  } as TFile;
}

function keyboardEvent(
  document: Document,
  key: string,
  init: KeyboardEventInit & { keyCode: number },
): KeyboardEvent {
  const KeyboardEventConstructor = document.defaultView?.KeyboardEvent;
  if (KeyboardEventConstructor === undefined) {
    throw new Error("test document has no KeyboardEvent constructor");
  }
  const event = new KeyboardEventConstructor("keydown", { key, ...init });
  Object.defineProperty(event, "keyCode", { value: init.keyCode });
  return event;
}

function documents(): { host: Document; iframe: Document } {
  const hostFrame = document.createElement("iframe");
  document.body.append(hostFrame);
  const host = hostFrame.contentDocument;
  if (host === null) {
    throw new Error("test host iframe has no document");
  }
  const readerFrame = host.createElement("iframe");
  host.body.append(readerFrame);
  const iframe = readerFrame.contentDocument;
  if (iframe === null) {
    throw new Error("test reader iframe has no document");
  }
  return {
    host,
    iframe,
  };
}

function childDocument(parent: Document): Document {
  const frame = parent.createElement("iframe");
  parent.body.append(frame);
  if (frame.contentDocument === null) {
    throw new Error("test iframe has no document");
  }
  return frame.contentDocument;
}

let testDom: JSDOM;

beforeEach(() => {
  vi.clearAllMocks();
  runtime.noticeMessages.length = 0;
  testDom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("window", testDom.window);
  vi.stubGlobal("document", testDom.window.document);
  vi.stubGlobal("navigator", testDom.window.navigator);
  vi.stubGlobal("MutationObserver", testDom.window.MutationObserver);
  vi.stubGlobal("getComputedStyle", testDom.window.getComputedStyle.bind(testDom.window));
  runtime.readBinary.mockResolvedValue(new ArrayBuffer(0));
  runtime.app = {
    vault: { readBinary: runtime.readBinary },
    workspace: { setActiveLeaf: runtime.setActiveLeaf },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  testDom.window.close();
});

describe("EpubKeyBridge", () => {
  it("forwards an equivalent non-paging key event to the host document", () => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());
    rendition.render(iframe);

    const forwarded: KeyboardEvent[] = [];
    host.addEventListener("keydown", (event) => forwarded.push(event));
    iframe.dispatchEvent(
      keyboardEvent(iframe, "p", {
        code: "KeyP",
        keyCode: 80,
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
        altKey: true,
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      key: "p",
      code: "KeyP",
      keyCode: 80,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: true,
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    bridge.destroy();
  });

  it("preserves the macOS meta modifier on a forwarded key", () => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());
    rendition.render(iframe);
    const forwarded: KeyboardEvent[] = [];
    host.addEventListener("keydown", (event) => forwarded.push(event));

    iframe.dispatchEvent(
      keyboardEvent(iframe, "p", {
        code: "KeyP",
        keyCode: 80,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].metaKey).toBe(true);
    bridge.destroy();
  });

  it.each([
    ["ArrowLeft", "prev"],
    ["ArrowRight", "next"],
  ] as const)("consumes %s for reader paging", (key, method) => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());
    rendition.render(iframe);
    const hostHandler = vi.fn();
    host.addEventListener("keydown", hostHandler);

    const event = keyboardEvent(iframe, key, {
      code: key,
      keyCode: key === "ArrowLeft" ? 37 : 39,
      bubbles: true,
      cancelable: true,
    });
    iframe.dispatchEvent(event);

    expect(rendition[method]).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(hostHandler).not.toHaveBeenCalled();
    bridge.destroy();
  });

  it.each([
    ["PageUp", 33],
    ["PageDown", 34],
  ] as const)("keeps %s reader-owned", (key, keyCode) => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const pageKeyJump = vi.fn();
    const bridge = new EpubKeyBridge(rendition, host, pageKeyJump);
    rendition.render(iframe);
    const hostHandler = vi.fn();
    host.addEventListener("keydown", hostHandler);

    const event = keyboardEvent(iframe, key, {
      code: key,
      keyCode,
      bubbles: true,
      cancelable: true,
    });
    iframe.dispatchEvent(event);

    expect(pageKeyJump).toHaveBeenCalledOnce();
    expect(pageKeyJump).toHaveBeenCalledWith(key);
    expect(event.defaultPrevented).toBe(true);
    expect(hostHandler).not.toHaveBeenCalled();
    bridge.destroy();
  });

  it("leaves the iframe copy default active exactly once", () => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());
    rendition.render(iframe);
    const hostHandler = vi.fn();
    host.addEventListener("keydown", hostHandler);

    let nativeCopyDefaults = 0;
    iframe.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "c" && !event.defaultPrevented) {
        nativeCopyDefaults += 1;
      }
    });
    const event = keyboardEvent(iframe, "c", {
      code: "KeyC",
      keyCode: 67,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    iframe.dispatchEvent(event);

    expect(hostHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(nativeCopyDefaults).toBe(1);
    bridge.destroy();
  });

  it("does not forward a key already handled by the EPUB document", () => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());
    const consumeInBook = (event: KeyboardEvent): void => event.preventDefault();
    iframe.addEventListener("keydown", consumeInBook);
    rendition.render(iframe);
    const hostHandler = vi.fn();
    host.addEventListener("keydown", hostHandler);

    iframe.dispatchEvent(
      keyboardEvent(iframe, "x", {
        code: "KeyX",
        keyCode: 88,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(hostHandler).not.toHaveBeenCalled();
    bridge.destroy();
  });

  it("does not forward its own synthetic event if it returns to the iframe", () => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());
    rendition.render(iframe);
    const forwarded: KeyboardEvent[] = [];
    host.addEventListener("keydown", (event) => forwarded.push(event));

    iframe.dispatchEvent(
      keyboardEvent(iframe, "p", {
        code: "KeyP",
        keyCode: 80,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    iframe.dispatchEvent(forwarded[0]);

    expect(forwarded).toHaveLength(1);
    bridge.destroy();
  });

  it("unsubscribes from rendered when destroyed", () => {
    const { host } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());

    bridge.destroy();

    expect(rendition.removedHandlerCount("rendered")).toBe(1);
    expect(rendition.activeHandlerCount("rendered")).toBe(0);
  });
});

describe("EpubView reader replacement", () => {
  it("physically detaches the previous book listeners and rendered handlers", async () => {
    const { EpubView } = await import("./EpubView");
    const oldDocument = childDocument(document);
    const replacementDocument = childDocument(document);
    const oldListeners = trackEventListeners(oldDocument);
    const replacementListeners = trackEventListeners(replacementDocument);
    const oldRendition = new FakeRendition(oldDocument);
    const replacementRendition = new FakeRendition(replacementDocument);
    runtime.createEpub
      .mockReturnValueOnce(fakeBook("Book A", oldRendition))
      .mockReturnValueOnce(fakeBook("Book B", replacementRendition));
    const view = new EpubView({} as WorkspaceLeaf);

    await view.onLoadFile(bookFile("Books/A.epub"));
    await view.onLoadFile(bookFile("Books/B.epub"));

    expect(oldListeners.removedCount("keydown")).toBe(1);
    expect(oldListeners.removedCount("mousedown")).toBe(1);
    expect(oldListeners.activeCount("keydown")).toBe(0);
    expect(oldListeners.activeCount("mousedown")).toBe(0);
    expect(replacementListeners.activeCount("keydown")).toBe(1);
    expect(replacementListeners.activeCount("mousedown")).toBe(1);
    expect(oldRendition.removedHandlerCount("rendered")).toBe(2);
    expect(oldRendition.activeHandlerCount("rendered")).toBe(0);
    await view.onClose();
  });
});

describe("forwarded EPUB hotkey integration", () => {
  it("creates the note for the iframe that received the chord, not the last active book", async () => {
    const { EpubView, EPUB_VIEW_TYPE } = await import("./EpubView");
    const firstDocument = childDocument(document);
    const secondDocument = childDocument(document);
    const firstRendition = new FakeRendition(firstDocument);
    const secondRendition = new FakeRendition(secondDocument);
    runtime.createEpub
      .mockReturnValueOnce(fakeBook("Book A", firstRendition))
      .mockReturnValueOnce(fakeBook("Book B", secondRendition));

    type EpubViewInstance = InstanceType<typeof EpubView>;
    let activeView: EpubViewInstance | null = null;
    let activeLeafHandler: ((leaf: WorkspaceLeaf | null) => void) | undefined;
    const createdFiles: string[] = [];
    const openedFiles: string[] = [];
    const leaves: Array<{
      view: EpubViewInstance;
      getViewState(): { type: string };
      loadIfDeferred(): Promise<void>;
    }> = [];
    runtime.setActiveLeaf.mockImplementation(
      (leaf: WorkspaceLeaf, _params: { focus?: boolean }): void => {
        activeView = leaf.view as EpubViewInstance;
        activeLeafHandler?.(leaf);
      },
    );
    runtime.app = {
      vault: {
        readBinary: runtime.readBinary,
        getAbstractFileByPath: () => null,
        create: async (path: string): Promise<TFile> => {
          createdFiles.push(path);
          return bookFile(path);
        },
        createFolder: async (): Promise<void> => undefined,
      },
      workspace: {
        setActiveLeaf: runtime.setActiveLeaf,
        getActiveViewOfType: (
          viewType: typeof EpubView,
        ): EpubViewInstance | null =>
          activeView instanceof viewType ? activeView : null,
        getLeavesOfType: () => leaves,
        on: (
          _name: string,
          handler: (leaf: WorkspaceLeaf | null) => void,
        ): { event: string } => {
          activeLeafHandler = handler;
          return { event: "active-leaf-change" };
        },
        getLeaf: () => ({
          openFile: async (file: TFile): Promise<void> => {
            openedFiles.push(file.path);
          },
        }),
      },
    };

    const makeLeaf = (): (typeof leaves)[number] => ({
      view: undefined as unknown as EpubViewInstance,
      getViewState: () => ({ type: EPUB_VIEW_TYPE }),
      loadIfDeferred: vi.fn(async (): Promise<void> => undefined),
    });
    const firstLeaf = makeLeaf();
    const secondLeaf = makeLeaf();
    const firstView = new EpubView(firstLeaf as unknown as WorkspaceLeaf);
    const secondView = new EpubView(secondLeaf as unknown as WorkspaceLeaf);
    firstLeaf.view = firstView;
    secondLeaf.view = secondView;
    leaves.push(firstLeaf, secondLeaf);
    await firstView.onLoadFile(bookFile("Books/Book A.epub"));
    await secondView.onLoadFile(bookFile("Books/Book B.epub"));
    activeView = secondView;
    activeLeafHandler?.(secondLeaf as unknown as WorkspaceLeaf);

    let command: Command | undefined;
    const plugin = {
      app: runtime.app,
      settings: {
        notesFolder: "",
        noteTemplate:
          "---\nsource: {{source}}\nformat: {{format}}\ntitle: {{title}}\n---\n",
      },
      registerEvent: vi.fn(),
      addCommand: (registered: Command): Command => {
        command = registered;
        return registered;
      },
    } as unknown as ObservationCarPlugin;
    registerCreateBookNoteCommand(plugin);

    const invokeHostHotkey = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "n") {
        command?.callback?.();
      }
    };
    document.addEventListener("keydown", invokeHostHotkey);
    firstDocument.dispatchEvent(
      keyboardEvent(firstDocument, "n", {
        code: "KeyN",
        keyCode: 78,
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    await vi.waitFor(() => {
      expect(createdFiles).toEqual(["Book A.md"]);
    });
    expect(openedFiles).toEqual(["Book A.md"]);
    expect(runtime.setActiveLeaf).toHaveBeenCalledWith(firstLeaf, {
      focus: false,
    });
    expect(runtime.noticeMessages).toEqual([]);

    document.removeEventListener("keydown", invokeHostHotkey);
    await firstView.onClose();
    await secondView.onClose();
  });
});
