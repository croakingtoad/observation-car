# Observation Car

An Obsidian plugin for reading EPUBs and PDFs alongside your own notes. The book opens on the left; an ordinary markdown note opens on the right, and each note section is anchored to a location in the book — so as you turn pages, the note scrolls to whatever you wrote about that passage. Close the book and the same file reads as a clean, gap-free set of reading notes.

**Status:** The book-note model, anchor utilities, settings, and an in-plugin EPUB view are in (F1.2–F1.4, F2.1). Scroll-sync, PDF integration, Booklore, and mobile support land in the follow-up milestones (PRD §9).

## Storage format

The format is deliberately plain: a book note is an ordinary markdown file in your vault, and every anchor is an ordinary Obsidian wikilink with a fragment. This section fully specifies the format — reading it, hand-editing it, and writing tools against it require neither the plugin nor this repository. The governing rule (PRD §1): the note is the single source of truth, and the plugin never introduces a storage format that dies with the plugin.

### Vault layout

Two folders (defaults shown; both configurable in the plugin settings):

```
Books/    ← book files (EPUB / PDF)
Reading/  ← book notes, one markdown file per book
```

A note and its book are paired by the note's `source` frontmatter field, not by name or location — either may be renamed or moved as long as `source` keeps pointing at the file.

### The book note

Frontmatter keys:

| Key | Required | Meaning |
|---|---|---|
| `source` | **Yes** — the only required key | Vault path of the book file. Wikilink form (`[[Books/Name.epub]]`) or plain path; a trailing `#fragment` is ignored. A note without a usable `source` is not a book note. |
| `format` | Recommended | `epub` or `pdf` (case-insensitive). Constrains which fragment kinds count as anchors; a kind/format mismatch is reported as a diagnostic, never guessed at. With no `format` or an unrecognized value it is treated as unset: any well-formed fragment kind is accepted and no kind check runs — silently, with no diagnostic. |
| `type` | No | The convention `book-note`. The parser keys off `source`; this key is for humans and other tools. |
| `title`, `author` | No | Free text, informational. |
| `booklore_id`, `booklore_url`, `cover` | No | Booklore provenance: the library's book id, its URL, and a wikilink to a cover image in the vault. Set when a book is downloaded from Booklore. |

Frontmatter is read as flat `key: value` lines — quoted, boolean, and numeric values are fine; nested YAML is not part of the format.

Complete worked example — an EPUB note:

```markdown
---
type: book-note
source: "[[Books/Surprised by Grace.epub]]"
format: epub
title: Surprised by Grace
author: A. N. Author
booklore_id: 142
booklore_url: https://booklore.example/book/142
cover: "[[Books/covers/142.jpg]]"
---

## [[Books/Surprised by Grace.epub#epubcfi(/6/8!/4/2/1:0)|Ch. 1 — the opening image]]
Free markdown: [[Links]], #tags, callouts, Dataview — anything goes in a section body.

### A subheading that is not an anchor
Headings at other levels are ordinary content inside the section.

## [[Books/Surprised by Grace.epub#epubcfi(/6/14!/4/2/12:0)|Ch. 3 — "leaves the furniture where it found it"]]
> Grace does not announce itself…

Commentary.
```

A PDF note has the same shape — `format: pdf` and `page=N` anchors:

```markdown
---
type: book-note
source: "[[Books/Some Paper.pdf]]"
format: pdf
title: Some Paper
author: R. D. Researcher
---

## [[Books/Some Paper.pdf#page=7|p. 7 — the method section]]
Why the method matters.

## [[Books/Some Paper.pdf#page=7&selection=12,0,14,40|p. 7 — the key sentence]]
> We measured …

## [[Books/Some Paper.pdf#page=23|p. 23 — results]]
The numbers, and what they do not say.
```

Text before the first anchor heading is free note preamble; it belongs to no section.

### Anchors

An **anchor** pins a section of the note to a location in the book. It is an ATX heading (the `##` style — setext `Title ===` headings are not recognized) at the anchor heading level, **H2 by default**, configurable from 1 to 6 in the plugin settings, whose text contains a wikilink to the note's `source` file **with a non-empty fragment**. The match against `source` is case-insensitive.

The link may sit anywhere in the heading, and the text around it (including the `|alias`) is the section's display title. If a heading carries several links to the source, the first is used.

A **section** runs from the anchor heading's line to the line before the next anchor heading; consecutive sections tile the file with no gap or overlap, so the note always reads cleanly top to bottom.

Not anchors — ordinary body content:

- headings at any other level (with the H2 default: H1, H3, H4, …);
- headings with no link, or a link to the source without a fragment;
- links to any file other than the note's `source`;
- headings inside fenced code blocks;
- headings whose fragment is malformed for the book's format (for example `#page=7` in an `epub` note): they are left in place as plain content, with a non-fatal diagnostic naming the line. The plugin never rewrites the note.

### Fragment syntax

The fragment is the part of the wikilink after `#`; in a note it always follows the file path (`[[path#fragment|label]]`), and the leading `#` is optional for the parser.

**EPUB** (`format: epub`) — two kinds:

- `epubcfi(<cfi>)` — an EPUB CFI exactly as emitted by epub.js: the precise location. A *point* CFI such as `/6/8!/4/2/1:0` is a chapter component (`/6/8!`) followed by a path into the chapter's HTML — element steps ending in a character offset (`:0`). A *range* CFI (captured from a text selection) has three components — `base!path, start, end` — and orders by its start. Node-id assertions in square brackets (for example `/4[chap01ref]!/`) are valid CFI content and are allowed inside the link.
- a bare spine-item href, such as `#chapter-01.xhtml` — a chapter-level anchor for the start of that spine item. The href may not contain whitespace or a second `#`.

**PDF** (`format: pdf`) — one kind, built on Obsidian's native page link:

- `page=N` — the page number, 1-based. This is the form Obsidian's built-in PDF viewer understands.
- `page=N&selection=x1,y1,x2,y2` — an optional rectangle in page coordinates (PDF++-compatible syntax), present when a text selection was captured with the anchor.
- `page=N&height=<number>` — accepted and ignored (a PDF++ vertical offset).
- `page` must be the first parameter; duplicate and unknown parameters are rejected.

Parsing is strict on purpose: anything outside this grammar is not a position. The heading is treated as ordinary content and a diagnostic is reported, rather than guessing a location.

### Ordering

A section's position in the book lives in its anchor; **the order sections appear in the file is not authoritative**. Sync will resolve each section by its parsed position, not its line in the file, so hand-reordering, splitting, or merging sections in the note will be tolerated and keep working. The intended workflow keeps the file tidy for you — new sections insert at their book-sorted position, and a "Sort sections by book position" command re-sorts an existing note (both per PRD §5.2, not yet shipped as of this writing).

Positions compare in book order: EPUB by spine item, then path, then character offset (epub.js `EpubCFI.compare`; range CFIs by their start); PDF by page, then selection rectangle, with a bare `page=N` before any selection on that page. Bare spine-item href anchors currently order lexicographically by href in code-unit order (`chapter-10.xhtml` sorts before `chapter-2.xhtml`); resolving them to true spine order needs the book and is not yet shipped.

### Chapter membership (focus mode)

Focus mode groups sections by the chapter of their anchor. Chapter membership is computed at read time and is **never stored in the note**:

- **EPUB** — the chapter is inside the anchor itself: the CFI chapter component is of the form `/X/N!`, where epub.js encodes the spine item as `N = (itemIndex + 1) × 2`, so the 0-based spine item index is `N / 2 − 1` (in the example above, `/6/8!` → spine item 3 (0-based), `/6/14!` → spine item 6 (0-based)). No book file is needed.
- **PDF** — the fragment carries no chapter. The chapter is the nearest outline/bookmark entry at or before the page, or — when the PDF has no outline — a configurable `±N` page window around the page (`pdfChapterWindowPages`, default 10).

The focus-mode behaviour itself (folding sections outside the current chapter) is planned (PRD F4.5) and not yet shipped.

### No hidden state

- There is no separate compact view, sidecar file, or render cache: the book note *is* the compact/reading view (PRD §5.3). Close the book and the file reads top to bottom with no gaps.
- The plugin's `data.json` (`.obsidian/plugins/observation-car/data.json`) holds **settings only** — including the Booklore OPDS credentials, which are stored there in plaintext (the settings tab shows a warning) — and, once Booklore support ships, a small download index mapping `booklore_id` to vault path with etag/updated. Note content never lives there (PRD §5.4).

### If you uninstall the plugin

Everything above outlives the plugin:

- The note is ordinary, valid markdown — no proprietary syntax anywhere.
- Every anchor is a standard Obsidian wikilink (`[[file#fragment|label]]`) to a book file that stays in the vault. The links keep resolving and keep opening the book file — for PDFs, `#page=N` is handled by Obsidian's built-in PDF viewer, not by the plugin — and Obsidian's search, backlinks, and link autocomplete keep working on them.
- The note still reads top to bottom as a clean, gap-free set of reading notes.

## Requirements

- Node.js >= 20
- npm

## Commands

- `npm install` — install dependencies
- `npm run dev` — build in watch mode (for development)
- `npm run build` — type-check (`tsc --noEmit`) and produce `main.js`
- `npm test` — run the vitest suite

## Directory layout

The `src/` tree follows PRD §8:

```
src/
  main.ts                 plugin entry (scaffold)
  model/                  bookNote, anchor          (LOCO-22, LOCO-23)
  readers/                Reader, EpubView, PdfAdapter, registry (E002/E003)
  sync/                   scrollSync, decorations, readingView, commands (E004)
  booklore/               opds, modal, download     (E005)
  ui/                     toolbar                   (E006)
styles.css
```

The component files are created by their owning issues; the directories exist so the skeleton is in place.

## Build notes

- `obsidian`, `epubjs`, `jszip`, `@codemirror/view`, and `@codemirror/state` are **externalized** in `esbuild.config.mjs` — they are not bundled. No React.
- `manifest.json` sets `isDesktopOnly: false` and `minAppVersion: 1.7.2`.
- The bundled `main.js` is CommonJS (Obsidian loads plugins via `require`); source files use ES modules.

## Spec

The product requirements live in [`plan/observation-car-prd.md`](plan/observation-car-prd.md).
