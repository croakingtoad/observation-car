import { Modal, Notice, type Plugin } from "obsidian";
import type { ObservationCarSettings } from "../settings";
import { getBookloreDownloader } from "./bookDownloadRegistration";

type OpenBooklorePlugin = Plugin & { settings: ObservationCarSettings };

function openBookloreModal(plugin: OpenBooklorePlugin): void {
  const downloader = getBookloreDownloader(plugin);
  if (downloader === undefined) {
    new Notice("Booklore downloads are not ready yet.");
    return;
  }

  new (class extends Modal {
    private implementation: { open(): void; destroy(): void } | undefined;
    private closed = false;

    async onOpen(): Promise<void> {
      this.setTitle("Open from Booklore");
      try {
        const [{ OpenBookloreModalContent }, { OpdsClient }] = await Promise.all([
          import("./openBookloreModal"),
          import("./opdsClient"),
        ]);
        if (this.closed) return;
        this.implementation = new OpenBookloreModalContent(this.contentEl, {
          client: new OpdsClient({ settings: () => plugin.settings }),
          downloader,
          close: () => this.close(),
          notify: (message) => new Notice(message),
        });
        this.implementation.open();
      } catch (error) {
        if (this.closed) return;
        const detail = error instanceof Error ? error.message : "Unknown error";
        this.contentEl.setText(`Could not open Booklore: ${detail}`);
      }
    }

    onClose(): void {
      this.closed = true;
      this.implementation?.destroy();
      this.implementation = undefined;
      this.contentEl.empty();
    }
  })(plugin.app).open();
}

/** Register command-palette and touch-reachable ribbon entry points. */
export function registerOpenFromBooklore(plugin: OpenBooklorePlugin): void {
  const open = (): void => openBookloreModal(plugin);
  plugin.addCommand({
    id: "open-from-booklore",
    name: "Open from Booklore",
    icon: "book-open",
    callback: open,
  });
  const ribbon = plugin.addRibbonIcon("book-open", "Open from Booklore", open);
  ribbon.addClass("oc-open-booklore-ribbon");
  ribbon.setAttribute("aria-label", "Open from Booklore");
}
