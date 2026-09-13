import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";
import {
  getBookloreDownloader,
  registerBookloreDownloads,
} from "./bookDownloadRegistration";

describe("registerBookloreDownloads", () => {
  it("hydrates the persisted index onto the live settings object", async () => {
    const updateSettings = vi.fn(
      async (_patch: Partial<typeof DEFAULT_SETTINGS>): Promise<void> =>
        undefined,
    );
    const host = {
      app: {} as App,
      settings: { ...DEFAULT_SETTINGS },
      loadData: async (): Promise<unknown> => ({
        ...DEFAULT_SETTINGS,
        downloadIndex: {
          "urn:booklore:book:92": {
            vaultPath: "Books/Surprised by Grace.epub",
            updated: "2026-09-11T12:00:00Z",
          },
        },
      }),
      updateSettings,
    };

    const downloader = await registerBookloreDownloads(host);
    expect(getBookloreDownloader(host)).toBe(downloader);
    expect(host.settings).toHaveProperty("downloadIndex", {
      "urn:booklore:book:92": {
        vaultPath: "Books/Surprised by Grace.epub",
        updated: "2026-09-11T12:00:00Z",
      },
    });

    expect(updateSettings).not.toHaveBeenCalled();
  });
});
