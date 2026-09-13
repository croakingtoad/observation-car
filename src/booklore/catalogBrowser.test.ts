// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseOpenSearchDescription, parseOpdsFeed } from "./opdsParser";
import type {
  OpdsEntry,
  OpdsFeed,
  OpenSearchDescription,
} from "./opdsTypes";
import {
  buildOpenSearchUrl,
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
const OPEN_SEARCH_URL =
  "https://booklore.example/api/v1/opds/search.opds";
const SEARCH_URL =
  "https://booklore.example/api/v1/opds/catalog?q=Turco";

function fixture(name: string, url: string): OpdsFeed {
  return parseOpdsFeed(readFileSync(join(fixturesDir, name), "utf8"), url);
}

function openSearchFixture(): OpenSearchDescription {
  return parseOpenSearchDescription(
    readFileSync(join(fixturesDir, "opensearch-description.xml"), "utf8"),
    OPEN_SEARCH_URL,
  );
}

function makeClient(
  feeds: ReadonlyMap<string, OpdsFeed>,
  descriptions: ReadonlyMap<string, OpenSearchDescription> = new Map(),
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
    async fetchOpenSearchDescription(
      url: string,
    ): Promise<OpenSearchDescription> {
      calls.push(url);
      const description = descriptions.get(url);
      if (description === undefined) {
        throw new Error(`missing OpenSearch fixture for ${url}`);
      }
      return description;
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
      async fetchOpenSearchDescription(): Promise<OpenSearchDescription> {
        throw new Error("unexpected OpenSearch request");
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

describe("F5.3 CatalogBrowser search", () => {
  it("lazily searches the live advertised template and reuses acquisition entries", async () => {
    const root = fixture("root-catalog.xml", ROOT_URL);
    const results = fixture("catalog-search-turco.xml", SEARCH_URL);
    const client = makeClient(
      new Map([
        [ROOT_URL, root],
        [SEARCH_URL, results],
      ]),
      new Map([[OPEN_SEARCH_URL, openSearchFixture()]]),
    );
    const container = document.createElement("div");
    const browser = new CatalogBrowser(container, client);

    await browser.openRoot();
    expect(client.calls).toEqual(["root"]);

    const input = container.querySelector("input[type='search']");
    const form = container.querySelector("form[role='search']");
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(form).toBeInstanceOf(HTMLFormElement);
    if (!(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) {
      throw new Error("search form not rendered");
    }
    input.value = "Turco";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(container.querySelector("[aria-busy='true']")).toBeNull();
      expect(container.querySelectorAll(".oc-catalog-acquisition-entry")).toHaveLength(2);
    });
    expect(client.calls).toEqual(["root", OPEN_SEARCH_URL, SEARCH_URL]);
    expect(container.textContent).toContain("1–2 of 2 books");
    expect(container.textContent).toContain("Turco, Lewis");
    expect(container.textContent).toContain("Lewis Turco");
  });

  it("takes the query parameter name from the template and URL-encodes the term", () => {
    const description = openSearchFixture();
    description.urls[0].template =
      "https://booklore.example/api/v1/opds/catalog?lookup={searchTerms}&scope=books";

    expect(buildOpenSearchUrl(description, "Poetic craft & form")).toBe(
      "https://booklore.example/api/v1/opds/catalog?lookup=Poetic%20craft%20%26%20form&scope=books",
    );
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
