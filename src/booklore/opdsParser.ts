import {
  OpdsError,
  type OpdsEntry,
  type OpdsFeed,
  type OpdsLink,
  type OpdsPagination,
} from "./opdsTypes";

/**
 * F5.1 — OPDS 1.2 / Atom feed parser.
 *
 * Deliberately free of `obsidian` imports so it unit-tests in Node (the test
 * file selects the jsdom environment, because Node has no `DOMParser`).
 * Parsing is `DOMParser` only — no XML library (PRD F5.1).
 *
 * The parser is namespace-agnostic: it matches elements by `localName`, so a
 * feed that declares the Atom namespace as the default, prefixes it with
 * `atom:`, or (invalid but seen in the wild) omits it entirely parses the
 * same way. Missing or empty optional elements yield empty values, never a
 * throw; only a response that is not an Atom feed at all throws.
 */

/** OpenSearch description media type advertised by OPDS 1.2 §3.1.1. */
const OPEN_SEARCH_TYPE = "application/opensearchdescription+xml";
/** OPDS acquisition rel; subtypes (`/open-access`, `/buy`, …) share the prefix. */
const ACQUISITION_REL_PREFIX = "http://opds-spec.org/acquisition";
const NAVIGATION_REL = "http://opds-spec.org/navigation";
const IMAGE_RELS = new Set([
  "http://opds-spec.org/image",
  "http://opds-spec.org/image/thumbnail",
]);

/**
 * Parse an OPDS 1.2 (Atom) feed into the `OpdsFeed` shape.
 *
 * @param xml - Raw feed body exactly as the server returned it.
 * @param feedUrl - Absolute URL the feed was fetched from; every relative
 *   `href` in the document is resolved against it.
 * @returns The parsed feed.
 * @throws OpdsError with `kind: "not-opds"` when the body is not a parseable
 *   Atom document (malformed XML, an HTML login page, a JSON error, …).
 */
export function parseOpdsFeed(xml: string, feedUrl: string): OpdsFeed {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  if (root === null) {
    throw notOpds("the response is empty");
  }
  // Both browser DOMParsers and jsdom mark a failed XML parse with a
  // `<parsererror>` root element; treat it like any other non-Atom body.
  if (root.localName === "parsererror") {
    throw notOpds("the response is not well-formed XML");
  }
  if (root.localName !== "feed") {
    throw notOpds(`the response root is <${root.tagName}>, not an Atom feed`);
  }
  return parseFeed(root, feedUrl);
}

function notOpds(reason: string): OpdsError {
  return new OpdsError("not-opds", `Not an OPDS feed: ${reason}.`);
}

/** Direct children of `parent` whose local name is `name` (prefix-insensitive). */
function directChildren(parent: Element, name: string): Element[] {
  const matches: Element[] = [];
  for (const child of Array.from(parent.children)) {
    if (child.localName === name) {
      matches.push(child);
    }
  }
  return matches;
}

function directChild(parent: Element, name: string): Element | null {
  return directChildren(parent, name)[0] ?? null;
}

/** Trimmed text content of an element; "" for a missing element. */
function textOf(element: Element | null): string {
  return element === null ? "" : (element.textContent ?? "").trim();
}

function attrOf(element: Element, name: string): string {
  return element.getAttribute(name) ?? "";
}

/**
 * Resolve a link `href` against the feed URL. Absolute hrefs pass through
 * unchanged; if `baseUrl` itself cannot be parsed as a URL (the client only
 * ever passes absolute URLs, so this is defensive), the raw href is kept
 * rather than dropping the whole feed.
 */
function resolveHref(href: string, baseUrl: string): string {
  if (href === "") {
    return href;
  }
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function parseLink(element: Element, baseUrl: string): OpdsLink {
  return {
    // Atom (RFC 4287 §4.2.7) defaults a missing rel to "alternate".
    rel: attrOf(element, "rel") || "alternate",
    type: attrOf(element, "type"),
    href: resolveHref(attrOf(element, "href"), baseUrl),
    title: attrOf(element, "title"),
  };
}

function parseEntry(element: Element, baseUrl: string): OpdsEntry {
  const links = directChildren(element, "link").map((link) =>
    parseLink(link, baseUrl),
  );
  const acquisitions = links.filter((link) =>
    link.rel.startsWith(ACQUISITION_REL_PREFIX),
  );
  const images = links.filter((link) => IMAGE_RELS.has(link.rel));
  const navigation = links.find((link) => link.rel === NAVIGATION_REL) ?? null;

  const authors: string[] = [];
  for (const author of directChildren(element, "author")) {
    const name = textOf(directChild(author, "name"));
    if (name !== "") {
      authors.push(name);
    }
  }

  const categories: string[] = [];
  for (const category of directChildren(element, "category")) {
    const term = attrOf(category, "term") || textOf(category);
    if (term !== "") {
      categories.push(term);
    }
  }

  return {
    id: textOf(directChild(element, "id")),
    title: textOf(directChild(element, "title")),
    authors,
    updated: textOf(directChild(element, "updated")),
    summary:
      textOf(directChild(element, "summary")) ||
      textOf(directChild(element, "content")),
    categories,
    // An entry with at least one acquisition link is downloadable;
    // everything else (including a bare catalog pointer) navigates.
    kind: acquisitions.length > 0 ? "acquisition" : "navigation",
    links,
    acquisitions,
    images,
    navigation,
  };
}

function firstHref(links: OpdsLink[], rel: string): string | null {
  const link = links.find((candidate) => candidate.rel === rel);
  return link !== undefined && link.href !== "" ? link.href : null;
}

function parseFeed(root: Element, feedUrl: string): OpdsFeed {
  const links = directChildren(root, "link").map((link) =>
    parseLink(link, feedUrl),
  );

  // The OpenSearch description link is matched by rel, tolerating a missing
  // type (OPDS 1.2 §3.1.1 names both; strict servers send both).
  const search =
    links.find(
      (link) =>
        link.rel === "search" &&
        (link.type === "" || link.type === OPEN_SEARCH_TYPE),
    ) ?? null;

  const pagination: OpdsPagination = {
    next: firstHref(links, "next"),
    prev: firstHref(links, "prev"),
    self: firstHref(links, "self"),
    start: firstHref(links, "start"),
  };

  return {
    id: textOf(directChild(root, "id")),
    title: textOf(directChild(root, "title")),
    updated: textOf(directChild(root, "updated")),
    url: feedUrl,
    links,
    search,
    pagination,
    entries: directChildren(root, "entry").map((entry) =>
      parseEntry(entry, feedUrl),
    ),
  };
}
