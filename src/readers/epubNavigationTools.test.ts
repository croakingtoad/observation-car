// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  EpubKeyBridge,
  type EpubKeyBridgeRendition,
} from "./epubNavigationTools";

type RenderedHandler = Parameters<EpubKeyBridgeRendition["on"]>[1];

class FakeRendition implements EpubKeyBridgeRendition {
  readonly prev = vi.fn(async (): Promise<void> => undefined);
  readonly next = vi.fn(async (): Promise<void> => undefined);
  private readonly renderedHandlers = new Set<RenderedHandler>();

  on(event: "rendered", handler: RenderedHandler): void {
    expect(event).toBe("rendered");
    this.renderedHandlers.add(handler);
  }

  off(event: "rendered", handler: RenderedHandler): void {
    expect(event).toBe("rendered");
    this.renderedHandlers.delete(handler);
  }

  render(document: Document): void {
    for (const handler of this.renderedHandlers) {
      handler({}, { document });
    }
  }
}

function keyboardEvent(
  document: Document,
  key: string,
  init: KeyboardEventInit & { keyCode: number },
): KeyboardEvent {
  const KeyboardEventConstructor = document.defaultView?.KeyboardEvent;
  if (KeyboardEventConstructor === undefined) {
    throw new Error("test document has no KeyboardEvent constructor");
  }
  const event = new KeyboardEventConstructor("keydown", { key, ...init });
  Object.defineProperty(event, "keyCode", { value: init.keyCode });
  return event;
}

function documents(): { host: Document; iframe: Document } {
  const hostFrame = document.createElement("iframe");
  document.body.append(hostFrame);
  const host = hostFrame.contentDocument;
  if (host === null) {
    throw new Error("test host iframe has no document");
  }
  const readerFrame = host.createElement("iframe");
  host.body.append(readerFrame);
  const iframe = readerFrame.contentDocument;
  if (iframe === null) {
    throw new Error("test reader iframe has no document");
  }
  return {
    host,
    iframe,
  };
}

function childDocument(parent: Document): Document {
  const frame = parent.createElement("iframe");
  parent.body.append(frame);
  if (frame.contentDocument === null) {
    throw new Error("test iframe has no document");
  }
  return frame.contentDocument;
}

describe("EpubKeyBridge", () => {
  it("forwards an equivalent non-paging key event to the host document", () => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());
    rendition.render(iframe);

    const forwarded: KeyboardEvent[] = [];
    host.addEventListener("keydown", (event) => forwarded.push(event));
    iframe.dispatchEvent(
      keyboardEvent(iframe, "p", {
        code: "KeyP",
        keyCode: 80,
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
        altKey: true,
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      key: "p",
      code: "KeyP",
      keyCode: 80,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: true,
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    bridge.destroy();
  });

  it.each([
    ["ArrowLeft", "prev"],
    ["ArrowRight", "next"],
  ] as const)("consumes %s for reader paging", (key, method) => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());
    rendition.render(iframe);
    const hostHandler = vi.fn();
    host.addEventListener("keydown", hostHandler);

    const event = keyboardEvent(iframe, key, {
      code: key,
      keyCode: key === "ArrowLeft" ? 37 : 39,
      bubbles: true,
      cancelable: true,
    });
    iframe.dispatchEvent(event);

    expect(rendition[method]).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(hostHandler).not.toHaveBeenCalled();
    bridge.destroy();
  });

  it("leaves the iframe copy default active exactly once", () => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());
    rendition.render(iframe);
    const hostHandler = vi.fn();
    host.addEventListener("keydown", hostHandler);

    let nativeCopyDefaults = 0;
    iframe.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "c" && !event.defaultPrevented) {
        nativeCopyDefaults += 1;
      }
    });
    const event = keyboardEvent(iframe, "c", {
      code: "KeyC",
      keyCode: 67,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    iframe.dispatchEvent(event);

    expect(hostHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(nativeCopyDefaults).toBe(1);
    bridge.destroy();
  });

  it("does not forward a key already handled by the EPUB document", () => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());
    const consumeInBook = (event: KeyboardEvent): void => event.preventDefault();
    iframe.addEventListener("keydown", consumeInBook);
    rendition.render(iframe);
    const hostHandler = vi.fn();
    host.addEventListener("keydown", hostHandler);

    iframe.dispatchEvent(
      keyboardEvent(iframe, "x", {
        code: "KeyX",
        keyCode: 88,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(hostHandler).not.toHaveBeenCalled();
    bridge.destroy();
  });

  it("does not forward its own synthetic event if it returns to the iframe", () => {
    const { host, iframe } = documents();
    const rendition = new FakeRendition();
    const bridge = new EpubKeyBridge(rendition, host, vi.fn());
    rendition.render(iframe);
    const forwarded: KeyboardEvent[] = [];
    host.addEventListener("keydown", (event) => forwarded.push(event));

    iframe.dispatchEvent(
      keyboardEvent(iframe, "p", {
        code: "KeyP",
        keyCode: 80,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    iframe.dispatchEvent(forwarded[0]);

    expect(forwarded).toHaveLength(1);
    bridge.destroy();
  });

  it("removes the disposed rendition's document handler before a replacement pages", () => {
    const { host, iframe: oldDocument } = documents();
    const replacementDocument = childDocument(host);
    const oldRendition = new FakeRendition();
    const oldBridge = new EpubKeyBridge(oldRendition, host, vi.fn());
    oldRendition.render(oldDocument);
    oldBridge.destroy();

    const replacementRendition = new FakeRendition();
    const replacementBridge = new EpubKeyBridge(replacementRendition, host, vi.fn());
    replacementRendition.render(replacementDocument);
    oldDocument.dispatchEvent(
      keyboardEvent(oldDocument, "ArrowRight", {
        code: "ArrowRight",
        keyCode: 39,
        bubbles: true,
        cancelable: true,
      }),
    );
    replacementDocument.dispatchEvent(
      keyboardEvent(replacementDocument, "ArrowRight", {
        code: "ArrowRight",
        keyCode: 39,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(oldRendition.next).not.toHaveBeenCalled();
    expect(replacementRendition.next).toHaveBeenCalledOnce();
    replacementBridge.destroy();
  });
});
