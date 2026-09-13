// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseOpdsFeed } from "./opdsParser";
import type { OpdsEntry, OpdsFeed } from "./opdsTypes";
import {
  CatalogBrowser,
  renderAcquisitionEntry,
  type CatalogFeedClient,
} from "./catalogBrowser";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const ROOT_URL = "https://booklore.example/api/v1/opds";
const LIBRARIES_URL = "https://booklore.example/api/v1/opds/libraries";
const LIBRARY_URL =
  "https://booklore.example/api/v1/opds/catalog?libraryId=1";
const ALL_BOOKS_URL =
  "https://booklore.example/api/v1/opds/catalog?page=1&size=50";
const PAGE1_URL =
  "https://booklore.example/api/v1/opds/catalog?page=1&size=3";
const PAGE2_URL =
  "https://booklore.example/api/v1/opds/catalog?page=2&size=3";

function fixture(name: string, url: string): OpdsFeed {
  return parseOpdsFeed(readFileSync(join(fixturesDir, name), "utf8"), url);
}

function makeClient(
  feeds: ReadonlyMap<string, OpdsFeed>,
): CatalogFeedClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getRootFeed(): Promise<OpdsFeed> {
      calls.push("root");
      const root = feeds.get(ROOT_URL);
      if (root === undefined) throw new Error("missing root fixture");
      return root;
    },
    async fetchFeed(url: string): Promise<OpdsFeed> {
      calls.push(url);
      const feed = feeds.get(url);
      if (feed === undefined) throw new Error(`missing fixture for ${url}`);
      return feed;
    },
  };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${label}`);
  }
  return match;
}

async function click(container: HTMLElement, label: string): Promise<void> {
  button(container, label).click();
  await vi.waitFor(() => {
    expect(container.querySelector("[aria-busy='true']")).toBeNull();
  });
}

describe("F5.2 CatalogBrowser", () => {
  it("renders the live root and navigates through a navigation feed to books", async () => {
    const root = fixture("root-catalog.xml", ROOT_URL);
    const libraries = fixture("nav-libraries.xml", LIBRARIES_URL);
    const library = fixture("catalog-page1.xml", LIBRARY_URL);
    const client = makeClient(
      new Map([
        [ROOT_URL, root],
        [LIBRARIES_URL, libraries],
        [LIBRARY_URL, library],
      ]),
    );
    const container = document.createElement("div");
    const browser = new CatalogBrowser(container, client);

    await browser.openRoot();

    expect(container.querySelector("h2")?.textContent).toBe("Booklore Catalog");
    expect(container.querySelectorAll(".oc-catalog-navigation-entry")).toHaveLength(8);
    expect(container.textContent).toContain("Browse all available books");

    await click(container, "Libraries");
    expect(container.querySelector("h2")?.textContent).toBe("Libraries");
    expect(container.textContent).toContain("Marty's Library");

    await click(container, "Marty's Library");
    expect(container.querySelectorAll(".oc-catalog-acquisition-entry")).toHaveLength(3);
    expect(container.textContent).toContain("68 books");
    expect(container.textContent).toContain("Turco, Lewis");
    expect(container.textContent).toContain("EPUB");
    expect(container.textContent).toContain("PDF");
    expect(client.calls).toEqual(["root", LIBRARIES_URL, LIBRARY_URL]);
  });

  it("does not follow rel=next until the user asks for the next page", async () => {
    const root = fixture("root-catalog.xml", ROOT_URL);
    const page1 = fixture("catalog-page1.xml", ALL_BOOKS_URL);
    const page2 = fixture("catalog-page2.xml", PAGE2_URL);
    const client = makeClient(
      new Map([
        [ROOT_URL, root],
        [ALL_BOOKS_URL, page1],
        [PAGE2_URL, page2],
      ]),
    );
    const container = document.createElement("div");
    const browser = new CatalogBrowser(container, client);

    await browser.openRoot();
    await click(container, "All Books");

    expect(client.calls).toEqual(["root", ALL_BOOKS_URL]);
    expect(button(container, "Next").disabled).toBe(false);

    await click(container, "Next");
    expect(client.calls).toEqual(["root", ALL_BOOKS_URL, PAGE2_URL]);
    expect(container.textContent).toContain("4–6 of 68 books");
    expect(button(container, "Previous").disabled).toBe(false);
  });

  it("opens an acquisition entry as a browsable detail without fetching it", async () => {
    const root = fixture("root-catalog.xml", ROOT_URL);
    const page1 = fixture("catalog-page1.xml", ALL_BOOKS_URL);
    const client = makeClient(
      new Map([
        [ROOT_URL, root],
        [ALL_BOOKS_URL, page1],
      ]),
    );
    const container = document.createElement("div");
    const browser = new CatalogBrowser(container, client);

    await browser.openRoot();
    await click(container, "All Books");
    const bookTitle = page1.entries[0].title;
    await click(container, bookTitle);

    expect(container.querySelector(".oc-catalog-book-detail h2")?.textContent).toBe(
      bookTitle,
    );
    expect(container.textContent).toContain("Lightning Source Inc");
    expect(container.textContent).toContain("Available format: EPUB");
    expect(client.calls).toEqual(["root", ALL_BOOKS_URL]);

    await click(container, "Back");
    expect(container.querySelectorAll(".oc-catalog-acquisition-entry")).toHaveLength(3);
  });

  it("keeps the last feed visible and offers retry after a navigation error", async () => {
    const root = fixture("root-catalog.xml", ROOT_URL);
    const client: CatalogFeedClient & { attempts: number } = {
      attempts: 0,
      async getRootFeed(): Promise<OpdsFeed> {
        return root;
      },
      async fetchFeed(): Promise<OpdsFeed> {
        this.attempts += 1;
        throw new Error("safe display message");
      },
    };
    const container = document.createElement("div");
    const browser = new CatalogBrowser(container, client);

    await browser.openRoot();
    await click(container, "Libraries");

    expect(container.querySelector("h2")?.textContent).toBe("Booklore Catalog");
    expect(container.textContent).toContain("safe display message");
    expect(button(container, "Retry")).toBeDefined();
  });
});

describe("renderAcquisitionEntry", () => {
  it("is a reusable selector for search-result acquisition feeds", () => {
    const entry: OpdsEntry = fixture("catalog-page1.xml", PAGE1_URL).entries[0];
    const onSelect = vi.fn();

    const element = renderAcquisitionEntry(entry, onSelect);
    element.click();

    expect(element.classList.contains("oc-catalog-acquisition-entry")).toBe(true);
    expect(element.textContent).toContain(entry.title);
    expect(element.textContent).toContain("EPUB");
    expect(onSelect).toHaveBeenCalledWith(entry);
  });
});
