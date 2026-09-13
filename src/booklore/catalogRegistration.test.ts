// @vitest-environment jsdom
import type {
  App,
  Command,
  Plugin,
  ViewCreator,
  WorkspaceLeaf,
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
});
