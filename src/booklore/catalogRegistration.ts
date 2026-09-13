import {
  ItemView,
  Notice,
  type Plugin,
  type WorkspaceLeaf,
} from "obsidian";
import type { ObservationCarSettings } from "../settings";
import { BOOKLORE_CATALOG_VIEW_TYPE } from "./catalogViewType";

type CatalogPlugin = Plugin & { settings: ObservationCarSettings };

function createBookloreCatalogView(
  leaf: WorkspaceLeaf,
  plugin: CatalogPlugin,
): ItemView {
  return new (class extends ItemView {
    private implementation:
      | { open(): Promise<void>; close(): void }
      | undefined;

    constructor() {
      super(leaf);
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
      const [{ BookloreCatalogView }, { OpdsClient }] = await Promise.all([
        import("./catalogView"),
        import("./opdsClient"),
      ]);
      this.implementation = new BookloreCatalogView(
        this.contentEl,
        new OpdsClient({ settings: () => plugin.settings }),
      );
      await this.implementation.open();
    }

    protected async onClose(): Promise<void> {
      this.implementation?.close();
      this.implementation = undefined;
    }
  })();
}

/**
 * Add the catalog command to the plugin runtime.
 *
 * The view type is registered during plugin load so Obsidian can restore an
 * existing catalog leaf before the command is used.
 */
export function registerBookloreCatalog(plugin: CatalogPlugin): void {
  plugin.registerView(
    BOOKLORE_CATALOG_VIEW_TYPE,
    (leaf) => createBookloreCatalogView(leaf, plugin),
  );

  plugin.addCommand({
    id: "browse-booklore-catalog",
    name: "Browse Booklore catalog",
    icon: "library",
    callback: async () => {
      const existing = plugin.app.workspace.getLeavesOfType(
        BOOKLORE_CATALOG_VIEW_TYPE,
      )[0];
      const leaf = existing ?? plugin.app.workspace.getLeaf("tab");
      try {
        if (existing === undefined) {
          await leaf.setViewState({
            type: BOOKLORE_CATALOG_VIEW_TYPE,
            active: true,
          });
        }
        await plugin.app.workspace.revealLeaf(leaf);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error.";
        console.error(
          "[observation-car] could not open Booklore catalog",
          error,
        );
        new Notice(`Could not open the Booklore catalog: ${message}`);
      }
    },
  });
}
