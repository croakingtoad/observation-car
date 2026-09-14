// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Book, Contents, Rendition } from "epubjs";
import { buildEpubCfiFragment } from "../model/anchor";
import { EpubNavigationTools, EpubSelectionTracker } from "./epubNavigationTools";

/** A valid range CFI as epub.js emits it for an in-section selection. */
const CFI_RANGE = "epubcfi(/6/4!/4/2/1:0,/4/2/1:0,/4/2/1:12)";
const OTHER_SECTION_CFI = "epubcfi(/8/2!/4/2/6:0)";
const SAME_SECTION_CFI = "epubcfi(/6/4!/4/2/6:0)";
const ZERO_RECT = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

interface FakeContents extends Contents {
  state: { text: string; collapsed: boolean };
}

function makeContents(
  options: { text?: string; collapsed?: boolean } = {},
): FakeContents {
  const state = {
    text: options.text ?? "",
    collapsed: options.collapsed ?? false,
  };
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const iframeDocument = iframe.contentDocument;
  const iframeWindow = iframe.contentWindow;
  if (iframeDocument === null || iframeWindow === null) {
    throw new Error("jsdom did not create an iframe browsing context");
  }
  Object.defineProperty(iframeWindow, "getSelection", {
    configurable: true,
    value: () => ({
      get rangeCount() {
        return 1;
      },
      toString: () => state.text,
      getRangeAt: () => ({
        collapsed: state.collapsed,
        getBoundingClientRect: () => ZERO_RECT,
      }),
    }),
  });
  const contents = {
    state,
    document: iframeDocument,
    window: iframeWindow,
  };
  return contents as unknown as FakeContents;
}

function makeIframeContents(): {
  contents: Contents;
  iframe: HTMLIFrameElement;
} {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const iframeDocument = iframe.contentDocument;
  const iframeWindow = iframe.contentWindow;
  if (iframeDocument === null || iframeWindow === null) {
    throw new Error("jsdom did not create an iframe browsing context");
  }
  return {
    contents: {
      document: iframeDocument,
      window: iframeWindow,
    } as unknown as Contents,
    iframe,
  };
}

function makeRendition(): {
  rendition: Rendition;
  emit: (event: string, ...args: unknown[]) => void;
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const rendition = {
    on(event: string, callback: (...args: unknown[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(callback);
      handlers.set(event, list);
      return rendition;
    },
    display: async () => undefined,
    themes: { override: () => undefined },
  };
  const emit = (event: string, ...args: unknown[]): void => {
    for (const callback of handlers.get(event) ?? []) {
      callback(...args);
    }
  };
  return { rendition: rendition as unknown as Rendition, emit };
}

function makeBook(): Book {
  return {
    loaded: {
      metadata: Promise.resolve({ title: "Test Book" }),
      navigation: Promise.resolve({ toc: [] }),
    },
  } as unknown as Book;
}

/** Let the constructor's async listener registrations settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function makeTools(tracker: EpubSelectionTracker) {
  const viewerEl = document.createElement("div");
  const { rendition, emit } = makeRendition();
  new EpubNavigationTools(viewerEl, "test.epub", makeBook(), rendition, tracker);
  await flush();
  return { emit };
}

describe("EpubSelectionTracker — selection state machine", () => {
  it("returns {text, fragment} for a present selection", () => {
    const tracker = new EpubSelectionTracker();
    tracker.setSelected(CFI_RANGE, "  the quick brown fox  ", makeContents());

    expect(tracker.getSelection()).toEqual({
      text: "the quick brown fox",
      fragment: buildEpubCfiFragment(CFI_RANGE),
    });
  });

  it("returns null for an empty cfiRange", () => {
    const tracker = new EpubSelectionTracker();
    tracker.setSelected("", "some text", makeContents());

    expect(tracker.getSelection()).toBeNull();
  });

  it("returns null for whitespace-only text", () => {
    const tracker = new EpubSelectionTracker();
    tracker.setSelected(CFI_RANGE, "  \t\n ", makeContents());

    expect(tracker.getSelection()).toBeNull();
  });

  it("returns null, not a throw, for a malformed CFI", () => {
    const tracker = new EpubSelectionTracker();
    tracker.setSelected("epubcfi(/6/4)", "some text", makeContents());

    expect(tracker.getSelection()).toBeNull();
  });

  it("clears the selection on relocation to another section", () => {
    const tracker = new EpubSelectionTracker();
    tracker.setSelected(CFI_RANGE, "some text", makeContents());

    tracker.clearUnlessInLocation(OTHER_SECTION_CFI);

    expect(tracker.getSelection()).toBeNull();
  });

  it("keeps the selection on relocation within the same section", () => {
    const tracker = new EpubSelectionTracker();
    tracker.setSelected(CFI_RANGE, "some text", makeContents());

    tracker.clearUnlessInLocation(SAME_SECTION_CFI);

    expect(tracker.getSelection()).not.toBeNull();
  });

  it("returns null once the selection's iframe is detached", () => {
    const { contents, iframe } = makeIframeContents();
    const tracker = new EpubSelectionTracker();
    tracker.setSelected(CFI_RANGE, "some text", contents);
    expect(tracker.getSelection()).not.toBeNull();

    iframe.remove();

    expect(tracker.getSelection()).toBeNull();
  });

  it("clear() drops the selection (the dispose path)", () => {
    const tracker = new EpubSelectionTracker();
    tracker.setSelected(CFI_RANGE, "some text", makeContents());

    tracker.clear();

    expect(tracker.getSelection()).toBeNull();
  });
});

describe("EpubNavigationTools — rendition event wiring", () => {
  it("stores {text, cfiRange} when the rendition emits selected", async () => {
    const tracker = new EpubSelectionTracker();
    const { emit } = await makeTools(tracker);

    emit("selected", CFI_RANGE, makeContents({ text: "quoted words" }));
    await flush();

    expect(tracker.getSelection()).toEqual({
      text: "quoted words",
      fragment: buildEpubCfiFragment(CFI_RANGE),
    });
  });

  it("clears the selection on selected with an empty cfiRange", async () => {
    const tracker = new EpubSelectionTracker();
    const { emit } = await makeTools(tracker);
    emit("selected", CFI_RANGE, makeContents({ text: "quoted words" }));

    emit("selected", "", makeContents());

    expect(tracker.getSelection()).toBeNull();
  });

  it("clears the selection on a collapsed selectionchange in the iframe", async () => {
    const tracker = new EpubSelectionTracker();
    const { emit } = await makeTools(tracker);
    const contents = makeContents({ text: "quoted words" });

    emit("rendered", undefined, contents);
    emit("selected", CFI_RANGE, contents);
    await flush();
    expect(tracker.getSelection()).not.toBeNull();

    contents.state.collapsed = true;
    contents.document.dispatchEvent(new Event("selectionchange"));

    expect(tracker.getSelection()).toBeNull();
  });

  it("clears an attached selection when a fresh view is rendered", async () => {
    const tracker = new EpubSelectionTracker();
    const { emit } = await makeTools(tracker);
    emit("selected", CFI_RANGE, makeContents({ text: "quoted words" }));
    await flush();
    expect(tracker.getSelection()).not.toBeNull();

    emit("rendered", undefined, makeContents());

    expect(tracker.getSelection()).toBeNull();
  });

  it("clears the selection when the rendition relocates to another section", async () => {
    const tracker = new EpubSelectionTracker();
    const { emit } = await makeTools(tracker);
    emit("selected", CFI_RANGE, makeContents({ text: "quoted words" }));

    emit("relocated", { start: { cfi: OTHER_SECTION_CFI } });

    expect(tracker.getSelection()).toBeNull();
  });

  it("clears a detached selection when resize re-renders the same section", async () => {
    const tracker = new EpubSelectionTracker();
    const { emit } = await makeTools(tracker);
    const { contents, iframe } = makeIframeContents();
    tracker.setSelected(CFI_RANGE, "quoted words", contents);

    emit("resized");
    iframe.remove();
    emit("rendered", undefined, makeContents());
    emit("relocated", { start: { cfi: SAME_SECTION_CFI } });

    expect(tracker.getSelection()).toBeNull();
  });
});
