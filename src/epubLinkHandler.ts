import type { App } from "obsidian";
import { TFile } from "obsidian";
import { parseFragment } from "./model/anchor";
import { EpubView, EPUB_VIEW_TYPE } from "./readers/EpubView";

interface EpubLink {
  linkpath: string;
  fragment: string;
}

function stateFilePath(state: unknown): string | null {
  if (typeof state !== "object" || state === null || !("file" in state)) {
    return null;
  }
  return typeof state.file === "string" ? state.file : null;
}

function parseEpubLink(linktext: string): EpubLink | null {
  const hash = linktext.indexOf("#");
  if (hash <= 0) return null;

  const fragment = linktext.slice(hash + 1);
  try {
    if (parseFragment(fragment).kind === "pdf-page") return null;
  } catch {
    return null;
  }
  return { linkpath: linktext.slice(0, hash), fragment };
}

/**
 * Route vault EPUB location links through the registered reader view.
 * Returns a cleanup callback that restores Obsidian's original handler.
 */
export function installEpubLinkHandler(app: App): () => void {
  const workspace = app.workspace;
  const original = workspace.openLinkText;

  const patched: typeof workspace.openLinkText = async (
    linktext,
    sourcePath,
    newLeaf,
    openViewState,
  ) => {
    const link = parseEpubLink(linktext);
    if (link === null) {
      await original.call(workspace, linktext, sourcePath, newLeaf, openViewState);
      return;
    }

    const file = app.metadataCache.getFirstLinkpathDest(link.linkpath, sourcePath);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "epub") {
      await original.call(workspace, linktext, sourcePath, newLeaf, openViewState);
      return;
    }

    const existingLeaf = workspace.getLeavesOfType(EPUB_VIEW_TYPE).find((leaf) => {
      if (leaf.view instanceof EpubView && leaf.view.file?.path === file.path) {
        return true;
      }
      return stateFilePath(leaf.getViewState().state) === file.path;
    });
    if (existingLeaf !== undefined) {
      await existingLeaf.loadIfDeferred();
      await workspace.revealLeaf(existingLeaf);
      if (existingLeaf.view instanceof EpubView) {
        await existingLeaf.view.openAtFragment(link.fragment);
      }
      return;
    }

    const leaf = workspace.getLeaf(newLeaf);
    await leaf.openFile(file, openViewState);
    if (leaf.view instanceof EpubView) {
      await leaf.view.openAtFragment(link.fragment);
    }
  };

  workspace.openLinkText = patched;
  return () => {
    if (workspace.openLinkText === patched) {
      workspace.openLinkText = original;
    }
  };
}
