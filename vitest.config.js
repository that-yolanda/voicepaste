import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["web/tests/**/*.test.js"],
    environment: "jsdom",
    globals: true,
  },
});
