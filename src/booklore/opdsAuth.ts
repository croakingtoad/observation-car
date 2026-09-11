/**
 * F5.1 — HTTP Basic Auth header for the OPDS client.
 *
 * Free of `obsidian` imports (unit-tested in Node). The only consumer is
 * `opdsClient.ts`, which builds the `Authorization` header from the F1.4
 * settings fields on every request; nothing in this module logs, persists,
 * or embeds the credentials anywhere else.
 */

/**
 * Build an HTTP Basic `Authorization` header value (RFC 7617).
 *
 * `btoa` operates on Latin-1 code units, so feeding it a credential with
 * non-ASCII characters directly would corrupt them. The username and
 * password are encoded to UTF-8 bytes first, and that byte sequence is
 * base64-encoded — which is exactly what RFC 7617 §2.2 prescribes.
 */
export function basicAuthHeader(username: string, password: string): string {
  const utf8 = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of utf8) {
    binary += String.fromCharCode(byte);
  }
  return `Basic ${btoa(binary)}`;
}
