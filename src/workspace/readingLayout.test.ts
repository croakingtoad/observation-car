import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import {
  findBookGroup,
  findDisplacements,
  findNoteGroup,
  openBesideInGroup,
  openBookInBookGroup,
  openNoteBesideReader,
  snapshotRootLeaves,
  type LayoutWorkspace,
} from "./readingLayout";

interface TestGroup {
  children: TestLeaf[];
}

interface TestLeaf {
  readonly parent: TestGroup;
  path: string | null;
  reader: boolean;
  detached: boolean;
  root: object;
  getRoot(): unknown;
  openFile(file: TFile): Promise<void>;
  detach(): void;
}

interface Harness {
  workspace: LayoutWorkspace<TestLeaf>;
  rootSplit: object;
  /** Every leaf still in the main area, in workspace order. */
  leaves: TestLeaf[];
  group(): TestGroup;
  addLeaf(
    group: TestGroup,
    options?: { path?: string; reader?: boolean; root?: object },
  ): TestLeaf;
  /** Records each `createLeafInParent`/`createLeafBySplit` call. */
  created: { kind: "tab" | "split" | "split-active"; leaf: TestLeaf }[];
  revealed: TestLeaf[];
  /** Root the next created leaf reports, for the outside-main-area guard. */
  nextRoot: { value: object | null };
}

function makeHarness(): Harness {
  const rootSplit = {};
  const leaves: TestLeaf[] = [];
  const created: Harness["created"] = [];
  const revealed: TestLeaf[] = [];
  const nextRoot = { value: null as object | null };

  function addLeaf(
    group: TestGroup,
    options: { path?: string; reader?: boolean; root?: object } = {},
  ): TestLeaf {
    const root = options.root ?? rootSplit;
    const leaf: TestLeaf = {
      parent: group,
      path: options.path ?? null,
      reader: options.reader ?? false,
      detached: false,
      root,
      getRoot: () => leaf.root,
      openFile: async (file: TFile): Promise<void> => {
        leaf.path = file.path;
      },
      detach: () => {
        leaf.detached = true;
        const inGroup = group.children.indexOf(leaf);
        if (inGroup !== -1) group.children.splice(inGroup, 1);
        const inWorkspace = leaves.indexOf(leaf);
        if (inWorkspace !== -1) leaves.splice(inWorkspace, 1);
      },
    };
    group.children.push(leaf);
    leaves.push(leaf);
    return leaf;
  }

  const workspace: LayoutWorkspace<TestLeaf> = {
    rootSplit,
    rootLeaves: () => [...leaves],
    pathOf: (leaf) => leaf.path,
    isReader: (leaf) => leaf.reader,
    tabCount: (group) => (group as TestGroup).children.length,
    createLeafInParent: (group, index) => {
      const leaf = addLeaf(group as TestGroup, {
        root: nextRoot.value ?? rootSplit,
      });
      const target = group as TestGroup;
      target.children.splice(target.children.indexOf(leaf), 1);
      target.children.splice(index, 0, leaf);
      created.push({ kind: "tab", leaf });
      return leaf;
    },
    createLeafBySplit: (leaf) => {
      const created_ = addLeaf(
        { children: [] },
        { root: nextRoot.value ?? leaf.root },
      );
      created.push({ kind: "split", leaf: created_ });
      return created_;
    },
    splitActiveLeaf: () => {
      const leaf = addLeaf(
        { children: [] },
        { root: nextRoot.value ?? rootSplit },
      );
      created.push({ kind: "split-active", leaf });
      return leaf;
    },
    revealLeaf: async (leaf) => {
      revealed.push(leaf);
    },
  };

  return {
    workspace,
    rootSplit,
    leaves,
    group: () => ({ children: [] }),
    addLeaf,
    created,
    revealed,
    nextRoot,
  };
}

function file(path: string): TFile {
  const created = new TFile();
  created.path = path;
  created.basename = path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? path;
  return created;
}

describe("findBookGroup", () => {
  it("is the group holding the readers", () => {
    const harness = makeHarness();
    const notes = harness.group();
    const books = harness.group();
    harness.addLeaf(notes, { path: "Notes/A.md" });
    harness.addLeaf(books, { path: "Books/A.epub", reader: true });

    expect(findBookGroup(harness.workspace)).toBe(books);
  });

  it("is the group with the most readers, not merely the first", () => {
    const harness = makeHarness();
    const stray = harness.group();
    const books = harness.group();
    harness.addLeaf(stray, { path: "Books/Stray.epub", reader: true });
    harness.addLeaf(books, { path: "Books/A.epub", reader: true });
    harness.addLeaf(books, { path: "Books/B.epub", reader: true });

    expect(findBookGroup(harness.workspace)).toBe(books);
  });

  it("is null when no reader is open", () => {
    const harness = makeHarness();
    harness.addLeaf(harness.group(), { path: "Notes/A.md" });

    expect(findBookGroup(harness.workspace)).toBeNull();
  });

  it("ignores an excluded leaf, so a hijacked note pane cannot claim it", () => {
    const harness = makeHarness();
    const books = harness.group();
    const notes = harness.group();
    harness.addLeaf(books, { path: "Books/A.epub", reader: true });
    // The note pane Obsidian just repurposed for a second book.
    const hijacked = harness.addLeaf(notes, {
      path: "Books/B.epub",
      reader: true,
    });

    expect(findBookGroup(harness.workspace, hijacked)).toBe(books);
  });
});

describe("findNoteGroup", () => {
  it("is the non-reader group beside the book group", () => {
    const harness = makeHarness();
    const books = harness.group();
    const notes = harness.group();
    harness.addLeaf(books, { path: "Books/A.epub", reader: true });
    harness.addLeaf(notes, { path: "Notes/A.md" });

    const bookGroup = findBookGroup(harness.workspace);
    expect(findNoteGroup(harness.workspace, bookGroup)).toBe(notes);
  });

  it("is null when the books and notes share one group", () => {
    const harness = makeHarness();
    const single = harness.group();
    harness.addLeaf(single, { path: "Books/A.epub", reader: true });
    harness.addLeaf(single, { path: "Notes/A.md" });

    const bookGroup = findBookGroup(harness.workspace);
    expect(findNoteGroup(harness.workspace, bookGroup)).toBeNull();
  });

  it("ignores a group whose leaves show no file", () => {
    const harness = makeHarness();
    const books = harness.group();
    harness.addLeaf(books, { path: "Books/A.epub", reader: true });
    harness.addLeaf(harness.group());

    const bookGroup = findBookGroup(harness.workspace);
    expect(findNoteGroup(harness.workspace, bookGroup)).toBeNull();
  });
});

describe("openNoteBesideReader", () => {
  it("splits the reader to open the note pane the first time", async () => {
    const harness = makeHarness();
    const books = harness.group();
    const reader = harness.addLeaf(books, {
      path: "Books/A.epub",
      reader: true,
    });

    const leaf = await openNoteBesideReader(
      harness.workspace,
      reader,
      file("Notes/A.md"),
    );

    expect(harness.created).toEqual([{ kind: "split", leaf }]);
    expect(leaf.path).toBe("Notes/A.md");
  });

  it("adds a tab to the note pane instead of splitting a third group", async () => {
    const harness = makeHarness();
    const books = harness.group();
    const notes = harness.group();
    harness.addLeaf(books, { path: "Books/A.epub", reader: true });
    harness.addLeaf(notes, { path: "Notes/A.md" });
    const readerB = harness.addLeaf(books, {
      path: "Books/B.epub",
      reader: true,
    });

    const leaf = await openNoteBesideReader(
      harness.workspace,
      readerB,
      file("Notes/B.md"),
    );

    expect(harness.created).toEqual([{ kind: "tab", leaf }]);
    expect(leaf.parent).toBe(notes);
    // Two groups, not three: this is the whole point (LOCO-430).
    expect(new Set(harness.leaves.map((l) => l.parent)).size).toBe(2);
  });

  it("appends the new tab after the notes already in the group", async () => {
    const harness = makeHarness();
    const books = harness.group();
    const notes = harness.group();
    harness.addLeaf(books, { path: "Books/A.epub", reader: true });
    const first = harness.addLeaf(notes, { path: "Notes/A.md" });
    const readerB = harness.addLeaf(books, {
      path: "Books/B.epub",
      reader: true,
    });

    const leaf = await openNoteBesideReader(
      harness.workspace,
      readerB,
      file("Notes/B.md"),
    );

    expect(notes.children).toEqual([first, leaf]);
  });

  it("reveals the note where it is already open", async () => {
    const harness = makeHarness();
    const books = harness.group();
    const notes = harness.group();
    harness.addLeaf(books, { path: "Books/A.epub", reader: true });
    const open = harness.addLeaf(notes, { path: "Notes/A.md" });
    const reader = harness.addLeaf(books, {
      path: "Books/B.epub",
      reader: true,
    });

    const leaf = await openNoteBesideReader(
      harness.workspace,
      reader,
      file("Notes/A.md"),
    );

    expect(leaf).toBe(open);
    expect(harness.revealed).toEqual([open]);
    expect(harness.created).toEqual([]);
  });

  it("splits the active leaf when the caller has no reader leaf", async () => {
    const harness = makeHarness();
    harness.addLeaf(harness.group(), { path: "Books/A.epub", reader: true });

    const leaf = await openNoteBesideReader(
      harness.workspace,
      null,
      file("Notes/A.md"),
    );

    expect(harness.created).toEqual([{ kind: "split-active", leaf }]);
  });

  it("detaches and reports a pane created outside the main area", async () => {
    const harness = makeHarness();
    const reader = harness.addLeaf(harness.group(), {
      path: "Books/A.epub",
      reader: true,
    });
    harness.nextRoot.value = {};

    await expect(
      openNoteBesideReader(harness.workspace, reader, file("Notes/A.md")),
    ).rejects.toThrow("outside the main area");
    expect(harness.created[0]?.leaf.detached).toBe(true);
  });
});

describe("openBookInBookGroup", () => {
  it("adds a tab to the book group", async () => {
    const harness = makeHarness();
    const books = harness.group();
    const notes = harness.group();
    const first = harness.addLeaf(books, {
      path: "Books/A.epub",
      reader: true,
    });
    harness.addLeaf(notes, { path: "Notes/A.md" });

    const leaf = await openBookInBookGroup(harness.workspace, file("Books/B.epub"));

    expect(leaf?.parent).toBe(books);
    expect(books.children).toEqual([first, leaf]);
  });

  it("reveals the book where it is already open", async () => {
    const harness = makeHarness();
    const books = harness.group();
    const open = harness.addLeaf(books, {
      path: "Books/A.epub",
      reader: true,
    });

    const leaf = await openBookInBookGroup(harness.workspace, file("Books/A.epub"));

    expect(leaf).toBe(open);
    expect(harness.created).toEqual([]);
  });

  it("is null when there is no book group to add to", async () => {
    const harness = makeHarness();
    harness.addLeaf(harness.group(), { path: "Notes/A.md" });

    expect(
      await openBookInBookGroup(harness.workspace, file("Books/A.epub")),
    ).toBeNull();
  });

  it("does not count the excluded leaf as the book group", async () => {
    const harness = makeHarness();
    const notes = harness.group();
    const hijacked = harness.addLeaf(notes, {
      path: "Books/B.epub",
      reader: true,
    });

    expect(
      await openBookInBookGroup(
        harness.workspace,
        file("Books/B.epub"),
        hijacked,
      ),
    ).toBeNull();
  });
});

describe("openBesideInGroup", () => {
  it("puts the file back as a tab in the leaf's own group", async () => {
    const harness = makeHarness();
    const notes = harness.group();
    const hijacked = harness.addLeaf(notes, {
      path: "Books/B.epub",
      reader: true,
    });

    const leaf = await openBesideInGroup(
      harness.workspace,
      hijacked,
      file("Notes/A.md"),
    );

    expect(leaf?.parent).toBe(notes);
    expect(leaf?.path).toBe("Notes/A.md");
  });
});

describe("findDisplacements", () => {
  const harness = makeHarness();
  const group = harness.group();
  const noteLeaf = harness.addLeaf(group);
  const bookLeaf = harness.addLeaf(group);
  const isBookPath = (path: string): boolean => path.endsWith(".epub");

  it("reports a note pane that a book took over", () => {
    const previous = new Map([[noteLeaf, "Notes/A.md"]]);
    const current = new Map([[noteLeaf, "Books/B.epub"]]);

    expect(findDisplacements(previous, current, isBookPath)).toEqual([
      {
        leaf: noteLeaf,
        displacedPath: "Notes/A.md",
        bookPath: "Books/B.epub",
      },
    ]);
  });

  it("reports a reader pane that another book took over", () => {
    const previous = new Map([[bookLeaf, "Books/A.epub"]]);
    const current = new Map([[bookLeaf, "Books/B.epub"]]);

    expect(findDisplacements(previous, current, isBookPath)).toEqual([
      {
        leaf: bookLeaf,
        displacedPath: "Books/A.epub",
        bookPath: "Books/B.epub",
      },
    ]);
  });

  it("ignores a leaf that did not exist before, so its own opens are not re-read", () => {
    const previous = new Map<TestLeaf, string>();
    const current = new Map([[bookLeaf, "Books/B.epub"]]);

    expect(findDisplacements(previous, current, isBookPath)).toEqual([]);
  });

  it("ignores a note replaced by another note", () => {
    const previous = new Map([[noteLeaf, "Notes/A.md"]]);
    const current = new Map([[noteLeaf, "Notes/B.md"]]);

    expect(findDisplacements(previous, current, isBookPath)).toEqual([]);
  });

  it("ignores a leaf whose file has not changed", () => {
    const previous = new Map([[bookLeaf, "Books/A.epub"]]);
    const current = new Map([[bookLeaf, "Books/A.epub"]]);

    expect(findDisplacements(previous, current, isBookPath)).toEqual([]);
  });
});

describe("snapshotRootLeaves", () => {
  it("records only the main-area leaves showing a file", () => {
    const harness = makeHarness();
    const group = harness.group();
    const withFile = harness.addLeaf(group, { path: "Notes/A.md" });
    harness.addLeaf(group);

    expect([...snapshotRootLeaves(harness.workspace)]).toEqual([
      [withFile, "Notes/A.md"],
    ]);
  });
});
