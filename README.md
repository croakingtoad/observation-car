# Observation Car

An Obsidian plugin for reading EPUBs and PDFs alongside your own notes. The book opens on the left; an ordinary markdown note opens on the right, and each note section is anchored to a location in the book — so as you turn pages, the note scrolls to whatever you wrote about that passage. Close the book and the same file reads as a clean, gap-free set of reading notes.

**Status:** F1.1 scaffold only — a TypeScript + esbuild project that builds an empty-but-loadable plugin. Feature work (readers, the book-note model, scroll-sync, Booklore, settings) lands in the follow-up issues.

## Requirements

- Node.js >= 20
- npm

## Commands

- `npm install` — install dependencies
- `npm run dev` — build in watch mode (for development)
- `npm run build` — type-check (`tsc --noEmit`) and produce `main.js`
- `npm test` — run the vitest suite

## Installing via BRAT

1. Install [BRAT](https://github.com/tfthacker/obsidian42-brat) if you don't have it already (Settings → Community plugins → Browse → "BRAT"; usage docs at https://tfthacker.com/BRAT).
2. In BRAT, paste the repo path `croakingtoad/observation-car` as a community plugin repo.
3. Pick the version you want — a GitHub release must already exist for that version; BRAT installs the release's top-level assets (`main.js`, `manifest.json`, `styles.css`). `versions.json` is kept in the repo root for Obsidian's update flow and is also attached to the release.
4. Restart Obsidian and enable **Observation Car** under Settings → Community plugins.

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
