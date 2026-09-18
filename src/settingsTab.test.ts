// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ObservationCarSettings } from "./settings";
import type { OpdsTransport } from "./booklore/opdsClient";

vi.mock("obsidian", () => ({
  PluginSettingTab: class {},
  Setting: class {},
  requestUrl: vi.fn(() => {
    throw new Error("Tests must inject the OPDS transport.");
  }),
}));

import { testBookloreConnection } from "./settingsTab";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "booklore",
  "fixtures",
);
const OPDS_BODY = readFileSync(join(fixturesDir, "root-catalog.xml"), "utf8");
const HTML_BODY = readFileSync(join(fixturesDir, "login-page.html"), "utf8");

function settings(
  overrides: Partial<ObservationCarSettings> = {},
): ObservationCarSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function respondingTransport(
  response: { status: number; text: string },
): { transport: OpdsTransport; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    transport: async (url) => {
      calls.push(url);
      return response;
    },
  };
}

describe("F5.8 Booklore connection test", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("passes only after a 200 response is parsed as an OPDS feed", async () => {
    const configured = settings({
      bookloreBaseUrl: "https://booklore.example",
      opdsUsername: "opds-user",
      opdsPassword: "correct-password",
    });
    const { transport, calls } = respondingTransport({
      status: 200,
      text: OPDS_BODY,
    });

    const result = await testBookloreConnection(() => configured, transport);

    expect(result).toEqual({
      ok: true,
      message: "Connected to Booklore. The OPDS catalog is available.",
    });
    expect(calls).toEqual(["https://booklore.example/api/v1/opds"]);
  });

  it("does not treat a non-OPDS 200 response as a successful connection", async () => {
    const configured = settings({
      bookloreBaseUrl: "https://booklore.example",
    });
    const { transport } = respondingTransport({ status: 200, text: HTML_BODY });

    const result = await testBookloreConnection(() => configured, transport);

    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      "Booklore responded, but OPDS is unavailable or disabled.",
    );
  });

  it("renders auth, unreachable, and OPDS-disabled failures distinctly", async () => {
    const secretUrl = "https://embedded-user:embedded-pass@booklore.example";
    const configured = settings({
      bookloreBaseUrl: secretUrl,
      opdsUsername: "private-user",
      opdsPassword: "private-password",
    });
    const auth = respondingTransport({
      status: 401,
      text: "HTTP Status 401 - Bad credentials",
    });
    const unreachable: OpdsTransport = async () => {
      throw new Error(
        `${secretUrl} private-user private-password could not connect`,
      );
    };
    const notOpds = respondingTransport({ status: 200, text: HTML_BODY });

    const results = await Promise.all([
      testBookloreConnection(() => configured, auth.transport),
      testBookloreConnection(() => configured, unreachable),
      testBookloreConnection(() => configured, notOpds.transport),
    ]);

    expect(results.map((result) => result.message)).toEqual([
      "Authentication failed. Check the OPDS username and password.",
      "Could not reach Booklore. Check that the server is running and reachable.",
      "Booklore responded, but OPDS is unavailable or disabled.",
    ]);
    expect(new Set(results.map((result) => result.message)).size).toBe(3);
    const rendered = JSON.stringify(results);
    expect(rendered).not.toContain(secretUrl);
    expect(rendered).not.toContain("embedded-pass");
    expect(rendered).not.toContain("private-user");
    expect(rendered).not.toContain("private-password");
    expect(rendered).not.toContain("HTTP Status 401 - Bad credentials");
  });

  it("rejects a scheme-less base URL before transport instead of blaming auth", async () => {
    const configured = settings({
      bookloreBaseUrl: "booklore.example",
      opdsUsername: "user",
      opdsPassword: "password",
    });
    const { transport, calls } = respondingTransport({
      status: 401,
      text: "HTTP Status 401 - Bad credentials",
    });

    const result = await testBookloreConnection(() => configured, transport);

    expect(result).toEqual({
      ok: false,
      message: "Enter a full Booklore base URL, for example https://host:port.",
    });
    expect(calls).toHaveLength(0);
  });

  it("renders the client's no-base-url failure without making a request", async () => {
    const { transport, calls } = respondingTransport({
      status: 200,
      text: OPDS_BODY,
    });

    const result = await testBookloreConnection(
      () => settings(),
      transport,
    );

    expect(result).toEqual({
      ok: false,
      message: "Enter a Booklore base URL before testing the connection.",
    });
    expect(calls).toHaveLength(0);
  });
});
