#!/usr/bin/env node
// Builds the Rust daemon for local development and E2E tests.
//
//   macOS      → universal binary (arm64 + x86_64 via `lipo`)
//   Linux/Win  → native-arch binary
//
// Published VSIX packages do not ship these binaries. At runtime the extension
// builds the current OS/CPU daemon from bundled Rust source and caches it in
// VS Code global storage.

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const daemonDir = path.join(root, 'daemon');
const outDir = path.join(root, 'resources', 'bin');
fs.mkdirSync(outDir, { recursive: true });

const { platform, arch } = process;

function run(cmd, cwd = daemonDir) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}
function tryRun(cmd, cwd = daemonDir) {
  try {
    run(cmd, cwd);
    return true;
  } catch {
    return false;
  }
}

if (platform === 'darwin') {
  const targets = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
  for (const t of targets) tryRun(`rustup target add ${t}`);
  for (const t of targets) run(`cargo build --release --target ${t}`);
  const arm = path.join(daemonDir, 'target/aarch64-apple-darwin/release/autoimport-daemon');
  const x64 = path.join(daemonDir, 'target/x86_64-apple-darwin/release/autoimport-daemon');
  const dest = path.join(outDir, 'autoimport-daemon-darwin-universal');
  run(`lipo -create "${arm}" "${x64}" -output "${dest}"`);
  fs.chmodSync(dest, 0o755);
  const size = (fs.statSync(dest).size / 1024 / 1024).toFixed(2);
  console.log(`✓ autoimport-daemon-darwin-universal (${size} MB fat)`);
} else {
  run('cargo build --release');
  const ext = platform === 'win32' ? '.exe' : '';
  const src = path.join(daemonDir, 'target', 'release', `autoimport-daemon${ext}`);
  const destName = `autoimport-daemon-${platform}-${arch}${ext}`;
  const dest = path.join(outDir, destName);
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
  const size = (fs.statSync(dest).size / 1024 / 1024).toFixed(2);
  console.log(`✓ ${destName} (${size} MB)`);
}
