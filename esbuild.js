const esbuild = require("esbuild");

const isWatch = process.argv.includes("--watch");

async function run() {
  const context = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    outfile: "dist/extension.js",
    sourcemap: true,
    target: "node18",
    logLevel: "info",
    tsconfig: "tsconfig.json"
  });

  if (isWatch) {
    await context.watch();
    return;
  }

  await context.rebuild();
  await context.dispose();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
