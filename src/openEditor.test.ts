// @vitest-environment jsdom
import { MarkdownView } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { findOpenEditor } from "./openEditor";

vi.mock("obsidian", () => {
  class MarkdownView {
    file: { path: string } | null;
    editor: unknown;
    constructor(file: { path: string } | null, editor: unknown) {
      this.file = file;
      this.editor = editor;
    }
  }
  return { MarkdownView };
});

const MarkdownViewDouble = MarkdownView as unknown as new (
  file: { path: string } | null,
  editor: unknown,
) => MarkdownView;

function makeEditor(hasFocus: boolean): unknown {
  return { hasFocus: () => hasFocus };
}

interface WorkspaceHost {
  getLeavesOfType(viewType: string): { view: unknown }[];
}

function makeApp(leaves: MarkdownView[]): { app: { workspace: WorkspaceHost } } {
  return {
    app: {
      workspace: {
        getLeavesOfType: () => leaves.map((view) => ({ view })),
      },
    },
  };
}

describe("findOpenEditor", () => {
  it("prefers the focused editor over the first matching leaf", () => {
    const first = makeEditor(false);
    const second = makeEditor(true);
    const app = makeApp([
      new MarkdownViewDouble({ path: "Note.md" }, first),
      new MarkdownViewDouble({ path: "Note.md" }, second),
    ]);

    expect(findOpenEditor(app, "Note.md")).toBe(second);
  });

  it("falls back to the first matching editor and returns null when absent", () => {
    const first = makeEditor(false);
    const firstApp = makeApp([
      new MarkdownViewDouble({ path: "Note.md" }, first),
      new MarkdownViewDouble({ path: "Other.md" }, makeEditor(true)),
    ]);

    expect(findOpenEditor(firstApp, "Note.md")).toBe(first);
    expect(findOpenEditor(firstApp, "Missing.md")).toBeNull();
  });
});
