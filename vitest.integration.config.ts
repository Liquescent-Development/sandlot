import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // macOS Sandbox Runtime attribution is delivered asynchronously through a
    // system-wide log stream. Parallel files create competing monitors and can
    // make an enforced denial appear under the wrong fixture at assertion time.
    fileParallelism: false,
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
