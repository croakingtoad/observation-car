/**
 * F5.1 — Shared types for the Booklore OPDS client.
 *
 * This is the surface the rest of E005 consumes: F5.2 (browse/paginate),
 * F5.3 (search via the OpenSearch link), F5.4 (the "Open from Booklore"
 * modal), F5.5 (download an acquisition link), and F5.8 (the connection
 * test, which renders `OpdsError.kind` as a human-readable message). The
 * parser produces `OpdsFeed`/`OpdsEntry`/`OpdsLink` (and, for the
 * `rel="search"` document, `OpenSearchDescription`); the client wraps
 * every transport failure in a typed `OpdsError`.
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
 *
 * `publisher`, `language`, and `summary` are pass-throughs of source
 * metadata: the live library's values are inconsistent (mixed author
 * spellings, `dc:publisher` values like `#PrB.rating#4.31`), so the parser
 * never normalizes them.
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
   * present. HTML markup — whether real markup inside the element or
   * markup the source escaped into the text, as Booklore sends — is
   * reduced to its text.
   */
  summary: string;
  /** `<category>` terms (attribute, falling back to text) in feed order. */
  categories: string[];
  /**
   * `<dc:publisher>` (Dublin Core, `http://purl.org/dc/terms/`); "" when
   * absent. The catalog browser displays it in the entry details.
   */
  publisher: string;
  /**
   * `<dc:language>` (Dublin Core); "" when absent. Observed live values:
   * `en`, `en-us`.
   */
  language: string;
  /**
   * `acquisition` when the entry has at least one
   * `http://opds-spec.org/acquisition*` link; `navigation` otherwise. Note
   * the live library also contains catalog entries with no acquisition
   * link at all (a book whose file is not downloadable); they classify as
   * `navigation` by this rule and F5.4 must cope.
   */
  kind: OpdsEntryKind;
  /** Every `<link>` on the entry, `href`s resolved against the feed URL. */
  links: OpdsLink[];
  /** Acquisition links (rel `http://opds-spec.org/acquisition` + subtypes). */
  acquisitions: OpdsLink[];
  /** Cover / thumbnail image links. */
  images: OpdsLink[];
  /**
   * The entry's sub-feed link — `rel="http://opds-spec.org/navigation"`
   * or the legacy `rel="subsection"` that Booklore sends on every
   * navigation entry — when present; null otherwise.
   */
  navigation: OpdsLink | null;
}

/**
 * Resolved pagination hrefs. Live Booklore feeds advertise `self`,
 * `start`, `first`, `previous`, `next`, and `last` (LOCO-101 captures);
 * `prev` matches either the `previous` or `prev` rel. `next` is what F5.2
 * follows to browse further.
 */
export interface OpdsPagination {
  next: string | null;
  prev: string | null;
  self: string | null;
  start: string | null;
  first: string | null;
  last: string | null;
}

/**
 * OpenSearch pagination metadata (namespace
 * `http://a9.com/-/spec/opensearch/1.1/`). Booklore sends it on acquisition
 * and search feeds, not on navigation feeds, so each field is `null` when
 * absent. `totalResults` backs F5.2's "68 books" label and F5.3's result
 * count; `startIndex`/`itemsPerPage` back sane paging.
 */
export interface OpdsOpenSearchMeta {
  totalResults: number | null;
  startIndex: number | null;
  itemsPerPage: number | null;
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
  /**
   * OpenSearch pagination metadata from the feed root; every field `null`
   * on feeds that do not carry it (navigation feeds).
   */
  opensearch: OpdsOpenSearchMeta;
  entries: OpdsEntry[];
}

/** One `<Url>` element of an OpenSearch description document. */
export interface OpenSearchUrl {
  /**
   * The result feed's media type, e.g.
   * `application/atom+xml;profile=opds-catalog;kind=acquisition`; "" when
   * absent.
   */
  type: string;
  /**
   * The `template` attribute with its `{searchTerms}` placeholder,
   * resolved to an absolute URL when it is relative (as Booklore sends).
   */
  template: string;
}

/**
 * A parsed OpenSearch description document (OPDS 1.2 §3.1.1) — the target
 * of the feed's `rel="search"` link. F5.3 picks the `opds-catalog` url and
 * fills `{searchTerms}` with the URL-encoded query.
 */
export interface OpenSearchDescription {
  /** The `<ShortName>` text; "" when absent. */
  shortName: string;
  /** The `<Description>` text; "" when absent. */
  description: string;
  /** Every `<Url>` element carrying a `template` attribute, in document order. */
  urls: OpenSearchUrl[];
}
