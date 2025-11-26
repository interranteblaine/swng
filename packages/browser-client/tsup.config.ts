import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  platform: "browser",
  target: "es2020",
  // Bundle workspace deps so the browser sees one clean ESM file
  noExternal: [
    "@swng/client",
    "@swng/contracts",
    "@swng/domain",
    "@swng/application",
  ],
});
