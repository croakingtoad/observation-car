// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS } from "../settings";
import { EpubView, type EpubViewHost } from "./EpubView";

vi.mock("./epubStyles", () => ({
  EpubStyles: class {
    destroy(): void {}
  },
}));

const showNotice = vi.hoisted(() => vi.fn());

vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return { ...actual, Notice: showNotice };
});

const epubMock = vi.hoisted(() => {
  const state = {
    initialDisplayGate: null as Promise<void> | null,
    targetedDisplayGates: new Map<string, Promise<void>[]>(),
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
      const gates = state.targetedDisplayGates.get(target);
      const gate = gates?.shift();
      if (gates?.length === 0) {
        state.targetedDisplayGates.delete(target);
      }
      if (gate !== undefined) {
        await gate;
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
  EpubNavigationTools: class {
    destroy(): void {}
  },
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
const CFI_TURN = "epubcfi(/6/14!/4/2/12:0)";
const CFI_UNENCODABLE = "epubcfi(/6/8[kapitel-ü]!/4/2/1:0)";

interface FlowHost extends EpubViewHost {
  beforeSettingsWrite: (
    patch: Parameters<EpubViewHost["updateSettings"]>[0],
  ) => Promise<void>;
  locations: Record<string, string>;
  persistSettings: () => Promise<void>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function gateTargetedDisplay(target: string): { resolve: () => void } {
  const gate = deferred();
  const gates = state.targetedDisplayGates.get(target) ?? [];
  gates.push(gate.promise);
  state.targetedDisplayGates.set(target, gates);
  return { resolve: gate.resolve };
}

async function waitForTargetedDisplay(
  renditionIndex: number,
  target: string,
): Promise<InstanceType<typeof FakeRendition>> {
  return vi.waitFor(() => {
    const rendition = FakeRendition.instances[renditionIndex];
    expect(rendition).toBeDefined();
    expect(rendition.display).toHaveBeenCalledWith(target);
    return rendition;
  });
}

function makeFile(path: string): TFile {
  return { path, basename: path.split("/").pop() ?? path } as TFile;
}

function createHost(options: {
  beforeSettingsWrite?: FlowHost["beforeSettingsWrite"];
  persistSettings?: FlowHost["persistSettings"];
} = {}): FlowHost {
  const stylesheetModes: Record<string, "theme" | "book"> = {};
  const host: FlowHost = {
    settings: { ...DEFAULT_SETTINGS },
    beforeSettingsWrite:
      options.beforeSettingsWrite ?? (async () => undefined),
    locations: {},
    persistSettings: options.persistSettings ?? (async () => undefined),
    updateSettings: vi.fn(async (patch) => {
      await host.beforeSettingsWrite(patch);
      // Faithful to main.ts:102-105: merge, then await persistence.
      host.settings = { ...host.settings, ...patch };
      await host.persistSettings();
    }),
    getLastEpubLocation: (path) => host.locations[path] ?? null,
    rememberEpubLocation: vi.fn(async (path, fragment) => {
      host.locations[path] = fragment;
    }),
    getEpubStylesheetMode: (path) => stylesheetModes[path] ?? "theme",
    setEpubStylesheetMode: async (path, mode) => {
      if (mode === "theme") delete stylesheetModes[path];
      else stylesheetModes[path] = mode;
    },
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

function loadViewFile(view: EpubView, file: TFile): Promise<void> {
  // Obsidian's runtime method is absent from its current public typings.
  return (view as EpubView & {
    loadFile(file: TFile): Promise<void>;
  }).loadFile(file);
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

function expectBookStillInstalled(
  view: EpubView,
  file: TFile,
  book: InstanceType<typeof FakeBook>,
  bookCount: number,
): void {
  const reader = view as unknown as {
    renderedFile: TFile | null;
    rendition: InstanceType<typeof FakeRendition> | null;
  };
  expect(FakeBook.instances).toHaveLength(bookCount);
  expect(reader.renderedFile).toBe(file);
  expect(book.rendition.destroyed).toBe(false);
  expect(reader.rendition).toBe(book.rendition);
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
  state.targetedDisplayGates.clear();
  state.failNextInitialDisplay = false;
  FakeBook.instances.length = 0;
  FakeRendition.instances.length = 0;
});

describe("F2.2 flow-mode recovery", () => {
  // QC-PROBE-W / MX-S1: the first ownership check after settings save.
  it("does not render book A after its settings write is superseded", async () => {
    const persistGate = deferred();
    const host = createHost({
      persistSettings: async () => persistGate.promise,
    });
    const { view } = await openInitialBook(host);

    const toggle = view.setFlowMode("scrolled");
    await vi.waitFor(() => {
      expect(host.updateSettings).toHaveBeenCalledOnce();
    });
    expect(host.settings.epubFlowMode).toBe("scrolled");

    await view.onLoadFile(FILE_B);
    const bookB = FakeBook.instances[1];
    persistGate.resolve();
    await toggle;

    expectBookStillInstalled(view, FILE_B, bookB, 2);
  });

  // QC-PROBE-V / MX-S4: ownership after a parked rollback write.
  it("does not recover book A after its rollback is superseded", async () => {
    const rollbackGate = deferred();
    let settingsWrite = 0;
    const host = createHost({
      persistSettings: async () => {
        settingsWrite += 1;
        if (settingsWrite === 2) {
          await rollbackGate.promise;
        }
      },
    });
    const { view } = await openInitialBook(host);
    state.failNextInitialDisplay = true;

    const toggle = view.setFlowMode("scrolled");
    await vi.waitFor(() => {
      expect(host.updateSettings).toHaveBeenCalledTimes(2);
    });
    expect(host.settings.epubFlowMode).toBe("paginated");
    expect(FakeBook.instances[1].flow).toBe("scrolled");

    await view.onLoadFile(FILE_B);
    const bookB = FakeBook.instances[2];
    rollbackGate.resolve();
    await toggle;

    expectBookStillInstalled(view, FILE_B, bookB, 3);
  });

  // Finding 21: recovery must not swallow a page turn's pending debounce.
  it("saves a pending page turn when a failed toggle restores the reader", async () => {
    vi.useFakeTimers();
    const { host, view } = await openInitialBook();
    FakeRendition.instances[0].emitRelocated(CFI_TURN);
    state.failNextInitialDisplay = true;

    await expect(view.setFlowMode("scrolled")).rejects.toThrow("render failed");

    expect(host.settings.epubFlowMode).toBe("paginated");
    expect(FakeBook.instances).toHaveLength(3);
    expect(FakeBook.instances[2].flow).toBe("paginated");
    expect(FakeRendition.instances[2].display).toHaveBeenCalledWith(CFI_TURN);
    expect(host.locations[FILE_A.path]).toBe(`#${CFI_TURN}`);
  });

  it("keeps a successful toggle when its CFI cannot be encoded", async () => {
    const { host, view } = await openInitialBook();
    FakeRendition.instances[0].location = {
      start: { cfi: CFI_UNENCODABLE, href: "chapter.xhtml" },
    };
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    (view as unknown as { toggleFlowMode(): void }).toggleFlowMode();
    await vi.waitFor(() => {
      expect(consoleError.mock.calls.length + showNotice.mock.calls.length)
        .toBeGreaterThan(0);
    });

    expect(host.settings.epubFlowMode).toBe("scrolled");
    expect(FakeBook.instances).toHaveLength(2);
    expect(FakeBook.instances[1].flow).toBe("scrolled");
    expect(showNotice).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "Observation Car: could not save EPUB location",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

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
    expect(FakeBook.instances[1].flow).toBe("scrolled");
    expect(race.renditionB.display).not.toHaveBeenCalledWith(CFI_A);
  });

  // The ownership conjuncts are equivalent only while EpubView.ts:131 is
  // `this.file`'s single writer, :608 in disposeReader is renderGeneration's
  // single bump, and the path between them cannot suspend: renderBook reaches
  // the void disposeReader at :250 before its first suspension at readBinary
  // (:253). If any fact changes, both conjunct pins become independently
  // observable and must be revisited.
  // QC-PROBE-Y: a stale redisplay must not overwrite a newer write for A.
  it("keeps book A's newer CFI when its stale redisplay finishes", async () => {
    const targetedDisplay = gateTargetedDisplay(CFI_A);
    const { host, view } = await openInitialBook();
    const toggle = view.setFlowMode("scrolled");
    await waitForTargetedDisplay(1, CFI_A);

    await loadViewFile(view, FILE_B);
    await loadViewFile(view, FILE_A);
    vi.useFakeTimers();
    FakeRendition.instances[3].emitRelocated(CFI_TURN);
    await vi.advanceTimersByTimeAsync(150);
    expect(host.rememberEpubLocation).toHaveBeenCalledWith(
      FILE_A.path,
      `#${CFI_TURN}`,
    );
    expect(host.locations[FILE_A.path]).toBe(`#${CFI_TURN}`);

    targetedDisplay.resolve();
    await toggle;
    await vi.advanceTimersByTimeAsync(150);

    expect(host.locations[FILE_A.path]).toBe(`#${CFI_TURN}`);
  });

  // QC-PROBE-Z2: rejecting A's stale CFI must not recover A over B.
  it("does not replace book B when book A's stale redisplay rejects", async () => {
    const targetedDisplay = gateTargetedDisplay(CFI_A);
    const { view } = await openInitialBook();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const toggle = view.setFlowMode("scrolled");
    const staleRendition = await waitForTargetedDisplay(1, CFI_A);
    staleRendition.failedTargets.add(CFI_A);

    await loadViewFile(view, FILE_B);
    const bookB = FakeBook.instances[2];

    targetedDisplay.resolve();
    await toggle;

    expect(staleRendition.display).toHaveBeenCalledWith(CFI_A);
    expect(consoleError).toHaveBeenCalledWith(
      "Observation Car: abandoned EPUB flow-mode failure",
      expect.any(Error),
    );
    expectBookStillInstalled(view, FILE_B, bookB, 3);
  });

  it("silently abandons a superseded recovery redisplay", async () => {
    const targetedDisplay = gateTargetedDisplay(CFI_A);
    const { view } = await openInitialBook();
    state.failNextInitialDisplay = true;

    const toggle = view.setFlowMode("scrolled");
    await waitForTargetedDisplay(2, CFI_A);

    await loadViewFile(view, FILE_B);
    const bookB = FakeBook.instances[3];
    targetedDisplay.resolve();
    await expect(toggle).resolves.toBeUndefined();

    expectBookStillInstalled(view, FILE_B, bookB, 4);
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
