import * as esbuild from "npm:esbuild";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader";

await Deno.mkdir("dist", { recursive: true });

// We need to copy the WASM blob for laz-perf, and given we're not using
// deno as the server it seems we have to copy that manually still. We do
// this by finding where deno keeps libraries and extracting it ourselves.
const infoCmd = new Deno.Command("deno", {
    args: ["info", "--json"],
    stdout: "piped",
});
const infoRes = await infoCmd.output();
const info = JSON.parse(new TextDecoder().decode(infoRes.stdout));

// We need to get the verion number also for whatever we're using
const pkgInfoCmd = new Deno.Command("deno", {
  args: ["info", "--json", "npm:laz-perf"],
  stdout: "piped",
});
const pkgInfoRes = await pkgInfoCmd.output();
const pkg = JSON.parse(new TextDecoder().decode(pkgInfoRes.stdout));

const lazPerfKey = Object.keys(pkg.npmPackages).find(k => k.startsWith("laz-perf@"));
if (!lazPerfKey) {
    throw new Error("laz-perf not found");
}
const lazPerfVersion = lazPerfKey.split("@")[1];

const lazPerfPath = `${info.npmCache}/registry.npmjs.org/laz-perf/${lazPerfVersion}`;

await esbuild.build({
  plugins: [...denoPlugins()],
  entryPoints: ["src/main.ts"],
  outfile: "dist/bundle.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  minify: true,
  treeShaking: true,
});

await Deno.copyFile(
  `${lazPerfPath}/lib/web/laz-perf.wasm`,
  "dist/laz-perf.wasm"
);

await esbuild.stop();
