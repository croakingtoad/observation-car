import { MarkdownView, Notice, type WorkspaceLeaf } from "obsidian";
import type ObservationCarPlugin from "../main";

export const SPLIT_RATIO_TOGGLE_COMMAND_ID =
  "toggle-reader-note-split-ratio";

/** A split up to 900 CSS px is Fold-sized around its ~830 px unfolded width. */
export const NARROW_TABLET_MAX_WIDTH_PX = 900;
export const NARROW_TABLET_READER_RATIO_PERCENT = 80;

const RATIO_MATCH_TOLERANCE_PERCENT = 0.75;

/**
 * Obsidian sizes a split's tab containers rather than its leaves. The
 * relationship is public (`leaf.parent.parent`), but dimensions and children
 * are not in the public typings. Keep the private runtime seam narrow and
 * reject it if the shape changes in a later Obsidian release.
 */
interface SplitItem {
  readonly parent?: unknown;
  readonly children?: unknown;
  readonly containerEl?: unknown;
  readonly direction?: unknown;
  readonly setDimension?: unknown;
}

interface SplitContext {
  readonly readerTabs: SplitItem;
  readonly noteTabs: SplitItem;
  readonly children: readonly SplitItem[];
  readonly widths: readonly number[] | null;
  readonly readerIndex: number;
  readonly noteIndex: number;
  readonly splitWidth: number;
}

/** Register F4.8's command for either side of the active reader/note pair. */
export function registerSplitRatioToggleCommand(
  plugin: ObservationCarPlugin,
): void {
  plugin.addCommand({
    id: SPLIT_RATIO_TOGGLE_COMMAND_ID,
    name: "Toggle reader/note split ratio",
    icon: "columns-2",
    checkCallback: (checking) => {
      const context = findSplitContext(plugin);
      if (context === null) return false;
      if (checking === false) {
        try {
          applyNextRatio(plugin, context);
        } catch (error) {
          console.error(
            "[observation-car] could not resize reader/note split",
            error,
          );
          new Notice(
            "Could not resize the reader/note split. Check the developer console for details.",
          );
        }
      }
      return true;
    },
  });
}

function findSplitContext(
  plugin: ObservationCarPlugin,
): SplitContext | null {
  const { workspace } = plugin.app;
  const recentLeaf = workspace.getMostRecentLeaf(workspace.rootSplit);
  if (
    recentLeaf === null ||
    recentLeaf.getRoot() !== workspace.rootSplit
  ) {
    return null;
  }

  const readerPairing = plugin.getReaderPairingForLeaf(recentLeaf);
  if (readerPairing !== undefined) {
    for (const noteLeaf of workspace.getLeavesOfType("markdown")) {
      if (
        noteLeaf.view instanceof MarkdownView &&
        noteLeaf.view.file?.path === readerPairing.notePath
      ) {
        const context = sharedSplitContext(readerPairing.leaf, noteLeaf);
        if (context !== null) return context;
      }
    }
    return null;
  }

  if (
    recentLeaf.view instanceof MarkdownView &&
    recentLeaf.view.file !== null
  ) {
    const pairing = plugin.getReaderPairingForNote(
      recentLeaf.view.file.path,
    );
    if (pairing !== undefined) {
      return sharedSplitContext(pairing.leaf, recentLeaf);
    }
  }
  return null;
}

function sharedSplitContext(
  readerLeaf: WorkspaceLeaf,
  noteLeaf: WorkspaceLeaf,
): SplitContext | null {
  if (readerLeaf.getRoot() !== noteLeaf.getRoot()) return null;

  const readerTabs = splitItem(readerLeaf.parent);
  const noteTabs = splitItem(noteLeaf.parent);
  if (readerTabs === null || noteTabs === null || readerTabs === noteTabs) {
    return null;
  }

  const parentSplit = splitItem(readerTabs.parent);
  if (parentSplit === null || noteTabs.parent !== parentSplit) return null;
  if (parentSplit.direction !== "vertical") return null;
  if (!Array.isArray(parentSplit.children)) return null;

  const children: SplitItem[] = [];
  for (const value of parentSplit.children) {
    const child = splitItem(value);
    if (child === null || typeof child.setDimension !== "function") {
      return null;
    }
    children.push(child);
  }

  const readerIndex = children.indexOf(readerTabs);
  const noteIndex = children.indexOf(noteTabs);
  if (readerIndex === -1 || noteIndex === -1) return null;

  const measuredWidths = children.map(measureWidth);
  const widths = measuredWidths.every(
    (width): width is number => width !== null,
  )
    ? measuredWidths
    : null;
  if (children.length > 2 && widths === null) return null;

  return {
    readerTabs,
    noteTabs,
    children,
    widths,
    readerIndex,
    noteIndex,
    splitWidth:
      widths?.reduce((total, width) => total + width, 0) ??
      readerLeaf.getContainer().win.innerWidth,
  };
}

function splitItem(value: unknown): SplitItem | null {
  if (typeof value !== "object" || value === null) return null;
  return value as SplitItem;
}

function measureWidth(item: SplitItem): number | null {
  const element = splitItem(item.containerEl);
  if (
    element === null ||
    !("getBoundingClientRect" in element) ||
    typeof element.getBoundingClientRect !== "function"
  ) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  if (
    typeof rect !== "object" ||
    rect === null ||
    !("width" in rect) ||
    typeof rect.width !== "number" ||
    !Number.isFinite(rect.width) ||
    rect.width <= 0
  ) {
    return null;
  }
  return rect.width;
}

function applyNextRatio(
  plugin: ObservationCarPlugin,
  context: SplitContext,
): void {
  const targets = ratioTargets(
    plugin.settings.splitReadRatioPercent,
    plugin.settings.splitWriteRatioPercent,
    context.splitWidth <= NARROW_TABLET_MAX_WIDTH_PX,
  );
  const current = currentReaderRatio(context);
  const target = nextTarget(targets, current);
  const dimensions = targetDimensions(context, target);

  for (let index = 0; index < context.children.length; index += 1) {
    const child = context.children[index];
    const setDimension = child?.setDimension;
    if (typeof setDimension !== "function") {
      throw new Error("The parent split is no longer resizable");
    }
    setDimension.call(child, dimensions[index]);
  }
}

function ratioTargets(
  readRatio: number,
  writeRatio: number,
  narrow: boolean,
): readonly number[] {
  const candidates = narrow
    ? [readRatio, writeRatio, NARROW_TABLET_READER_RATIO_PERCENT]
    : [readRatio, writeRatio];
  return candidates.filter(
    (ratio, index) => candidates.indexOf(ratio) === index,
  );
}

function currentReaderRatio(context: SplitContext): number | null {
  if (context.widths === null) return null;
  const readerWidth = context.widths[context.readerIndex];
  const noteWidth = context.widths[context.noteIndex];
  if (readerWidth === undefined || noteWidth === undefined) return null;
  return (readerWidth / (readerWidth + noteWidth)) * 100;
}

function nextTarget(
  targets: readonly number[],
  current: number | null,
): number {
  const first = targets[0];
  if (first === undefined) {
    throw new Error("No split ratios are configured");
  }
  if (current === null || targets.length === 1) return first;

  let closestIndex = 0;
  let closestDistance = Math.abs(current - first);
  for (let index = 1; index < targets.length; index += 1) {
    const target = targets[index];
    if (target === undefined) continue;
    const distance = Math.abs(current - target);
    if (distance < closestDistance) {
      closestIndex = index;
      closestDistance = distance;
    }
  }
  if (closestDistance > RATIO_MATCH_TOLERANCE_PERCENT) return first;
  return targets[(closestIndex + 1) % targets.length] ?? first;
}

function targetDimensions(
  context: SplitContext,
  readerRatio: number,
): readonly number[] {
  if (context.widths === null) {
    const dimensions = [0, 0];
    dimensions[context.readerIndex] = readerRatio;
    dimensions[context.noteIndex] = 100 - readerRatio;
    return dimensions;
  }

  const dimensions = [...context.widths];
  const pairWidth =
    (dimensions[context.readerIndex] ?? 0) +
    (dimensions[context.noteIndex] ?? 0);
  dimensions[context.readerIndex] = pairWidth * (readerRatio / 100);
  dimensions[context.noteIndex] = pairWidth * ((100 - readerRatio) / 100);
  const total = dimensions.reduce((sum, dimension) => sum + dimension, 0);
  return dimensions.map((dimension) => (dimension / total) * 100);
}
