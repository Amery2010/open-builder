export const BUILD_SCRIPT_PATH = "__open_builder_build__.cjs";
export const BUILD_STATUS_PATH = "__open_builder_build_status__.json";
export const BUILD_OUTPUT_PATH = "__open_builder_deployment__";

/** Runs in the disposable Nodebox filesystem, never in the user's project. */
export const COMPATIBILITY_BUILD_SCRIPT = `
const fs = require('fs');
const vite = require('vite');
function assetFileNames(asset) {
  const name = String(asset.name || 'asset');
  const leaf = name.split('/').pop();
  const match = /\\.([a-zA-Z0-9]+)$/.exec(leaf);
  if (!match) throw new Error('Cannot determine deployment asset type: ' + name);
  const extension = match[1].toLowerCase();
  const stem = leaf.slice(0, -match[0].length).replace(/[^a-zA-Z0-9_-]/g, '-') || 'asset';
  return 'assets/' + stem + '-[hash].' + extension;
}
function finish(ok, error) {
  fs.writeFileSync('${BUILD_STATUS_PATH}', JSON.stringify({ ok, error: error || null }));
  setTimeout(function () { process.exit(ok ? 0 : 1); }, 0);
}
vite.build({
  clearScreen: false,
  build: {
    minify: false, target: 'esnext', cssMinify: false, cssCodeSplit: false,
    outDir: '${BUILD_OUTPUT_PATH}', emptyOutDir: true,
    rollupOptions: { output: {
      entryFileNames: 'assets/entry-[hash].js',
      chunkFileNames: 'assets/chunk-[hash].js',
      assetFileNames
    } }
  }
}).then(function () { finish(true); }, function (error) {
  finish(false, error && error.message ? error.message : String(error));
});
`;
