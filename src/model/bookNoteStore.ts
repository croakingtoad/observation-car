/**
 * F1.2 — debounced re-parse cache for the BookNote model.
 *
 * Holds parsed book notes keyed by vault path and re-parses on demand with
 * a debounce window, so bursts of `metadataCache` events (a save storm, a
 * vault sync) collapse into one parse pass instead of one per event.
 *
 * Deliberately free of `obsidian` imports so the debounce is unit-testable
 * in Node: file reads and the live `anchorHeadingLevel` read are injected.
 * `main.ts` wires `metadataCache` events into `scheduleReparse`/`remove`
 * and passes `() => this.settings.anchorHeadingLevel` — the level is read
 * at parse time, never snapshotted (`updateSettings` replaces the settings
 * object wholesale, and there is no settings-change event to listen for).
 * Link resolution is injected the same way (`resolveLink`), so the store
 * can hand the parser a per-note resolver built on
 * `metadataCache.getFirstLinkpathDest` without importing `obsidian`.
 */

import { isBookNote, parseBookNote, type BookNote } from "./bookNote";

export interface BookNoteStoreDeps {
  /** Read a note's text; return null when the file no longer exists. */
  readText: (path: string) => Promise<string | null>;
  /**
   * Live read of the anchor heading level. Called for every parse; the
   * store never caches the value, so a mid-session settings change is
   * picked up on the next parse.
   */
  anchorHeadingLevel: () => number;
  /**
   * Resolve a link path (a wikilink target or the note's `source`) to the
   * vault path of the file it points at, or null when it does not
   * resolve. `main.ts` supplies
   * `metadataCache.getFirstLinkpathDest(linkpath, notePath)?.path`;
   * without it the parser falls back to string comparison, which keeps
   * `parseBookNote` testable from plain Node.
   */
  resolveLink?: (linkpath: string, notePath: string) => string | null;
  /** Debounce window in ms. Default 250. */
  debounceMs?: number;
}

export const DEFAULT_REPARSE_DEBOUNCE_MS = 250;

export class BookNoteStore {
  private readonly deps: BookNoteStoreDeps;
  private readonly notes = new Map<string, BookNote>();
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerunRequested = false;

  constructor(deps: BookNoteStoreDeps) {
    this.deps = deps;
  }

  /** The cached parse of a path, if the store holds one. */
  get(path: string): BookNote | undefined {
    return this.notes.get(path);
  }

  has(path: string): boolean {
    return this.notes.has(path);
  }

  get size(): number {
    return this.notes.size;
  }

  paths(): string[] {
    return [...this.notes.keys()];
  }

  /** Queue a path for re-parse; coalesced until the debounce elapses. */
  scheduleReparse(path: string): void {
    this.pending.add(path);
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.runPending().catch((error) => {
          // Per-path read/parse failures are contained and logged inside
          // the loop; only a bug in the store itself escapes here.
          console.error(
            "[observation-car] book-note re-parse pass failed",
            error,
          );
        });
      }, this.deps.debounceMs ?? DEFAULT_REPARSE_DEBOUNCE_MS);
    }
  }

  /** Drop a path (deleted/renamed away); also clears any pending re-parse. */
  remove(path: string): void {
    this.pending.delete(path);
    this.notes.delete(path);
  }

  /** Drop everything and cancel a pending re-parse (plugin unload). */
  clear(): void {
    this.pending.clear();
    this.notes.clear();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Run any pending re-parses now, ignoring the debounce window. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.runPending();
  }

  private async runPending(): Promise<void> {
    if (this.running) {
      // A run is in flight; its pending-set snapshot may not include paths
      // scheduled after it started, so re-loop once it is done.
      this.rerunRequested = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerunRequested = false;
        const paths = [...this.pending];
        this.pending.clear();
        for (const path of paths) {
          // Per-path containment: a read or parse failure logs and moves
          // on, so one bad note can never drop its batch siblings.
          await this.reparsePath(path);
        }
      } while (this.rerunRequested);
    } finally {
      this.running = false;
    }
  }

  /**
   * Re-parse a single path. Never throws: every failure mode is logged to
   * the dev console and the cache keeps the last-good parse, so a failing
   * note degrades to stale-but-usable data instead of corrupting the
   * batch or silently discarding state.
   */
  private async reparsePath(path: string): Promise<void> {
    let text: string | null;
    try {
      text = await this.deps.readText(path);
    } catch (error) {
      // A thrown read is a failure, not a deletion: the file may still
      // exist (iCloud sync eviction on iPad is the realistic case). Log
      // and keep the previous entry; a `null` return — the read
      // contract's "file gone", expected in the post-delete race — is
      // the only signal that evicts without logging.
      console.error(
        `[observation-car] read failed for book note ${path}`,
        error,
      );
      return;
    }
    if (text === null) {
      this.notes.delete(path);
      return;
    }
    try {
      const note = parseBookNote(text, {
        anchorHeadingLevel: this.deps.anchorHeadingLevel(),
        resolveLink: this.resolveLinkFor(path),
      });
      if (isBookNote(note)) {
        this.notes.set(path, note);
      } else {
        this.notes.delete(path);
      }
    } catch (error) {
      // parseBookNote rethrows anything that is not an AnchorError
      // (malformed fragments are diagnostics, not throws). Documented
      // choice: keep the last-good cache entry until a future parse
      // succeeds and replaces it — discarding known-good data on a parse
      // failure would repeat the data-loss the store is meant to avoid.
      console.error(
        `[observation-car] parse failed for book note ${path}`,
        error,
      );
    }
  }

  /**
   * The per-note resolver handed to the parser: the injected dependency
   * bound to the note's own path (Obsidian resolves relative to the file
   * the link sits in), or undefined when the caller supplied none, which
   * keeps the parser on its string-comparison fallback.
   */
  private resolveLinkFor(
    path: string,
  ): ((linkpath: string) => string | null) | undefined {
    const resolver = this.deps.resolveLink;
    if (resolver === undefined) return undefined;
    return (linkpath: string) => resolver(linkpath, path);
  }
}
