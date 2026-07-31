import { defineConfig } from "rolldown";

const external = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

const piLoaderCompatibility = {
  name: "pi-loader-compatibility",
  generateBundle() {
    // Pi loads extensions through Jiti so host packages can be supplied via
    // aliases. Prevent Node's native ESM fast path from bypassing those aliases.
    this.emitFile({
      type: "asset",
      fileName: "package.json",
      source: '{\n  "type": "commonjs"\n}\n',
    });
  },
};

const output = (entryFileNames, cleanDir) => ({
  dir: "dist",
  entryFileNames,
  format: "esm",
  codeSplitting: false,
  cleanDir,
  // Pi's Jiti extension loader parses fully minified single-line bundles much
  // more slowly. Dead-code elimination keeps the one-file startup benefit
  // without that parser regression, while preserving useful stack traces.
  minify: "dce-only",
  // Keep maps for diagnostics, but do not make Jiti load and compose the map
  // during every extension import.
  sourcemap: "hidden",
});

export default defineConfig([
  {
    input: "src/index.ts",
    platform: "node",
    external,
    plugins: [piLoaderCompatibility],
    output: output("index.js", true),
  },
  {
    input: "src/background-worker.ts",
    platform: "node",
    external,
    output: output("background-worker.mjs", false),
  },
]);
