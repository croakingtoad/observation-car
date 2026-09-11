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
 *
 * Failure policy (LOCO-105): a re-parse that fails — a read that throws,
 * or a `parseBookNote` throw, which the parser reserves for its own bugs
 * rather than legitimately unparseable notes — logs the error and keeps
 * the last-good cache entry, if any: a slightly stale section list beats
 * losing the note's sections outright. Only a null read (the file is
 * gone) evicts. Errors surface via `console.error` with the path and the
 * error, visible in Obsidian's dev console; the note is re-parsed by the
 * next event that schedules it.
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
          // Per-path read and parse failures are handled inside
          // runPending, so this only fires on an unexpected store-internal
          // failure. Log it; any path dropped from the queue is re-parsed
          // by the next event that schedules it.
          console.error("[observation-car] book-note re-parse pass failed:", error);
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
          try {
            const text = await this.deps.readText(path);
            if (text === null) {
              // A null read means the file is gone (deleted or renamed
              // away) — the expected post-delete race: evict, no log.
              this.notes.delete(path);
              continue;
            }
            const note = parseBookNote(text, {
              anchorHeadingLevel: this.deps.anchorHeadingLevel(),
            });
            if (isBookNote(note)) {
              this.notes.set(path, note);
            } else {
              this.notes.delete(path);
            }
          } catch (error) {
            // A read that throws is not a deletion (iCloud eviction, a
            // transient vault error), and a parseBookNote throw is a parser
            // bug — the parser itself handles every legitimately malformed
            // note. Either way the last-good entry, if any, stays cached,
            // and the note is re-parsed by the next event that schedules
            // this path.
            console.error(
              `[observation-car] book-note re-parse failed for ${path}:`,
              error,
            );
          }
        }
      } while (this.rerunRequested);
    } finally {
      this.running = false;
    }
  }
}
