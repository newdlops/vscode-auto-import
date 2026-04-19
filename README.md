# Auto Import Plus

Fast workspace-wide auto-import suggestions for **TypeScript / JavaScript / Python / Java**, powered by a native Rust indexer. Designed for large monorepos where built-in IntelliSense is slow or misses third-party library exports.

## Why

- The built-in TypeScript language server doesn't cover Python or Java imports.
- Pylance/Jedi can be heavy, and their import suggestions often skip `node_modules` / `site-packages` symbols in big repos.
- Many WASM-based auto-import extensions crash on large Python libraries (tree-sitter `Aborted()` panics).

Auto Import Plus builds a small native Rust daemon for your OS on first activation. The daemon indexes your entire workspace **and** its 3rd-party libraries (node_modules, Python site-packages) into a compact symbol table, then serves suggestions in **1–2 ms per keystroke**.

## Features

- **4 languages, one index.** TypeScript (+ TSX / JSX), JavaScript, Python, Java.
- **Library-aware.** Reads your `package.json` dependencies and scans `.venv/venv/env/`-rooted `site-packages` (plus any paths you configure).
- **Smart merging.** When you accept a suggestion, the extension merges into an existing `import { … } from '…'` or `from pkg import …` block — preserving multi-line style, indent width, and trailing-comma style.
- **Filters what you already imported.** Suggestions exclude names already imported in the current file.
- **Re-export flattening.** `export * from './foo'` and `from .foo import Bar` in `__init__.py` barrels are resolved so `Bar` can be imported directly from the barrel.
- **Persistent cache.** Index is saved to `.vscode/.auto-import-cache/index.bin` (bincode) and restored on next launch — sub-second cold start for 20k+ file monorepos after the first session.
- **Safe fallback.** If tree-sitter crashes on a rogue Python file, a regex-based extractor still captures top-level `class` / `def` / assignments.
- **Always-visible source path.** Every suggested item shows `./user`, `fake-lib`, `pkg.models`, or `com.example.Foo` right-aligned next to the label.

## Supported import shapes

| Language | Shape | Example |
|---|---|---|
| TypeScript | `export class/function/const/type/interface/enum/namespace` | `import { User } from './user';` |
| TypeScript | `export default …` | `import DefaultApi from './api';` |
| TypeScript | `export * [as X] from '…'`, `export { A as B } from '…'` | re-exports flattened automatically |
| TypeScript | `.d.ts` ambient declarations | `import { FakeClient } from 'fake-lib';` |
| TypeScript | Type-only | `import type { UserId } from './types';` |
| JavaScript | `export …` declarations | Same as TS |
| Python | top-level `class`, `def`, assignments, `__all__` | `from pkg.models import Account` |
| Python | `__init__.py` re-exports via `from .sub import X` | `from pkg import Account` (barrel) |
| Java | `public class/interface/enum/record` | `import com.example.Foo;` |
| Java | `public static` inner classes | `import com.example.Outer.Inner;` |

## Installation

### From marketplace *(when published)*
Search for **"Auto Import Plus"** in the VS Code extensions view.

### From a `.vsix`

```bash
code --install-extension vscode-auto-import-0.1.1.vsix
```

The first activation compiles the Rust daemon for the current OS/CPU and caches it in VS Code global storage. If `cargo` is not available, the extension downloads official `rustup-init`, installs a minimal Rust toolchain into its own global storage directory, and builds with that managed Cargo.

### Build locally

Requires **Node ≥ 20** and **Rust ≥ 1.75**.

```bash
git clone https://github.com/newdlops/vscode-auto-import.git
cd vscode-auto-import
npm install
npm run build                 # bundles the TS extension into dist/extension.js
npm run daemon:build          # optional: prebuilds the daemon for local dev/e2e
```

Launch with `F5` (Run Extension) using the included `.vscode/launch.json`.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `autoImport.languages` | `[typescript, javascript, python, java]` | Which languages to offer auto-imports for |
| `autoImport.minPrefixLength` | `1` | Minimum typed-prefix length before suggestions appear |
| `autoImport.maxResults` | `20` | Top-N suggestions to return |
| `autoImport.excludeGlobs` | `**/node_modules/**, **/.venv/**, **/venv/**, …` | Paths excluded from the *workspace* scan (libraries are scanned separately) |
| `autoImport.libraries.enabled` | `true` | Master switch for library indexing |
| `autoImport.libraries.tsNodeModules` | `true` | Parse TS/JS dependencies from `node_modules` |
| `autoImport.libraries.pythonSitePackages` | `true` | Auto-discover `.venv / venv / env / .env` site-packages |
| `autoImport.libraries.pythonMaxDepth` | `3` | How deep to recurse inside each Python package |
| `autoImport.libraries.pythonExtraPaths` | `[]` | Additional site-packages directories to scan |
| `autoImport.python.respectAllDunder` | `true` | Respect `__all__` when determining exported names |
| `autoImport.typescript.preferTypeImports` | `auto` | `auto` / `always` / `never` — when to emit `import type` |
| `autoImport.java.includeInnerClasses` | `true` | Index inner public-static classes |
| `autoImport.cache.location` | `workspace` | `workspace` (`.vscode/.auto-import-cache`) or `global` |
| `autoImport.cache.maxDiskMB` | `20` | Advisory upper bound on cache size |
| `autoImport.logLevel` | `info` | `info` or `debug` (debug logs per-file and per-query) |

## Commands

- **Auto Import: Show Logs** — opens the output channel
- **Auto Import: Show Cache Stats** — displays current file/symbol/name counts
- **Auto Import: Rebuild Workspace Index** — drops the in-memory state and rescans
- **Auto Import: Restart Daemon** — terminates the Rust daemon and respawns it (useful after updating the binary)
- **Auto Import: Daemon Status** — returns `{running, lastInit}` (mainly for extension tests)

## Architecture

```
┌──────────────────────────────────────────────┐       ┌──────────────────────────────────┐
│         VS Code Extension (thin client)      │       │    Rust Daemon (autoimport-      │
│                                              │       │     daemon native binary)        │
│  ┌──────────────────────────────┐            │       │                                  │
│  │ DaemonCompletionProvider     │─── query ──┼──────►│  SymbolIndex  (StringTable +     │
│  └──────────────────────────────┘  <─ items ─│       │      HotIndex + PrefixIndex)     │
│  ┌──────────────────────────────┐  indexFile │  ─►   │  tree-sitter (C FFI, native)     │
│  │ DaemonClient (JSON-RPC)      │  removeFile│  ─►   │  Scanner (rayon parallel)        │
│  │   spawn + stdin/stdout       │  scan      │  ─►   │  Library scan (node_modules +    │
│  └──────────────────────────────┘            │       │      site-packages)              │
│  FileSystemWatcher + onDidChange ─ debounced │  ─►   │  Persistence (bincode)           │
└──────────────────────────────────────────────┘       └──────────────────────────────────┘
```

- **IPC** is newline-delimited JSON-RPC over stdio.
- The extension spawns one daemon per workspace. It dies when the extension host exits.
- The daemon uses native `tree-sitter` bindings (no WASM), so `Aborted()` / `memory access out of bounds` crashes from the WASM grammars are gone.
- Incremental edits fire through `onDidChangeTextDocument` → debounced `indexFile` (200 ms). External file changes are picked up via `FileSystemWatcher`.

## Performance

Measured on a 22k-file Python + TypeScript monorepo (MacBook Air M2):

| Phase | V1 (TS + web-tree-sitter) | **V2 (Rust daemon)** |
|---|---|---|
| Cold workspace scan | 18–25 s | **2–4 s** |
| Library scan (10k+ files) | 8–18 s, ~5,700 parse crashes | **3–6 s, 0 crashes** |
| Warm query (1–2 char prefix) | 1–3 ms | **<1 ms** |
| Repeat cold start (cache hit) | full rescan | **<500 ms** (mtime short-circuit) |

## Distribution layout

A published `.vsix` contains:

```
extension/
├── package.json
├── README.md
├── CHANGELOG.md
├── LICENSE
├── resources/
│   └── icon.png
├── daemon/
│   ├── Cargo.toml
│   ├── Cargo.lock
│   └── src/
└── dist/
    └── extension.js
```

No platform daemon binaries are shipped in the VSIX. On first activation the extension runs `cargo build --release --locked` from the bundled `daemon/` source and copies the resulting binary to VS Code global storage, under a versioned `bin/` directory. If no system Cargo is found, it downloads `rustup-init`, verifies its `.sha256` file, and installs a minimal toolchain under the extension's own `CARGO_HOME` and `RUSTUP_HOME`.

## Troubleshooting

- **"native daemon build failed":** run **Auto Import: Show Logs** to inspect the Cargo or rustup error. The extension builds the daemon on first activation.
- **Corporate/offline machines:** the first activation may need access to `static.rust-lang.org` for Rust and `crates.io` for Cargo dependencies unless they are already cached locally.
- **Windows C compiler errors:** rustup installs Rust/Cargo, but native C dependencies may still require Microsoft C++ Build Tools.
- **Suggestions for a freshly installed `pip` package don't appear:** run the command **Auto Import: Rebuild Workspace Index**, or just restart VS Code.
- **Cache seems stale:** delete `.vscode/.auto-import-cache/` and reopen the workspace.
- **"cache save failed: …":** make sure the workspace directory is writable; alternatively set `autoImport.cache.location` to `global`.

## Contributing

The extension has 29 end-to-end tests covering all 4 languages, library scanning, re-export flattening, cache reload, and multi-line import merging.

```bash
npm run build          # bundles the TS extension
npm run daemon:build   # optional: prebuilds the Rust daemon for local dev/e2e
npm run test:e2e       # runs the E2E suite via @vscode/test-electron
npm run icon           # regenerates resources/icon.png
npm run package        # TS + release layout check + vsce package -> .vsix
npm run publish        # same, but uploads to the VS Code marketplace
```

### Release checklist

1. Bump `package.json` `version` + add a CHANGELOG.md entry.
2. Run `npm run verify:release` to ensure the VSIX includes `daemon/` source and excludes prebuilt binaries.
3. `git tag v0.1.x && git push --tags` — the release workflow uploads the `.vsix` as a GitHub release asset.

See [`PLAN.md`](./PLAN.md) for the full internal design document.

## License

MIT — see [LICENSE](./LICENSE).
