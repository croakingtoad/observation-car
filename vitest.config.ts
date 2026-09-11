import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The `obsidian` npm package is types-only (the app provides the
      // real module at runtime), so Vite cannot resolve it; point it at a
      // loud-failure stub and let tests inject their own fakes.
      obsidian: fileURLToPath(new URL("./src/test/obsidian-stub.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
  },
});
