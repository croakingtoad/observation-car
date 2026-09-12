import { readFileSync, readdirSync } from "node:fs";
import { isIP } from "node:net";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixturesDir = fileURLToPath(new URL("fixtures", import.meta.url));

// These are fixed identifiers from Atom, OPDS, OpenSearch, and Dublin Core,
// rather than captured service hosts.
const protocolHosts = new Set([
  "a9.com",
  "opds-spec.org",
  "purl.org",
  "www.w3.org",
]);
// Dotted filenames, media types, and fixture data can resemble hostnames.
const nonHostnameSuffixes = new Set([
  "ebook",
  "epub",
  "html",
  "jpeg",
  "jpg",
  "md",
  "opds",
  "pdf",
  "png",
  "rating",
  "txt",
  "xml",
]);

function listFixtureFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFixtureFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function isReservedExampleHost(host: string): boolean {
  return (
    /^(?:.+\.)?example$/.test(host) ||
    /^(?:.+\.)?example\.(?:com|net|org)$/.test(host)
  );
}

function findFixtureViolations(contents: Buffer): string[] {
  // latin1 preserves every byte so binary fixtures are scanned without
  // decoding failures or replacement characters hiding an ASCII secret.
  const text = contents.toString("latin1");
  const violations: string[] = [];

  const dottedTokens =
    text.match(
      /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi,
    ) ?? [];
  for (const token of dottedTokens) {
    const host = token.toLowerCase();
    const suffix = host.slice(host.lastIndexOf(".") + 1);
    if (
      !nonHostnameSuffixes.has(suffix) &&
      !protocolHosts.has(host) &&
      !isReservedExampleHost(host)
    ) {
      violations.push(`non-example hostname: ${token}`);
    }
  }

  const ipCandidates = [
    ...(text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []),
    ...(
      text.match(
        /(?<![0-9a-f:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![0-9a-f:])/gi,
      ) ?? []
    ),
  ];
  for (const candidate of ipCandidates) {
    if (isIP(candidate)) {
      violations.push(`IP literal: ${candidate}`);
    }
  }

  const hostPorts =
    text.match(
      /(?:\[[0-9a-f:]+\]|\b(?:localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+|(?:\d{1,3}\.){3}\d{1,3})):\d{1,5}\b/gi,
    ) ?? [];
  for (const hostPort of hostPorts) {
    violations.push(`host:port pair: ${hostPort}`);
  }

  if (/\bauthorization\s*:\s*\S+/i.test(text)) {
    violations.push("Authorization header value");
  }
  const basicValues = text.matchAll(
    /\bbasic[ \t]+([a-z0-9+/]{4,}={0,2})(?![a-z0-9+/=])/gi,
  );
  for (const match of basicValues) {
    if (Buffer.from(match[1], "base64").includes(0x3a)) {
      violations.push("Basic authentication token");
    }
  }
  for (const field of ["opdsUsername", "opdsPassword"]) {
    if (text.includes(field)) {
      violations.push(`credential field name: ${field}`);
    }
  }
  if (/(?:\?|&|&amp;)(?:password|passwd|token)=/i.test(text)) {
    violations.push("credential query parameter");
  }

  return violations;
}

describe("F5.1 fixture redaction", () => {
  it("keeps every fixture free of private hosts and credentials", () => {
    for (const path of listFixtureFiles(fixturesDir)) {
      const name = relative(fixturesDir, path);
      const violations = findFixtureViolations(readFileSync(path));
      expect(violations, `${name}: ${violations.join(", ")}`).toEqual([]);
    }
  });
});
