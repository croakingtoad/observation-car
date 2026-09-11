/**
 * Test-time resolution target for the `obsidian` module, which ships no
 * runtime code in the npm package (the app provides the real module; the
 * production bundle externalizes it and never includes this file). Vite
 * cannot resolve the bare `obsidian` specifier without an entry point, so
 * the vitest config aliases it here.
 *
 * Every export fails loudly if actually invoked: tests must inject their
 * own fakes (e.g. `OpdsClient`'s `transport` option) instead of relying on
 * stub behavior, so no test can pass on simulated Obsidian APIs.
 */

function notAvailable(member: string): never {
  throw new Error(
    `obsidian.${member} is not available in tests; inject a fake instead.`,
  );
}

export function requestUrl(_options: unknown): Promise<never> {
  return Promise.reject(notAvailable("requestUrl"));
}
