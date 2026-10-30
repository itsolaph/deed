import { defineConfig } from "vite";

// Relative base so the build works from any path, for example GitHub Pages.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: false,
  },
  server: {
    fs: { allow: [".."] },
  },
});
