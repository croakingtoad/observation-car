# Observation Car — Obsidian reading & marginalia plugin

**Status:** PRD v1 for Claude Code handoff
**Date:** 2026-09-10
**Owner:** Marty Martin
**Working name:** Observation Car (railroad theme; rename freely — `obsidian-observation-car`)
**Tracking:** Multica project "Observation Car" — see §13 for how this document decomposes into Multica issues

---

## 1. Vision

Read an EPUB or PDF inside Obsidian with the book on the left and a normal Obsidian note on the right. Notes are anchored to locations in the book. As you turn pages, the note scrolls to the section for where you are. Close the book and the same note reads as a clean, gap-free set of reading notes. Books come from a self-hosted Booklore library; notes stay in the vault.

**Problem solved:** Every existing tool either (a) reads well but stores highlights in a proprietary sidecar, (b) uses real markdown but has no positional sync between book and notes, or (c) handles PDF or EPUB but not both. Nothing does "notes keyed to book position, shown alongside as you read, collapsing to a plain document when you don't."

**Design principle (non-negotiable):** The book note is an ordinary markdown file and is the single source of truth. The plugin adds behavior *on top of* Obsidian's editor; it never introduces a storage format that dies with the plugin. If Observation Car is uninstalled, every note remains fully readable and every anchor link still resolves to "a link to a file with a fragment."

## 2. Users

One user: Marty, on desktop (macOS/Windows/Linux Obsidian), tablet (iPadOS Obsidian primarily), and a Google Pixel 10 Pro Fold (Android). The Fold has two personalities and the plugin must handle both:

| State | Screen | Obsidian mode | Layout |
|---|---|---|---|
| Unfolded | 8" inner, 2076×2152 px (≈ 830 CSS px wide, roughly an iPad mini) | Tablet mode — split panes available | Side-by-side, same as iPad; narrower, so the split-ratio toggle and a "flip" mode matter more |
| Folded | 6.4" cover, 1080×2364 px | Phone mode — single leaf, no splits | Single-pane mode: one leaf at a time, flip between book and note (see F6.6) |

Obsidian switches modes on fold/unfold at runtime (there are open reports of this being unreliable on some foldables), so the plugin must survive a mode change mid-session without losing the reader↔note pairing (F6.7). Ordinary slab phones get the same single-pane mode as a by-product but are not a test target.

## 3. Scope

### In scope (v1)
- Native EPUB reading view inside Obsidian
- Native PDF reading via Obsidian's built-in PDF viewer, instrumented by the plugin
- Book note format with location-anchored sections
- Scroll-sync: reader location → note section
- Focus mode: fold/dim sections outside the current chapter
- "New note here" command inserting an anchored section at the current location (optionally with a quoted selection)
- Anchor links clickable from anywhere in the vault → open the book at that location
- Booklore integration via OPDS: browse, search, download into the vault, seed the book note's frontmatter
- Split-ratio toggle (read vs. write)
- Desktop, tablet, and foldable support (`isDesktopOnly: false`); single-pane fallback for phone mode

### Out of scope (v1) — do not create Multica issues
- Highlights painted onto the book (colored ranges persisted in the EPUB/PDF)
- Writing reading progress or annotations back to Booklore (Booklore's REST API is explicitly undocumented/unstable; OPDS is read-only)
- Slab-phone-specific polish (single-pane mode should work there but is not tested or tuned)
- Margin-card rendering of notes (v2 candidate; see §12)
- Comics/CBZ
- Sync of book files between devices beyond whatever vault sync the user already runs

## 4. Prior art and reuse

| Project | License | Use |
|---|---|---|
| `vinceRV/obsidian-epub-reader` | MIT | **Fork as the EPUB view starting point.** Already: epub.js render, TOC, arrow-key paging, "copy quote with link to exact location" (CFI), link resolution for `.epub#…` links, PDF++-style workspace patching. Tiny (23 commits) — own it outright rather than depend on it. |
| `RyotaUshio/obsidian-pdf-plus` (PDF++) | MIT (verify before copying code) | **Reference implementation** for hooking Obsidian's native PDF viewer: how it obtains the pdf.js `eventBus`, listens to `pagechanging`, reads selections, and patches `openLinkText` for `#page=N&selection=…` fragments. Do not depend on PDF++ at runtime; do stay compatible with its link syntax so users with PDF++ installed get highlights for free. |
| Obsidian core PDF view | — | Provides the PDF renderer, mobile support, and `#page=N` link handling. The plugin wraps it; it does not bundle pdf.js. |
| `epubjs` (0.3.x) + `jszip` | BSD/MIT | EPUB rendering and CFI generation/comparison (`EpubCFI.compare`). |
| Booklore OPDS catalog (`/api/v1/opds`, HTTP Basic Auth, OPDS user accounts separate from the web login) | — | Library browse/search/download. |

## 5. Storage model

### 5.1 Vault layout (all configurable)

```
Books/                      ← downloaded EPUB/PDF files (inside vault, per decision)
  Surprised by Grace.epub
  Some Paper.pdf
Reading/                    ← one book note per book
  Surprised by Grace.md
  Some Paper.md
```

### 5.2 Book note

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
Free markdown. [[Links]], #tags, callouts, Dataview — anything.

## [[Books/Surprised by Grace.epub#epubcfi(/6/14!/4/2/12:0)|Ch. 3 — "leaves the furniture where it found it"]]
> Grace does not announce itself…

Commentary.

## [[Books/Some Paper.pdf#page=7&selection=12,0,14,40|p. 7 — method section]]
```

**Anchor definition:** an H2 (configurable level) whose text contains a wikilink to the note's `source` file with a fragment. Everything from that heading to the next anchor heading is the section body. Non-anchor headings (H3+, or H2 without a link) are ordinary content inside a section.

**Fragments:**
- EPUB: `#epubcfi(<cfi>)` — canonical fragment identifier generated by epub.js. Also accept `#<href>` (spine item href) for chapter-level anchors.
- PDF: `#page=N` (Obsidian native). Optional `&selection=a,b,c,d` (PDF++ syntax) when a text selection was captured. Optional `&height=` ignored.

**Ordering:** sections are ordered by book position, not file order. The plugin sorts on insert; if a user hand-reorders, the plugin tolerates it (sync uses position lookup, not line order). A "Sort sections by book position" command exists.

**Chapter membership (for focus mode):**
- EPUB: spine index parsed from the CFI (`/6/N!` → spine position).
- PDF: outline/bookmarks if present (nearest outline entry ≤ page); else a configurable ±N page window (default ±10).

### 5.3 Compact view
There is no separate compact view. The book note *is* the compact view: close the reader leaf and the file reads top to bottom with no gaps. Focus mode is off when no reader for that source is open.

### 5.4 Plugin data (`data.json`)
Settings only, plus a small download index `{booklore_id → vault path, etag/updated}`. No note content ever lives here.

## 6. Functional requirements

### E001 — Plugin scaffold & storage model (P0)
- F1.1 TypeScript + esbuild scaffold, `manifest.json` with `isDesktopOnly: false`, `minAppVersion` ≥ 1.7.2.
- F1.2 `BookNote` model: parse a markdown file into `{frontmatter, sections: [{headingLine, bodyRange, fragment, position, chapter}]}`. Pure function, unit-tested (vitest). Re-parse on `metadataCache` change, debounced.
- F1.3 `Anchor` utilities: build/parse fragments for EPUB and PDF; comparator for positions (CFI compare via epub.js; integer for PDF).
- F1.4 Settings tab: books folder, notes folder, anchor heading level, note template, focus mode default, PDF chapter window, split ratios, Booklore base URL / OPDS username / OPDS password (stored in `data.json`; show a plaintext warning in the UI).
- F1.5 Command: "Create book note for current book" (from an open reader) using the template.

### E002 — EPUB reader (P0)
- F2.1 Register `.epub` extension → `EpubView` (ItemView). Fork vinceRV's view; strip what isn't needed.
- F2.2 Paginated mode (default) and scrolled mode; page turn via arrow keys, on-screen buttons, and on touch: tap zones (left/right thirds) and horizontal swipe.
- F2.3 TOC sidebar/dropdown; jump to chapter.
- F2.4 Remember last location per book (CFI) in `data.json`; restore on open.
- F2.5 Emit `LocationChanged {file, fragment, chapter}` events on every relocation (debounced ~150 ms). This is the contract the sync layer consumes.
- F2.6 Selection API: return `{text, cfiRange}` for the current selection.
- F2.7 Open at fragment: `openAtFragment(fragment)` for link navigation.
- F2.8 Theme-aware: inherit Obsidian font/colors; font-size stepper.
- F2.9 Link handling: `[[book.epub#epubcfi(...)]]` anywhere in the vault opens/focuses the reader leaf at that location (patch `openLinkText` as vinceRV/PDF++ do). Hover preview P2.

### E003 — PDF reader adapter (P0)
- F3.1 Detect when a leaf of core view type `pdf` opens a file that has (or could have) a book note. Do not replace the core viewer.
- F3.2 Obtain the pdf.js viewer/eventBus from the core view (follow PDF++'s approach; guard every access, fail soft on API changes).
- F3.3 Emit `LocationChanged` on `pagechanging`; chapter from outline or page window.
- F3.4 Selection API: `{text, page, selectionRect|selectionTuple}`; emit PDF++-compatible `&selection=` when computable, else `#page=N` only.
- F3.5 Open at fragment: use Obsidian's native `#page=N` handling; if `selection=` present and PDF++ is installed, defer to it.
- F3.6 Verify on iPad: core PDF view exists on mobile; confirm eventBus access works there or fall back to polling the visible page (P0 fallback if patching fails on mobile).

### E004 — Note sync layer (P0)
- F4.1 `ReaderRegistry`: maps open reader leaves ↔ book notes by `source`. One active pairing per book.
- F4.2 "Open book note beside reader" command and auto-open setting: opens/creates the note in a vertical split in the main area (never the sidebar).
- F4.3 Scroll-sync: on `LocationChanged`, find the section with the greatest position ≤ current (or none). Scroll the editor so the heading sits near the top (`editor.scrollIntoView` / CM6 `EditorView.scrollIntoView` with margin). Do not steal focus. Debounced; suppressed while the user is typing (idle threshold ~1.5 s) so the pane never yanks mid-sentence.
- F4.4 Current-section decoration: CM6 `ViewPlugin` adds a line class (`oc-current`) to the current section's heading + body; styled via `styles.css` using Obsidian CSS vars.
- F4.5 Focus mode: CM6 decoration replaces every section outside the current chapter with a one-line widget ("N sections in other chapters folded"). Click the widget or run "Toggle focus mode" to expand. Also works in Reading view (post-processor hides non-current sections) — P1.
- F4.6 "New note here" command (default hotkey Alt+N; also a reader toolbar button and a mobile toolbar action): 
  1. Get current location (+ selection if any).
  2. Build heading: `## [[<source>#<fragment>|<label>]]` where label = `Ch. N — ` + (selection excerpt ≤ 60 chars | "note").
  3. Insert at the sorted position; if a section already exists for this exact fragment, jump to it instead.
  4. If selection: insert `> <selection>` under the heading.
  5. Place cursor on the blank line after the heading/quote, focus the editor.
- F4.7 "Jump book to this section" command: from the editor cursor, open the reader at the enclosing section's fragment.
- F4.8 Split-ratio toggle command: cycles read (60/40) ↔ write (40/60) by resizing the two leaves' parent split. Ratios configurable.
- F4.9 "Sort sections by book position" command.

### E005 — Booklore integration (P0)
- F5.1 OPDS client using Obsidian `requestUrl` (works on mobile, avoids CORS). Basic Auth from settings. Parse Atom XML with `DOMParser` (no extra dependency).
- F5.2 Browse: root catalog → navigation feeds → acquisition entries; paginate via `rel="next"`.
- F5.3 Search: use the catalog's OpenSearch link if advertised; otherwise fetch the "all books" feed and filter client-side by title/author. Verify against the live instance during implementation.
- F5.4 Modal: "Open from Booklore" — fuzzy search box, results with title/author/format badges, cover thumbnail if cheap. Prefer EPUB when both formats exist; let the user pick.
- F5.5 Download: acquisition link with `type` `application/epub+zip` or `application/pdf` → `requestUrl` (arraybuffer) → `vault.adapter.writeBinary` into the books folder. Filename from title (sanitized). Record in download index. Skip download if already present and unchanged.
- F5.6 Create/open the book note with frontmatter seeded from the OPDS entry (title, author(s), booklore id/url, format, cover if downloaded), then open reader + note side by side.
- F5.7 "Re-download from Booklore" command for a book note (uses `booklore_id`).
- F5.8 Connection test button in settings with a readable error (auth failure vs. unreachable vs. OPDS disabled).

### E006 — Tablet & foldable support (P0)
- F6.1 No Node/Electron APIs anywhere; no `fs`, no `path`, no `child_process`. Vault access only through `app.vault` / `adapter`.
- F6.2 EPUB view usable with touch: tap zones, swipe, pinch-to-zoom disabled inside the reader (font-size stepper instead).
- F6.3 All commands reachable without a keyboard: ribbon icon, reader toolbar, and registered as commands so they appear in the mobile toolbar.
- F6.4 Layout on iPad split view: verify both leaves render at ~50% of a 1024–1366 px width; split-ratio toggle available.
- F6.5 Layout on the Fold's inner screen (~830 CSS px): both leaves at 50/50 are ~410 px each. EPUB must reflow legibly at that width (auto-reduce default font size below a configurable threshold); PDF is expected to be poor at 50/50, so the split-ratio toggle offers an 80/20 "reader-dominant" step on narrow tablets and the flip mode (F6.6) is one tap away.
- F6.6 Single-pane ("flip") mode for phone mode / very narrow widths: the reader and the note share the main area one at a time. Commands and a reader-toolbar button: "Flip to note" (opens the note at the section for the current location, applying focus mode and the current-section highlight) and "Flip to book" (returns to the reader at the last location). "New note here" in flip mode inserts the section and flips to it with the cursor placed. Location and pairing persist across flips.
- F6.7 Fold/unfold resilience: listen for `layout-change` / `resize` and `Platform` mode changes; when the app moves from phone → tablet mode, offer (setting: automatic) to re-open the paired note in a split; when tablet → phone, collapse to flip mode without losing state. Never crash or duplicate leaves on a mode change.
- F6.8 Test matrix documented in `TESTING.md`: macOS desktop, iPadOS, Pixel 10 Pro Fold (unfolded and folded, plus a fold/unfold transition mid-session). Each release manually checked on desktop + iPad + Fold.

### E007 — Quality, docs, release (P1)
- F7.1 Unit tests: note parser, fragment parse/build, position comparator, section insert placement, OPDS feed parser (fixtures from a real Booklore instance).
- F7.2 README with the storage format spec (§5) so the format is documented independently of the code.
- F7.3 BRAT-installable releases via GitHub Actions (main.js, manifest.json, styles.css, versions.json).
- F7.4 Graceful degradation: if PDF viewer patching fails, show a one-time notice and fall back to page polling; if epub.js throws on a malformed book, show the error in the leaf rather than a blank pane.

## 7. Non-functional requirements
- Reader open ≤ 1.5 s for a typical 2–5 MB EPUB on desktop; ≤ 3 s on iPad.
- Scroll-sync latency ≤ 200 ms after a page turn.
- Note parsing must not block the UI for files up to ~5,000 lines.
- Zero writes to the book note except via explicit user commands (F4.6, F4.9, F1.5, F5.6). Sync and focus are read-only decorations.
- Works offline once a book is downloaded.

## 8. Architecture

```
src/
  main.ts                 plugin entry; registers views, commands, settings, patches
  settings.ts
  model/
    bookNote.ts           parse/serialize sections, insert-at-position
    anchor.ts             fragment build/parse, comparators
  readers/
    Reader.ts             interface: onLocationChanged, getSelection, openAtFragment, chapterOf
    EpubView.ts           ItemView (forked from vinceRV)
    PdfAdapter.ts         wraps core pdf leaf (PDF++-style access)
    registry.ts           reader ↔ note pairing
  sync/
    scrollSync.ts
    decorations.ts        CM6 ViewPlugin: current-section + focus folding
    readingView.ts        post-processor for Reading view (P1)
    commands.ts           new-note-here, jump, sort, split toggle
  booklore/
    opds.ts               client + parser
    modal.ts              search/open modal
    download.ts
  ui/
    toolbar.ts
styles.css
```

**Reader contract** (everything downstream depends only on this):
```ts
interface Reader {
  file: TFile;
  format: 'epub' | 'pdf';
  on(event: 'location', cb: (loc: Location) => void): () => void;
  getLocation(): Location | null;
  getSelection(): { text: string; fragment: string } | null;
  openAtFragment(fragment: string): Promise<void>;
}
interface Location { fragment: string; chapter: ChapterId; label: string; }
```

**Dependencies:** `obsidian`, `@codemirror/view`, `@codemirror/state` (externalized; Obsidian provides them). `epubjs` and `jszip` are bundled into `main.js` — an Obsidian plugin ships no `node_modules`, so externalizing them can never resolve at load (DP-003). No React.

## 9. Milestones

| M | Deliverable | Epics |
|---|---|---|
| M1 | Read an EPUB from the vault with a synced book note: scroll-sync, focus mode, new-note-here, link navigation. Desktop only for this milestone. | E001, E002, E004 |
| M2 | Same for PDF via the core viewer. | E003 |
| M3 | Booklore: search, download, open with seeded note. | E005 |
| M4 | iPad and Pixel Fold verified (unfolded split + folded flip mode); touch paging; mobile toolbar; BRAT release. | E006, E007 |

Critical path: E001 parser/anchors → E002 location events → E004 scroll-sync → E004 new-note-here → E003 → E005 → E006.

## 10. Acceptance test (end-to-end, run on desktop, iPad, and the Fold unfolded)
1. Settings: point at Booklore, connection test passes.
2. "Open from Booklore" → search a title → pick EPUB → file appears in `Books/`, note appears in `Reading/` with correct frontmatter, both open side by side.
3. Turn pages: when a page with an anchored section is reached, the note scrolls to it and highlights it within 200 ms; pages without notes produce no movement past the last relevant section.
4. Alt+N with text selected → a sorted anchored section with a blockquote appears; cursor is in the body; typing `[[` triggers Obsidian link autocomplete.
5. Toggle focus mode → sections in other chapters fold; expand works.
6. Close the reader → the note shows all sections, no folds, no highlight.
7. From an unrelated note, click an `[[book.epub#epubcfi(...)]]` link → reader opens at that location.
8. Repeat 3–7 with a PDF using `#page=N` anchors.
9. Uninstall the plugin → book notes remain valid markdown; links still open the file.
10. Fold only: with the reader open unfolded, fold the phone → Obsidian drops to phone mode → the reader remains, "Flip to note" opens the note at the current section, Alt+N-equivalent toolbar button inserts a section and flips. Unfold → the split is restored (or offered) with pairing intact.

## 11. Open questions (resolve during implementation; don't block M1)
- Does Booklore's OPDS advertise OpenSearch? If not, confirm the "all books" feed is paginated and size-reasonable for client-side filtering.
- Can the pdf.js eventBus be reached from the core PDF view on iPadOS? If not, F3.6 polling fallback becomes the mobile path.
- Should chapter labels come from the EPUB TOC title (preferred) or "Ch. N"? Default: TOC title when resolvable, else number.
- Anchor heading level: H2 default. Confirm this doesn't collide with existing note conventions in the vault.
- Does Obsidian on the Pixel 10 Pro Fold reliably switch tablet↔phone mode on fold/unfold? If not, F6.7 may need a manual "Force split / force single-pane" command as a workaround.

## 12. v2 candidates (not now)
- Margin-card read-only rendering of the note beside the book.
- Highlight overlays in the reader driven by anchors (PDF++ already does this for PDF).
- Push reading position to Booklore once its API stabilizes (or via KOReader-sync-compatible endpoint if exposed).
- Hover previews for anchor links.
- Multi-note per book (e.g. a "quotes" file and a "commentary" file both anchored to the same source).

## 13. Multica handoff

Work is tracked in Multica (Planning and Tasks), not in any file-based tracker. Decompose this PRD as follows:

- **Project:** create a Multica project "Observation Car" and attach this PRD to it. Every issue below is created with `--project` set to it.
- **Epics → parent issues:** one issue per epic E001–E007, titled exactly as the section headings here (e.g. `E004 — Note sync layer`), priority from the epic's P-tag, labeled `epic`.
- **Features → sub-issues:** one sub-issue per F-line under its epic, titled `F4.3 Scroll-sync` etc. Description = the F-line text verbatim plus a `## Done when` checklist derived from §10 where applicable, and a `## Depends on` line naming other F-ids. Keep each sub-issue ≤ 1 day of agent work; split if larger.
- **Milestones → labels:** `M1`–`M4` labels on each sub-issue per §9.
- **Dependencies:** Multica has no hard dependency edges, so the critical path in §9 is recorded in the project description and in each issue's `## Depends on` line. Agents must not start a sub-issue whose dependencies are not in a done state.
- **Assignment:** the coding agent (Claude Code via the local Multica daemon) is assigned sub-issues one milestone at a time in critical-path order. Epics are never assigned; they close when their sub-issues close.
- **Reporting:** the agent comments on the issue with a short summary and the commit/PR link on completion, moves it to review, and raises a blocker comment (not a status change) for anything in §11 it cannot resolve.
- **Tooling:** use the `multica-cli` skill (multica-ai/multica-cli) for issue creation, comments, and status moves; run `multica version` first and confirm ≥ 0.4.26.
