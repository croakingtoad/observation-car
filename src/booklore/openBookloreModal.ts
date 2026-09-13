import { buildOpenSearchUrl, type CatalogFeedClient } from "./catalogBrowser";
import type { BookDownloadResult } from "./bookDownload";
import type {
  OpdsEntry,
  OpdsLink,
  OpenSearchDescription,
} from "./opdsTypes";

export interface OpenBookloreDownloader {
  download(
    entry: Pick<OpdsEntry, "id" | "title" | "updated">,
    acquisition: Pick<OpdsLink, "href" | "type">,
  ): Promise<BookDownloadResult>;
}

export interface OpenBookloreModalOptions {
  client: CatalogFeedClient;
  downloader: OpenBookloreDownloader;
  close: () => void;
  notify: (message: string) => void;
}

interface DisplayFormat {
  label: string;
  supported: boolean;
  link: OpdsLink;
}

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

function button(label: string): HTMLButtonElement {
  const result = textElement("button", label);
  result.type = "button";
  return result;
}

function mediaType(link: OpdsLink): string {
  return link.type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function formatLabel(link: OpdsLink): string {
  switch (mediaType(link)) {
    case "application/epub+zip":
      return "EPUB";
    case "application/pdf":
      return "PDF";
    case "application/x-mobipocket-ebook":
      return "MOBI";
    case "application/vnd.amazon.ebook":
      return "AZW3";
    default:
      return link.title.trim() || link.type.trim() || "Unknown format";
  }
}

function isSupported(link: OpdsLink): boolean {
  const type = mediaType(link);
  return type === "application/epub+zip" || type === "application/pdf";
}

function formatsFor(entry: OpdsEntry): DisplayFormat[] {
  return entry.acquisitions
    .map((link) => ({
      label: formatLabel(link),
      supported: isSupported(link),
      link,
    }))
    .sort((left, right) => {
      const rank = (format: DisplayFormat): number => {
        if (mediaType(format.link) === "application/epub+zip") return 0;
        if (mediaType(format.link) === "application/pdf") return 1;
        return 2;
      };
      return rank(left) - rank(right);
    });
}

function authors(entry: OpdsEntry): string {
  const unique = [...new Set(entry.authors)];
  return unique.length > 0 ? unique.join(", ") : "Unknown author";
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Could not complete the Booklore request.";
}

/** Touch- and keyboard-accessible contents for the Open from Booklore modal. */
export class OpenBookloreModalContent {
  private readonly container: HTMLElement;
  private readonly client: CatalogFeedClient;
  private readonly downloader: OpenBookloreDownloader;
  private readonly closeModal: () => void;
  private readonly notify: (message: string) => void;
  private resultsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private searchButton!: HTMLButtonElement;
  private searchDescriptionUrl: string | undefined;
  private searchDescription: OpenSearchDescription | undefined;
  private requestEpoch = 0;
  private disposed = false;
  private downloading = false;

  constructor(container: HTMLElement, options: OpenBookloreModalOptions) {
    this.container = container;
    this.client = options.client;
    this.downloader = options.downloader;
    this.closeModal = options.close;
    this.notify = options.notify;
  }

  open(): void {
    this.container.classList.add("oc-open-booklore");

    const form = element("form", "oc-open-booklore-search");
    form.setAttribute("role", "search");
    this.searchInput = element("input");
    this.searchInput.type = "search";
    this.searchInput.name = "query";
    this.searchInput.required = true;
    this.searchInput.placeholder = "Title or author";
    this.searchInput.setAttribute("aria-label", "Search Booklore by title or author");
    this.searchButton = button("Search");
    this.searchButton.type = "submit";
    form.append(this.searchInput, this.searchButton);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.downloading) return;
      const query = this.searchInput.value.trim();
      if (query === "") {
        this.searchInput.focus();
        return;
      }
      void this.search(query);
    });

    this.statusEl = textElement(
      "div",
      "Search by title or author.",
      "oc-open-booklore-status",
    );
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("aria-live", "polite");
    this.resultsEl = element("section", "oc-open-booklore-results");
    this.resultsEl.setAttribute("aria-label", "Booklore search results");
    this.container.replaceChildren(form, this.statusEl, this.resultsEl);
    this.searchInput.focus();
  }

  destroy(): void {
    this.disposed = true;
    this.requestEpoch += 1;
  }

  private async search(query: string): Promise<void> {
    const epoch = ++this.requestEpoch;
    this.setSearching(true);
    this.statusEl.setAttribute("role", "status");
    this.statusEl.textContent = `Searching Booklore for “${query}”…`;
    this.resultsEl.replaceChildren();
    try {
      let descriptionUrl = this.searchDescriptionUrl;
      if (descriptionUrl === undefined) {
        const root = await this.client.getRootFeed();
        if (this.isStale(epoch)) return;
        if (root.search === null) {
          throw new Error("Booklore does not advertise catalog search.");
        }
        descriptionUrl = root.search.href;
        this.searchDescriptionUrl = descriptionUrl;
      }
      let description = this.searchDescription;
      if (description === undefined) {
        description = await this.client.fetchOpenSearchDescription(descriptionUrl);
        if (this.isStale(epoch)) return;
        this.searchDescription = description;
      }
      const feed = await this.client.fetchFeed(
        buildOpenSearchUrl(description, query),
      );
      if (this.isStale(epoch)) return;
      this.renderResults(feed.entries, query);
    } catch (error) {
      if (this.isStale(epoch)) return;
      this.statusEl.textContent = errorMessage(error);
      this.statusEl.setAttribute("role", "alert");
    } finally {
      if (this.isStale(epoch) === false) this.setSearching(false);
    }
  }

  private renderResults(entries: OpdsEntry[], query: string): void {
    this.statusEl.setAttribute("role", "status");
    this.statusEl.textContent = entries.length === 0
      ? `No books found for “${query}”.`
      : `${entries.length} ${entries.length === 1 ? "book" : "books"} found.`;
    const fragment = document.createDocumentFragment();
    entries.forEach((entry, entryIndex) => {
      fragment.append(this.renderEntry(entry, entryIndex));
    });
    this.resultsEl.replaceChildren(fragment);
  }

  private renderEntry(entry: OpdsEntry, entryIndex: number): HTMLElement {
    const card = element("article", "oc-open-booklore-result");
    card.append(
      textElement("h3", entry.title || "Untitled book", "oc-open-booklore-title"),
      textElement("p", authors(entry), "oc-open-booklore-author"),
    );

    const formats = formatsFor(entry);
    const badges = element("div", "oc-open-booklore-badges");
    if (formats.length === 0) {
      badges.append(textElement("span", "Unavailable", "oc-open-booklore-badge"));
    } else {
      for (const format of formats) {
        const label = format.supported
          ? format.label
          : `${format.label} · unsupported`;
        badges.append(textElement("span", label, "oc-open-booklore-badge"));
      }
    }
    card.append(badges);

    const supported = formats.filter((format) => format.supported);
    if (supported.length === 0) {
      card.append(
        textElement(
          "p",
          "This format is not supported yet.",
          "oc-open-booklore-unsupported",
        ),
      );
      return card;
    }

    let selected = supported[0];
    const formatPicker = element("fieldset", "oc-open-booklore-format-picker");
    formatPicker.append(textElement("legend", "Choose format"));
    const groupName = `oc-booklore-format-${entryIndex}`;
    for (const format of supported) {
      const option = element("label", "oc-open-booklore-format-option");
      const radio = element("input");
      radio.type = "radio";
      radio.name = groupName;
      radio.value = mediaType(format.link);
      radio.checked = format === selected;
      option.append(radio, textElement("span", format.label));
      radio.addEventListener("change", () => {
        if (radio.checked) {
          selected = format;
          downloadButton.textContent = `Download ${format.label}`;
        }
      });
      formatPicker.append(option);
    }
    if (supported.length > 1) card.append(formatPicker);

    const downloadButton = button(`Download ${selected.label}`);
    downloadButton.className = "mod-cta oc-open-booklore-download";
    downloadButton.addEventListener("click", () => {
      void this.download(entry, selected);
    });
    card.append(downloadButton);
    return card;
  }

  private async download(
    entry: OpdsEntry,
    format: DisplayFormat,
  ): Promise<void> {
    if (this.downloading) return;
    this.downloading = true;
    const epoch = ++this.requestEpoch;
    this.setResultControlsDisabled(true);
    this.searchButton.disabled = true;
    this.searchInput.disabled = true;
    this.statusEl.setAttribute("role", "status");
    this.statusEl.textContent = `Downloading ${entry.title || "book"}…`;
    try {
      const result = await this.downloader.download(entry, format.link);
      if (this.isStale(epoch)) return;
      const verb = result.status === "unchanged" ? "Already downloaded" : "Downloaded";
      this.notify(`${verb}: ${result.vaultPath}`);
      this.closeModal();
    } catch (error) {
      if (this.isStale(epoch)) return;
      this.statusEl.setAttribute("role", "alert");
      this.statusEl.textContent = errorMessage(error);
      this.downloading = false;
      this.setResultControlsDisabled(false);
      this.searchButton.disabled = false;
      this.searchInput.disabled = false;
    }
  }

  private setResultControlsDisabled(disabled: boolean): void {
    for (const control of this.resultsEl.querySelectorAll<HTMLElement>(
      "button, input",
    )) {
      if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) {
        control.disabled = disabled;
      }
    }
  }

  private setSearching(searching: boolean): void {
    this.searchButton.disabled = searching;
    this.searchInput.setAttribute("aria-busy", searching ? "true" : "false");
  }

  private isStale(epoch: number): boolean {
    return this.disposed || epoch !== this.requestEpoch;
  }
}
