// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseOpenSearchDescription, parseOpdsFeed } from "./opdsParser";
import { OpdsError } from "./opdsTypes";

// `import.meta.url` goes through node:url's own parser: the jsdom
// environment swaps the global `URL`, which mangles file: base URLs.
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

// Every live capture was redacted to this host (see each fixture's header).
const ROOT_URL = "https://booklore.example/api/v1/opds";
const NAV_LIBRARIES_URL = "https://booklore.example/api/v1/opds/libraries";
const PAGE1_URL = "https://booklore.example/api/v1/opds/catalog?page=1&size=3";
const PAGE2_URL = "https://booklore.example/api/v1/opds/catalog?page=2&size=3";
const PAGE17_URL =
  "https://booklore.example/api/v1/opds/catalog?page=17&size=3";
const PAGE23_URL =
  "https://booklore.example/api/v1/opds/catalog?page=23&size=3";
const OSD_URL = "https://booklore.example/api/v1/opds/search.opds";
const SEARCH_URL = "https://booklore.example/api/v1/opds/catalog?q=Turco";
const PREFIXED_URL = "https://booklore.example/atom/catalog";
const AUTHORS_URL = "https://booklore.example/api/v1/opds/authors";
const UNSAFE_HREFS_URL =
  "https://booklore.example/api/v1/opds/unsafe-hrefs";

describe("F5.1c parseOpdsFeed — live root catalog", () => {
  const feed = () => parseOpdsFeed(readFixture("root-catalog.xml"), ROOT_URL);

  it("reads the feed id, title, and records the feed URL", () => {
    const parsed = feed();
    expect(parsed.id).toBe("urn:booklore:root");
    expect(parsed.title).toBe("Booklore Catalog");
    expect(parsed.updated).not.toBe("");
    expect(parsed.url).toBe(ROOT_URL);
  });

  it("classifies all eight entries as navigation with no acquisitions", () => {
    const entries = feed().entries;
    expect(entries).toHaveLength(8);
    expect(entries.every((entry) => entry.kind === "navigation")).toBe(true);
    expect(entries.every((entry) => entry.acquisitions.length === 0)).toBe(
      true,
    );
  });

  it("surfaces the legacy subsection rel as each entry's navigation, resolved", () => {
    const entries = feed().entries;
    expect(entries.every((entry) => entry.navigation !== null)).toBe(true);
    expect(entries[0].title).toBe("All Books");
    expect(entries[0].navigation?.href).toBe(
      "https://booklore.example/api/v1/opds/catalog?page=1&size=50",
    );
    expect(entries[2].title).toBe("Libraries");
    expect(entries[2].navigation?.href).toBe(
      "https://booklore.example/api/v1/opds/libraries",
    );
  });

  it("resolves the self, start, and search links against the feed URL", () => {
    const parsed = feed();
    expect(parsed.links.find((link) => link.rel === "self")?.href).toBe(
      ROOT_URL,
    );
    expect(parsed.links.find((link) => link.rel === "start")?.href).toBe(
      ROOT_URL,
    );
    expect(parsed.search?.rel).toBe("search");
    expect(parsed.search?.type).toBe("application/opensearchdescription+xml");
    expect(parsed.search?.href).toBe(
      "https://booklore.example/api/v1/opds/search.opds",
    );
  });

  it("leaves OpenSearch pagination metadata null on a navigation feed", () => {
    expect(feed().opensearch).toEqual({
      totalResults: null,
      startIndex: null,
      itemsPerPage: null,
    });
  });

  it('reads the navigation entry\'s <content type="text"> as its summary', () => {
    expect(feed().entries[0].summary).toBe("Browse all available books");
  });
});

describe("F5.1c parseOpdsFeed — live navigation feed (libraries)", () => {
  const feed = () =>
    parseOpdsFeed(readFixture("nav-libraries.xml"), NAV_LIBRARIES_URL);

  it("parses the single entry with its decoded apostrophe and resolved subsection link", () => {
    const [entry] = feed().entries;
    expect(feed().entries).toHaveLength(1);
    expect(entry.title).toBe("Marty's Library");
    expect(entry.kind).toBe("navigation");
    expect(entry.navigation?.href).toBe(
      "https://booklore.example/api/v1/opds/catalog?libraryId=1",
    );
    expect(entry.summary).toBe("Marty's Library");
  });
});

describe("F5.1c parseOpdsFeed — live acquisition feed, page 1 (size=3)", () => {
  const feed = () =>
    parseOpdsFeed(readFixture("catalog-page1.xml"), PAGE1_URL);

  it("reads the OpenSearch pagination metadata as numbers", () => {
    expect(feed().opensearch).toEqual({
      totalResults: 68,
      startIndex: 1,
      itemsPerPage: 3,
    });
  });

  it("resolves first, next, last, self, and start, and leaves prev null on the first page", () => {
    const pagination = feed().pagination;
    expect(pagination.first).toBe(PAGE1_URL);
    expect(pagination.next).toBe(
      "https://booklore.example/api/v1/opds/catalog?page=2&size=3",
    );
    expect(pagination.last).toBe(
      "https://booklore.example/api/v1/opds/catalog?page=23&size=3",
    );
    expect(pagination.self).toBe(PAGE1_URL);
    expect(pagination.start).toBe(ROOT_URL);
    expect(pagination.prev).toBeNull();
  });

  it("parses the first entry: ISBN-suffixed title, Dublin Core fields, EPUB acquisition, cover links", () => {
    const entry = feed().entries[0];
    expect(entry.title).toBe(
      "Book of Literary Terms : The Genres of Fiction, Drama, Nonfiction, Literary Criticism, and Scholarship (9780826361936)",
    );
    expect(entry.id).toBe("urn:booklore:book:92");
    expect(entry.authors).toEqual(["Turco, Lewis"]);
    expect(entry.publisher).toBe("Lightning Source Inc");
    expect(entry.language).toBe("en");
    expect(entry.kind).toBe("acquisition");
    expect(entry.acquisitions).toHaveLength(1);
    expect(entry.acquisitions[0].type).toBe("application/epub+zip");
    expect(entry.acquisitions[0].title).toBe("EPUB");
    expect(entry.acquisitions[0].href).toBe(
      "https://booklore.example/api/v1/opds/92/download?fileId=93",
    );
    // Cover and thumbnail point at the same live URL in this library.
    expect(entry.images.map((link) => link.rel)).toEqual([
      "http://opds-spec.org/image",
      "http://opds-spec.org/image/thumbnail",
    ]);
    expect(entry.images[0].href).toBe(
      "https://booklore.example/api/v1/opds/92/cover?2026-09-09T16:58:31Z",
    );
    expect(entry.images[1].href).toBe(entry.images[0].href);
  });

  it("passes a duplicate source author through unchanged", () => {
    expect(feed().entries[1].authors).toEqual([
      "Shaw, Martin",
      "Shaw, Martin",
    ]);
  });

  it("tolerates the PDF entry with no author and no Dublin Core fields", () => {
    const entry = feed().entries[2];
    expect(entry.title).toBe("Poetic meter and poetic form");
    expect(entry.authors).toEqual([]);
    expect(entry.publisher).toBe("");
    expect(entry.language).toBe("");
    expect(entry.categories).toEqual(["Poetry"]);
    expect(entry.summary).toBe("");
    expect(entry.kind).toBe("acquisition");
    expect(entry.acquisitions[0].type).toBe("application/pdf");
    expect(entry.acquisitions[0].href).toBe(
      "https://booklore.example/api/v1/opds/90/download?fileId=91",
    );
  });
});

describe("F5.1c parseOpdsFeed — live acquisition feed, page 2", () => {
  const feed = () =>
    parseOpdsFeed(readFixture("catalog-page2.xml"), PAGE2_URL);

  it("resolves the rel=\"previous\" link into pagination.prev", () => {
    const pagination = feed().pagination;
    expect(pagination.prev).toBe(PAGE1_URL);
    expect(pagination.next).toBe(
      "https://booklore.example/api/v1/opds/catalog?page=3&size=3",
    );
    expect(pagination.first).toBe(PAGE1_URL);
    expect(pagination.last).toBe(
      "https://booklore.example/api/v1/opds/catalog?page=23&size=3",
    );
    expect(pagination.start).toBe(ROOT_URL);
  });

  it("strips escaped HTML markup from the summary text", () => {
    const entry = feed().entries[1];
    expect(entry.title).toBe(
      "The Matter With Things: Our Brains, Our Delusions, and the Unmaking of the World",
    );
    expect(entry.summary).toMatch(/^This book addresses some of the oldest and hardest questions/);
    expect(entry.summary).not.toContain("<p>");
    expect(entry.summary).not.toContain("</p>");
  });

  it("turns escaped breaks and block endings into a single newline", () => {
    const parsed = parseOpdsFeed(
      `<feed><entry><summary>&lt;p&gt;one&lt;br&gt;two&lt;br/&gt;three&lt;br /&gt;four&lt;BR&gt;five&lt;/p&gt;&lt;div&gt;six&lt;/div&gt;</summary></entry></feed>`,
      PAGE2_URL,
    );
    expect(parsed.entries[0].summary).toBe(
      "one\ntwo\nthree\nfour\nfive\nsix",
    );
  });

  it("passes inconsistent author spellings through unchanged", () => {
    expect(feed().entries[0].authors).toEqual(["Lewis Turco"]);
    expect(feed().entries[1].authors).toEqual(["McGilchrist, Iain"]);
    expect(feed().entries[2].authors).toEqual(["Iain McGilchrist"]);
  });
});

describe("F5.1c parseOpdsFeed — live acquisition feed, MOBI/AZW3 page", () => {
  const feed = () =>
    parseOpdsFeed(readFixture("catalog-page17.xml"), PAGE17_URL);

  it("parses the MOBI entry with its unsupported acquisition type", () => {
    const entry = feed().entries[0];
    expect(entry.title).toBe("The Aeneid");
    expect(entry.kind).toBe("acquisition");
    expect(entry.acquisitions[0].type).toBe("application/x-mobipocket-ebook");
    expect(entry.acquisitions[0].title).toBe("MOBI");
    expect(entry.acquisitions[0].href).toBe(
      "https://booklore.example/api/v1/opds/39/download?fileId=39",
    );
    // The escaped-HTML summary is reduced to text on these entries too.
    expect(entry.summary).toMatch(/^With his translations of Homer's classic poems/);
    expect(entry.summary).not.toContain("<div>");
  });

  it("parses the AZW3 entry and its en-us language code", () => {
    const entry = feed().entries[2];
    expect(entry.title).toBe("The Odyssey");
    expect(entry.acquisitions[0].type).toBe("application/vnd.amazon.ebook");
    expect(entry.acquisitions[0].title).toBe("AZW3");
    expect(entry.language).toBe("en-us");
  });

  it("keeps a middle page's previous and next links resolved", () => {
    const pagination = feed().pagination;
    expect(pagination.prev).toBe(
      "https://booklore.example/api/v1/opds/catalog?page=16&size=3",
    );
    expect(pagination.next).toBe(
      "https://booklore.example/api/v1/opds/catalog?page=18&size=3",
    );
    expect(pagination.last).toBe(
      "https://booklore.example/api/v1/opds/catalog?page=23&size=3",
    );
    expect(feed().opensearch.startIndex).toBe(49);
  });
});

describe("F5.1c parseOpdsFeed — live acquisition feed, page 23 (final page)", () => {
  const feed = () =>
    parseOpdsFeed(readFixture("catalog-page23.xml"), PAGE23_URL);

  it("parses the last two entries of the library with startIndex 67 and no next link", () => {
    expect(feed().entries).toHaveLength(2);
    expect(feed().opensearch).toEqual({
      totalResults: 68,
      startIndex: 67,
      itemsPerPage: 3,
    });
    expect(feed().pagination.next).toBeNull();
    expect(feed().pagination.prev).toBe(
      "https://booklore.example/api/v1/opds/catalog?page=22&size=3",
    );
    expect(feed().pagination.last).toBe(PAGE23_URL);
    expect(feed().pagination.self).toBe(PAGE23_URL);
  });

  it("passes the junk dc:publisher value through unchanged", () => {
    const entry = feed().entries[1];
    expect(entry.id).toBe("urn:booklore:book:2");
    expect(entry.title).toBe(
      "Fred Rogers: A Captivating Guide to the Man Behind Mister Rogers' Neighborhood",
    );
    expect(entry.publisher).toBe("#PrB.rating#4.31");
    expect(entry.language).toBe("en");
  });

  it("decodes entities nested inside escaped summary markup", () => {
    const entry = feed().entries[0];
    expect(entry.summary).toContain(
      '"Whoever does not love does not know God, because God is love."—1 John 4:8\nAre you looking',
    );
    expect(entry.summary).toContain(
      '"the best couple therapist in the world," according to bestselling relationship expert',
    );
  });

  it("classifies the zero-acquisition entry with a null navigation link", () => {
    const entry = feed().entries[1];
    expect(entry.acquisitions).toHaveLength(0);
    expect(entry.navigation).toBeNull();
    // Its only links are the image and thumbnail; with no acquisition
    // link at all the parser's rule labels it "navigation" — the shape
    // F5.4 must cope with (see OpdsEntry.kind).
    expect(entry.links.map((link) => link.rel)).toEqual([
      "http://opds-spec.org/image",
      "http://opds-spec.org/image/thumbnail",
    ]);
    expect(entry.kind).toBe("navigation");
  });
});

describe("F5.1c parseOpdsFeed — live OpenSearch result feed (q=Turco)", () => {
  const feed = () =>
    parseOpdsFeed(readFixture("catalog-search-turco.xml"), SEARCH_URL);

  it("reports the result count in the OpenSearch metadata", () => {
    expect(feed().opensearch).toEqual({
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 50,
    });
  });

  it("keeps both author spellings the server-side search matched", () => {
    expect(feed().entries[0].authors).toEqual(["Turco, Lewis"]);
    expect(feed().entries[1].authors).toEqual(["Lewis Turco"]);
  });

  it("resolves self/first/last to the server-normalized query, with no next/prev on a single page", () => {
    const pagination = feed().pagination;
    const normalized =
      "https://booklore.example/api/v1/opds/catalog?q=Turco&page=1&size=50";
    expect(pagination.self).toBe(normalized);
    expect(pagination.first).toBe(normalized);
    expect(pagination.last).toBe(normalized);
    expect(pagination.next).toBeNull();
    expect(pagination.prev).toBeNull();
    expect(pagination.start).toBe(ROOT_URL);
  });
});

describe("F5.1c parseOpenSearchDescription — live description document", () => {
  const osd = () =>
    parseOpenSearchDescription(readFixture("opensearch-description.xml"), OSD_URL);

  it("reads the short name and description", () => {
    expect(osd().shortName).toBe("Booklore");
    expect(osd().description).toBe("Search Booklore catalog");
  });

  it("resolves the relative template against the document URL so F5.3 can fill it", () => {
    expect(osd().urls).toHaveLength(1);
    expect(osd().urls[0].type).toBe(
      "application/atom+xml;profile=opds-catalog;kind=acquisition",
    );
    expect(osd().urls[0].template).toBe(
      "https://booklore.example/api/v1/opds/catalog?q={searchTerms}",
    );
  });

  it("drops a javascript OpenSearch template", () => {
    const parsed = parseOpenSearchDescription(
      `<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
        <ShortName>Unsafe search</ShortName>
        <Url type="application/atom+xml" template="javascript:alert({searchTerms})" />
      </OpenSearchDescription>`,
      OSD_URL,
    );

    expect(parsed.urls).toEqual([]);
  });

  it("rejects an Atom feed body as not-opds", () => {
    try {
      parseOpenSearchDescription(readFixture("root-catalog.xml"), OSD_URL);
      expect.unreachable("expected an OpdsError");
    } catch (error) {
      expect(error).toBeInstanceOf(OpdsError);
      expect((error as OpdsError).kind).toBe("not-opds");
    }
  });
});

describe("F5.1 parseOpdsFeed — acquisition feed (spec-derived dual formats)", () => {
  const feed = () =>
    parseOpdsFeed(readFixture("acquisitions-mixed.xml"), "https://booklore.example/api/v1/opds/all");

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

describe("F5.1 parseOpdsFeed — atom: namespace prefix", () => {
  const feed = () =>
    parseOpdsFeed(readFixture("atom-prefixed.xml"), PREFIXED_URL);

  it("parses a prefixed feed the same way as an unprefixed one", () => {
    const parsed = feed();
    expect(parsed.title).toBe("Prefixed Catalog");
    expect(parsed.updated).toBe("2026-05-05T05:05:05Z");
    expect(parsed.pagination.self).toBe("https://booklore.example/atom/catalog");
    expect(parsed.pagination.prev).toBeNull();

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
  const feed = () =>
    parseOpdsFeed(readFixture("entry-authors.xml"), AUTHORS_URL);

  it("keeps two authors in feed order", () => {
    expect(feed().entries[0].authors).toEqual(["Ada Lovelace", "Charles Babbage"]);
  });

  it("yields an empty author list for an entry with none", () => {
    expect(feed().entries[1].authors).toEqual([]);
  });
});

describe("F5.1 parseOpdsFeed — unsafe href schemes", () => {
  const feed = () =>
    parseOpdsFeed(readFixture("unsafe-hrefs.xml"), UNSAFE_HREFS_URL);

  it.each([
    ["javascript:", 0],
    ["data:", 1],
  ])("drops %s acquisition and image links without dropping the entry", (_scheme, index) => {
    const entry = feed().entries[index];

    expect(entry.links).toEqual([]);
    expect(entry.acquisitions).toEqual([]);
    expect(entry.images).toEqual([]);
    expect(entry.kind).toBe("navigation");
  });

  it("keeps http and https acquisition and image links", () => {
    const entry = feed().entries[2];

    expect(entry.acquisitions.map((link) => link.href)).toEqual([
      "https://booklore.example/api/v1/opds/books/3.epub",
    ]);
    expect(entry.images.map((link) => link.href)).toEqual([
      "http://booklore.example/covers/3.jpg",
    ]);
  });

  it("drops a javascript feed-level next link from pagination", () => {
    const parsed = parseOpdsFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom">
        <id>urn:booklore:unsafe-pagination</id>
        <title>Unsafe pagination</title>
        <link rel="next" href="javascript:alert('next')" />
      </feed>`,
      UNSAFE_HREFS_URL,
    );

    expect(parsed.pagination.next).toBeNull();
  });
});

describe("F5.1 parseOpdsFeed — summary text decoding", () => {
  const entryFeed = (summary: string): string =>
    `<feed xmlns="http://www.w3.org/2005/Atom">
      <id>urn:booklore:summary-test</id>
      <title>Summary decode</title>
      <entry>
        <id>urn:booklore:book:1</id>
        <title>Summary probe</title>
        <summary>${summary}</summary>
      </entry>
    </feed>`;

  it("keeps bare angle brackets that are not tags (1 < 2 and 3 > 2)", () => {
    const entry = parseOpdsFeed(
      entryFeed("Compare 1 &lt; 2 and 3 &gt; 2 carefully."),
      "https://booklore.example/api/v1/opds/catalog",
    ).entries[0];
    expect(entry.summary).toBe("Compare 1 < 2 and 3 > 2 carefully.");
  });

  it("keeps an angle-bracket pair with no tag content (Vols. I<>III)", () => {
    const entry = parseOpdsFeed(
      entryFeed("Vols. I&lt;&gt;III"),
      "https://booklore.example/api/v1/opds/catalog",
    ).entries[0];
    expect(entry.summary).toBe("Vols. I<>III");
  });

  it("reduces escaped HTML markup to its text, decoding entities", () => {
    const entry = parseOpdsFeed(
      entryFeed("&lt;p&gt;Hello, &amp; welcome.&lt;/p&gt;"),
      "https://booklore.example/api/v1/opds/catalog",
    ).entries[0];
    expect(entry.summary).toBe("Hello, & welcome.");
  });
});

describe("F5.1 parseOpdsFeed — OpenSearch count validation", () => {
  const countFeed = (totalResults: string): string =>
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
      <id>urn:booklore:count-test</id>
      <title>Count validation</title>
      <opensearch:totalResults>${totalResults}</opensearch:totalResults>
    </feed>`;

  it("reads plain non-negative integers, including zero", () => {
    expect(parseOpdsFeed(countFeed("68"), ROOT_URL).opensearch.totalResults).toBe(68);
    expect(parseOpdsFeed(countFeed("0"), ROOT_URL).opensearch.totalResults).toBe(0);
  });

  it("falls back to null for negatives, hex, exponents, and other Number() quirks", () => {
    for (const value of ["-1", "0x10", "1.5e2", "3.0", "+5", "abc"]) {
      expect(
        parseOpdsFeed(countFeed(value), ROOT_URL).opensearch.totalResults,
        value,
      ).toBeNull();
    }
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
      parseOpdsFeed(readFixture("malformed.xml"), "https://booklore.example/api/v1/opds/all");
      expect.unreachable("expected an OpdsError");
    } catch (error) {
      expect(error).toBeInstanceOf(OpdsError);
      expect((error as OpdsError).kind).toBe("not-opds");
    }
  });

  it("rejects a parsererror nested under the expected feed root", () => {
    expect(() =>
      parseOpdsFeed(
        "<feed><title>Partial feed</title><parsererror>truncated</parsererror></feed>",
        ROOT_URL,
      ),
    ).toThrowError(OpdsError);

    try {
      parseOpdsFeed(
        "<feed><title>Partial feed</title><parsererror>truncated</parsererror></feed>",
        ROOT_URL,
      );
      expect.unreachable("expected an OpdsError");
    } catch (error) {
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
      parseOpdsFeed(
        "<html><body>secret-token-123</body></html>",
        "https://booklore.example/api/v1/opds/all",
      );
      expect.unreachable("expected an OpdsError");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("secret-token-123");
      expect(message).not.toContain("https://booklore.example/api/v1/opds/all");
    }
  });
});
