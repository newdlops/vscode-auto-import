# Changelog

All notable changes to **Auto Import Plus** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-04-19

### Changed

- **First-activation daemon build** — the VSIX now ships the Rust daemon source instead of prebuilt platform binaries. On first activation the extension runs `cargo build --release --locked` for the current OS/CPU and caches the binary in VS Code global storage.
- **Managed Rust fallback** — if `cargo` is not available, the extension downloads official `rustup-init`, verifies its `.sha256` file, and installs a minimal Rust toolchain under extension global storage before building the daemon.
- **Release layout** — `resources/bin/` is excluded from packaged extensions; `daemon/Cargo.toml`, `daemon/Cargo.lock`, and `daemon/src/` are included so Windows, Linux, and macOS users build their own native daemon locally.
- **CI matrix** — CI now verifies that the bundled daemon source builds natively on macOS, Linux, and Windows, then packages one source-based `.vsix`.
- Publisher rename to `newdlops`.

### Fixed

- Missing platform binaries no longer block Windows/Linux users; the binary is produced locally on first activation when Rust/Cargo is available.

## [0.1.0] — 2026-04-19

Initial release. This is a from-scratch rewrite on a native Rust daemon; no prior public versions exist.

### Added

- **Rust indexer daemon** (`autoimport-daemon`) per platform, with native `tree-sitter` bindings for TypeScript, JavaScript, Python, and Java.
- **Workspace scan** with `rayon` parallel file walking — thousands of files indexed in seconds.
- **Library scan:**
  - TypeScript / JavaScript — reads `package.json` `dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies`, resolves `types` → `typings` → `exports['.'].types` → `main → .d.ts` → `index.d.ts`, also picks up `@types/*` companions.
  - Python — auto-discovers `.venv`, `venv`, `env`, `.env` site-packages; additional paths via `autoImport.libraries.pythonExtraPaths`; depth-limited recursion with `__init__.py` barrel support.
- **Re-export flattening** — `export * from`, `export { X as Y } from`, `export * as NS from`, `from .sub import X` in `__init__.py`.
- **Import insertion with smart merging:**
  - TypeScript: merges into existing named-import blocks, preserves multi-line layout, indent width (tabs / 2-space / 4-space), and trailing-comma style; falls back to a new line when the existing import is default-only, namespace, or when value/type-only keywords mismatch.
  - Python: supports both `from pkg import A, B` and `from pkg import (A, B,)` / multi-line parenthesized forms; preserves paren / indent / trailing-comma style.
  - Java: emits FQCN imports `import com.example.Outer.Inner;`.
- **Persistent cache** at `.vscode/.auto-import-cache/index.bin` (bincode). Loaded on init; flushed on shutdown, after each scan, and every 10 s if dirty. Second-session cold start is <500 ms on a 22k-file repo thanks to mtime-based short-circuit.
- **Python regex fallback** — when `tree-sitter-python` can't parse a file (rare but happens with certain generated code), a lightweight regex extractor still captures top-level `class` / `def` / `async def` / module-level assignments.
- **Single-char class support** (e.g. Django's `Q` and `F`) — the per-package file cap was lifted so deep/alphabetically-late files in large libraries are indexed.
- **Panic isolation** — per-file `catch_unwind` ensures one rogue source file cannot abort the entire scan.
- **Completion item description** (`CompletionItemLabel.description`) always shows the resolved import path — `./user`, `pkg.models`, `fake-lib`, `com.example.Foo`, etc.
- **Commands:** `Show Logs`, `Show Cache Stats`, `Rebuild Workspace Index`, `Daemon Status`, `Restart Daemon`.
- **29 end-to-end tests** covering all 4 languages, library scanning, single-char classes, re-exports, cache reload, and multi-line merging.
- **Cross-platform CI** (`.github/workflows/build.yml`) verifies native daemon source builds on macOS, Linux, and Windows, then produces one `.vsix` containing the daemon source.

### Performance

- 22k-file monorepo scan: **2–4 s** (vs. 18–25 s on the TS/WASM predecessor).
- Warm completion query: **<1 ms**.
- Zero tree-sitter WASM `Aborted()` crashes in our test corpus (previously 5,711 in one session).
