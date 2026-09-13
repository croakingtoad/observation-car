import { ItemView, type WorkspaceLeaf } from "obsidian";
import { CatalogBrowser, type CatalogFeedClient } from "./catalogBrowser";
import { BOOKLORE_CATALOG_VIEW_TYPE } from "./catalogViewType";

/** Obsidian shell around the DOM-only, fixture-tested catalog browser. */
export class BookloreCatalogView extends ItemView {
  private readonly browser: CatalogBrowser;

  constructor(leaf: WorkspaceLeaf, client: CatalogFeedClient) {
    super(leaf);
    this.browser = new CatalogBrowser(this.contentEl, client);
    this.navigation = true;
  }

  getViewType(): string {
    return BOOKLORE_CATALOG_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Booklore catalog";
  }

  getIcon(): "library" {
    return "library";
  }

  protected async onOpen(): Promise<void> {
    this.contentEl.addClass("oc-catalog-view");
    await this.browser.openRoot();
  }

  protected async onClose(): Promise<void> {
    this.browser.destroy();
  }
}
