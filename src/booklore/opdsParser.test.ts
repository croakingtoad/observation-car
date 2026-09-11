// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseOpdsFeed } from "./opdsParser";
import { OpdsError } from "./opdsTypes";

// `import.meta.url` goes through node:url's own parser: the jsdom
// environment swaps the global `URL`, which mangles file: base URLs.
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

const ROOT_URL = "https://booklore.example/api/v1/opds";
const ALL_URL = "https://booklore.example/api/v1/opds/all";
const PAGE2_URL = "https://booklore.example/api/v1/opds/all?page=2";
const PREFIXED_URL = "https://booklore.example/atom/catalog";
const AUTHORS_URL = "https://booklore.example/api/v1/opds/authors";

describe("F5.1 parseOpdsFeed — root navigation feed", () => {
  const feed = () => parseOpdsFeed(readFixture("root-navigation.xml"), ROOT_URL);

  it("reads the feed id, title, updated, and records the feed URL", () => {
    const parsed = feed();
    expect(parsed.id).toBe("urn:uuid:4a7f1c2e-root-catalog");
    expect(parsed.title).toBe("My Booklore Library");
    expect(parsed.updated).toBe("2026-09-01T08:30:00Z");
    expect(parsed.url).toBe(ROOT_URL);
  });

  it("resolves every relative feed-level href against the feed URL", () => {
    const self = feed().links.find((link) => link.rel === "self");
    expect(self?.href).toBe(ROOT_URL);
    expect(self?.type).toBe("application/atom+xml");
  });

  it("surfaces the OpenSearch description link for F5.3", () => {
    const search = feed().search;
    expect(search).not.toBeNull();
    expect(search?.rel).toBe("search");
    expect(search?.type).toBe("application/opensearchdescription+xml");
    expect(search?.href).toBe("https://booklore.example/api/v1/opds/search");
    expect(search?.title).toBe("Search the catalog");
  });

  it("classifies navigation entries and exposes their resolved navigation links", () => {
    const entries = feed().entries;
    expect(entries.map((entry) => entry.kind)).toEqual([
      "navigation",
      "navigation",
    ]);
    expect(entries[0].navigation?.href).toBe(
      "https://booklore.example/api/v1/opds/genres/fiction",
    );
    expect(entries[1].navigation?.href).toBe(
      "https://booklore.example/api/v1/opds/genres/nonfiction",
    );
    expect(entries[0].acquisitions).toEqual([]);
  });

  it("leaves a missing entry-level updated empty instead of throwing", () => {
    const [withUpdated, withoutUpdated] = feed().entries;
    expect(withUpdated.updated).toBe("2026-09-01T08:30:00Z");
    expect(withoutUpdated.updated).toBe("");
  });
});

describe("F5.1 parseOpdsFeed — acquisition feed", () => {
  const feed = () => parseOpdsFeed(readFixture("acquisitions-mixed.xml"), ALL_URL);

  it("classifies the EPUB-only entry as acquisition via the open-access subtype", () => {
    const entry = feed().entries[0];
    expect(entry.kind).toBe("acquisition");
    expect(entry.acquisitions).toHaveLength(1);
    expect(entry.acquisitions[0].rel).toBe(
      "http://opds-spec.org/acquisition/open-access",
    );
    expect(entry.acquisitions[0].type).toBe("application/epub+zip");
    expect(entry.acquisitions[0].href).toBe(
      "https://booklore.example/api/v1/opds/download/201.epub",
    );
  });

  it("classifies the PDF-only entry and resolves a relative href without a leading slash", () => {
    const entry = feed().entries[1];
    expect(entry.kind).toBe("acquisition");
    expect(entry.acquisitions[0].type).toBe("application/pdf");
    // "download/202.pdf" resolves against the feed URL's directory.
    expect(entry.acquisitions[0].href).toBe(
      "https://booklore.example/api/v1/opds/download/202.pdf",
    );
  });

  it("reads both formats, the buy subtype, and the cover + thumbnail on the dual-format entry", () => {
    const entry = feed().entries[2];
    expect(entry.kind).toBe("acquisition");
    expect(entry.acquisitions.map((link) => link.type)).toEqual([
      "application/epub+zip",
      "application/pdf",
    ]);
    // Absolute acquisition hrefs pass through unchanged.
    expect(entry.acquisitions[1].rel).toBe("http://opds-spec.org/acquisition/buy");
    expect(entry.acquisitions[1].href).toBe("https://store.example.com/pay?item=203");
    expect(entry.images.map((link) => link.rel)).toEqual([
      "http://opds-spec.org/image",
      "http://opds-spec.org/image/thumbnail",
    ]);
    expect(entry.images[0].href).toBe("https://booklore.example/api/v1/covers/203.jpg");
    expect(entry.images[1].href).toBe(
      "https://booklore.example/api/v1/covers/203-thumb.jpg",
    );
  });

  it("extracts author, summary text (not markup), and categories", () => {
    const entry = feed().entries[2];
    expect(entry.title).toBe("Maps of Elsewhere");
    expect(entry.authors).toEqual(["J. T. Marlowe"]);
    expect(entry.summary).toBe("An atlas of places that moved.");
    expect(entry.categories).toEqual(["Fantasy", "Novel"]);
  });

  it("classifies an entry with no author elements with an empty author list", () => {
    const entry = feed().entries[3];
    expect(entry.kind).toBe("acquisition");
    expect(entry.authors).toEqual([]);
    expect(entry.summary).toBe("");
    expect(entry.categories).toEqual([]);
  });
});

describe("F5.1 parseOpdsFeed — pagination", () => {
  const feed = () => parseOpdsFeed(readFixture("paged-feed.xml"), PAGE2_URL);

  it("resolves next, prev, and self and leaves start null when absent", () => {
    const pagination = feed().pagination;
    expect(pagination.next).toBe("https://booklore.example/api/v1/opds/all?page=3");
    expect(pagination.prev).toBe("https://booklore.example/api/v1/opds/all?page=1");
    expect(pagination.self).toBe(PAGE2_URL);
    expect(pagination.start).toBeNull();
  });

  it("keeps a rel=\"first\" link in links but out of pagination", () => {
    const parsed = feed();
    expect(parsed.links.some((link) => link.rel === "first")).toBe(true);
    expect("first" in parsed.pagination).toBe(false);
  });

  it("leaves a missing feed-level updated empty instead of throwing", () => {
    expect(feed().updated).toBe("");
  });
});

describe("F5.1 parseOpdsFeed — atom: namespace prefix", () => {
  const feed = () => parseOpdsFeed(readFixture("atom-prefixed.xml"), PREFIXED_URL);

  it("parses a prefixed feed the same way as an unprefixed one", () => {
    const parsed = feed();
    expect(parsed.title).toBe("Prefixed Catalog");
    expect(parsed.updated).toBe("2026-05-05T05:05:05Z");
    expect(parsed.pagination.self).toBe("https://booklore.example/atom/catalog");

    const entry = parsed.entries[0];
    expect(entry.title).toBe("Bound for the Ridge");
    expect(entry.authors).toEqual(["R. E. Calder"]);
    expect(entry.kind).toBe("acquisition");
    expect(entry.acquisitions[0].type).toBe("application/epub+zip");
    expect(entry.acquisitions[0].href).toBe(
      "https://booklore.example/atom/items/401.epub",
    );
    expect(entry.images[0].href).toBe("https://booklore.example/atom/covers/401.jpg");
  });
});

describe("F5.1 parseOpdsFeed — author coverage", () => {
  const feed = () => parseOpdsFeed(readFixture("entry-authors.xml"), AUTHORS_URL);

  it("keeps two authors in feed order", () => {
    expect(feed().entries[0].authors).toEqual(["Ada Lovelace", "Charles Babbage"]);
  });

  it("yields an empty author list for an entry with none", () => {
    expect(feed().entries[1].authors).toEqual([]);
  });
});

describe("F5.1 parseOpdsFeed — non-OPDS responses", () => {
  it("rejects an HTML login page body", () => {
    try {
      parseOpdsFeed(readFixture("login-page.html"), "https://booklore.example/login");
      expect.unreachable("expected an OpdsError");
    } catch (error) {
      expect(error).toBeInstanceOf(OpdsError);
      expect((error as OpdsError).kind).toBe("not-opds");
    }
  });

  it("rejects malformed XML (a truncated feed)", () => {
    try {
      parseOpdsFeed(readFixture("malformed.xml"), ALL_URL);
      expect.unreachable("expected an OpdsError");
    } catch (error) {
      expect(error).toBeInstanceOf(OpdsError);
      expect((error as OpdsError).kind).toBe("not-opds");
    }
  });

  it("rejects an empty body", () => {
    expect(() => parseOpdsFeed("", ROOT_URL)).toThrowError(OpdsError);
    expect(() => parseOpdsFeed("", ROOT_URL)).toThrowError(
      /not-opds|Not an OPDS feed/i,
    );
  });

  it("rejects a JSON error body the same way", () => {
    try {
      parseOpdsFeed('{"detail": "Not Found."}', ROOT_URL);
      expect.unreachable("expected an OpdsError");
    } catch (error) {
      expect(error).toBeInstanceOf(OpdsError);
      expect((error as OpdsError).kind).toBe("not-opds");
    }
  });

  it("never includes the feed URL or body in the error message", () => {
    try {
      parseOpdsFeed("<html><body>secret-token-123</body></html>", ALL_URL);
      expect.unreachable("expected an OpdsError");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("secret-token-123");
      expect(message).not.toContain(ALL_URL);
    }
  });
});
