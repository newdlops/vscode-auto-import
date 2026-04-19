const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

function copyWasms() {
  // no-op: parsers now live in the Rust daemon
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
