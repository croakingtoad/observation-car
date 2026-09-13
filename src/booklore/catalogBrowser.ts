import type {
  OpdsEntry,
  OpdsFeed,
  OpdsLink,
  OpenSearchDescription,
  OpenSearchUrl,
} from "./opdsTypes";

/** The read-only client surface needed by the catalog browser. */
export interface CatalogFeedClient {
  getRootFeed(): Promise<OpdsFeed>;
  fetchFeed(url: string): Promise<OpdsFeed>;
  fetchOpenSearchDescription(url: string): Promise<OpenSearchDescription>;
}

export type AcquisitionEntryHandler = (entry: OpdsEntry) => void;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className !== undefined) result.className = className;
  return result;
}

function textElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const result = element(tag, className);
  result.textContent = text;
  return result;
}

function button(label: string, className?: string): HTMLButtonElement {
  const result = textElement("button", label, className);
  result.type = "button";
  return result;
}

function displayAuthors(entry: OpdsEntry): string {
  const uniqueAuthors = [...new Set(entry.authors)];
  return uniqueAuthors.length > 0 ? uniqueAuthors.join(", ") : "Unknown author";
}

function displayFormat(link: OpdsLink): string {
  if (link.title.trim() !== "") return link.title.trim();
  switch (link.type.toLowerCase()) {
    case "application/epub+zip":
      return "EPUB";
    case "application/pdf":
      return "PDF";
    case "application/x-mobipocket-ebook":
      return "MOBI";
    case "application/vnd.amazon.ebook":
      return "AZW3";
    default:
      return link.type || "Book";
  }
}

function formatLabels(entry: OpdsEntry): string[] {
  return [...new Set(entry.acquisitions.map(displayFormat))];
}

/**
 * Render one acquisition result as a reusable, keyboard-accessible selector.
 *
 * F5.3 imports this function for search results; callers decide what selection
 * does, while browse mode opens the entry's local detail view.
 */
export function renderAcquisitionEntry(
  entry: OpdsEntry,
  onSelect: AcquisitionEntryHandler,
): HTMLButtonElement {
  const result = button("", "oc-catalog-acquisition-entry");
  result.setAttribute("aria-label", entry.title || "Untitled book");
  result.append(
    textElement("span", entry.title || "Untitled book", "oc-catalog-entry-title"),
    textElement("span", displayAuthors(entry), "oc-catalog-entry-author"),
  );

  const formats = element("span", "oc-catalog-entry-formats");
  for (const label of formatLabels(entry)) {
    formats.append(textElement("span", label, "oc-catalog-format-badge"));
  }
  result.append(formats);
  result.addEventListener("click", () => onSelect(entry));
  return result;
}

function renderNavigationEntry(
  entry: OpdsEntry,
  onNavigate: (url: string) => void,
): HTMLElement {
  const result = element("article", "oc-catalog-navigation-entry");
  const navigate = button(entry.title || "Untitled section");
  navigate.addEventListener("click", () => {
    if (entry.navigation !== null) onNavigate(entry.navigation.href);
  });
  result.append(navigate);
  if (entry.summary !== "") {
    result.append(textElement("p", entry.summary));
  }
  if (entry.navigation === null) {
    navigate.disabled = true;
    navigate.title = "This catalog entry has no navigation link.";
  }
  return result;
}

function feedCount(feed: OpdsFeed): string {
  const { totalResults, startIndex } = feed.opensearch;
  if (totalResults === null) {
    const noun = feed.entries.length === 1 ? "item" : "items";
    return `${feed.entries.length} ${noun}`;
  }
  if (feed.entries.length === 0 || startIndex === null) {
    return `${totalResults} ${totalResults === 1 ? "book" : "books"}`;
  }
  const end = Math.min(totalResults, startIndex + feed.entries.length - 1);
  return `${startIndex}–${end} of ${totalResults} ${
    totalResults === 1 ? "book" : "books"
  }`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not load this catalog feed.";
}

function isAcquisitionFeed(searchUrl: OpenSearchUrl): boolean {
  const mediaType = searchUrl.type
    .toLowerCase()
    .split(";")
    .map((part) => part.trim());
  return (
    mediaType[0] === "application/atom+xml" &&
    mediaType.includes("profile=opds-catalog") &&
    mediaType.includes("kind=acquisition")
  );
}

/** Fill the acquisition template advertised by the OpenSearch document. */
export function buildOpenSearchUrl(
  description: OpenSearchDescription,
  query: string,
): string {
  const searchUrl = description.urls.find(isAcquisitionFeed);
  if (searchUrl === undefined) {
    throw new Error("Booklore does not advertise an OPDS acquisition search.");
  }

  // OpenSearch marks optional parameters with a trailing `?`. Booklore's live
  // template uses the required form, but accepting both avoids hardcoding its
  // `q` parameter name or reconstructing the server URL ourselves.
  const searchTerms = /\{searchTerms\??\}/g;
  if (searchTerms.test(searchUrl.template) === false) {
    throw new Error("Booklore advertised an unusable OpenSearch template.");
  }
  return searchUrl.template.replace(
    searchTerms,
    encodeURIComponent(query),
  );
}

/** Stateful renderer for root, navigation, and paged acquisition feeds. */
export class CatalogBrowser {
  private readonly container: HTMLElement;
  private readonly client: CatalogFeedClient;
  private feeds: OpdsFeed[] = [];
  private readonly searchDescriptions = new Map<string, OpenSearchDescription>();
  private searchQuery = "";
  private requestEpoch = 0;
  private disposed = false;

  constructor(container: HTMLElement, client: CatalogFeedClient) {
    this.container = container;
    this.client = client;
  }

  /** Load the root only when the view opens; no child or next feed is prefetched. */
  async openRoot(): Promise<void> {
    await this.load(
      () => this.client.getRootFeed(),
      () => this.openRoot(),
      true,
    );
  }

  destroy(): void {
    this.disposed = true;
    this.requestEpoch += 1;
    this.container.replaceChildren();
  }

  private async load(
    request: () => Promise<OpdsFeed>,
    retry: () => Promise<void>,
    reset: boolean,
  ): Promise<void> {
    const epoch = ++this.requestEpoch;
    this.renderLoading();
    try {
      const feed = await request();
      if (this.disposed || epoch !== this.requestEpoch) return;
      this.feeds = reset ? [feed] : [...this.feeds, feed];
      this.renderCurrentFeed();
    } catch (error) {
      if (this.disposed || epoch !== this.requestEpoch) return;
      this.renderCurrentFeed();
      this.renderError(errorMessage(error), () => void retry());
    }
  }

  private async navigate(url: string): Promise<void> {
    await this.load(
      () => this.client.fetchFeed(url),
      () => this.navigate(url),
      false,
    );
  }

  private async search(
    descriptionUrl: string,
    query: string,
  ): Promise<void> {
    const normalizedQuery = query.trim();
    if (normalizedQuery === "") return;
    this.searchQuery = normalizedQuery;
    await this.load(
      async () => {
        let description = this.searchDescriptions.get(descriptionUrl);
        if (description === undefined) {
          description = await this.client.fetchOpenSearchDescription(
            descriptionUrl,
          );
          this.searchDescriptions.set(descriptionUrl, description);
        }
        return this.client.fetchFeed(
          buildOpenSearchUrl(description, normalizedQuery),
        );
      },
      () => this.search(descriptionUrl, normalizedQuery),
      false,
    );
  }

  private renderLoading(): void {
    const loading = textElement("div", "Loading Booklore catalog…", "oc-catalog-loading");
    loading.setAttribute("aria-busy", "true");
    loading.setAttribute("role", "status");
    this.container.replaceChildren(loading);
  }

  private renderCurrentFeed(): void {
    const feed = this.feeds.at(-1);
    if (feed === undefined) {
      this.container.replaceChildren();
      return;
    }
    this.renderFeed(feed);
  }

  private renderFeed(feed: OpdsFeed): void {
    const fragment = document.createDocumentFragment();
    const toolbar = element("nav", "oc-catalog-toolbar");
    toolbar.setAttribute("aria-label", "Catalog navigation");
    if (this.feeds.length > 1) {
      const back = button("Back");
      back.addEventListener("click", () => {
        this.feeds = this.feeds.slice(0, -1);
        this.renderCurrentFeed();
      });
      toolbar.append(back);

      const home = button("Catalog home");
      home.addEventListener("click", () => {
        this.feeds = this.feeds.slice(0, 1);
        this.renderCurrentFeed();
      });
      toolbar.append(home);
    }
    if (feed.search !== null) {
      toolbar.append(this.renderSearch(feed.search.href));
    }
    fragment.append(toolbar);

    const header = element("header", "oc-catalog-header");
    header.append(
      textElement("h2", feed.title || "Booklore catalog"),
      textElement("p", feedCount(feed), "oc-catalog-count"),
    );
    fragment.append(header);

    const entries = element("section", "oc-catalog-entries");
    entries.setAttribute("aria-label", "Catalog entries");
    for (const entry of feed.entries) {
      if (entry.navigation !== null && entry.acquisitions.length === 0) {
        entries.append(
          renderNavigationEntry(entry, (url) => {
            void this.navigate(url);
          }),
        );
      } else {
        entries.append(
          renderAcquisitionEntry(entry, (selected) => this.renderDetail(selected)),
        );
      }
    }
    if (feed.entries.length === 0) {
      entries.append(textElement("p", "This catalog feed is empty."));
    }
    fragment.append(entries);

    if (feed.pagination.prev !== null || feed.pagination.next !== null) {
      const pager = element("nav", "oc-catalog-pager");
      pager.setAttribute("aria-label", "Catalog pages");
      const previous = button("Previous");
      previous.disabled = feed.pagination.prev === null;
      previous.addEventListener("click", () => {
        if (feed.pagination.prev !== null) void this.navigate(feed.pagination.prev);
      });
      const next = button("Next");
      next.disabled = feed.pagination.next === null;
      next.addEventListener("click", () => {
        if (feed.pagination.next !== null) void this.navigate(feed.pagination.next);
      });
      pager.append(previous, next);
      fragment.append(pager);
    }

    this.container.replaceChildren(fragment);
  }

  private renderSearch(descriptionUrl: string): HTMLFormElement {
    const form = element("form", "oc-catalog-search");
    form.setAttribute("role", "search");
    const input = element("input");
    input.type = "search";
    input.name = "query";
    input.required = true;
    input.placeholder = "Title or author";
    input.value = this.searchQuery;
    input.setAttribute("aria-label", "Search Booklore by title or author");
    const submit = button("Search");
    submit.type = "submit";
    form.append(input, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const query = input.value.trim();
      if (query === "") {
        input.focus();
        return;
      }
      void this.search(descriptionUrl, query);
    });
    return form;
  }

  private renderDetail(entry: OpdsEntry): void {
    const detail = element("article", "oc-catalog-book-detail");
    const back = button("Back");
    back.addEventListener("click", () => {
      this.renderCurrentFeed();
    });
    detail.append(
      back,
      textElement("h2", entry.title || "Untitled book"),
      textElement("p", displayAuthors(entry), "oc-catalog-entry-author"),
    );
    if (entry.publisher !== "") {
      detail.append(textElement("p", `Publisher: ${entry.publisher}`));
    }
    if (entry.language !== "") {
      detail.append(textElement("p", `Language: ${entry.language}`));
    }
    const formats = formatLabels(entry);
    const formatLabel = formats.length === 1 ? "Available format" : "Available formats";
    detail.append(textElement("p", `${formatLabel}: ${formats.join(", ") || "None"}`));
    if (entry.summary !== "") detail.append(textElement("p", entry.summary));
    this.container.replaceChildren(detail);
  }

  private renderError(message: string, retry: () => void): void {
    const error = element("div", "oc-catalog-error");
    error.setAttribute("role", "alert");
    error.append(textElement("span", message));
    const retryButton = button("Retry");
    retryButton.addEventListener("click", retry);
    error.append(retryButton);
    this.container.prepend(error);
  }
}
