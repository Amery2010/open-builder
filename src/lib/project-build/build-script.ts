export const BUILD_SCRIPT_PATH = "__open_builder_build__.cjs";
export const BUILD_STATUS_PATH = "__open_builder_build_status__.json";
export const BUILD_OUTPUT_PATH = "__open_builder_deployment__";

/** Runs in the disposable Nodebox filesystem, never in the user's project. */
export const COMPATIBILITY_BUILD_SCRIPT = `
const fs = require('fs');
const childProcess = require('child_process');
const spawn = childProcess.spawn;
// Nodebox can truncate writes larger than esbuild's 16 KiB stdin read buffer.
// Serialize complete protocol packets so concurrent transforms cannot interleave.
function spawnEsbuildService() {
  const child = spawn.apply(this, arguments);
  const args = arguments[1];
  if (!Array.isArray(args) || !args.some(function (arg) { return typeof arg === 'string' && arg.startsWith('--service='); }) || !child.stdin) return child;
  const write = child.stdin.write.bind(child.stdin);
  const pending = [];
  let writing = false;
  let failure;
  function fail(error) {
    failure = error;
    writing = false;
    pending.splice(0).forEach(function (entry) { if (entry.callback) entry.callback(error); });
  }
  function drain() {
    const item = pending[0];
    if (!item) { writing = false; return; }
    const chunk = item.bytes.subarray(item.offset, item.offset + 8192);
    try {
      write(chunk, function (error) {
        if (error) { fail(error); return; }
        item.offset += chunk.length;
        if (item.offset === item.bytes.length) {
          pending.shift();
          if (item.callback) item.callback();
        }
        drain();
      });
    } catch (error) { fail(error); }
  }
  child.stdin.write = function (bytes, callback) {
    if (failure) { if (callback) callback(failure); return false; }
    pending.push({ bytes, callback, offset: 0 });
    if (!writing) { writing = true; drain(); }
    return true;
  };
  return child;
}
// Nodebox's module replacement hook handles its read-only built-in exports.
require('module').addPatchedModule('child_process', { ...childProcess, spawn: spawnEsbuildService });
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
