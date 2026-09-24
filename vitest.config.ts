import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/src/**/*.test.tsx", "apps/*/test/**/*.test.ts"],
    environment: "node",
  },
});
