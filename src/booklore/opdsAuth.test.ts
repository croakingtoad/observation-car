import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { basicAuthHeader } from "./opdsAuth";

/** Independent oracle: base64 of the UTF-8 bytes of `user:pass`. */
function expectedHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

describe("F5.1 basicAuthHeader", () => {
  it("builds the RFC 7617 §2 vector for ASCII credentials", () => {
    expect(basicAuthHeader("user", "pass")).toBe("Basic dXNlcjpwYXNz");
  });

  it("is UTF-8 safe for a non-ASCII password (RFC 7617 §2.2 vector)", () => {
    // btoa("user:pässwörd") would corrupt the multibyte characters; the
    // TextEncoder step must not.
    expect(basicAuthHeader("user", "pässwörd")).toBe("Basic dXNlcjpww6Rzc3fDtnJk");
    expect(basicAuthHeader("user", "pässwörd")).toBe(
      expectedHeader("user", "pässwörd"),
    );
  });

  it("is UTF-8 safe for a non-ASCII username", () => {
    expect(basicAuthHeader("üser", "paß")).toBe(expectedHeader("üser", "paß"));
  });

  it("handles an empty username (password still transmitted)", () => {
    expect(basicAuthHeader("", "pass")).toBe("Basic OnBhc3M=");
  });

  it("decodes back to the exact UTF-8 credentials", () => {
    const credentials = "høst-lector:ñandú-8421";
    const [, token] = basicAuthHeader(credentials.split(":")[0], credentials.split(":")[1]).split(" ");
    const decoded = Buffer.from(token, "base64").toString("utf8");
    expect(decoded).toBe(credentials);
  });
});
