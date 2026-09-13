// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { BookDownloadResult } from "./bookDownload";
import type { CatalogFeedClient } from "./catalogBrowser";
import {
  OpenBookloreModalContent,
  type OpenBookloreDownloader,
} from "./openBookloreModal";
import { parseOpenSearchDescription, parseOpdsFeed } from "./opdsParser";
import type { OpdsFeed, OpenSearchDescription } from "./opdsTypes";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const ROOT_URL = "https://booklore.example/api/v1/opds";
const SEARCH_DESCRIPTION_URL = "https://booklore.example/api/v1/opds/search.opds";
const SEARCH_URL = "https://booklore.example/api/v1/opds/catalog?q=Maps";

function fixture(name: string, url: string): OpdsFeed {
  return parseOpdsFeed(readFileSync(join(fixturesDir, name), "utf8"), url);
}

function description(): OpenSearchDescription {
  return parseOpenSearchDescription(
    readFileSync(join(fixturesDir, "opensearch-description.xml"), "utf8"),
    SEARCH_DESCRIPTION_URL,
  );
}

function makeClient(results: OpdsFeed): CatalogFeedClient {
  return {
    getRootFeed: vi.fn(async () => fixture("root-catalog.xml", ROOT_URL)),
    fetchOpenSearchDescription: vi.fn(async () => description()),
    fetchFeed: vi.fn(async (url: string) => {
      expect(url).toBe(SEARCH_URL);
      return results;
    }),
  };
}

function submit(container: HTMLElement, query: string): void {
  const input = container.querySelector("input[type='search']");
  const form = container.querySelector("form");
  if (!(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) {
    throw new Error("search form was not rendered");
  }
  input.value = query;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function findCard(container: HTMLElement, title: string): HTMLElement {
  const card = [...container.querySelectorAll<HTMLElement>(".oc-open-booklore-result")]
    .find((candidate) => candidate.querySelector("h3")?.textContent === title);
  if (card === undefined) throw new Error(`result not found: ${title}`);
  return card;
}

function downloaderResult(
  result: BookDownloadResult = {
    status: "downloaded",
    vaultPath: "Books/Maps of Elsewhere.epub",
  },
) {
  return {
    download: vi.fn<OpenBookloreDownloader["download"]>(async () => result),
  };
}

describe("OpenBookloreModalContent", () => {
  it("searches the advertised OPDS endpoint and downloads the preselected EPUB", async () => {
    const results = fixture("acquisitions-mixed.xml", SEARCH_URL);
    const client = makeClient(results);
    const downloader = downloaderResult();
    const close = vi.fn();
    const notify = vi.fn();
    const container = document.createElement("div");
    const modal = new OpenBookloreModalContent(container, {
      client,
      downloader,
      close,
      notify,
    });

    modal.open();
    submit(container, "Maps");
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".oc-open-booklore-result")).toHaveLength(4);
    });

    const card = findCard(container, "Maps of Elsewhere");
    expect(card.textContent).toContain("J. T. Marlowe");
    expect(card.textContent).toContain("EPUB");
    expect(card.textContent).toContain("PDF");
    const checked = card.querySelector("input:checked");
    expect(checked).toBeInstanceOf(HTMLInputElement);
    expect((checked as HTMLInputElement).value).toBe("application/epub+zip");
    const download = [...card.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Download EPUB");
    download?.click();

    await vi.waitFor(() => expect(downloader.download).toHaveBeenCalledOnce());
    const selected = downloader.download.mock.calls[0][1];
    expect(selected.type).toBe("application/epub+zip");
    expect(notify).toHaveBeenCalledWith("Downloaded: Books/Maps of Elsewhere.epub");
    expect(close).toHaveBeenCalledOnce();
    expect(client.fetchOpenSearchDescription).toHaveBeenCalledWith(
      SEARCH_DESCRIPTION_URL,
    );
  });

  it("lets a touch user select PDF before downloading a mixed-format book", async () => {
    const results = fixture("acquisitions-mixed.xml", SEARCH_URL);
    const downloader = downloaderResult({
      status: "downloaded",
      vaultPath: "Books/Maps of Elsewhere.pdf",
    });
    const container = document.createElement("div");
    const modal = new OpenBookloreModalContent(container, {
      client: makeClient(results),
      downloader,
      close: vi.fn(),
      notify: vi.fn(),
    });

    modal.open();
    submit(container, "Maps");
    await vi.waitFor(() => expect(container.querySelectorAll("article")).toHaveLength(4));
    const card = findCard(container, "Maps of Elsewhere");
    const pdf = card.querySelector("input[value='application/pdf']");
    if (!(pdf instanceof HTMLInputElement)) throw new Error("PDF option not found");
    pdf.checked = true;
    pdf.dispatchEvent(new Event("change", { bubbles: true }));
    const download = [...card.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Download PDF");
    if (download === undefined) throw new Error("PDF download action not found");
    download.click();

    await vi.waitFor(() => expect(downloader.download).toHaveBeenCalledOnce());
    expect(downloader.download.mock.calls[0][1].type).toBe(
      "application/pdf",
    );
  });

  it("shows live MOBI and AZW3 results as unsupported with no download action", async () => {
    const results = fixture(
      "catalog-page17.xml",
      "https://booklore.example/api/v1/opds/catalog?page=17&size=3",
    );
    const client = makeClient(results);
    (client.fetchFeed as ReturnType<typeof vi.fn>).mockImplementation(
      async () => results,
    );
    const downloader = downloaderResult();
    const container = document.createElement("div");
    const modal = new OpenBookloreModalContent(container, {
      client,
      downloader,
      close: vi.fn(),
      notify: vi.fn(),
    });

    modal.open();
    submit(container, "Homer");
    await vi.waitFor(() => expect(container.querySelectorAll("article")).toHaveLength(3));

    expect(container.textContent).toContain("MOBI · unsupported");
    expect(container.textContent).toContain("AZW3 · unsupported");
    expect(container.querySelectorAll(".oc-open-booklore-download")).toHaveLength(0);
    expect(downloader.download).not.toHaveBeenCalled();
  });

  it("renders a safe error and leaves search available for retry", async () => {
    const client: CatalogFeedClient = {
      getRootFeed: vi.fn(async () => {
        throw new Error("Could not reach the Booklore instance.");
      }),
      fetchFeed: vi.fn(),
      fetchOpenSearchDescription: vi.fn(),
    };
    const container = document.createElement("div");
    const modal = new OpenBookloreModalContent(container, {
      client,
      downloader: downloaderResult(),
      close: vi.fn(),
      notify: vi.fn(),
    });

    modal.open();
    submit(container, "Maps");
    await vi.waitFor(() => {
      expect(container.querySelector("[role='alert']")?.textContent).toBe(
        "Could not reach the Booklore instance.",
      );
    });
    expect(container.querySelector("button")?.disabled).toBe(false);
  });

  it("does not continue or touch the DOM when a search resolves after close", async () => {
    let resolveRoot!: (feed: OpdsFeed) => void;
    const client: CatalogFeedClient = {
      getRootFeed: vi.fn(() => new Promise<OpdsFeed>((resolve) => { resolveRoot = resolve; })),
      fetchFeed: vi.fn(),
      fetchOpenSearchDescription: vi.fn(),
    };
    const container = document.createElement("div");
    const modal = new OpenBookloreModalContent(container, {
      client,
      downloader: downloaderResult(),
      close: vi.fn(),
      notify: vi.fn(),
    });

    modal.open();
    submit(container, "Maps");
    modal.destroy();
    container.replaceChildren(document.createTextNode("closed sentinel"));
    resolveRoot(fixture("root-catalog.xml", ROOT_URL));
    await Promise.resolve();
    await Promise.resolve();

    expect(container.textContent).toBe("closed sentinel");
    expect(client.fetchOpenSearchDescription).not.toHaveBeenCalled();
  });
});
