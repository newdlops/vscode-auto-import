const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const WASM_SOURCES = [
  'node_modules/web-tree-sitter/tree-sitter.wasm',
  'node_modules/tree-sitter-wasms/out/tree-sitter-tsx.wasm',
  'node_modules/tree-sitter-wasms/out/tree-sitter-javascript.wasm',
  'node_modules/tree-sitter-wasms/out/tree-sitter-python.wasm',
  'node_modules/tree-sitter-wasms/out/tree-sitter-java.wasm',
];

function copyWasms() {
  const dest = path.join(__dirname, 'resources', 'wasm');
  fs.mkdirSync(dest, { recursive: true });
  for (const src of WASM_SOURCES) {
    const abs = path.join(__dirname, src);
    const out = path.join(dest, path.basename(src));
    fs.copyFileSync(abs, out);
  }
  console.log(`copied ${WASM_SOURCES.length} wasm files → resources/wasm/`);
}

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

async function main() {
  copyWasms();
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('esbuild: watching for changes...');
  } else {
    await esbuild.build(buildOptions);
    console.log(`esbuild: build complete (${production ? 'production' : 'development'})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
