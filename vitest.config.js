import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["web/tests/**/*.test.{js,ts,tsx}"],
    environment: "jsdom",
    globals: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "web/src"),
    },
  },
});
