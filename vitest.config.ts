import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

const dir = resolve(fileURLToPath(import.meta.url), "..");

export default defineProject({
  resolve: {
    alias: {
      "cloudflare:workers": resolve(dir, "src/__mocks__/cloudflare-workers.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/__mocks__/**"],
    },
  },
});
