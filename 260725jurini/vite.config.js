import { defineConfig } from "vite";

export default defineConfig({
  base: "/myChangGo/260725jurini/",
  build: {
    target: "es2020",
    sourcemap: true,
  },
  test: {
    environment: "node",
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
