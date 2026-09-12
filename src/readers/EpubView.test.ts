import { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type EpubFlowMode } from "../settings";
import { EpubView, type EpubViewHost } from "./EpubView";

const showNotice = vi.hoisted(() => vi.fn());

vi.mock("obsidian", () => ({
  FileView: class {},
  Notice: showNotice,
  TFile: class {},
  WorkspaceLeaf: class {},
}));
vi.mock("epubjs", () => ({
  Book: class {},
  default: vi.fn(),
  Rendition: class {},
}));
vi.mock("./epubNavigationTools", () => ({ EpubNavigationTools: class {} }));
vi.mock("./epubThemes", () => ({ EpubThemes: class {} }));

interface FlowHarnessState {
  renderedFlowMode: EpubFlowMode;
}

function createHost(): EpubViewHost {
  const host: EpubViewHost = {
    settings: { ...DEFAULT_SETTINGS },
    updateSettings: vi.fn(async (patch) => {
      host.settings = { ...host.settings, ...patch };
    }),
  };
  return host;
}

function createView(
  host: EpubViewHost,
  renderBook: (file: TFile, flowMode: EpubFlowMode) => Promise<void>,
): EpubView {
  const view = Object.create(EpubView.prototype) as EpubView;
  Object.assign(view, {
    file: Object.create(TFile.prototype) as TFile,
    flowModeChange: null,
    host,
    renderedFlowMode: "paginated",
    renderBook,
    rendition: {
      display: vi.fn(async () => undefined),
      location: { start: { cfi: "epubcfi(/6/2)" } },
    },
  });
  return view;
}

describe("F2.2 flow-mode recovery", () => {
  it("keeps a second toggle from starting another render", async () => {
    let releaseSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const host = createHost();
    host.updateSettings = vi.fn(async (patch) => {
      host.settings = { ...host.settings, ...patch };
      await saveGate;
    });
    const renderBook = vi.fn(async () => undefined);
    const view = createView(host, renderBook);

    const first = view.setFlowMode("scrolled");
    const second = view.setFlowMode("paginated");

    expect(host.updateSettings).toHaveBeenCalledOnce();
    expect(renderBook).not.toHaveBeenCalled();
    if (releaseSave === undefined) {
      throw new Error("Settings save did not start");
    }
    releaseSave();
    await Promise.all([first, second]);

    expect(host.updateSettings).toHaveBeenCalledOnce();
    expect(renderBook).toHaveBeenCalledOnce();
    expect(renderBook).toHaveBeenCalledWith(expect.any(TFile), "scrolled");
  });

  it("rolls back the setting and restores the previous reader after a render failure", async () => {
    const host = createHost();
    let view: EpubView;
    const renderBook = vi.fn(async (_file: TFile, mode: EpubFlowMode) => {
      Object.assign(view, { renderedFlowMode: mode } satisfies FlowHarnessState);
      if (mode === "scrolled") {
        throw new Error("render failed");
      }
    });
    view = createView(host, renderBook);

    await expect(view.setFlowMode("scrolled")).rejects.toThrow("render failed");

    expect(host.updateSettings).toHaveBeenNthCalledWith(1, { epubFlowMode: "scrolled" });
    expect(host.updateSettings).toHaveBeenNthCalledWith(2, { epubFlowMode: "paginated" });
    expect(renderBook).toHaveBeenNthCalledWith(1, expect.any(TFile), "scrolled");
    expect(renderBook).toHaveBeenNthCalledWith(2, expect.any(TFile), "paginated");
    expect(host.settings.epubFlowMode).toBe("paginated");
  });

  it("notifies the user when a toggle fails", async () => {
    const host = createHost();
    const view = createView(host, vi.fn(async () => undefined));
    const error = new Error("toggle failed");
    Object.assign(view, {
      setFlowMode: vi.fn(async () => {
        throw error;
      }),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

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
    consoleError.mockRestore();
  });
});
