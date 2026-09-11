import { requestUrl } from "obsidian";
import {
  normalizeBaseUrl,
  type ObservationCarSettings,
} from "../settings";
import { basicAuthHeader } from "./opdsAuth";
import { parseOpdsFeed } from "./opdsParser";
import { OpdsError, type OpdsFeed } from "./opdsTypes";

/**
 * F5.1 — OPDS client for a self-hosted Booklore instance.
 *
 * The only module in `src/booklore/` that imports `obsidian` — for
 * `requestUrl`, which works on mobile and avoids the CORS problems a
 * `fetch`-based client would hit there (PRD F5.1). The parser and auth
 * helpers stay obsidian-free so they unit-test in Node; this class is
 * tested with an injected transport standing in for `requestUrl`.
 *
 * Settings are read through a getter on every call — never snapshot the
 * settings object. `updateSettings` replaces the object wholesale and there
 * is no settings-change event (see `main.ts`), so on-demand reads are the
 * live-reload path for mid-session edits to the Booklore URL and the OPDS
 * account. The getter therefore receives a *function*, not an object.
 */

/** What the client needs from an HTTP transport: a status and a body. */
export interface OpdsTransportResult {
  status: number;
  text: string;
}

/**
 * Minimal transport surface. `requestUrl` with `throw: false` satisfies it:
 * non-2xx statuses resolve (so the client can classify them) and only
 * network-level failures reject.
 */
export type OpdsTransport = (
  url: string,
  headers: Record<string, string>,
) => Promise<OpdsTransportResult>;

const defaultTransport: OpdsTransport = async (url, headers) => {
  // `throw: false` so 401/403/404/5xx resolve and the client can map them to
  // OpdsError kinds; a rejected promise means the network failed.
  const response = await requestUrl({ url, headers, throw: false });
  return { status: response.status, text: response.text };
};

export interface OpdsClientOptions {
  /**
   * Returns the plugin's current settings; called once per request so
   * edits in the settings tab apply to the very next feed fetch.
   */
  settings: () => ObservationCarSettings;
  /** HTTP transport; defaults to Obsidian's `requestUrl`. */
  transport?: OpdsTransport;
}

export class OpdsClient {
  private readonly settings: () => ObservationCarSettings;
  private readonly transport: OpdsTransport;

  constructor(options: OpdsClientOptions) {
    this.settings = options.settings;
    this.transport = options.transport ?? defaultTransport;
  }

  /**
   * Fetch and parse the root catalog at `${bookloreBaseUrl}/api/v1/opds`.
   *
   * @throws OpdsError with kind `no-base-url` when the Booklore base URL is
   *   empty, or `auth` / `unreachable` / `http` / `not-opds` per
   *   {@link fetchFeed}.
   */
  async getRootFeed(): Promise<OpdsFeed> {
    const base = normalizeBaseUrl(this.settings().bookloreBaseUrl);
    if (base === "") {
      throw new OpdsError("no-base-url", "No Booklore base URL is set.");
    }
    return this.fetchFeed(`${base}/api/v1/opds`);
  }

  /**
   * Fetch and parse an absolute feed URL: a pagination `rel="next"`, a
   * navigation entry's feed, or an OpenSearch query feed.
   *
   * @throws OpdsError with kind `auth` (401/403), `unreachable` (network
   *   failure), `http` (any other non-2xx, status in `error.status`), or
   *   `not-opds` (a 2xx body that is not an Atom feed). Error messages never
   *   include credentials, the URL, or the body.
   */
  async fetchFeed(feedUrl: string): Promise<OpdsFeed> {
    const credentials = this.settings();
    const headers: Record<string, string> = {
      Accept: "application/atom+xml",
    };
    if (credentials.opdsUsername !== "" || credentials.opdsPassword !== "") {
      headers.Authorization = basicAuthHeader(
        credentials.opdsUsername,
        credentials.opdsPassword,
      );
    }

    let result: OpdsTransportResult;
    try {
      result = await this.transport(feedUrl, headers);
    } catch {
      throw new OpdsError(
        "unreachable",
        "Could not reach the Booklore instance.",
      );
    }

    if (result.status === 401 || result.status === 403) {
      throw new OpdsError(
        "auth",
        "Booklore rejected the OPDS credentials.",
      );
    }
    if (result.status < 200 || result.status >= 300) {
      throw new OpdsError(
        "http",
        `Booklore answered with HTTP ${result.status}.`,
        result.status,
      );
    }

    try {
      return parseOpdsFeed(result.text, feedUrl);
    } catch (error) {
      if (error instanceof OpdsError) {
        throw error;
      }
      throw new OpdsError("not-opds", "Booklore returned an unreadable feed.");
    }
  }
}
