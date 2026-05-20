import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  banner: {
    js: '#!/usr/bin/env node',
  },
  clean: true,
  splitting: false,
  sourcemap: false,
  define: {
    PKG_VERSION: JSON.stringify(require("./package.json").version),
  },
});
