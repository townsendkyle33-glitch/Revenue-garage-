import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    setupFiles: ["./test/env.ts"],
    fileParallelism: false, // tests share one database
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
