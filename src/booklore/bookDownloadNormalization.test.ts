import type { App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settingsMocks = vi.hoisted(() => ({
  normalizeBaseUrl: vi.fn<(value: string) => string>(),
}));

vi.mock("../settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings")>();
  return {
    ...actual,
    normalizeBaseUrl: settingsMocks.normalizeBaseUrl,
  };
});

import { DEFAULT_SETTINGS } from "../settings";
import { BookloreDownloader } from "./bookDownload";

describe("BookloreDownloader credential origin normalization", () => {
  beforeEach(() => {
    settingsMocks.normalizeBaseUrl.mockReset();
    settingsMocks.normalizeBaseUrl.mockReturnValue("https://trusted.example");
  });

  it("trusts the origin returned by the shared base URL normalizer", async () => {
    const transport = vi.fn(async (_url: string, headers: Record<string, string>) => {
      expect(headers.Authorization).toMatch(/^Basic /);
      return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
      };
    });
    const app = {
      vault: {
        adapter: {
          exists: async () => false,
          writeBinary: vi.fn(async () => {}),
        },
        getAbstractFileByPath: () => null,
        createFolder: vi.fn(async () => {}),
      },
    } as unknown as App;
    const configuredBaseUrl = "https://configured.example/untrusted";
    const downloader = new BookloreDownloader({
      app,
      settings: () => ({
        ...DEFAULT_SETTINGS,
        booksFolder: "",
        bookloreBaseUrl: configuredBaseUrl,
        opdsUsername: "reader",
        opdsPassword: "secret",
      }),
      transport,
      saveIndex: async () => {},
    });

    await downloader.download(
      { id: "book-1", title: "Trusted", updated: "v1" },
      {
        type: "application/epub+zip",
        href: "https://trusted.example/book.epub",
      },
    );

    expect(settingsMocks.normalizeBaseUrl).toHaveBeenCalledWith(
      configuredBaseUrl,
    );
    expect(transport).toHaveBeenCalledOnce();
  });
});
