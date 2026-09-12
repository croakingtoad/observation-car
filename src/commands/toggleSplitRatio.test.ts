import { MarkdownView, type Command, type WorkspaceLeaf } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type ObservationCarPlugin from "../main";
import {
  NARROW_TABLET_MAX_WIDTH_PX,
  SPLIT_RATIO_TOGGLE_COMMAND_ID,
  registerSplitRatioToggleCommand,
} from "./toggleSplitRatio";

vi.mock("obsidian", () => {
  class MarkdownView {
    file: { path: string } | null;
    constructor(file: { path: string } | null) {
      this.file = file;
    }
  }
  class Notice {
    constructor(_message: string) {}
  }
  return { MarkdownView, Notice };
});

interface TestSplitItem {
  parent?: TestSplitItem;
  children?: TestSplitItem[];
  direction?: "vertical" | "horizontal";
  containerEl: {
    getBoundingClientRect(): { width: number };
  };
  width: number;
  dimensions: number[];
  setDimension?(dimension: number): void;
}

interface TestView {
  file: { path: string } | null;
}

interface TestLeaf {
  parent: TestSplitItem;
  view: TestView;
  getRoot(): object;
  getContainer(): { win: { innerWidth: number } };
}

interface Harness {
  command: Command;
  plugin: ObservationCarPlugin;
  readerLeaf: TestLeaf;
  noteLeaf: TestLeaf;
  readerTabs: TestSplitItem;
  noteTabs: TestSplitItem;
  setViewportWidth(width: number): void;
  setMostRecentLeaf(leaf: TestLeaf | null): void;
}

const MarkdownViewDouble = MarkdownView as unknown as new (
  file: { path: string } | null,
) => MarkdownView;

function makeTabs(width: number): TestSplitItem {
  const tabs: TestSplitItem = {
    containerEl: {
      getBoundingClientRect: () => {
        const dimension = tabs.dimensions.at(-1);
        const splitWidth = tabs.parent?.width;
        return {
          width:
            dimension === undefined || splitWidth === undefined
              ? tabs.width
              : (dimension / 100) * splitWidth,
        };
      },
    },
    width,
    dimensions: [],
    setDimension: (dimension) => {
      tabs.dimensions.push(dimension);
    },
  };
  return tabs;
}

function makeHarness(
  settings: { splitReadRatioPercent: number; splitWriteRatioPercent: number } = {
    splitReadRatioPercent: 60,
    splitWriteRatioPercent: 40,
  },
): Harness {
  const rootSplit = {};
  const parentSplit = makeTabs(1200);
  parentSplit.direction = "vertical";
  const readerTabs = makeTabs(600);
  const noteTabs = makeTabs(600);
  readerTabs.parent = parentSplit;
  noteTabs.parent = parentSplit;
  parentSplit.children = [readerTabs, noteTabs];

  let viewportWidth = 1200;
  let mostRecentLeaf: TestLeaf | null = null;
  const container = { win: { innerWidth: viewportWidth } };
  const readerLeaf: TestLeaf = {
    parent: readerTabs,
    view: { file: { path: "Books/A.epub" } },
    getRoot: () => rootSplit,
    getContainer: () => container,
  };
  const noteLeaf: TestLeaf = {
    parent: noteTabs,
    view: new MarkdownViewDouble({ path: "Reading/A.md" }),
    getRoot: () => rootSplit,
    getContainer: () => container,
  };
  mostRecentLeaf = readerLeaf;

  let command: Command | undefined;
  const pairing = {
    leaf: readerLeaf as unknown as WorkspaceLeaf,
    notePath: "Reading/A.md",
  };
  const plugin = {
    settings,
    app: {
      workspace: {
        rootSplit,
        getMostRecentLeaf: () =>
          mostRecentLeaf as unknown as WorkspaceLeaf | null,
        getLeavesOfType: () => [noteLeaf as unknown as WorkspaceLeaf],
      },
    },
    addCommand: (registered: Command) => {
      command = registered;
      return registered;
    },
    getReaderPairingForLeaf: (leaf: WorkspaceLeaf) =>
      leaf === (readerLeaf as unknown as WorkspaceLeaf) ? pairing : undefined,
    getReaderPairingForNote: (path: string) =>
      path === "Reading/A.md" ? pairing : undefined,
  } as unknown as ObservationCarPlugin;

  registerSplitRatioToggleCommand(plugin);
  if (command === undefined) throw new Error("split-ratio command was not registered");
  expect(command.id).toBe(SPLIT_RATIO_TOGGLE_COMMAND_ID);

  return {
    command,
    plugin,
    readerLeaf,
    noteLeaf,
    readerTabs,
    noteTabs,
    setViewportWidth: (width) => {
      viewportWidth = width;
      container.win.innerWidth = viewportWidth;
    },
    setMostRecentLeaf: (leaf) => {
      mostRecentLeaf = leaf;
    },
  };
}

function invoke(harness: Harness): void {
  expect(harness.command.checkCallback?.(true)).toBe(true);
  expect(harness.command.checkCallback?.(false)).toBe(true);
}

describe("split-ratio toggle command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("cycles the paired split through live configured read and write ratios", () => {
    const harness = makeHarness({
      splitReadRatioPercent: 65,
      splitWriteRatioPercent: 35,
    });

    invoke(harness);
    expect(harness.readerTabs.dimensions).toEqual([65]);
    expect(harness.noteTabs.dimensions).toEqual([35]);

    invoke(harness);
    expect(harness.readerTabs.dimensions).toEqual([65, 35]);
    expect(harness.noteTabs.dimensions).toEqual([35, 65]);

    harness.plugin.settings.splitReadRatioPercent = 70;
    harness.plugin.settings.splitWriteRatioPercent = 30;
    invoke(harness);
    expect(harness.readerTabs.dimensions).toEqual([65, 35, 70]);
    expect(harness.noteTabs.dimensions).toEqual([35, 65, 30]);
  });

  it("adds the 80/20 step for a narrow split inside a wide window", () => {
    const harness = makeHarness();
    const split = harness.readerTabs.parent;
    if (split === undefined) throw new Error("parent split fixture is missing");
    split.width = NARROW_TABLET_MAX_WIDTH_PX;
    harness.readerTabs.width = NARROW_TABLET_MAX_WIDTH_PX / 2;
    harness.noteTabs.width = NARROW_TABLET_MAX_WIDTH_PX / 2;
    harness.setViewportWidth(1400);

    invoke(harness);
    invoke(harness);
    invoke(harness);
    invoke(harness);

    expect(harness.readerTabs.dimensions).toEqual([60, 40, 80, 60]);
    expect(harness.noteTabs.dimensions).toEqual([40, 60, 20, 40]);
  });

  it("emits percentage dimensions when measured widths are pixels", () => {
    const harness = makeHarness();

    invoke(harness);

    expect(harness.readerTabs.dimensions).toEqual([60]);
    expect(harness.noteTabs.dimensions).toEqual([40]);
  });

  it("advances when the measured ratio is within the configured tolerance", () => {
    const harness = makeHarness();
    const split = harness.readerTabs.parent;
    if (split === undefined) throw new Error("parent split fixture is missing");
    split.width = 1000;
    harness.readerTabs.width = 605;
    harness.noteTabs.width = 395;

    invoke(harness);

    expect(harness.readerTabs.dimensions).toEqual([40]);
    expect(harness.noteTabs.dimensions).toEqual([60]);
  });

  it("cycles directly to 80/20 when the read and write ratios match", () => {
    const harness = makeHarness({
      splitReadRatioPercent: 60,
      splitWriteRatioPercent: 60,
    });
    const split = harness.readerTabs.parent;
    if (split === undefined) throw new Error("parent split fixture is missing");
    split.width = 800;
    harness.readerTabs.width = 400;
    harness.noteTabs.width = 400;

    invoke(harness);
    invoke(harness);

    expect(harness.readerTabs.dimensions).toEqual([60, 80]);
    expect(harness.noteTabs.dimensions).toEqual([40, 20]);
  });

  it("uses the note leaf when the paired note was most recently active", () => {
    const harness = makeHarness();
    harness.setMostRecentLeaf(harness.noteLeaf);

    invoke(harness);

    expect(harness.readerTabs.dimensions).toEqual([60]);
    expect(harness.noteTabs.dimensions).toEqual([40]);
  });

  it("preserves other siblings while changing the paired leaves' relative ratio", () => {
    const harness = makeHarness();
    const split = harness.readerTabs.parent;
    if (split === undefined) throw new Error("parent split fixture is missing");
    const otherTabs = makeTabs(50);
    otherTabs.parent = split;
    harness.readerTabs.width = 30;
    harness.noteTabs.width = 20;
    split.children = [harness.readerTabs, harness.noteTabs, otherTabs];

    invoke(harness);

    expect(harness.readerTabs.dimensions).toEqual([20]);
    expect(harness.noteTabs.dimensions).toEqual([30]);
    expect(otherTabs.dimensions).toEqual([50]);
  });

  it("is unavailable when the paired leaves do not share a resizable split", () => {
    const harness = makeHarness();
    harness.noteTabs.parent = makeTabs(100);

    expect(harness.command.checkCallback?.(true)).toBe(false);
    expect(harness.readerTabs.dimensions).toEqual([]);
    expect(harness.noteTabs.dimensions).toEqual([]);
  });

  it("is unavailable for a stacked split", () => {
    const harness = makeHarness();
    const split = harness.readerTabs.parent;
    if (split === undefined) throw new Error("parent split fixture is missing");
    split.direction = "horizontal";

    expect(harness.command.checkCallback?.(true)).toBe(false);
    expect(harness.readerTabs.dimensions).toEqual([]);
    expect(harness.noteTabs.dimensions).toEqual([]);
  });
});
