# Vendored code: vinceRV/obsidian-epub-reader

The files in this directory are forked from
[vinceRV/obsidian-epub-reader](https://github.com/vinceRV/obsidian-epub-reader)
(MIT), commit `67e5edbfee12cb09ba3c7216442d251196ff806f` (main; 23 commits
at the time of the fork). They are vendored into the repo per PRD §4 ("own
it outright rather than depend on it") — the upstream project is **not** a
runtime or build dependency.

| Forked file | Upstream file |
|---|---|
| `EpubView.ts` | `src/epub-view.ts` |
| `epubNavigationTools.ts` | `src/epub-navigation-tools.ts` |
| `epubThemes.ts` | `src/epub-themes.ts` |
| "EPUB reader view" block in the root `styles.css` | `src/styles.css` |

## Not forked

- Upstream `src/main.ts`: the plugin entry, the `openLinkText` patch and
  the `monkey-around` dependency. Link handling returns in F2.9 using the
  project's `#epubcfi(...)` grammar (F1.3); no monkey-patching
  third-party dependency is taken in.

## Adaptations made at fork time

- Copied links use the project's anchor grammar (F1.3): `#epubcfi(...)`
  for CFI positions and `#<href>` for spine items, replacing upstream's
  `#cfi=` / `#href=` fragment parameters.
- The location table (`book.locations.generate`) is produced on first
  copy, not at view open (PRD §7 open budget).
- `navigateToLocation` (the `openLinkText` patch's entry point) and its
  highlight state are dropped; navigation returns with the Reader
  contract (F2.7) in F2.9.
- `EpubThemes` gains a `destroy()`: upstream's `MutationObserver` on
  `document.body` outlived the view, so a theme toggle after closing the
  reader kept re-styling a destroyed rendition.
- `EpubView` disposes the previous reader when `onLoadFile` re-enters for
  a different file (upstream rendered on top of the live book).
- The `setEphemeralState`/`hasFocus` focus hack is dropped: no Obsidian
  code path invokes it; the relocated/resized correction carries the
  pane-resize recovery.
- Formatting aligned to the repo style (2-space indent, double quotes).

## Licence

MIT License

Copyright (c) 2025 vinceRV

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
