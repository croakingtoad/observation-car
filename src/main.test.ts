import { describe, expect, it } from "vitest";
import manifest from "../manifest.json";

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

describe("manifest.json", () => {
  it("runs on mobile (isDesktopOnly is false)", () => {
    expect(manifest.isDesktopOnly).toBe(false);
  });

  it("targets a supported Obsidian version (minAppVersion >= 1.7.2)", () => {
    expect(compareVersions(manifest.minAppVersion, "1.7.2")).toBeGreaterThanOrEqual(0);
  });
});
