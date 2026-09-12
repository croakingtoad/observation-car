// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type ObservationCarSettings } from "../settings";
import { basicAuthHeader } from "./opdsAuth";
import { OpdsClient, type OpdsTransport } from "./opdsClient";
import { OpdsError } from "./opdsTypes";

// `obsidian` resolves to the loud-failure stub in tests (see vitest.config.ts);
// a fake transport is always injected, so the stub's requestUrl is never
// reached and would throw loudly if it were.
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

// Fixtures that are verbatim response bodies (like auth-401.txt) carry a
// provenance header comment; strip it to get the body exactly as captured.
function readFixtureBody(name: string): string {
  const raw = readFileSync(join(fixturesDir, name), "utf8");
  const marker = raw.indexOf("-->");
  return marker === -1 ? raw : raw.slice(marker + 3).replace(/^\r?\n/, "");
}

const AUTH_401_BODY = readFixtureBody("auth-401.txt");

const ATOM_BODY = readFixture("root-catalog.xml");
const HTML_BODY = readFixture("login-page.html");

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

function makeTransport(response: { status: number; text: string }): {
  transport: OpdsTransport;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const transport: OpdsTransport = async (url, headers) => {
    calls.push({ url, headers });
    return response;
  };
  return { transport, calls };
}

function makeSettings(overrides: Partial<ObservationCarSettings> = {}): ObservationCarSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function makeClient(
  settings: ObservationCarSettings,
  transport: OpdsTransport,
): OpdsClient {
  return new OpdsClient({ settings: () => settings, transport });
}

/** Await an OpdsError rejection and assert its kind (and status if given). */
async function expectOpdsError(
  promise: Promise<unknown>,
  kind: OpdsError["kind"],
  status?: number,
): Promise<OpdsError> {
  try {
    await promise;
    expect.unreachable("expected an OpdsError");
  } catch (error) {
    expect(error).toBeInstanceOf(OpdsError);
    const opdsError = error as OpdsError;
    expect(opdsError.kind).toBe(kind);
    if (status !== undefined) {
      expect(opdsError.status).toBe(status);
    }
    return opdsError;
  }
}

describe("F5.1 OpdsClient — root catalog", () => {
  it("fetches ${bookloreBaseUrl}/api/v1/opds and parses the feed", async () => {
    const { transport, calls } = makeTransport({ status: 200, text: ATOM_BODY });
    const client = makeClient(
      makeSettings({
        bookloreBaseUrl: "https://booklore.example",
        opdsUsername: "opds-user",
        opdsPassword: "s3cret",
      }),
      transport,
    );

    const feed = await client.getRootFeed();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://booklore.example/api/v1/opds");
    expect(calls[0].headers.Authorization).toBe(
      basicAuthHeader("opds-user", "s3cret"),
    );
    expect(calls[0].headers.Accept).toBe("application/atom+xml");
    expect(feed.title).toBe("Booklore Catalog");
    expect(feed.url).toBe("https://booklore.example/api/v1/opds");
  });

  it("normalizes a trailing slash on the base URL", async () => {
    const { transport, calls } = makeTransport({ status: 200, text: ATOM_BODY });
    const client = makeClient(
      makeSettings({ bookloreBaseUrl: "https://booklore.example/" }),
      transport,
    );
    await client.getRootFeed();
    expect(calls[0].url).toBe("https://booklore.example/api/v1/opds");
  });

  it("rejects with no-base-url before any request when the URL is empty", async () => {
    const { transport, calls } = makeTransport({ status: 200, text: ATOM_BODY });
    const client = makeClient(makeSettings(), transport);
    const error = await expectOpdsError(client.getRootFeed(), "no-base-url");
    expect(calls).toHaveLength(0);
    expect(error.name).toBe("OpdsError");
  });
});

describe("F5.1 OpdsClient — live settings reads", () => {
  it("re-reads the base URL and credentials on every call, never a snapshot", async () => {
    const settings = makeSettings({
      bookloreBaseUrl: "https://first.example",
      opdsUsername: "first-user",
      opdsPassword: "first-pass",
    });
    const { transport, calls } = makeTransport({ status: 200, text: ATOM_BODY });
    const client = new OpdsClient({ settings: () => settings, transport });

    await client.getRootFeed();

    // The user edits the settings tab mid-session; the same client must
    // pick the new values up on the next call.
    settings.bookloreBaseUrl = "https://second.example";
    settings.opdsUsername = "second-user";
    settings.opdsPassword = "p@sswörd-ñ";

    await client.getRootFeed();

    expect(calls[0].url).toBe("https://first.example/api/v1/opds");
    expect(calls[0].headers.Authorization).toBe(
      basicAuthHeader("first-user", "first-pass"),
    );
    expect(calls[1].url).toBe("https://second.example/api/v1/opds");
    expect(calls[1].headers.Authorization).toBe(
      basicAuthHeader("second-user", "p@sswörd-ñ"),
    );
  });

  it("applies the same live reads to an absolute feed URL", async () => {
    const settings = makeSettings({ opdsUsername: "u", opdsPassword: "p" });
    const { transport, calls } = makeTransport({ status: 200, text: ATOM_BODY });
    const client = new OpdsClient({ settings: () => settings, transport });

    await client.fetchFeed("https://booklore.example/api/v1/opds/page2");
    expect(calls[0].url).toBe("https://booklore.example/api/v1/opds/page2");
    expect(calls[0].headers.Authorization).toBe(basicAuthHeader("u", "p"));
  });
});

describe("F5.1 OpdsClient — transport outcome classification", () => {
  it.each([401, 403])("maps HTTP %i to auth", async (status) => {
    const { transport } = makeTransport({ status, text: "Unauthorized" });
    const client = makeClient(
      makeSettings({ bookloreBaseUrl: "https://booklore.example" }),
      transport,
    );
    const error = await expectOpdsError(client.getRootFeed(), "auth");
    expect(error.status).toBeUndefined();
  });

  it("maps a 401 carrying Booklore's real plain-text body to auth", async () => {
    // Live capture (LOCO-101): a wrong OPDS password yields this exact
    // non-XML body; the client must classify it auth, not not-opds.
    expect(AUTH_401_BODY).toBe("HTTP Status 401 - Bad credentials");
    const { transport } = makeTransport({ status: 401, text: AUTH_401_BODY });
    const client = makeClient(
      makeSettings({
        bookloreBaseUrl: "https://booklore.example",
        opdsUsername: "opds-user",
        opdsPassword: "bad-pass",
      }),
      transport,
    );
    const error = await expectOpdsError(client.getRootFeed(), "auth");
    expect(error.message).toBe("Booklore rejected the OPDS credentials.");
    expect(error.message).not.toContain("bad-pass");
  });

  it.each([
    [404, "Not Found"],
    [502, "<html>Bad Gateway</html>"],
  ])("maps HTTP %i to http with the status recorded", async (status, text) => {
    const { transport } = makeTransport({ status, text });
    const client = makeClient(
      makeSettings({ bookloreBaseUrl: "https://booklore.example" }),
      transport,
    );
    const error = await expectOpdsError(client.getRootFeed(), "http", status);
    expect(error.message).toContain(String(status));
  });

  it("maps a network failure (transport rejection) to unreachable", async () => {
    const failing: OpdsTransport = async () => {
      throw new Error("socket hang up");
    };
    const client = makeClient(
      makeSettings({ bookloreBaseUrl: "https://booklore.example" }),
      failing,
    );
    await expectOpdsError(client.getRootFeed(), "unreachable");
  });

  it("maps a 2xx HTML body to not-opds", async () => {
    const { transport } = makeTransport({ status: 200, text: HTML_BODY });
    const client = makeClient(
      makeSettings({ bookloreBaseUrl: "https://booklore.example" }),
      transport,
    );
    await expectOpdsError(client.getRootFeed(), "not-opds");
  });

  it("maps a 2xx malformed-XML body to not-opds", async () => {
    const { transport } = makeTransport({ status: 200, text: "<feed><id" });
    const client = makeClient(
      makeSettings({ bookloreBaseUrl: "https://booklore.example" }),
      transport,
    );
    await expectOpdsError(client.getRootFeed(), "not-opds");
  });

  it("sends no Authorization header when no credentials are configured", async () => {
    const { transport, calls } = makeTransport({ status: 200, text: ATOM_BODY });
    const client = makeClient(
      makeSettings({ bookloreBaseUrl: "https://booklore.example" }),
      transport,
    );
    await client.getRootFeed();
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

});

describe("F5.1 OpdsClient — secret hygiene", () => {
  const PASSWORD = "honey-butter-9876";
  const USERNAME = "shhh-opds-account";
  const authedSettings = makeSettings({
    bookloreBaseUrl: "https://booklore.example",
    opdsUsername: USERNAME,
    opdsPassword: PASSWORD,
  });

  it.each([
    ["no-base-url", () => makeClient(makeSettings(), makeTransport({ status: 200, text: ATOM_BODY }).transport).getRootFeed()],
    ["auth", () => makeClient(authedSettings, makeTransport({ status: 401, text: "no" }).transport).getRootFeed()],
    ["http", () => makeClient(authedSettings, makeTransport({ status: 404, text: "no" }).transport).getRootFeed()],
    ["unreachable", () => makeClient(authedSettings, (async () => { throw new Error("down"); }) as OpdsTransport).getRootFeed()],
    ["not-opds", () => makeClient(authedSettings, makeTransport({ status: 200, text: HTML_BODY }).transport).getRootFeed()],
  ])("never puts credentials in a %s error message", async (kind, request) => {
    const error = await expectOpdsError(request(), kind as OpdsError["kind"]);
    expect(error.message).not.toContain(PASSWORD);
    expect(error.message).not.toContain(USERNAME);
  });
});
