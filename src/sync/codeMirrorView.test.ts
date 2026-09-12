// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { codeMirrorView } from "./codeMirrorView";

describe("codeMirrorView", () => {
  it("returns null when the editor has no cm property", () => {
    expect(codeMirrorView({})).toBeNull();
  });

  it("returns null when cm is not an EditorView", () => {
    const notAView = {};

    expect(codeMirrorView({ cm: notAView })).toBeNull();
  });
});
