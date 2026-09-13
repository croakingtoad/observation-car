import { CatalogBrowser, type CatalogFeedClient } from "./catalogBrowser";

/** Lazily loaded DOM implementation for the catalog view shell. */
export class BookloreCatalogView {
  private readonly contentEl: HTMLElement;
  private readonly browser: CatalogBrowser;

  constructor(contentEl: HTMLElement, client: CatalogFeedClient) {
    this.contentEl = contentEl;
    this.browser = new CatalogBrowser(contentEl, client);
  }

  async open(): Promise<void> {
    this.contentEl.addClass("oc-catalog-view");
    await this.browser.openRoot();
  }

  close(): void {
    this.browser.destroy();
  }
}
