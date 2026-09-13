import { Notice, type Plugin } from "obsidian";
import type { ObservationCarSettings } from "../settings";
import { BOOKLORE_CATALOG_VIEW_TYPE } from "./catalogViewType";

type CatalogPlugin = Plugin & { settings: ObservationCarSettings };

/**
 * Add the catalog command to the plugin runtime.
 *
 * The view module is loaded when the command is first used. This keeps plugin
 * startup free of browser-only catalog work and still registers the view before
 * Obsidian receives its first view state.
 */
export function registerBookloreCatalog(plugin: CatalogPlugin): void {
  let viewRegistered = false;

  plugin.addCommand({
    id: "browse-booklore-catalog",
    name: "Browse Booklore catalog",
    icon: "library",
    callback: async () => {
      try {
        const [{ BookloreCatalogView }, { OpdsClient }] = await Promise.all([
          import("./catalogView"),
          import("./opdsClient"),
        ]);
        if (!viewRegistered) {
          plugin.registerView(
            BOOKLORE_CATALOG_VIEW_TYPE,
            (leaf) =>
              new BookloreCatalogView(
                leaf,
                new OpdsClient({ settings: () => plugin.settings }),
              ),
          );
          viewRegistered = true;
        }

        const existing = plugin.app.workspace.getLeavesOfType(
          BOOKLORE_CATALOG_VIEW_TYPE,
        )[0];
        const leaf = existing ?? plugin.app.workspace.getLeaf("tab");
        if (existing === undefined) {
          await leaf.setViewState({
            type: BOOKLORE_CATALOG_VIEW_TYPE,
            active: true,
          });
        }
        await plugin.app.workspace.revealLeaf(leaf);
      } catch {
        new Notice("Could not open the Booklore catalog.");
      }
    },
  });
}
