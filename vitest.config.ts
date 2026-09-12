import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // `obsidian` is a type-only npm package (`"main": ""`); the runtime
    // is provided by the app in production. Point tests at a stub.
    alias: {
      obsidian: fileURLToPath(
        new URL("./src/__mocks__/obsidian.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
  },
});
