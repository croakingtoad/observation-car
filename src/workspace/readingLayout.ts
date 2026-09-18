/**
 * The reading layout: books in one tab group, book notes in its sibling
 * (PRD §1 — "the book opens on the left, and an ordinary markdown note
 * opens on the right").
 *
 * This is not a new idea in the codebase, it is an existing requirement
 * that nothing enforced. F4.8's split-ratio command already refuses to
 * resolve unless the reader group and the note group are two children of
 * one vertical split (`toggleSplitRatio.ts` — `readerTabs !== noteTabs`,
 * `noteTabs.parent === parentSplit`, `direction === "vertical"`). Every
 * pane-opening site, meanwhile, called `getLeaf("split", "vertical")` or
 * `createLeafBySplit` on its own, so the second book note built a third
 * tab group, the third a fourth, and F4.8 went quietly dead. Routing all
 * of them through here is what makes the two-pane contract true.
 *
 * Leaf routing for a file-explorer click belongs to Obsidian, not to a
 * plugin: `getLeaf(false)` returns an existing navigable leaf, so
 * clicking a second `.epub` while a note pane is active repurposes that
 * note's leaf. Obsidian exposes no pre-open hook to refuse it, and
 * `FileView.canAcceptExtension` only chooses whether the leaf's *view*
 * is reused — it never asks for a different leaf. So the repurposing is
 * read back off a leaf→file snapshot afterwards (`findDisplacements`) and
 * the caller puts both files where the layout says they belong.
 *
 * The workspace is reached through the narrow structural seams below
 * rather than Obsidian's classes, for the same reason `ReaderRegistry`
 * and `openEditor` do: the surface stays small enough to drive from a
 * unit test, and `main.ts` owns the one adaptation to the real API. The
 * leaf type is a parameter so that adaptation keeps Obsidian's own
 * `WorkspaceLeaf` end to end, with no cast back.
 */
import type { TFile } from "obsidian";

/** A tab group. Held for identity only; this module never inspects it. */
export type TabGroup = object;

/** The slice of a workspace leaf the layout reads and drives. */
export interface LayoutLeaf {
  /** The tab group holding this leaf, or null when it has none. */
  readonly parent: TabGroup | null;
  getRoot(): unknown;
  openFile(file: TFile): Promise<void>;
  detach(): void;
}

/** The slice of the workspace the layout reads and drives. */
export interface LayoutWorkspace<L extends LayoutLeaf = LayoutLeaf> {
  readonly rootSplit: unknown;
  /** Every leaf in the main area, in workspace order. */
  rootLeaves(): readonly L[];
  /** Vault path shown in a leaf, or null; must also read deferred leaves. */
  pathOf(leaf: L): string | null;
  /** True when this leaf hosts one of the plugin's reader views. */
  isReader(leaf: L): boolean;
  /**
   * A new tab in the group that already holds `anchor`.
   *
   * Deliberately expressed as "beside this leaf" rather than "in this
   * group at this index": Obsidian's `createLeafInParent` is typed for a
   * `WorkspaceSplit`, and passing the `WorkspaceTabs` that `leaf.parent`
   * yields corrupted the workspace tree badly enough to crash Obsidian's
   * own command-palette close path (`n.instanceOf is not a function`).
   * Adding a tab next to a known leaf is expressible with `setActiveLeaf`
   * plus `getLeaf("tab")`, both of which have settled public semantics.
   */
  createTabBeside(anchor: L): L;
  createLeafBySplit(leaf: L, direction: "vertical"): L;
  /** Split off the active leaf, for when no reader leaf is in hand. */
  splitActiveLeaf(direction: "vertical"): L;
  revealLeaf(leaf: L): Promise<void>;
}

/** One leaf Obsidian repurposed to show a book. */
export interface Displacement<L extends LayoutLeaf = LayoutLeaf> {
  /** The repurposed leaf, now showing `bookPath`. */
  readonly leaf: L;
  /** Vault path the leaf showed before. */
  readonly displacedPath: string;
  /** Vault path of the book that took the leaf over. */
  readonly bookPath: string;
}

/**
 * The group holding the open readers: the one with the most reader
 * leaves, earliest in workspace order on a tie. `exclude` drops a leaf
 * that is mid-reconciliation, so a book that has just hijacked a note
 * pane cannot nominate that pane as the book group.
 */
export function findBookGroup<L extends LayoutLeaf>(
  workspace: LayoutWorkspace<L>,
  exclude?: L,
): TabGroup | null {
  return heaviestGroup(
    workspace,
    (leaf) => leaf !== exclude && workspace.isReader(leaf),
  );
}

/**
 * The group holding the book notes: the non-reader-heaviest group that
 * is not the book group. Null means no note pane exists yet.
 */
export function findNoteGroup<L extends LayoutLeaf>(
  workspace: LayoutWorkspace<L>,
  bookGroup: TabGroup | null,
  exclude?: L,
): TabGroup | null {
  return heaviestGroup(
    workspace,
    (leaf) =>
      leaf !== exclude &&
      leaf.parent !== bookGroup &&
      workspace.isReader(leaf) === false &&
      workspace.pathOf(leaf) !== null,
  );
}

/**
 * Show a book note in the note pane: reveal it where it is already open,
 * else add a tab to the note group, else open the note group by splitting
 * the reader. This replaces the unconditional split that each calling
 * command used to perform.
 */
export async function openNoteBesideReader<L extends LayoutLeaf>(
  workspace: LayoutWorkspace<L>,
  readerLeaf: L | null,
  note: TFile,
): Promise<L> {
  const open = findLeafShowing(
    workspace,
    note.path,
    (leaf) => workspace.isReader(leaf) === false,
  );
  if (open !== null) {
    await workspace.revealLeaf(open);
    return open;
  }

  const noteGroup = findNoteGroup(workspace, findBookGroup(workspace));
  const noteAnchor =
    noteGroup === null ? null : anchorIn(workspace, noteGroup);
  return openInMainArea(
    workspace,
    noteAnchor !== null
      ? workspace.createTabBeside(noteAnchor)
      : newNoteGroup(workspace, readerLeaf),
    note,
  );
}

/**
 * Show a book in the book pane: reveal it where it is already open, else
 * add a tab to the book group. Null means there is no book group to add
 * to, and the caller should leave the choice of leaf to Obsidian.
 */
export async function openBookInBookGroup<L extends LayoutLeaf>(
  workspace: LayoutWorkspace<L>,
  book: TFile,
  exclude?: L,
): Promise<L | null> {
  const open = findLeafShowing(
    workspace,
    book.path,
    (leaf) => leaf !== exclude && workspace.isReader(leaf),
  );
  if (open !== null) {
    await workspace.revealLeaf(open);
    return open;
  }

  const bookGroup = findBookGroup(workspace, exclude);
  const bookAnchor =
    bookGroup === null ? null : anchorIn(workspace, bookGroup);
  if (bookAnchor === null) return null;
  return openInMainArea(workspace, workspace.createTabBeside(bookAnchor), book);
}

/** Add a tab next to `sibling` and show `file` in it. */
export async function openBesideInGroup<L extends LayoutLeaf>(
  workspace: LayoutWorkspace<L>,
  sibling: L,
  file: TFile,
): Promise<L> {
  return openInMainArea(workspace, workspace.createTabBeside(sibling), file);
}

/**
 * Leaves whose file changed from something else to a book since the
 * previous snapshot — Obsidian reused them instead of opening a new one.
 * A leaf absent from `previous` is newly created, not repurposed, which
 * is what keeps the layout's own opens from being read back as further
 * displacements.
 */
export function findDisplacements<L extends LayoutLeaf>(
  previous: ReadonlyMap<L, string>,
  current: ReadonlyMap<L, string>,
  isBookPath: (path: string) => boolean,
): readonly Displacement<L>[] {
  const displacements: Displacement<L>[] = [];
  for (const [leaf, bookPath] of current) {
    if (isBookPath(bookPath) === false) continue;
    const displacedPath = previous.get(leaf);
    if (displacedPath === undefined || displacedPath === bookPath) continue;
    displacements.push({ leaf, displacedPath, bookPath });
  }
  return displacements;
}

/** Every main-area leaf showing a file, keyed by leaf identity. */
export function snapshotRootLeaves<L extends LayoutLeaf>(
  workspace: LayoutWorkspace<L>,
): Map<L, string> {
  const snapshot = new Map<L, string>();
  for (const leaf of workspace.rootLeaves()) {
    const path = workspace.pathOf(leaf);
    if (path !== null) snapshot.set(leaf, path);
  }
  return snapshot;
}

function heaviestGroup<L extends LayoutLeaf>(
  workspace: LayoutWorkspace<L>,
  counts: (leaf: L) => boolean,
): TabGroup | null {
  const weights = new Map<TabGroup, number>();
  for (const leaf of workspace.rootLeaves()) {
    const group = leaf.parent;
    if (group === null || counts(leaf) === false) continue;
    weights.set(group, (weights.get(group) ?? 0) + 1);
  }

  let winner: TabGroup | null = null;
  let best = 0;
  // Map iteration is insertion-ordered, so the earliest group in
  // workspace order wins a tie — the book pane is the left one.
  for (const [group, weight] of weights) {
    if (weight > best) {
      winner = group;
      best = weight;
    }
  }
  return winner;
}

function findLeafShowing<L extends LayoutLeaf>(
  workspace: LayoutWorkspace<L>,
  path: string,
  accept: (leaf: L) => boolean,
): L | null {
  for (const leaf of workspace.rootLeaves()) {
    if (workspace.pathOf(leaf) === path && accept(leaf)) return leaf;
  }
  return null;
}

/**
 * Open the note pane for the first time, to the right of the reader.
 * Splitting the active leaf is the fallback for a caller that resolved a
 * book without a leaf to split from — the same leaf Obsidian would have
 * chosen before this module existed.
 */
function newNoteGroup<L extends LayoutLeaf>(
  workspace: LayoutWorkspace<L>,
  readerLeaf: L | null,
): L {
  return readerLeaf === null
    ? workspace.splitActiveLeaf("vertical")
    : workspace.createLeafBySplit(readerLeaf, "vertical");
}

/** Any main-area leaf in a group, to add a tab next to. */
function anchorIn<L extends LayoutLeaf>(
  workspace: LayoutWorkspace<L>,
  group: TabGroup,
): L | null {
  for (const leaf of workspace.rootLeaves()) {
    if (leaf.parent === group) return leaf;
  }
  return null;
}

async function openInMainArea<L extends LayoutLeaf>(
  workspace: LayoutWorkspace<L>,
  leaf: L,
  file: TFile,
): Promise<L> {
  if (leaf.getRoot() !== workspace.rootSplit) {
    leaf.detach();
    throw new Error("The reading pane was created outside the main area");
  }
  await leaf.openFile(file);
  return leaf;
}
