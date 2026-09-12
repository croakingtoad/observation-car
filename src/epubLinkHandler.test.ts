import type { App, OpenViewState, PaneType, WorkspaceLeaf } from "obsidian";
import { TFile } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reader = vi.hoisted(() => ({
  openAtFragment: vi.fn<(fragment: string) => Promise<void>>(),
}));

vi.mock("./readers/EpubView", () => ({
  EPUB_VIEW_TYPE: "observation-car-epub",
  EpubView: class {
    file: TFile | null = null;
    openAtFragment = reader.openAtFragment;
  },
}));

import { installEpubLinkHandler } from "./epubLinkHandler";
import { EpubView } from "./readers/EpubView";

function file(path: string): TFile {
  const result = new TFile();
  result.path = path;
  result.basename = path.split("/").at(-1)?.replace(/\.epub$/i, "") ?? "";
  Object.assign(result, { extension: path.split(".").at(-1) ?? "" });
  return result;
}

function appFor(destination: TFile | null, leaves: WorkspaceLeaf[] = []) {
  const original = vi.fn(async () => undefined);
  const newLeaf = {
    view: new EpubView({} as WorkspaceLeaf, {} as never),
    openFile: vi.fn(async (opened: TFile) => {
      (newLeaf.view as EpubView).file = opened;
    }),
  };
  const workspace = {
    openLinkText: original,
    getLeavesOfType: vi.fn(() => leaves),
    revealLeaf: vi.fn(async () => undefined),
    getLeaf: vi.fn((_newLeaf?: PaneType | boolean) => newLeaf),
  };
  const app = {
    workspace,
    metadataCache: {
      getFirstLinkpathDest: vi.fn(() => destination),
    },
  } as unknown as App;
  return { app, workspace, original, newLeaf };
}

describe("installEpubLinkHandler", () => {
  beforeEach(() => {
    reader.openAtFragment.mockReset().mockResolvedValue(undefined);
  });

  it("focuses and relocates an existing reader without duplicating it", async () => {
    const book = file("Books/Test.epub");
    const view = new EpubView({} as WorkspaceLeaf, {} as never);
    view.file = book;
    const leaf = {
      view,
      getViewState: () => ({ type: "observation-car-epub", state: { file: book.path } }),
      loadIfDeferred: vi.fn(async () => undefined),
    } as unknown as WorkspaceLeaf;
    const { app, workspace } = appFor(book, [leaf]);
    installEpubLinkHandler(app);

    await app.workspace.openLinkText(
      "Books/Test.epub#epubcfi(/6/8!/4/2/1:0)",
      "Notes/unrelated.md",
    );

    expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
    expect(leaf.loadIfDeferred).toHaveBeenCalled();
    expect(reader.openAtFragment).toHaveBeenCalledWith("epubcfi(/6/8!/4/2/1:0)");
    expect(workspace.getLeaf).not.toHaveBeenCalled();
  });

  it("reuses a deferred reader leaf from its saved file state", async () => {
    const book = file("Books/Test.epub");
    const deferredLeaf: {
      view: unknown;
      getViewState: () => { type: string; state: { file: string } };
      loadIfDeferred: ReturnType<typeof vi.fn>;
    } = {
      view: { getViewType: () => "observation-car-epub" },
      getViewState: () => ({ type: "observation-car-epub", state: { file: book.path } }),
      loadIfDeferred: vi.fn(async () => {
        const loadedView = new EpubView({} as WorkspaceLeaf, {} as never);
        loadedView.file = book;
        deferredLeaf.view = loadedView;
      }),
    };
    const { app, workspace } = appFor(book, [deferredLeaf as unknown as WorkspaceLeaf]);
    installEpubLinkHandler(app);

    await app.workspace.openLinkText(
      "Books/Test.epub#epubcfi(/6/8!/4/2/1:0)",
      "Notes/unrelated.md",
    );

    expect(deferredLeaf.loadIfDeferred).toHaveBeenCalled();
    expect(workspace.revealLeaf).toHaveBeenCalledWith(deferredLeaf);
    expect(reader.openAtFragment).toHaveBeenCalledWith("epubcfi(/6/8!/4/2/1:0)");
    expect(workspace.getLeaf).not.toHaveBeenCalled();
  });

  it("opens a new reader leaf and then relocates it", async () => {
    const book = file("Books/Test.epub");
    const { app, workspace, newLeaf } = appFor(book);
    installEpubLinkHandler(app);
    const openViewState = {} as OpenViewState;

    await app.workspace.openLinkText(
      "../Books/Test.epub#epubcfi(/6/4!/4/2/1:0)",
      "Notes/unrelated.md",
      "tab",
      openViewState,
    );

    expect(workspace.getLeaf).toHaveBeenCalledWith("tab");
    expect(newLeaf.openFile).toHaveBeenCalledWith(book, openViewState);
    expect(reader.openAtFragment).toHaveBeenCalledWith("epubcfi(/6/4!/4/2/1:0)");
  });

  it("routes a generated spine href and jumps the reader to that item", async () => {
    const book = file("Books/Test.epub");
    const { app, newLeaf } = appFor(book);
    installEpubLinkHandler(app);

    await app.workspace.openLinkText(
      "Books/Test.epub#text/chapter03.xhtml",
      "Notes/unrelated.md",
    );

    expect(newLeaf.openFile).toHaveBeenCalledWith(book, undefined);
    expect(reader.openAtFragment).toHaveBeenCalledWith("text/chapter03.xhtml");
  });

  it("delegates invalid grammar and PDF fragments on an EPUB link", async () => {
    const book = file("Books/Test.epub");
    const { app, original, workspace } = appFor(book);
    installEpubLinkHandler(app);

    await app.workspace.openLinkText("Books/Test.epub#bad href", "source.md");
    await app.workspace.openLinkText("Books/Test.epub#epubcfi(nonsense)", "source.md");
    await app.workspace.openLinkText("Books/Test.epub#page=7", "source.md");

    expect(original).toHaveBeenCalledTimes(3);
    expect(workspace.getLeaf).not.toHaveBeenCalled();
    expect(reader.openAtFragment).not.toHaveBeenCalled();
  });

  it("delegates links that are not resolvable EPUB CFI links", async () => {
    const { app, original } = appFor(null);
    installEpubLinkHandler(app);

    await app.workspace.openLinkText("note.md#heading", "source.md", true);
    await app.workspace.openLinkText("missing.epub#epubcfi(/6/2)", "source.md");

    expect(original).toHaveBeenNthCalledWith(1, "note.md#heading", "source.md", true, undefined);
    expect(original).toHaveBeenNthCalledWith(
      2,
      "missing.epub#epubcfi(/6/2)",
      "source.md",
      undefined,
      undefined,
    );
  });

  it("restores the original openLinkText method on uninstall", () => {
    const { app, workspace, original } = appFor(file("Books/Test.epub"));
    const uninstall = installEpubLinkHandler(app);

    expect(workspace.openLinkText).not.toBe(original);
    uninstall();
    expect(workspace.openLinkText).toBe(original);
  });
});
