import { describe, expect, it } from "vitest";
import { requestUrl } from "obsidian";

describe("obsidian stub — loud-failure contract (PL-037)", () => {
  it("throws for requestUrl so tests inject their own transport fakes", () => {
    expect(() => requestUrl({ url: "http://example.com" })).toThrow(
      "obsidian.requestUrl is not available in tests; inject a fake instead.",
    );
  });
});
