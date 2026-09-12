import {
  OpdsError,
  type OpdsEntry,
  type OpdsFeed,
  type OpdsLink,
  type OpdsOpenSearchMeta,
  type OpdsPagination,
  type OpenSearchDescription,
  type OpenSearchUrl,
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
 *
 * Shape verified against live Booklore captures (LOCO-101 fixtures): every
 * href is site-relative and resolves against the feed URL; navigation
 * entries use the legacy `subsection` rel; acquisition and search feeds
 * carry `opensearch:` pagination metadata; entries carry Dublin Core
 * `dc:publisher`/`dc:language`; the back link is `rel="previous"`;
 * summaries escape their HTML into the element's text.
 */

/** OpenSearch description media type advertised by OPDS 1.2 §3.1.1. */
const OPEN_SEARCH_TYPE = "application/opensearchdescription+xml";
/** OPDS acquisition rel; subtypes (`/open-access`, `/buy`, …) share the prefix. */
const ACQUISITION_REL_PREFIX = "http://opds-spec.org/acquisition";
/**
 * Rels that mark the link to an entry's sub-feed. Booklore sends the legacy
 * OPDS 1.0 `subsection` rel on every navigation entry (LOCO-101 capture);
 * OPDS 1.2's own rel is accepted alongside it.
 */
const NAVIGATION_RELS = new Set([
  "http://opds-spec.org/navigation",
  "subsection",
]);
const IMAGE_RELS = new Set([
  "http://opds-spec.org/image",
  "http://opds-spec.org/image/thumbnail",
]);
/** Rels for the "previous page" link; Booklore sends `previous`. */
const PREV_RELS = ["previous", "prev"];

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
  // DOMParser engines disagree on whether malformed XML produces a
  // `<parsererror>` root or nests one under the document's original root.
  if (hasParserError(doc)) {
    throw notOpds("the response is not well-formed XML");
  }
  if (root.localName !== "feed") {
    throw notOpds(`the response root is <${root.tagName}>, not an Atom feed`);
  }
  return parseFeed(root, feedUrl);
}

/**
 * Parse an OpenSearch description document (OPDS 1.2 §3.1.1) into the
 * search-URL template(s) F5.3 fills with the query.
 *
 * @param xml - Raw document body exactly as the server returned it.
 * @param docUrl - Absolute URL the document was fetched from; a relative
 *   `template` (as Booklore sends) resolves against it.
 * @returns The parsed description.
 * @throws OpdsError with `kind: "not-opds"` when the body is not a
 *   parseable OpenSearch description document.
 */
export function parseOpenSearchDescription(
  xml: string,
  docUrl: string,
): OpenSearchDescription {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  if (root === null) {
    throw notOpds("the response is empty");
  }
  if (hasParserError(doc)) {
    throw notOpds("the response is not well-formed XML");
  }
  if (root.localName !== "OpenSearchDescription") {
    throw notOpds(
      `the response root is <${root.tagName}>, not an OpenSearch description`,
    );
  }
  const urls: OpenSearchUrl[] = [];
  for (const urlElement of directChildren(root, "Url")) {
    const template = attrOf(urlElement, "template");
    // A <Url> without a template cannot be filled; skip it.
    if (template === "") {
      continue;
    }
    const resolvedTemplate = resolveHref(template, docUrl);
    if (resolvedTemplate === null) {
      continue;
    }
    urls.push({
      type: attrOf(urlElement, "type"),
      template: resolvedTemplate,
    });
  }
  return {
    shortName: textOf(directChild(root, "ShortName")),
    description: textOf(directChild(root, "Description")),
    urls,
  };
}

function notOpds(reason: string): OpdsError {
  return new OpdsError("not-opds", `Not an OPDS feed: ${reason}.`);
}

function hasParserError(doc: Document): boolean {
  return Array.from(doc.getElementsByTagName("*")).some(
    (element) => element.localName === "parsererror",
  );
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

/**
 * Trimmed text of an element reduced to displayable prose. `textContent`
 * already flattens real markup inside the element; Booklore instead
 * escapes its markup into the text
 * (`<summary>&lt;p&gt;…&lt;/p&gt;</summary>`), so the decoded text still
 * carries tag-like sequences. Those are decoded for real — the markup is
 * parsed as HTML into a throwaway document and its body's text read back —
 * rather than stripped by a `<…>` regex, which cannot tell markup from
 * prose around bare angle brackets (`"1 < 2"`, `"I<>III"`) and deletes it.
 * HTML line breaks are changed to newlines first because `textContent`
 * otherwise removes them without leaving a word boundary.
 */
function summaryText(element: Element | null): string {
  if (element === null) {
    return "";
  }
  const markup = (element.textContent ?? "").replace(/<br\s*\/?>/gi, "\n");
  if (markup === "") {
    return "";
  }
  const probe = new DOMParser().parseFromString(markup, "text/html");
  return (probe.body?.textContent ?? "").trim();
}

function attrOf(element: Element, name: string): string {
  return element.getAttribute(name) ?? "";
}

/**
 * Parse OpenSearch metadata numbers; `null` when the element is missing,
 * empty, or not a non-negative integer. These values come from an untrusted
 * server, so `Number()`'s tolerance for hex, exponents, and signs is
 * deliberately not extended to them (Booklore sends plain integers).
 */
function parseCount(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return Number(trimmed);
}

/**
 * Resolve a link `href` against the feed URL. Only HTTP(S) links are safe for
 * downstream navigation, image, and download consumers; everything else is
 * dropped without rejecting the surrounding feed or entry.
 */
function resolveHref(href: string, baseUrl: string): string | null {
  if (href === "") {
    return null;
  }
  try {
    const resolved = new URL(href, baseUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.toString()
      : null;
  } catch {
    return null;
  }
}

function parseLink(element: Element, baseUrl: string): OpdsLink | null {
  const href = resolveHref(attrOf(element, "href"), baseUrl);
  if (href === null) {
    return null;
  }
  return {
    // Atom (RFC 4287 §4.2.7) defaults a missing rel to "alternate".
    rel: attrOf(element, "rel") || "alternate",
    type: attrOf(element, "type"),
    href,
    title: attrOf(element, "title"),
  };
}

function parseEntry(element: Element, baseUrl: string): OpdsEntry {
  const links = directChildren(element, "link")
    .map((link) => parseLink(link, baseUrl))
    .filter((link): link is OpdsLink => link !== null);
  const acquisitions = links.filter((link) =>
    link.rel.startsWith(ACQUISITION_REL_PREFIX),
  );
  const images = links.filter((link) => IMAGE_RELS.has(link.rel));
  const navigation = links.find((link) => NAVIGATION_RELS.has(link.rel)) ?? null;

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
      summaryText(directChild(element, "summary")) ||
      summaryText(directChild(element, "content")),
    categories,
    // Dublin Core metadata, matched by local name like everything else in
    // this parser; passed through unchanged.
    publisher: textOf(directChild(element, "publisher")),
    language: textOf(directChild(element, "language")),
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

function firstHrefAny(links: OpdsLink[], rels: string[]): string | null {
  const link = links.find((candidate) => rels.includes(candidate.rel));
  return link !== undefined && link.href !== "" ? link.href : null;
}

function parseFeed(root: Element, feedUrl: string): OpdsFeed {
  const links = directChildren(root, "link")
    .map((link) => parseLink(link, feedUrl))
    .filter((link): link is OpdsLink => link !== null);

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
    prev: firstHrefAny(links, PREV_RELS),
    self: firstHref(links, "self"),
    start: firstHref(links, "start"),
    first: firstHref(links, "first"),
    last: firstHref(links, "last"),
  };

  const opensearch: OpdsOpenSearchMeta = {
    totalResults: parseCount(textOf(directChild(root, "totalResults"))),
    startIndex: parseCount(textOf(directChild(root, "startIndex"))),
    itemsPerPage: parseCount(textOf(directChild(root, "itemsPerPage"))),
  };

  return {
    id: textOf(directChild(root, "id")),
    title: textOf(directChild(root, "title")),
    updated: textOf(directChild(root, "updated")),
    url: feedUrl,
    links,
    search,
    pagination,
    opensearch,
    entries: directChildren(root, "entry").map((entry) =>
      parseEntry(entry, feedUrl),
    ),
  };
}
