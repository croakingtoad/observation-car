/**
 * F5.1 — Shared types for the Booklore OPDS client.
 *
 * This is the surface the rest of E005 consumes: F5.2 (browse/paginate),
 * F5.3 (search via the OpenSearch link), F5.4 (the "Open from Booklore"
 * modal), F5.5 (download an acquisition link), and F5.8 (the connection
 * test, which renders `OpdsError.kind` as a human-readable message). The
 * parser produces `OpdsFeed`/`OpdsEntry`/`OpdsLink`; the client wraps every
 * transport failure in a typed `OpdsError`.
 *
 * Deliberately free of `obsidian` imports so it (and the parser) unit-tests
 * in Node. See the `@vitest-environment jsdom` pragma on the parser test —
 * Node has no `DOMParser`, so that one test file runs against jsdom.
 */

/**
 * Why an OPDS request failed, classified at the point of failure so the
 * connection test (F5.8) can render a readable message without re-deriving
 * it. `http` carries the status in `OpdsError.status`.
 */
export type OpdsErrorKind =
  | "no-base-url"
  | "auth"
  | "unreachable"
  | "not-opds"
  | "http";

export class OpdsError extends Error {
  readonly kind: OpdsErrorKind;
  /** The HTTP status when `kind` is `"http"`; undefined otherwise. */
  readonly status?: number;

  constructor(kind: OpdsErrorKind, message: string, status?: number) {
    super(message);
    this.name = "OpdsError";
    this.kind = kind;
    this.status = status;
  }
}

/** A single `<link>` element, its `href` resolved to an absolute URL. */
export interface OpdsLink {
  rel: string;
  /** The `type` media type (e.g. `application/epub+zip`); "" when absent. */
  type: string;
  /** Absolute URL, resolved against the feed's own URL. */
  href: string;
  /** Human label from the `title` attribute; "" when absent. */
  title: string;
}

/** Whether an entry points at a sub-feed (navigation) or a file (acquisition). */
export type OpdsEntryKind = "navigation" | "acquisition";

/**
 * One `<entry>` in a feed.
 *
 * `acquisitions`, `images`, and `navigation` are filtered views of `links`
 * (the complete, resolved list), exposed so F5.4/F5.5 do not re-derive them.
 */
export interface OpdsEntry {
  id: string;
  title: string;
  /** Author names in feed order; empty when the entry has no `<author>`. */
  authors: string[];
  /** The entry-level `<updated>` value; "" when absent. */
  updated: string;
  /**
   * `<summary>` text, falling back to `<content>`; "" when neither is
   * present. HTML markup inside the element is reduced to its text.
   */
  summary: string;
  /** `<category>` terms (attribute, falling back to text) in feed order. */
  categories: string[];
  /**
   * `acquisition` when the entry has at least one
   * `http://opds-spec.org/acquisition*` link; `navigation` otherwise.
   */
  kind: OpdsEntryKind;
  /** Every `<link>` on the entry, `href`s resolved against the feed URL. */
  links: OpdsLink[];
  /** Acquisition links (rel `http://opds-spec.org/acquisition` + subtypes). */
  acquisitions: OpdsLink[];
  /** Cover / thumbnail image links. */
  images: OpdsLink[];
  /** The `rel="http://opds-spec.org/navigation"` link, when present. */
  navigation: OpdsLink | null;
}

/** Resolved pagination hrefs; `next` is what F5.2 follows to browse further. */
export interface OpdsPagination {
  next: string | null;
  prev: string | null;
  self: string | null;
  start: string | null;
}

/** A parsed OPDS 1.2 (Atom) feed. */
export interface OpdsFeed {
  /** The feed-level `<id>`; "" when absent. */
  id: string;
  title: string;
  /** The feed-level `<updated>` value; "" when absent. */
  updated: string;
  /** The URL the feed was fetched from (the parser's `feedUrl` argument). */
  url: string;
  /** Every feed-level `<link>`, `href`s resolved against `url`. */
  links: OpdsLink[];
  /** The OpenSearch description link (`rel="search"`), when advertised. */
  search: OpdsLink | null;
  pagination: OpdsPagination;
  entries: OpdsEntry[];
}
