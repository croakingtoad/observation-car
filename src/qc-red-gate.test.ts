import { describe, expect, it } from "vitest";

describe("QC Tier 2 red-gate verification (LOCO-87, disposable)", () => {
  it("deliberately fails so the main-branch CI gate can be proven to block", () => {
    expect(true).toBe(false);
  });
});
