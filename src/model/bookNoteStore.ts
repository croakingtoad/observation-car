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
  /**
   * The re-parse pass currently in flight, if any. `flush()` awaits this
   * (and loops while work keeps landing) instead of returning early when
   * a pass is already underway — see `flush` for the contract.
   */
  private runPromise: Promise<void> | null = null;
  private rerunRequested = false;
  /**
   * Invalidation generation for re-parse runs. `clear()` advances it so
   * orphaned runs stop reading and cannot publish into the cleared store.
   */
  private epoch = 0;

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
        this.ensureRun().catch((error) => {
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
    if (this.pending.size === 0 && this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Drop everything, cancel pending work, and invalidate in-flight re-parses
   * (plugin unload).
   */
  clear(): void {
    this.epoch += 1;
    this.pending.clear();
    this.notes.clear();
    this.runPromise = null;
    this.rerunRequested = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run any pending re-parses now, ignoring the debounce window.
   *
   * Resolves only when every scheduled path has been re-parsed —
   * including paths scheduled while this flush is in flight. A consumer
   * that does `await flush(); read()` must never read a half-built cache.
   * If an invariant violation leaves a settled run published, the
   * progress guard logs and clears it instead of spinning the renderer.
   */
  async flush(): Promise<void> {
    for (;;) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (this.runPromise === null && this.pending.size === 0) return;
      const run = this.ensureRun();
      await run;
      if (this.runPromise === run) {
        console.error(
          "[observation-car] book-note flush made no progress",
        );
        this.runPromise = null;
      }
    }
  }

  /**
   * Make sure a pass is in flight covering the current pending set, and
   * return its promise. When a pass is already running, the flag it
   * checks before exiting — together with the pending set itself, which
   * it re-checks on every loop — makes it pick up whatever was scheduled
   * after its last snapshot. An initial microtask yield ensures the new
   * promise is published before its empty-pending path can settle and
   * clear itself; one run drains the set without dropping paths.
   */
  private ensureRun(): Promise<void> {
    if (this.runPromise !== null) {
      this.rerunRequested = true;
      return this.runPromise;
    }
    const run = this.runPending();
    this.runPromise = run;
    return run;
  }

  private runPending(): Promise<void> {
    const epoch = this.epoch;
    let thisRun: Promise<void> | null = null;
    thisRun = (async (): Promise<void> => {
      // `ensureRun` must publish this promise before any path, including an
      // empty pending set, can reach the finally block that clears it.
      await Promise.resolve();
      try {
        do {
          if (this.epoch !== epoch) return;
          this.rerunRequested = false;
          // Absorb the debounce timer: its paths are already in the pending
          // set this loop drains, so the timer must not fire a second pass
          // for work this pass has taken over.
          if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
          }
          const paths = [...this.pending];
          this.pending.clear();
          for (const path of paths) {
            // Per-path containment: a read or parse failure logs and moves
            // on, so one bad note can never drop its batch siblings.
            await this.reparsePath(path, epoch);
          }
        } while (
          // Deliberate defence-in-depth: the hoisted guard currently makes
          // this epoch check redundant, but this loop has produced a renderer
          // freeze and two orphan defects. No test can distinguish its presence.
          this.epoch === epoch &&
          (this.rerunRequested || this.pending.size > 0)
        );
      } finally {
        if (this.runPromise === thisRun) this.runPromise = null;
      }
    })();
    return thisRun;
  }

  /**
   * Re-parse a single path. Never throws: every failure mode is logged to
   * the dev console and the cache keeps the last-good parse, so a failing
   * note degrades to stale-but-usable data instead of corrupting the
   * batch or silently discarding state.
   */
  private async reparsePath(path: string, epoch: number): Promise<void> {
    if (this.epoch !== epoch) return;
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
    if (this.epoch !== epoch) return;
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
