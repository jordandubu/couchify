// Bundle content scripts to classic scripts and background worker to bundled ESM,
// copying static assets to dist/.
import { context } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

const watch = process.argv.includes("--watch");

const content = await context({
  entryPoints: ["content/video.js"],
  bundle: true,
  format: "iife",
  outfile: "dist/content/video.js",
  logLevel: "info",
});
await content.rebuild();
if (watch) await content.watch();
else await content.dispose();

const bg = await context({
  entryPoints: ["background/worker.js"],
  bundle: true,
  format: "esm",
  outfile: "dist/background/worker.js",
  logLevel: "info",
});
await bg.rebuild();
if (watch) await bg.watch();
else await bg.dispose();

// Popup, options, lib, icons + manifest
for (const dir of ["popup", "options", "lib", "icons"]) {
  cpSync(dir, `dist/${dir}`, { recursive: true });
}
cpSync("manifest.json", "dist/manifest.json");
if (!watch) console.log("build → dist/");