// @vitest-environment jsdom
import {
  Notice,
  type App,
  type Command,
  type Plugin,
  type ViewCreator,
  type WorkspaceLeaf,
} from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";
import { registerBookloreCatalog } from "./catalogRegistration";
import { BOOKLORE_CATALOG_VIEW_TYPE } from "./catalogViewType";

describe("registerBookloreCatalog", () => {
  it("registers the command and opens one catalog leaf", async () => {
    let command: Command | undefined;
    let viewCreator: ViewCreator | undefined;
    const setViewState = vi.fn(async (): Promise<void> => undefined);
    const leaf = { setViewState } as unknown as WorkspaceLeaf;
    const getLeaf = vi.fn(() => leaf);
    const revealLeaf = vi.fn(async (): Promise<void> => undefined);
    const registerView = vi.fn((type: string, creator: ViewCreator): void => {
      expect(type).toBe(BOOKLORE_CATALOG_VIEW_TYPE);
      viewCreator = creator;
    });
    const host = {
      app: {
        workspace: {
          getLeavesOfType: vi.fn((): WorkspaceLeaf[] => []),
          getLeaf,
          revealLeaf,
        },
      } as unknown as App,
      settings: { ...DEFAULT_SETTINGS },
      registerView,
      addCommand(value: Command): Command {
        command = value;
        return value;
      },
    } as unknown as Plugin & { settings: typeof DEFAULT_SETTINGS };

    registerBookloreCatalog(host);

    expect(registerView).toHaveBeenCalledOnce();
    expect(command?.id).toBe("browse-booklore-catalog");
    expect(viewCreator).toBeTypeOf("function");
    const view = viewCreator?.(leaf);
    expect(view?.getViewType()).toBe(BOOKLORE_CATALOG_VIEW_TYPE);
    if (command?.callback === undefined) {
      throw new Error("catalog command callback was not registered");
    }

    await command.callback();

    expect(getLeaf).toHaveBeenCalledOnce();
    expect(getLeaf).toHaveBeenCalledWith("tab");
    expect(setViewState).toHaveBeenCalledOnce();
    expect(setViewState).toHaveBeenCalledWith({
      type: BOOKLORE_CATALOG_VIEW_TYPE,
      active: true,
    });
    expect(revealLeaf).toHaveBeenCalledOnce();
    expect(revealLeaf).toHaveBeenCalledWith(leaf);
  });

  it("logs and surfaces the cause when opening the catalog fails", async () => {
    let command: Command | undefined;
    const failure = new Error("workspace unavailable");
    const leaf = {
      setViewState: vi.fn(async (): Promise<void> => {
        throw failure;
      }),
    } as unknown as WorkspaceLeaf;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const noticeMessages = (
      Notice as unknown as { readonly messages: string[] }
    ).messages;
    noticeMessages.length = 0;
    const host = {
      app: {
        workspace: {
          getLeavesOfType: vi.fn((): WorkspaceLeaf[] => []),
          getLeaf: vi.fn(() => leaf),
          revealLeaf: vi.fn(async (): Promise<void> => undefined),
        },
      } as unknown as App,
      settings: { ...DEFAULT_SETTINGS },
      registerView: vi.fn(),
      addCommand(value: Command): Command {
        command = value;
        return value;
      },
    } as unknown as Plugin & { settings: typeof DEFAULT_SETTINGS };

    try {
      registerBookloreCatalog(host);
      if (command?.callback === undefined) {
        throw new Error("catalog command callback was not registered");
      }

      await command.callback();

      expect(log).toHaveBeenCalledWith(
        "[observation-car] could not open Booklore catalog",
        failure,
      );
      expect(noticeMessages).toEqual([
        "Could not open the Booklore catalog: workspace unavailable",
      ]);
    } finally {
      log.mockRestore();
    }
  });
});
