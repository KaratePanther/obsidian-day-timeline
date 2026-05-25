import esbuild from "esbuild";
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const prod = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const vaultPluginDir = join(
  process.env.HOME,
  "Library/Mobile Documents/iCloud~md~obsidian/Documents/My Idea Garden/.obsidian/plugins/day-timeline"
);

function copyToVault() {
  if (!existsSync(vaultPluginDir)) {
    mkdirSync(vaultPluginDir, { recursive: true });
  }
  copyFileSync("main.js", join(vaultPluginDir, "main.js"));
  copyFileSync("styles.css", join(vaultPluginDir, "styles.css"));
  copyFileSync("manifest.json", join(vaultPluginDir, "manifest.json"));
  console.log("Copied to vault plugin directory");
}

const copyPlugin = {
  name: "copy-to-vault",
  setup(build) {
    build.onEnd(() => {
      copyToVault();
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2020",
  outfile: "main.js",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  plugins: [copyPlugin],
});

if (watch) {
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
