// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS } from "../settings";
import { EpubView, type EpubViewHost } from "./EpubView";

const showNotice = vi.hoisted(() => vi.fn());

vi.mock("obsidian", () => ({
  FileView: class {
    app: unknown;
    contentEl = document.createElement("div");

    constructor(leaf: { app?: unknown } | null) {
      this.app = leaf?.app;
    }
  },
  Notice: showNotice,
  TFile: class {},
  WorkspaceLeaf: class {},
}));

const epubMock = vi.hoisted(() => {
  const state = {
    initialDisplayGate: null as Promise<void> | null,
    failNextInitialDisplay: false,
  };

  class FakeRendition {
    static instances: FakeRendition[] = [];
    readonly failedTargets = new Set<string>();
    private readonly listeners = new Map<
      string,
      Set<(...args: unknown[]) => void>
    >();
    destroyed = false;
    location: { start: { cfi: string; href: string } };
    display = vi.fn(async (target?: string) => {
      if (target === undefined) {
        const shouldFail = state.failNextInitialDisplay;
        state.failNextInitialDisplay = false;
        if (shouldFail) {
          throw new Error("render failed");
        }
        const gate = state.initialDisplayGate;
        if (gate !== null) {
          await gate;
        }
        return;
      }
      if (this.failedTargets.has(target)) {
        throw new Error("CFI does not resolve in this book");
      }
      this.emitRelocated(target);
    });
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    epubcfi = {
      compare: (left: string, right: string): number =>
        left === right ? 0 : left < right ? -1 : 1,
    };
    themes = { register: vi.fn(), select: vi.fn(), override: vi.fn() };

    constructor(bookId: number) {
      const cfi = bookId === 2 ? CFI_B : CFI_A;
      this.location = { start: { cfi, href: `book-${bookId}.xhtml` } };
      FakeRendition.instances.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void): void {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
    }

    off(event: string, listener: (...args: unknown[]) => void): void {
      this.listeners.get(event)?.delete(listener);
    }

    emitRelocated(cfi: string): void {
      const location = {
        start: { cfi, href: "chapter.xhtml" },
        end: { cfi, href: "chapter.xhtml" },
      };
      this.location = location;
      for (const listener of [...(this.listeners.get("relocated") ?? [])]) {
        listener(location);
      }
    }
  }

  class FakeBook {
    static instances: FakeBook[] = [];
    readonly rendition: FakeRendition;
    readonly loaded = {
      navigation: Promise.resolve({ toc: [] }),
      metadata: Promise.resolve({ title: "Fake book" }),
    };
    readonly spine = {
      get: (_target: string) => ({ href: "chapter.xhtml" }),
    };
    readonly renderTo = vi.fn(
      (_element: HTMLElement, options: { flow: string }) => {
        this.flow = options.flow;
        return this.rendition;
      },
    );
    readonly destroy = vi.fn();
    flow: string | null = null;

    constructor(bytes: Uint8Array) {
      this.rendition = new FakeRendition(bytes[0] ?? 1);
      FakeBook.instances.push(this);
    }
  }

  return {
    epub: vi.fn((bytes: Uint8Array) => new FakeBook(bytes)),
    FakeBook,
    FakeRendition,
    state,
  };
});

vi.mock("epubjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("epubjs")>();
  return { ...actual, default: epubMock.epub };
});
vi.mock("./epubNavigationTools", () => ({
  EpubNavigationTools: class {},
  EpubSelectionTracker: class {
    getSelection(): null {
      return null;
    }
  },
}));
vi.mock("./epubThemes", () => ({
  EpubThemes: class {
    destroy(): void {}
  },
}));

const { FakeBook, FakeRendition, state } = epubMock;
const FILE_A = makeFile("Books/A.epub");
const FILE_B = makeFile("Books/B.epub");
const CFI_A = "epubcfi(/6/8!/4/2/1:0)";
const CFI_B = "epubcfi(/6/22!/4/2/9:0)";

interface FlowHost extends EpubViewHost {
  locations: Record<string, string>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeFile(path: string): TFile {
  return { path, basename: path.split("/").pop() ?? path } as TFile;
}

function createHost(): FlowHost {
  const host: FlowHost = {
    settings: { ...DEFAULT_SETTINGS },
    locations: {},
    updateSettings: vi.fn(async (patch) => {
      // Faithful to main.ts:102-105: merge first, then persist.
      host.settings = { ...host.settings, ...patch };
    }),
    getLastEpubLocation: (path) => host.locations[path] ?? null,
    rememberEpubLocation: vi.fn(async (path, fragment) => {
      host.locations[path] = fragment;
    }),
  };
  return host;
}

function createView(host: EpubViewHost): EpubView {
  const leaf = {
    app: {
      vault: {
        readBinary: async (file: TFile) =>
          new Uint8Array([file.path === FILE_B.path ? 2 : 1]),
      },
    },
  } as unknown as WorkspaceLeaf;
  return new EpubView(leaf, host);
}

async function openInitialBook(
  host: FlowHost = createHost(),
): Promise<{ host: FlowHost; view: EpubView }> {
  const view = createView(host);
  await view.onLoadFile(FILE_A);
  return { host, view };
}

async function swapWhileFlowRenderIsBlocked(
  view: EpubView,
  startToggle: () => Promise<void> = () => view.setFlowMode("scrolled"),
): Promise<{
  finishFlowRender: () => void;
  renditionB: InstanceType<typeof FakeRendition>;
  toggle: Promise<void>;
}> {
  const displayGate = deferred();
  state.initialDisplayGate = displayGate.promise;
  const toggle = startToggle();
  await vi.waitFor(() => {
    expect(FakeRendition.instances).toHaveLength(2);
    expect(FakeRendition.instances[1].display).toHaveBeenCalledWith();
  });

  state.initialDisplayGate = null;
  await view.onLoadFile(FILE_B);
  return {
    finishFlowRender: displayGate.resolve,
    renditionB: FakeRendition.instances[2],
    toggle,
  };
}

beforeAll(() => {
  const proto = HTMLElement.prototype as unknown as {
    createDiv: (options?: { cls?: string }) => HTMLDivElement;
    empty: () => void;
  };
  proto.createDiv = function (
    this: HTMLElement,
    options?: { cls?: string },
  ) {
    const element = document.createElement("div");
    if (options?.cls !== undefined) {
      element.className = options.cls;
    }
    this.appendChild(element);
    return element;
  };
  proto.empty = function (this: HTMLElement) {
    this.replaceChildren();
  };
});

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  state.initialDisplayGate = null;
  state.failNextInitialDisplay = false;
  FakeBook.instances.length = 0;
  FakeRendition.instances.length = 0;
});

describe("F2.2 flow-mode recovery", () => {
  // QC-PROBE-X plus the existing toggle-vs-toggle mutex pin.
  it("keeps a second toggle from driving a replacement book", async () => {
    const host = createHost();
    const saveGate = deferred();
    host.updateSettings = vi.fn(async (patch) => {
      host.settings = { ...host.settings, ...patch };
      await saveGate.promise;
    });
    const { view } = await openInitialBook(host);
    const startToggle = (): Promise<void> => {
      const first = view.setFlowMode("scrolled");
      const second = view.setFlowMode("scrolled");
      expect(host.updateSettings).toHaveBeenCalledOnce();
      saveGate.resolve();
      return Promise.all([first, second]).then(() => undefined);
    };
    const race = await swapWhileFlowRenderIsBlocked(view, startToggle);

    race.finishFlowRender();
    await race.toggle;

    expect(host.updateSettings).toHaveBeenCalledOnce();
    expect(race.renditionB.display).not.toHaveBeenCalledWith(CFI_A);
  });

  // QC-PROBE-Y: a stale redisplay must not become a valid write for B.
  it("keeps book B's saved CFI when book A's flow render is superseded", async () => {
    const host = createHost();
    host.locations[FILE_B.path] = `#${CFI_B}`;
    const { view } = await openInitialBook(host);
    const race = await swapWhileFlowRenderIsBlocked(view);
    vi.useFakeTimers();

    race.finishFlowRender();
    await race.toggle;
    await vi.advanceTimersByTimeAsync(150);

    expect(host.locations[FILE_B.path]).toBe(`#${CFI_B}`);
  });

  // QC-PROBE-Z2: rejecting A's CFI in B must not recover A over B.
  it("does not replace book B when book A's stale CFI rejects", async () => {
    const { view } = await openInitialBook();
    const race = await swapWhileFlowRenderIsBlocked(view);
    race.renditionB.failedTargets.add(CFI_A);

    race.finishFlowRender();
    await race.toggle.catch(() => undefined);

    expect(FakeBook.instances).toHaveLength(3);
    expect(race.renditionB.destroyed).toBe(false);
    expect(view.file).toBe(FILE_B);
  });

  it("notifies the user when a toggle fails", async () => {
    const { view } = await openInitialBook();
    const error = new Error("toggle failed");
    vi.spyOn(view, "setFlowMode").mockRejectedValue(error);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    (view as unknown as { toggleFlowMode(): void }).toggleFlowMode();

    await vi.waitFor(() => {
      expect(showNotice).toHaveBeenCalledWith(
        "Could not switch EPUB flow mode. The previous mode was restored.",
      );
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Observation Car: could not switch EPUB flow mode",
      error,
    );
  });
});
