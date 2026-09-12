import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The `obsidian` npm package ships types only (`main: ""` — the API
      // is provided by the Obsidian app at runtime), so Vite cannot
      // resolve the bare import; unit tests get the runtime stand-in.
      obsidian: fileURLToPath(
        new URL("./src/test/obsidian-mock.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
  },
});
