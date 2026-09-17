import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = fileURLToPath(
  new URL("../scripts/verify-release-consistency.sh", import.meta.url),
);
const VALID_MANIFEST = JSON.stringify({
  version: "0.1.0",
  minAppVersion: "1.7.2",
});
const VALID_VERSIONS = JSON.stringify({ "0.1.0": "1.7.2" });
const SHAPE_DIAGNOSTIC =
  "::error::versions.json must contain exactly one top-level JSON object.";
const MISSING_ENTRY_DIAGNOSTIC =
  "::error::versions.json has no entry for plugin version '0.1.0'. Add it (keyed by plugin version, with minAppVersion as the value) before tagging.";

interface FixtureOptions {
  manifest?: string | null;
  versions?: string | null;
}

interface GuardResult {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

const fixtureDirectories: string[] = [];

const createFixture = (options: FixtureOptions = {}): string => {
  const directory = mkdtempSync(join(tmpdir(), "observation-car-release-"));
  fixtureDirectories.push(directory);

  const manifest =
    options.manifest === undefined ? VALID_MANIFEST : options.manifest;
  const versions = options.versions ??
    (options.versions === null ? null : VALID_VERSIONS);

  if (manifest !== null) {
    writeFileSync(join(directory, "manifest.json"), manifest);
  }
  if (versions !== null) {
    writeFileSync(join(directory, "versions.json"), versions);
  }

  return directory;
};

const runGuard = (directory: string, tag = "0.1.0"): GuardResult => {
  const result = spawnSync(SCRIPT_PATH, [tag], {
    encoding: "utf8",
    env: { ...process.env, RELEASE_ROOT: directory },
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
  };
};

const expectFailure = (
  result: GuardResult,
  expectedStatus: number,
  diagnostic: string,
  stderrDiagnostic?: string,
): void => {
  expect(result.status).toBe(expectedStatus);
  expect(result.stdout).toBe(`${diagnostic}\n`);
  if (stderrDiagnostic === undefined) {
    expect(result.stderr).toBe("");
  } else {
    expect(result.stderr).toContain(stderrDiagnostic);
  }
};

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

describe("release version consistency guard", () => {
  describe("unevaluatable versions.json", () => {
    it.each([
      ["zero-byte", "", undefined],
      ["whitespace-only", " \n\t", undefined],
      ["null document", "null\n", undefined],
      ["array", "[]\n", undefined],
      ["multi-document", "{}\n{}\n", undefined],
      ["malformed JSON", "{not-json\n", "jq: parse error:"],
      [
        "missing file",
        null,
        "jq: error: Could not open file versions.json:",
      ],
    ])(
      "rejects %s input with the shape diagnostic",
      (_name, versions, stderrDiagnostic) => {
        const result = runGuard(createFixture({ versions }));

        expectFailure(result, 1, SHAPE_DIAGNOSTIC, stderrDiagnostic);
      },
    );
  });

  describe("versions.json direction", () => {
    it("accepts plugin version keys with minAppVersion values", () => {
      const result = runGuard(
        createFixture({ versions: '{"0.1.0":"1.7.2"}\n' }),
      );

      expect(result.status).toBe(0);
      expect(result.output).toContain(
        "Version consistency OK: tag '0.1.0' -> version '0.1.0', minAppVersion '1.7.2'.",
      );
    });

    it("rejects the historically inverted key/value direction", () => {
      const result = runGuard(
        createFixture({ versions: '{"1.7.2":"0.1.0"}\n' }),
      );

      expectFailure(result, 1, MISSING_ENTRY_DIAGNOSTIC);
    });
  });

  describe("versions.json entry lookup", () => {
    it.each([
      ["absent", '{"0.2.0":"1.7.2"}\n'],
      ["null", '{"0.1.0":null}\n'],
      ["empty string", '{"0.1.0":""}\n'],
    ])("rejects an %s entry", (_name, versions) => {
      const result = runGuard(createFixture({ versions }));

      expectFailure(result, 1, MISSING_ENTRY_DIAGNOSTIC);
    });

    it("rejects an entry value of the wrong type", () => {
      const result = runGuard(
        createFixture({ versions: '{"0.1.0":172}\n' }),
      );

      expectFailure(
        result,
        1,
        "::error::versions.json lists minAppVersion '172' for plugin version '0.1.0' but manifest.json minAppVersion is '1.7.2'.",
      );
    });

    it("rejects the wrong minAppVersion", () => {
      const result = runGuard(
        createFixture({ versions: '{"0.1.0":"1.8.0"}\n' }),
      );

      expectFailure(
        result,
        1,
        "::error::versions.json lists minAppVersion '1.8.0' for plugin version '0.1.0' but manifest.json minAppVersion is '1.7.2'.",
      );
    });
  });

  describe("tag handling", () => {
    it.each(["0.1.0", "v0.1.0"])("accepts tag %s", (tag) => {
      const result = runGuard(createFixture(), tag);

      expect(result.status).toBe(0);
      expect(result.output).toContain(
        `Version consistency OK: tag '${tag}' -> version '0.1.0', minAppVersion '1.7.2'.`,
      );
    });

    it("rejects a non-version tag before reading release metadata", () => {
      const result = runGuard(createFixture(), "release-latest");

      expectFailure(
        result,
        1,
        "::error::Tag 'release-latest' is not a plugin version (expected '1.2.3' or 'v1.2.3').",
      );
    });

    it("rejects a version tag that differs from manifest.json", () => {
      const result = runGuard(createFixture(), "0.2.0");

      expectFailure(
        result,
        1,
        "::error::manifest.json version '0.1.0' does not match tag '0.2.0' (normalized version '0.2.0'). Bump manifest.json before tagging, or retag.",
      );
    });
  });

  describe("manifest validation", () => {
    it("reports a missing manifest.json", () => {
      const result = runGuard(createFixture({ manifest: null }));

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "jq: error: Could not open file manifest.json:",
      );
    });

    it("reports malformed manifest.json", () => {
      const result = runGuard(createFixture({ manifest: "{not-json\n" }));

      expect(result.status).toBe(5);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("jq: parse error:");
    });

    it.each([
      ["null", null],
      ["empty", ""],
      ["non-string", 123],
    ])("preserves the silent exit for a %s manifest version", (_name, version) => {
      const result = runGuard(
        createFixture({
          manifest: JSON.stringify({ version, minAppVersion: "1.7.2" }),
        }),
      );

      expect(result).toMatchObject({ status: 4, stdout: "", stderr: "" });
    });

    it.each([
      ["null", null],
      ["empty", ""],
      ["non-string", 172],
    ])("preserves the silent exit for a %s minAppVersion", (_name, minAppVersion) => {
      const result = runGuard(
        createFixture({
          manifest: JSON.stringify({ version: "0.1.0", minAppVersion }),
        }),
      );

      expect(result).toMatchObject({ status: 4, stdout: "", stderr: "" });
    });
  });

  it("resolves the requested version in a realistic multi-entry file", () => {
    const result = runGuard(
      createFixture({
        versions: JSON.stringify({
          "0.0.1": "1.4.0",
          "0.0.2": "1.4.0",
          "0.0.3": "1.5.0",
          "0.1.0": "1.7.2",
          "0.2.0": "1.8.0",
          "1.0.0": "1.9.0",
        }),
      }),
    );

    expect(result.status).toBe(0);
    expect(result.output).toContain(
      "Version consistency OK: tag '0.1.0' -> version '0.1.0', minAppVersion '1.7.2'.",
    );
  });
});
