import * as esbuild from "npm:esbuild";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader";

await Deno.mkdir("dist", { recursive: true });

// Resolve laz-perf's local cache path via deno info
const cmd = new Deno.Command("deno", {
  args: ["info", "--json", "npm:laz-perf"],
  stdout: "piped",
});
const output = await cmd.output();
const info = JSON.parse(new TextDecoder().decode(output.stdout));
const lazPerfPath = info.npmPackages["laz-perf@0.0.7"].localPath;

await esbuild.build({
  plugins: [...denoPlugins()],
  entryPoints: ["src/main.ts"],
  outfile: "dist/bundle.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  minify: false,
  treeShaking: true,
});

await Deno.copyFile(
  `${lazPerfPath}/lib/web/laz-perf.wasm`,
  "dist/laz-perf.wasm"
);

await esbuild.stop();
