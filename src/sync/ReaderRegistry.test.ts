import type { TFile, WorkspaceLeaf } from "obsidian";
import { describe, expect, it } from "vitest";
import type { BookNote } from "../model/bookNote";
import {
  ReaderRegistry,
  type Reader,
  type ReaderRegistryDeps,
} from "./ReaderRegistry";

interface Rig {
  readonly registry: ReaderRegistry;
  readonly notes: Map<string, BookNote>;
  readonly destinations: Map<string, TFile>;
  readonly openLeaves: Set<WorkspaceLeaf>;
  readonly resolvedLinks: string[];
}

function makeRig(): Rig {
  const notes = new Map<string, BookNote>();
  const destinations = new Map<string, TFile>();
  const openLeaves = new Set<WorkspaceLeaf>();
  const resolvedLinks: string[] = [];
  const deps: ReaderRegistryDeps = {
    listBookNotes: () =>
      [...notes].map(([path, bookNote]) => ({ path, bookNote })),
    resolveLink: (linkpath) => {
      resolvedLinks.push(linkpath);
      return destinations.get(linkpath) ?? null;
    },
    isLeafOpen: (leaf) => openLeaves.has(leaf),
  };
  return {
    registry: new ReaderRegistry(deps),
    notes,
    destinations,
    openLeaves,
    resolvedLinks,
  };
}

function file(path: string): TFile {
  return { path } as TFile;
}

function leaf(): WorkspaceLeaf {
  return {} as WorkspaceLeaf;
}

function note(source: string | null): BookNote {
  return {
    frontmatter: { data: { source }, source, format: "epub" },
    sections: [],
    diagnostics: [],
  };
}

function reader(viewType: string, book: TFile | null): Reader & {
  file: TFile | null;
} {
  return {
    file: book,
    getViewType: () => viewType,
  };
}

describe("ReaderRegistry", () => {
  it("pairs a reader with a note by resolved file identity", () => {
    const rig = makeRig();
    const book = file("Books/Book.epub");
    const readerLeaf = leaf();
    const bookReader = reader("custom-reader", book);
    rig.notes.set("Reading/Book.md", note("Book.epub"));
    rig.destinations.set("Book.epub", book);
    rig.openLeaves.add(readerLeaf);

    rig.registry.register(readerLeaf, bookReader);

    const pairing = rig.registry.getByNotePath("Reading/Book.md");
    expect(pairing).toMatchObject({
      leaf: readerLeaf,
      reader: bookReader,
      bookFile: book,
      notePath: "Reading/Book.md",
    });
    expect(pairing?.bookNote).toBe(rig.notes.get("Reading/Book.md"));
  });

  it("gives a book to its newest reader leaf and displaces the older leaf", () => {
    const rig = makeRig();
    const book = file("Books/Book.epub");
    const olderLeaf = leaf();
    const newerLeaf = leaf();
    rig.notes.set("Reading/Book.md", note(book.path));
    rig.destinations.set(book.path, book);
    rig.openLeaves.add(olderLeaf);
    rig.openLeaves.add(newerLeaf);

    rig.registry.register(olderLeaf, reader("reader-a", book));
    expect(rig.registry.getByLeaf(olderLeaf)).toBeDefined();

    rig.registry.register(newerLeaf, reader("reader-b", book));

    expect(rig.registry.getByLeaf(olderLeaf)).toBeUndefined();
    expect(rig.registry.getByLeaf(newerLeaf)?.notePath).toBe(
      "Reading/Book.md",
    );
    expect(rig.registry.pairings()).toHaveLength(1);
  });

  it("does not promote a reader when the same leaf and reader register twice", () => {
    const rig = makeRig();
    const book = file("Books/Book.epub");
    const olderLeaf = leaf();
    const newerLeaf = leaf();
    const olderReader = reader("reader", book);
    rig.notes.set("Reading/Book.md", note(book.path));
    rig.destinations.set(book.path, book);
    rig.openLeaves.add(olderLeaf);
    rig.openLeaves.add(newerLeaf);

    rig.registry.register(olderLeaf, olderReader);
    rig.registry.register(newerLeaf, reader("reader", book));
    rig.registry.register(olderLeaf, olderReader);

    expect(rig.registry.getByLeaf(olderLeaf)).toBeUndefined();
    expect(rig.registry.getByLeaf(newerLeaf)?.notePath).toBe(
      "Reading/Book.md",
    );
  });

  it("gives a book to an existing leaf when that leaf opens it later", () => {
    const rig = makeRig();
    const book = file("Books/Book.epub");
    const existingLeaf = leaf();
    const currentLeaf = leaf();
    const existingReader = reader("reader", null);
    rig.notes.set("Reading/Book.md", note(book.path));
    rig.destinations.set(book.path, book);
    rig.openLeaves.add(existingLeaf);
    rig.openLeaves.add(currentLeaf);

    rig.registry.register(existingLeaf, existingReader);
    rig.registry.register(currentLeaf, reader("reader", book));
    expect(rig.registry.getByLeaf(currentLeaf)).toBeDefined();

    existingReader.file = book;
    rig.registry.refresh();

    expect(rig.registry.getByLeaf(existingLeaf)?.notePath).toBe(
      "Reading/Book.md",
    );
    expect(rig.registry.getByLeaf(currentLeaf)).toBeUndefined();
  });

  it("deterministically gives one book to the lowest-path note", () => {
    const rig = makeRig();
    const book = file("Books/Book.epub");
    const readerLeaf = leaf();
    rig.notes.set("Reading/Zeta.md", note(book.path));
    rig.notes.set("Reading/Alpha.md", note(book.path));
    rig.destinations.set(book.path, book);
    rig.openLeaves.add(readerLeaf);

    rig.registry.register(readerLeaf, reader("reader", book));

    expect(rig.registry.getByLeaf(readerLeaf)?.notePath).toBe(
      "Reading/Alpha.md",
    );
    expect(rig.registry.getByNotePath("Reading/Zeta.md")).toBeUndefined();
  });

  it("does not resolve a note whose source is null", () => {
    const rig = makeRig();
    rig.notes.set("Reading/Unlinked.md", note(null));

    rig.registry.refresh();

    expect(rig.resolvedLinks).toEqual([]);
    expect(rig.registry.pairings()).toEqual([]);
  });

  it("keeps the pairing through layout moves and re-focus", () => {
    const rig = makeRig();
    const book = file("Books/Book.epub");
    const readerLeaf = leaf();
    const bookReader = reader("reader", book);
    rig.notes.set("Reading/Book.md", note(book.path));
    rig.destinations.set(book.path, book);
    rig.openLeaves.add(readerLeaf);
    rig.registry.register(readerLeaf, bookReader);

    const before = rig.registry.getByLeaf(readerLeaf);
    rig.registry.refresh();
    rig.registry.refresh();

    expect(rig.registry.getByLeaf(readerLeaf)).toEqual(before);
  });

  it("tears down a pairing when its reader leaf closes", () => {
    const rig = makeRig();
    const book = file("Books/Book.epub");
    const readerLeaf = leaf();
    rig.notes.set("Reading/Book.md", note(book.path));
    rig.destinations.set(book.path, book);
    rig.openLeaves.add(readerLeaf);
    rig.registry.register(readerLeaf, reader("reader", book));
    expect(rig.registry.getByLeaf(readerLeaf)).toBeDefined();

    rig.openLeaves.delete(readerLeaf);
    rig.registry.refresh();

    expect(rig.registry.getByLeaf(readerLeaf)).toBeUndefined();
    expect(rig.registry.getByNotePath("Reading/Book.md")).toBeUndefined();
  });

  it("tracks structurally compatible reader implementations without format imports", () => {
    const rig = makeRig();
    const epub = file("Books/Book.epub");
    const pdf = file("Books/Paper.pdf");
    const epubLeaf = leaf();
    const pdfLeaf = leaf();
    rig.notes.set("Reading/Book.md", note(epub.path));
    rig.notes.set("Reading/Paper.md", {
      ...note(pdf.path),
      frontmatter: {
        data: { source: pdf.path },
        source: pdf.path,
        format: "pdf",
      },
    });
    rig.destinations.set(epub.path, epub);
    rig.destinations.set(pdf.path, pdf);
    rig.openLeaves.add(epubLeaf);
    rig.openLeaves.add(pdfLeaf);

    rig.registry.register(epubLeaf, reader("third-party-epub", epub));
    rig.registry.register(pdfLeaf, reader("core-pdf", pdf));

    expect(rig.registry.getByNotePath("Reading/Book.md")?.bookFile).toBe(epub);
    expect(rig.registry.getByNotePath("Reading/Paper.md")?.bookFile).toBe(pdf);
  });

  it("clears every reader and pairing on unload", () => {
    const rig = makeRig();
    const book = file("Books/Book.epub");
    const readerLeaf = leaf();
    rig.notes.set("Reading/Book.md", note(book.path));
    rig.destinations.set(book.path, book);
    rig.openLeaves.add(readerLeaf);
    rig.registry.register(readerLeaf, reader("reader", book));
    expect(rig.registry.pairings()).toHaveLength(1);

    rig.registry.clear();

    expect(rig.registry.pairings()).toEqual([]);
    expect(rig.registry.getByLeaf(readerLeaf)).toBeUndefined();
  });
});
