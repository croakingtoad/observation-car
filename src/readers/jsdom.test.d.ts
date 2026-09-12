declare module "jsdom" {
  type DOMWindow = Window & typeof globalThis & { close(): void };

  export class JSDOM {
    constructor(html?: string);
    readonly window: DOMWindow;
  }
}
