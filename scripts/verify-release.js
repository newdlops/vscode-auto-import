#!/usr/bin/env node
// Verifies that a production .vsix contains the Rust daemon source needed for
// first-run native builds. Platform binaries are intentionally not shipped.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const requiredFiles = [
  'daemon/Cargo.toml',
  'daemon/Cargo.lock',
  'daemon/src/main.rs',
  'resources/icon.png',
];

let failed = false;

console.log('Release source check:');
for (const rel of requiredFiles) {
  const full = path.join(root, rel);
  if (fs.existsSync(full)) {
    console.log(`  ok ${rel}`);
  } else {
    failed = true;
    console.error(`  missing ${rel}`);
  }
}

const rustFiles = listRustFiles(path.join(root, 'daemon', 'src'));
if (rustFiles.length === 0) {
  failed = true;
  console.error('  missing daemon/src/**/*.rs');
} else {
  console.log(`  ok daemon/src/**/*.rs (${rustFiles.length} files)`);
}

const vscodeignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf-8');
const ignored = vscodeignore
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

if (ignored.includes('daemon/')) {
  failed = true;
  console.error('  .vscodeignore must not exclude daemon/');
} else {
  console.log('  ok .vscodeignore includes daemon source');
}

if (!ignored.includes('daemon/target/')) {
  failed = true;
  console.error('  .vscodeignore should exclude daemon/target/');
} else {
  console.log('  ok .vscodeignore excludes daemon/target/');
}

if (!ignored.includes('resources/bin/')) {
  failed = true;
  console.error('  .vscodeignore should exclude resources/bin/');
} else {
  console.log('  ok .vscodeignore excludes prebuilt binaries');
}

if (failed) {
  process.exit(1);
}

console.log('\nRelease layout ready: daemon source will build on first activation.');

function listRustFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listRustFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.rs')) {
      out.push(full);
    }
  }
  return out;
}
