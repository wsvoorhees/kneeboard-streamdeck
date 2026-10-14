import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const outDir = "com.willvoorhees.kneeboard-streamdeck.sdPlugin/bin";

const shared = {
  // koffi is a NATIVE module: bundling it would inline a .node loader that resolves nothing at
  // runtime. It stays external and is installed, for Windows, beside the built plugin.
  external: ["koffi"],
  plugins: [
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs(),
    json(),
    typescript({
      tsconfig: "./tsconfig.json",
      // The sources use explicit `.ts` specifiers, which the Node test runner needs. TypeScript
      // 5.7+ rewrites them on emit, so the bundle is valid ESM
      // without the sources having to lie about their own extensions.
      compilerOptions: { noEmit: false, declaration: false },
    }),
  ],
};

export default [
  { input: "src/runtime/plugin.ts", output: { file: `${outDir}/plugin.js`, format: "es" }, ...shared },
  // Built alongside the plugin so the smoke test used to diagnose a machine is the same code the
  // plugin ships, not a hand-written copy that can drift from it.
  { input: "src/runtime/smoke.ts", output: { file: `${outDir}/smoke.js`, format: "es" }, ...shared },
];
