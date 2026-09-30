import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/src/**/*.test.tsx", "apps/*/test/**/*.test.ts"],
    environment: "node",
    // apps/web/src/lib/supabase.ts needs these to construct its client at import time. Never a real
    // project: tests never sign in for real, and components that need a session mock ../lib/supabase.
    env: {
      VITE_SUPABASE_URL: "https://test.supabase.co",
      VITE_SUPABASE_ANON_KEY: "test-anon-key",
    },
  },
});
