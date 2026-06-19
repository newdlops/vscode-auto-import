use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::index::{ExportedSymbol, SymbolFlag, SymbolKind};
use crate::parsers::{ParserBundle, ParserLanguage};

use super::indexer::WorkspaceIndexer;

#[derive(Default)]
pub struct StandardLibraryStats {
    pub typescript: usize,
    pub python: usize,
    pub java: usize,
}

#[derive(Clone, Copy)]
struct StdSymbol {
    name: &'static str,
    kind: SymbolKind,
    flags: u32,
}

struct StdModule {
    qualifier: &'static str,
    module_import: Option<&'static str>,
    symbols: &'static [StdSymbol],
}

pub fn index_standard_libraries(
    indexer: &WorkspaceIndexer,
    languages: &[ParserLanguage],
) -> StandardLibraryStats {
    let mut stats = StandardLibraryStats::default();

    if languages
        .iter()
        .any(|l| matches!(l, ParserLanguage::TypeScript | ParserLanguage::JavaScript))
    {
        stats.typescript = index_modules(indexer, "typescript", "d.ts", NODE_MODULES);
    }
    if languages.contains(&ParserLanguage::Python) {
        stats.python = index_modules(indexer, "python", "py", PYTHON_MODULES);
        stats.python += index_python_runtime_stdlib(indexer);
    }
    if languages.contains(&ParserLanguage::Java) {
        stats.java = index_modules(indexer, "java", "java", JAVA_MODULES);
    }

    stats
}

fn index_modules(
    indexer: &WorkspaceIndexer,
    language_key: &str,
    extension: &str,
    modules: &[StdModule],
) -> usize {
    let mut count = 0usize;
    for module in modules {
        let mut exports =
            Vec::with_capacity(module.symbols.len() + usize::from(module.module_import.is_some()));
        for symbol in module.symbols {
            exports.push(exported(
                symbol.name,
                symbol.kind,
                symbol.flags | SymbolFlag::STANDARD_LIBRARY,
            ));
        }
        if let Some(name) = module.module_import {
            exports.push(exported(
                name,
                SymbolKind::Module,
                SymbolFlag::MODULE_IMPORT | SymbolFlag::STANDARD_LIBRARY,
            ));
        }
        count += exports.len();
        let path = synthetic_path(language_key, module.qualifier, extension);
        indexer.index_synthetic_file(&path, Some(module.qualifier), exports);
    }
    count
}

fn index_python_runtime_stdlib(indexer: &WorkspaceIndexer) -> usize {
    let dirs = discover_python_stdlib_dirs();
    if dirs.is_empty() {
        return 0;
    }

    let mut count = 0usize;
    let mut bundle = ParserBundle::new();
    let mut seen_files: HashSet<PathBuf> = HashSet::new();
    let mut seen_modules: HashSet<String> = HashSet::new();

    for dir in dirs {
        count += scan_python_stdlib_dir(
            indexer,
            &mut bundle,
            &dir,
            &mut seen_files,
            &mut seen_modules,
        );
    }
    indexer.reflatten_all_barrels();
    count
}

fn discover_python_stdlib_dirs() -> Vec<PathBuf> {
    for (cmd, extra_args) in [
        ("python3", &[][..]),
        ("python", &[][..]),
        ("py", &["-3"][..]),
    ] {
        let Some(paths) = query_python_stdlib_dirs(cmd, extra_args) else {
            continue;
        };
        if !paths.is_empty() {
            return paths;
        }
    }
    Vec::new()
}

fn query_python_stdlib_dirs(cmd: &str, extra_args: &[&str]) -> Option<Vec<PathBuf>> {
    let script = concat!(
        "import json, sysconfig\n",
        "paths = []\n",
        "for key in ('stdlib', 'platstdlib'):\n",
        "    path = sysconfig.get_path(key)\n",
        "    if path:\n",
        "        paths.append(path)\n",
        "print(json.dumps(paths))\n",
    );
    let output = Command::new(cmd)
        .args(extra_args)
        .arg("-c")
        .arg(script)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    let parsed: Vec<String> = serde_json::from_str(raw.trim()).ok()?;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for item in parsed {
        let Ok(path) = PathBuf::from(item).canonicalize() else {
            continue;
        };
        if path.is_dir() && seen.insert(path.clone()) {
            out.push(path);
        }
    }
    Some(out)
}

fn scan_python_stdlib_dir(
    indexer: &WorkspaceIndexer,
    bundle: &mut ParserBundle,
    root: &Path,
    seen_files: &mut HashSet<PathBuf>,
    seen_modules: &mut HashSet<String>,
) -> usize {
    let mut count = 0usize;
    let mut stack = vec![(root.to_path_buf(), Vec::<String>::new(), 0usize)];

    while let Some((dir, parts, depth)) = stack.pop() {
        if depth > 8 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if should_skip_python_stdlib_entry(&name) {
                continue;
            }
            let abs = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                let mut next_parts = parts.clone();
                next_parts.push(name);
                stack.push((abs, next_parts, depth + 1));
                continue;
            }
            if !file_type.is_file() || !(name.ends_with(".py") || name.ends_with(".pyi")) {
                continue;
            }
            let Some(module) = python_module_from_file_name(&parts, &name) else {
                continue;
            };
            if module.split('.').count() == 1 && seen_modules.insert(module.clone()) {
                let path = synthetic_path("python-runtime-module", &module, "py");
                indexer.index_synthetic_file(
                    &path,
                    Some(&module),
                    vec![exported(
                        &module,
                        SymbolKind::Module,
                        SymbolFlag::MODULE_IMPORT | SymbolFlag::STANDARD_LIBRARY,
                    )],
                );
                count += 1;
            }

            let canonical = abs.canonicalize().unwrap_or(abs.clone());
            if !seen_files.insert(canonical) {
                continue;
            }
            let path_str = abs.to_string_lossy().to_string();
            if indexer.index_file_disk_with_export_flags(
                bundle,
                &path_str,
                Some(&module),
                SymbolFlag::STANDARD_LIBRARY,
            ) {
                count += 1;
            }
        }
    }

    count
}

fn should_skip_python_stdlib_entry(name: &str) -> bool {
    name.starts_with('.')
        || name == "__pycache__"
        || name == "site-packages"
        || name == "dist-packages"
        || name == "test"
        || name == "tests"
}

fn python_module_from_file_name(parts: &[String], file_name: &str) -> Option<String> {
    let stem = file_name
        .trim_end_matches(".pyi")
        .trim_end_matches(".py");
    let mut module_parts = parts.to_vec();
    if stem != "__init__" {
        if stem == "__main__" {
            return None;
        }
        module_parts.push(stem.to_string());
    }
    if module_parts.is_empty() {
        return None;
    }
    Some(module_parts.join("."))
}

fn exported(name: &str, kind: SymbolKind, flags: u32) -> ExportedSymbol {
    ExportedSymbol {
        name: name.to_string(),
        kind,
        flags,
        parent_qualifier: None,
        source_path: None,
        line: 0,
        col: 0,
    }
}

fn synthetic_path(language_key: &str, qualifier: &str, extension: &str) -> String {
    let mut safe = String::with_capacity(qualifier.len());
    for ch in qualifier.chars() {
        if ch.is_ascii_alphanumeric() {
            safe.push(ch);
        } else {
            safe.push('_');
        }
    }
    format!(
        "$auto-import-stdlib/{}/{}.{}",
        language_key, safe, extension
    )
}

const fn sym(name: &'static str, kind: SymbolKind) -> StdSymbol {
    StdSymbol {
        name,
        kind,
        flags: SymbolFlag::NONE,
    }
}

const PYTHON_MODULES: &[StdModule] = &[
    StdModule {
        qualifier: "abc",
        module_import: Some("abc"),
        symbols: &[
            sym("ABC", SymbolKind::Class),
            sym("abstractmethod", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "argparse",
        module_import: Some("argparse"),
        symbols: &[
            sym("ArgumentParser", SymbolKind::Class),
            sym("Namespace", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "asyncio",
        module_import: Some("asyncio"),
        symbols: &[
            sym("Queue", SymbolKind::Class),
            sym("Task", SymbolKind::Class),
            sym("Event", SymbolKind::Class),
            sym("Lock", SymbolKind::Class),
            sym("Semaphore", SymbolKind::Class),
            sym("create_task", SymbolKind::Function),
            sym("gather", SymbolKind::Function),
            sym("run", SymbolKind::Function),
            sym("sleep", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "collections",
        module_import: Some("collections"),
        symbols: &[
            sym("Counter", SymbolKind::Class),
            sym("defaultdict", SymbolKind::Class),
            sym("deque", SymbolKind::Class),
            sym("OrderedDict", SymbolKind::Class),
            sym("ChainMap", SymbolKind::Class),
            sym("namedtuple", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "collections.abc",
        module_import: None,
        symbols: &[
            sym("Iterable", SymbolKind::Class),
            sym("Iterator", SymbolKind::Class),
            sym("Mapping", SymbolKind::Class),
            sym("MutableMapping", SymbolKind::Class),
            sym("Sequence", SymbolKind::Class),
            sym("MutableSequence", SymbolKind::Class),
            sym("Set", SymbolKind::Class),
            sym("Callable", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "contextlib",
        module_import: Some("contextlib"),
        symbols: &[
            sym("ExitStack", SymbolKind::Class),
            sym("AsyncExitStack", SymbolKind::Class),
            sym("contextmanager", SymbolKind::Function),
            sym("asynccontextmanager", SymbolKind::Function),
            sym("suppress", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "concurrent.futures",
        module_import: None,
        symbols: &[
            sym("Executor", SymbolKind::Class),
            sym("Future", SymbolKind::Class),
            sym("ThreadPoolExecutor", SymbolKind::Class),
            sym("ProcessPoolExecutor", SymbolKind::Class),
            sym("as_completed", SymbolKind::Function),
            sym("wait", SymbolKind::Function),
            sym("FIRST_COMPLETED", SymbolKind::Variable),
            sym("FIRST_EXCEPTION", SymbolKind::Variable),
            sym("ALL_COMPLETED", SymbolKind::Variable),
        ],
    },
    StdModule {
        qualifier: "configparser",
        module_import: Some("configparser"),
        symbols: &[
            sym("ConfigParser", SymbolKind::Class),
            sym("RawConfigParser", SymbolKind::Class),
            sym("SectionProxy", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "copy",
        module_import: Some("copy"),
        symbols: &[sym("deepcopy", SymbolKind::Function)],
    },
    StdModule {
        qualifier: "csv",
        module_import: Some("csv"),
        symbols: &[
            sym("DictReader", SymbolKind::Class),
            sym("DictWriter", SymbolKind::Class),
            sym("reader", SymbolKind::Function),
            sym("writer", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "dataclasses",
        module_import: Some("dataclasses"),
        symbols: &[
            sym("InitVar", SymbolKind::Class),
            sym("dataclass", SymbolKind::Function),
            sym("field", SymbolKind::Function),
            sym("fields", SymbolKind::Function),
            sym("asdict", SymbolKind::Function),
            sym("astuple", SymbolKind::Function),
            sym("replace", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "datetime",
        module_import: Some("datetime"),
        symbols: &[
            sym("date", SymbolKind::Class),
            sym("datetime", SymbolKind::Class),
            sym("time", SymbolKind::Class),
            sym("timedelta", SymbolKind::Class),
            sym("timezone", SymbolKind::Class),
            sym("tzinfo", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "decimal",
        module_import: Some("decimal"),
        symbols: &[sym("Decimal", SymbolKind::Class)],
    },
    StdModule {
        qualifier: "enum",
        module_import: Some("enum"),
        symbols: &[
            sym("Enum", SymbolKind::Class),
            sym("IntEnum", SymbolKind::Class),
            sym("StrEnum", SymbolKind::Class),
            sym("Flag", SymbolKind::Class),
            sym("auto", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "email.message",
        module_import: None,
        symbols: &[
            sym("EmailMessage", SymbolKind::Class),
            sym("Message", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "functools",
        module_import: Some("functools"),
        symbols: &[
            sym("cached_property", SymbolKind::Class),
            sym("lru_cache", SymbolKind::Function),
            sym("partial", SymbolKind::Function),
            sym("wraps", SymbolKind::Function),
            sym("reduce", SymbolKind::Function),
            sym("singledispatch", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "hashlib",
        module_import: Some("hashlib"),
        symbols: &[
            sym("sha256", SymbolKind::Function),
            sym("sha1", SymbolKind::Function),
            sym("md5", SymbolKind::Function),
            sym("blake2b", SymbolKind::Function),
            sym("blake2s", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "http.client",
        module_import: None,
        symbols: &[
            sym("HTTPConnection", SymbolKind::Class),
            sym("HTTPSConnection", SymbolKind::Class),
            sym("HTTPResponse", SymbolKind::Class),
            sym("HTTPException", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "http.server",
        module_import: None,
        symbols: &[
            sym("HTTPServer", SymbolKind::Class),
            sym("BaseHTTPRequestHandler", SymbolKind::Class),
            sym("SimpleHTTPRequestHandler", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "heapq",
        module_import: Some("heapq"),
        symbols: &[
            sym("heappush", SymbolKind::Function),
            sym("heappop", SymbolKind::Function),
            sym("heapify", SymbolKind::Function),
            sym("nlargest", SymbolKind::Function),
            sym("nsmallest", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "inspect",
        module_import: Some("inspect"),
        symbols: &[
            sym("signature", SymbolKind::Function),
            sym("isclass", SymbolKind::Function),
            sym("isfunction", SymbolKind::Function),
            sym("getmembers", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "itertools",
        module_import: Some("itertools"),
        symbols: &[
            sym("chain", SymbolKind::Function),
            sym("combinations", SymbolKind::Function),
            sym("permutations", SymbolKind::Function),
            sym("product", SymbolKind::Function),
            sym("cycle", SymbolKind::Function),
            sym("repeat", SymbolKind::Function),
            sym("count", SymbolKind::Function),
            sym("islice", SymbolKind::Function),
            sym("groupby", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "json",
        module_import: Some("json"),
        symbols: &[
            sym("JSONDecoder", SymbolKind::Class),
            sym("JSONEncoder", SymbolKind::Class),
            sym("load", SymbolKind::Function),
            sym("loads", SymbolKind::Function),
            sym("dump", SymbolKind::Function),
            sym("dumps", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "logging",
        module_import: Some("logging"),
        symbols: &[
            sym("Logger", SymbolKind::Class),
            sym("StreamHandler", SymbolKind::Class),
            sym("Formatter", SymbolKind::Class),
            sym("getLogger", SymbolKind::Function),
            sym("basicConfig", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "math",
        module_import: Some("math"),
        symbols: &[
            sym("sqrt", SymbolKind::Function),
            sym("ceil", SymbolKind::Function),
            sym("floor", SymbolKind::Function),
            sym("sin", SymbolKind::Function),
            sym("cos", SymbolKind::Function),
            sym("pi", SymbolKind::Variable),
            sym("inf", SymbolKind::Variable),
            sym("isnan", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "os",
        module_import: Some("os"),
        symbols: &[
            sym("PathLike", SymbolKind::Class),
            sym("environ", SymbolKind::Variable),
            sym("getenv", SymbolKind::Function),
            sym("makedirs", SymbolKind::Function),
            sym("walk", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "pathlib",
        module_import: Some("pathlib"),
        symbols: &[
            sym("Path", SymbolKind::Class),
            sym("PurePath", SymbolKind::Class),
            sym("PurePosixPath", SymbolKind::Class),
            sym("PureWindowsPath", SymbolKind::Class),
            sym("PosixPath", SymbolKind::Class),
            sym("WindowsPath", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "pprint",
        module_import: Some("pprint"),
        symbols: &[
            sym("pprint", SymbolKind::Function),
            sym("pformat", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "queue",
        module_import: Some("queue"),
        symbols: &[
            sym("Queue", SymbolKind::Class),
            sym("LifoQueue", SymbolKind::Class),
            sym("PriorityQueue", SymbolKind::Class),
            sym("Empty", SymbolKind::Class),
            sym("Full", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "random",
        module_import: Some("random"),
        symbols: &[
            sym("Random", SymbolKind::Class),
            sym("randint", SymbolKind::Function),
            sym("choice", SymbolKind::Function),
            sym("choices", SymbolKind::Function),
            sym("shuffle", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "re",
        module_import: Some("re"),
        symbols: &[
            sym("Pattern", SymbolKind::Class),
            sym("Match", SymbolKind::Class),
            sym("compile", SymbolKind::Function),
            sym("search", SymbolKind::Function),
            sym("match", SymbolKind::Function),
            sym("fullmatch", SymbolKind::Function),
            sym("sub", SymbolKind::Function),
            sym("findall", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "shutil",
        module_import: Some("shutil"),
        symbols: &[
            sym("copyfile", SymbolKind::Function),
            sym("copytree", SymbolKind::Function),
            sym("rmtree", SymbolKind::Function),
            sym("move", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "sqlite3",
        module_import: Some("sqlite3"),
        symbols: &[
            sym("Connection", SymbolKind::Class),
            sym("Cursor", SymbolKind::Class),
            sym("Row", SymbolKind::Class),
            sym("connect", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "statistics",
        module_import: Some("statistics"),
        symbols: &[
            sym("mean", SymbolKind::Function),
            sym("median", SymbolKind::Function),
            sym("mode", SymbolKind::Function),
            sym("stdev", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "subprocess",
        module_import: Some("subprocess"),
        symbols: &[
            sym("Popen", SymbolKind::Class),
            sym("CalledProcessError", SymbolKind::Class),
            sym("CompletedProcess", SymbolKind::Class),
            sym("PIPE", SymbolKind::Variable),
            sym("run", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "sys",
        module_import: Some("sys"),
        symbols: &[
            sym("argv", SymbolKind::Variable),
            sym("path", SymbolKind::Variable),
            sym("stderr", SymbolKind::Variable),
            sym("stdout", SymbolKind::Variable),
            sym("stdin", SymbolKind::Variable),
            sym("exit", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "tempfile",
        module_import: Some("tempfile"),
        symbols: &[
            sym("TemporaryDirectory", SymbolKind::Class),
            sym("NamedTemporaryFile", SymbolKind::Function),
            sym("mkdtemp", SymbolKind::Function),
            sym("mkstemp", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "threading",
        module_import: Some("threading"),
        symbols: &[
            sym("Thread", SymbolKind::Class),
            sym("Lock", SymbolKind::Function),
            sym("RLock", SymbolKind::Function),
            sym("Event", SymbolKind::Class),
            sym("Condition", SymbolKind::Class),
            sym("Semaphore", SymbolKind::Class),
            sym("Timer", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "time",
        module_import: Some("time"),
        symbols: &[
            sym("sleep", SymbolKind::Function),
            sym("time", SymbolKind::Function),
            sym("monotonic", SymbolKind::Function),
            sym("perf_counter", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "typing",
        module_import: Some("typing"),
        symbols: &[
            sym("Any", SymbolKind::TypeAlias),
            sym("Callable", SymbolKind::TypeAlias),
            sym("Dict", SymbolKind::TypeAlias),
            sym("List", SymbolKind::TypeAlias),
            sym("Optional", SymbolKind::TypeAlias),
            sym("Union", SymbolKind::TypeAlias),
            sym("TypeVar", SymbolKind::Function),
            sym("Generic", SymbolKind::Class),
            sym("Iterable", SymbolKind::TypeAlias),
            sym("Iterator", SymbolKind::TypeAlias),
            sym("Mapping", SymbolKind::TypeAlias),
            sym("Sequence", SymbolKind::TypeAlias),
            sym("Protocol", SymbolKind::Class),
            sym("Literal", SymbolKind::TypeAlias),
            sym("TypedDict", SymbolKind::Class),
            sym("Self", SymbolKind::TypeAlias),
            sym("Final", SymbolKind::TypeAlias),
            sym("ClassVar", SymbolKind::TypeAlias),
            sym("overload", SymbolKind::Function),
            sym("cast", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "unittest",
        module_import: Some("unittest"),
        symbols: &[sym("TestCase", SymbolKind::Class)],
    },
    StdModule {
        qualifier: "unittest.mock",
        module_import: None,
        symbols: &[
            sym("Mock", SymbolKind::Class),
            sym("MagicMock", SymbolKind::Class),
            sym("patch", SymbolKind::Function),
            sym("call", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "urllib.parse",
        module_import: None,
        symbols: &[
            sym("urlparse", SymbolKind::Function),
            sym("urlencode", SymbolKind::Function),
            sym("quote", SymbolKind::Function),
            sym("unquote", SymbolKind::Function),
            sym("urljoin", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "urllib.request",
        module_import: None,
        symbols: &[
            sym("Request", SymbolKind::Class),
            sym("OpenerDirector", SymbolKind::Class),
            sym("urlopen", SymbolKind::Function),
            sym("urlretrieve", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "xml.etree.ElementTree",
        module_import: None,
        symbols: &[
            sym("Element", SymbolKind::Class),
            sym("ElementTree", SymbolKind::Class),
            sym("ParseError", SymbolKind::Class),
            sym("SubElement", SymbolKind::Function),
            sym("parse", SymbolKind::Function),
            sym("fromstring", SymbolKind::Function),
            sym("tostring", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "uuid",
        module_import: Some("uuid"),
        symbols: &[
            sym("UUID", SymbolKind::Class),
            sym("uuid4", SymbolKind::Function),
            sym("uuid5", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "warnings",
        module_import: Some("warnings"),
        symbols: &[sym("warn", SymbolKind::Function)],
    },
    StdModule {
        qualifier: "weakref",
        module_import: Some("weakref"),
        symbols: &[
            sym("ref", SymbolKind::Function),
            sym("WeakKeyDictionary", SymbolKind::Class),
            sym("WeakValueDictionary", SymbolKind::Class),
        ],
    },
];

const JAVA_MODULES: &[StdModule] = &[
    StdModule {
        qualifier: "java.io",
        module_import: None,
        symbols: &[
            sym("File", SymbolKind::Class),
            sym("IOException", SymbolKind::Class),
            sym("InputStream", SymbolKind::Class),
            sym("OutputStream", SymbolKind::Class),
            sym("FileInputStream", SymbolKind::Class),
            sym("FileOutputStream", SymbolKind::Class),
            sym("BufferedReader", SymbolKind::Class),
            sym("BufferedWriter", SymbolKind::Class),
            sym("InputStreamReader", SymbolKind::Class),
            sym("OutputStreamWriter", SymbolKind::Class),
            sym("PrintWriter", SymbolKind::Class),
            sym("Serializable", SymbolKind::Interface),
        ],
    },
    StdModule {
        qualifier: "java.math",
        module_import: None,
        symbols: &[
            sym("BigDecimal", SymbolKind::Class),
            sym("BigInteger", SymbolKind::Class),
            sym("MathContext", SymbolKind::Class),
            sym("RoundingMode", SymbolKind::Enum),
        ],
    },
    StdModule {
        qualifier: "java.net",
        module_import: None,
        symbols: &[
            sym("URL", SymbolKind::Class),
            sym("URI", SymbolKind::Class),
            sym("HttpURLConnection", SymbolKind::Class),
            sym("Socket", SymbolKind::Class),
            sym("ServerSocket", SymbolKind::Class),
            sym("InetAddress", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "java.lang.annotation",
        module_import: None,
        symbols: &[
            sym("Annotation", SymbolKind::Interface),
            sym("Documented", SymbolKind::Interface),
            sym("ElementType", SymbolKind::Enum),
            sym("Retention", SymbolKind::Interface),
            sym("RetentionPolicy", SymbolKind::Enum),
            sym("Target", SymbolKind::Interface),
        ],
    },
    StdModule {
        qualifier: "java.lang.reflect",
        module_import: None,
        symbols: &[
            sym("Constructor", SymbolKind::Class),
            sym("Field", SymbolKind::Class),
            sym("InvocationHandler", SymbolKind::Interface),
            sym("InvocationTargetException", SymbolKind::Class),
            sym("Method", SymbolKind::Class),
            sym("Modifier", SymbolKind::Class),
            sym("ParameterizedType", SymbolKind::Interface),
            sym("Proxy", SymbolKind::Class),
            sym("Type", SymbolKind::Interface),
        ],
    },
    StdModule {
        qualifier: "java.net.http",
        module_import: None,
        symbols: &[
            sym("HttpClient", SymbolKind::Class),
            sym("HttpRequest", SymbolKind::Class),
            sym("HttpResponse", SymbolKind::Interface),
            sym("WebSocket", SymbolKind::Interface),
        ],
    },
    StdModule {
        qualifier: "java.nio",
        module_import: None,
        symbols: &[
            sym("ByteBuffer", SymbolKind::Class),
            sym("CharBuffer", SymbolKind::Class),
            sym("DoubleBuffer", SymbolKind::Class),
            sym("FloatBuffer", SymbolKind::Class),
            sym("IntBuffer", SymbolKind::Class),
            sym("LongBuffer", SymbolKind::Class),
            sym("ShortBuffer", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "java.nio.channels",
        module_import: None,
        symbols: &[
            sym("FileChannel", SymbolKind::Class),
            sym("ServerSocketChannel", SymbolKind::Class),
            sym("SocketChannel", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "java.nio.charset",
        module_import: None,
        symbols: &[
            sym("Charset", SymbolKind::Class),
            sym("StandardCharsets", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "java.nio.file",
        module_import: None,
        symbols: &[
            sym("Path", SymbolKind::Interface),
            sym("Paths", SymbolKind::Class),
            sym("Files", SymbolKind::Class),
            sym("StandardOpenOption", SymbolKind::Enum),
            sym("WatchService", SymbolKind::Interface),
        ],
    },
    StdModule {
        qualifier: "java.nio.file.attribute",
        module_import: None,
        symbols: &[
            sym("BasicFileAttributes", SymbolKind::Interface),
            sym("FileTime", SymbolKind::Class),
            sym("PosixFilePermission", SymbolKind::Enum),
        ],
    },
    StdModule {
        qualifier: "java.security",
        module_import: None,
        symbols: &[
            sym("MessageDigest", SymbolKind::Class),
            sym("SecureRandom", SymbolKind::Class),
            sym("KeyPair", SymbolKind::Class),
            sym("KeyPairGenerator", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "java.sql",
        module_import: None,
        symbols: &[
            sym("Connection", SymbolKind::Interface),
            sym("DriverManager", SymbolKind::Class),
            sym("PreparedStatement", SymbolKind::Interface),
            sym("ResultSet", SymbolKind::Interface),
            sym("SQLException", SymbolKind::Class),
            sym("Statement", SymbolKind::Interface),
        ],
    },
    StdModule {
        qualifier: "java.text",
        module_import: None,
        symbols: &[
            sym("SimpleDateFormat", SymbolKind::Class),
            sym("DecimalFormat", SymbolKind::Class),
            sym("ParseException", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "java.time",
        module_import: None,
        symbols: &[
            sym("LocalDate", SymbolKind::Class),
            sym("LocalDateTime", SymbolKind::Class),
            sym("LocalTime", SymbolKind::Class),
            sym("ZonedDateTime", SymbolKind::Class),
            sym("Instant", SymbolKind::Class),
            sym("Duration", SymbolKind::Class),
            sym("Period", SymbolKind::Class),
            sym("ZoneId", SymbolKind::Class),
            sym("OffsetDateTime", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "java.time.format",
        module_import: None,
        symbols: &[
            sym("DateTimeFormatter", SymbolKind::Class),
            sym("DateTimeParseException", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "java.util",
        module_import: None,
        symbols: &[
            sym("ArrayDeque", SymbolKind::Class),
            sym("ArrayList", SymbolKind::Class),
            sym("Arrays", SymbolKind::Class),
            sym("Base64", SymbolKind::Class),
            sym("BitSet", SymbolKind::Class),
            sym("Calendar", SymbolKind::Class),
            sym("Collections", SymbolKind::Class),
            sym("Comparator", SymbolKind::Interface),
            sym("Currency", SymbolKind::Class),
            sym("Date", SymbolKind::Class),
            sym("Deque", SymbolKind::Interface),
            sym("EnumMap", SymbolKind::Class),
            sym("EnumSet", SymbolKind::Class),
            sym("HashMap", SymbolKind::Class),
            sym("HashSet", SymbolKind::Class),
            sym("Iterator", SymbolKind::Interface),
            sym("LinkedHashMap", SymbolKind::Class),
            sym("LinkedHashSet", SymbolKind::Class),
            sym("LinkedList", SymbolKind::Class),
            sym("List", SymbolKind::Interface),
            sym("Locale", SymbolKind::Class),
            sym("Map", SymbolKind::Interface),
            sym("Objects", SymbolKind::Class),
            sym("Optional", SymbolKind::Class),
            sym("OptionalDouble", SymbolKind::Class),
            sym("OptionalInt", SymbolKind::Class),
            sym("OptionalLong", SymbolKind::Class),
            sym("PriorityQueue", SymbolKind::Class),
            sym("Properties", SymbolKind::Class),
            sym("Queue", SymbolKind::Interface),
            sym("Random", SymbolKind::Class),
            sym("ResourceBundle", SymbolKind::Class),
            sym("Scanner", SymbolKind::Class),
            sym("Set", SymbolKind::Interface),
            sym("SplittableRandom", SymbolKind::Class),
            sym("StringJoiner", SymbolKind::Class),
            sym("StringTokenizer", SymbolKind::Class),
            sym("Timer", SymbolKind::Class),
            sym("TimerTask", SymbolKind::Class),
            sym("TreeMap", SymbolKind::Class),
            sym("TreeSet", SymbolKind::Class),
            sym("UUID", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "java.util.concurrent",
        module_import: None,
        symbols: &[
            sym("BlockingQueue", SymbolKind::Interface),
            sym("Callable", SymbolKind::Interface),
            sym("CompletableFuture", SymbolKind::Class),
            sym("ConcurrentHashMap", SymbolKind::Class),
            sym("ConcurrentLinkedDeque", SymbolKind::Class),
            sym("ConcurrentLinkedQueue", SymbolKind::Class),
            sym("CountDownLatch", SymbolKind::Class),
            sym("CopyOnWriteArrayList", SymbolKind::Class),
            sym("CopyOnWriteArraySet", SymbolKind::Class),
            sym("Executor", SymbolKind::Interface),
            sym("ExecutorService", SymbolKind::Interface),
            sym("Executors", SymbolKind::Class),
            sym("Future", SymbolKind::Interface),
            sym("LinkedBlockingQueue", SymbolKind::Class),
            sym("ScheduledExecutorService", SymbolKind::Interface),
            sym("ScheduledFuture", SymbolKind::Interface),
            sym("Semaphore", SymbolKind::Class),
            sym("ThreadFactory", SymbolKind::Interface),
            sym("TimeUnit", SymbolKind::Enum),
        ],
    },
    StdModule {
        qualifier: "java.util.concurrent.atomic",
        module_import: None,
        symbols: &[
            sym("AtomicBoolean", SymbolKind::Class),
            sym("AtomicInteger", SymbolKind::Class),
            sym("AtomicLong", SymbolKind::Class),
            sym("AtomicReference", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "java.util.concurrent.locks",
        module_import: None,
        symbols: &[
            sym("Condition", SymbolKind::Interface),
            sym("Lock", SymbolKind::Interface),
            sym("ReadWriteLock", SymbolKind::Interface),
            sym("ReentrantLock", SymbolKind::Class),
            sym("ReentrantReadWriteLock", SymbolKind::Class),
            sym("StampedLock", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "java.util.function",
        module_import: None,
        symbols: &[
            sym("BiConsumer", SymbolKind::Interface),
            sym("BiFunction", SymbolKind::Interface),
            sym("BinaryOperator", SymbolKind::Interface),
            sym("Consumer", SymbolKind::Interface),
            sym("Function", SymbolKind::Interface),
            sym("Predicate", SymbolKind::Interface),
            sym("Supplier", SymbolKind::Interface),
            sym("UnaryOperator", SymbolKind::Interface),
        ],
    },
    StdModule {
        qualifier: "java.util.regex",
        module_import: None,
        symbols: &[
            sym("Matcher", SymbolKind::Class),
            sym("Pattern", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "java.util.stream",
        module_import: None,
        symbols: &[
            sym("Collectors", SymbolKind::Class),
            sym("DoubleStream", SymbolKind::Interface),
            sym("IntStream", SymbolKind::Interface),
            sym("LongStream", SymbolKind::Interface),
            sym("Stream", SymbolKind::Interface),
        ],
    },
    StdModule {
        qualifier: "java.util.jar",
        module_import: None,
        symbols: &[
            sym("JarEntry", SymbolKind::Class),
            sym("JarFile", SymbolKind::Class),
            sym("JarInputStream", SymbolKind::Class),
            sym("JarOutputStream", SymbolKind::Class),
            sym("Manifest", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "java.util.zip",
        module_import: None,
        symbols: &[
            sym("GZIPInputStream", SymbolKind::Class),
            sym("GZIPOutputStream", SymbolKind::Class),
            sym("ZipEntry", SymbolKind::Class),
            sym("ZipFile", SymbolKind::Class),
            sym("ZipInputStream", SymbolKind::Class),
            sym("ZipOutputStream", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "javax.crypto",
        module_import: None,
        symbols: &[
            sym("Cipher", SymbolKind::Class),
            sym("SecretKey", SymbolKind::Interface),
        ],
    },
    StdModule {
        qualifier: "javax.net.ssl",
        module_import: None,
        symbols: &[
            sym("HttpsURLConnection", SymbolKind::Class),
            sym("SSLContext", SymbolKind::Class),
            sym("SSLEngine", SymbolKind::Class),
            sym("SSLServerSocketFactory", SymbolKind::Class),
            sym("SSLSocketFactory", SymbolKind::Class),
            sym("TrustManager", SymbolKind::Interface),
        ],
    },
    StdModule {
        qualifier: "javax.xml.parsers",
        module_import: None,
        symbols: &[
            sym("DocumentBuilder", SymbolKind::Class),
            sym("DocumentBuilderFactory", SymbolKind::Class),
            sym("ParserConfigurationException", SymbolKind::Class),
            sym("SAXParser", SymbolKind::Class),
            sym("SAXParserFactory", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "org.w3c.dom",
        module_import: None,
        symbols: &[
            sym("Document", SymbolKind::Interface),
            sym("Element", SymbolKind::Interface),
            sym("NamedNodeMap", SymbolKind::Interface),
            sym("Node", SymbolKind::Interface),
            sym("NodeList", SymbolKind::Interface),
        ],
    },
    StdModule {
        qualifier: "org.xml.sax",
        module_import: None,
        symbols: &[
            sym("Attributes", SymbolKind::Interface),
            sym("InputSource", SymbolKind::Class),
            sym("SAXException", SymbolKind::Class),
            sym("XMLReader", SymbolKind::Interface),
        ],
    },
];

const NODE_MODULES: &[StdModule] = &[
    StdModule {
        qualifier: "node:assert/strict",
        module_import: None,
        symbols: &[
            sym("AssertionError", SymbolKind::Class),
            sym("deepEqual", SymbolKind::Function),
            sym("equal", SymbolKind::Function),
            sym("fail", SymbolKind::Function),
            sym("notEqual", SymbolKind::Function),
            sym("ok", SymbolKind::Function),
            sym("rejects", SymbolKind::Function),
            sym("strictEqual", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:buffer",
        module_import: Some("buffer"),
        symbols: &[sym("Buffer", SymbolKind::Class)],
    },
    StdModule {
        qualifier: "node:child_process",
        module_import: Some("child_process"),
        symbols: &[
            sym("exec", SymbolKind::Function),
            sym("execFile", SymbolKind::Function),
            sym("fork", SymbolKind::Function),
            sym("spawn", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:cluster",
        module_import: Some("cluster"),
        symbols: &[
            sym("Worker", SymbolKind::Class),
            sym("disconnect", SymbolKind::Function),
            sym("fork", SymbolKind::Function),
            sym("isPrimary", SymbolKind::Variable),
            sym("isWorker", SymbolKind::Variable),
        ],
    },
    StdModule {
        qualifier: "node:crypto",
        module_import: Some("crypto"),
        symbols: &[
            sym("createHash", SymbolKind::Function),
            sym("createHmac", SymbolKind::Function),
            sym("randomBytes", SymbolKind::Function),
            sym("randomUUID", SymbolKind::Function),
            sym("timingSafeEqual", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:dns",
        module_import: Some("dns"),
        symbols: &[
            sym("lookup", SymbolKind::Function),
            sym("resolve", SymbolKind::Function),
            sym("resolve4", SymbolKind::Function),
            sym("resolve6", SymbolKind::Function),
            sym("reverse", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:dns/promises",
        module_import: None,
        symbols: &[
            sym("lookup", SymbolKind::Function),
            sym("resolve", SymbolKind::Function),
            sym("resolve4", SymbolKind::Function),
            sym("resolve6", SymbolKind::Function),
            sym("reverse", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:events",
        module_import: Some("events"),
        symbols: &[
            sym("EventEmitter", SymbolKind::Class),
            sym("once", SymbolKind::Function),
            sym("on", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:fs",
        module_import: Some("fs"),
        symbols: &[
            sym("createReadStream", SymbolKind::Function),
            sym("createWriteStream", SymbolKind::Function),
            sym("existsSync", SymbolKind::Function),
            sym("mkdirSync", SymbolKind::Function),
            sym("promises", SymbolKind::Variable),
            sym("readFileSync", SymbolKind::Function),
            sym("readdirSync", SymbolKind::Function),
            sym("statSync", SymbolKind::Function),
            sym("watch", SymbolKind::Function),
            sym("writeFileSync", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:fs/promises",
        module_import: None,
        symbols: &[
            sym("access", SymbolKind::Function),
            sym("cp", SymbolKind::Function),
            sym("mkdir", SymbolKind::Function),
            sym("readFile", SymbolKind::Function),
            sym("readdir", SymbolKind::Function),
            sym("rename", SymbolKind::Function),
            sym("rm", SymbolKind::Function),
            sym("stat", SymbolKind::Function),
            sym("writeFile", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:http2",
        module_import: Some("http2"),
        symbols: &[
            sym("Http2ServerRequest", SymbolKind::Class),
            sym("Http2ServerResponse", SymbolKind::Class),
            sym("connect", SymbolKind::Function),
            sym("createSecureServer", SymbolKind::Function),
            sym("createServer", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:http",
        module_import: Some("http"),
        symbols: &[
            sym("IncomingMessage", SymbolKind::Class),
            sym("Server", SymbolKind::Class),
            sym("ServerResponse", SymbolKind::Class),
            sym("createServer", SymbolKind::Function),
            sym("get", SymbolKind::Function),
            sym("request", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:https",
        module_import: Some("https"),
        symbols: &[
            sym("createServer", SymbolKind::Function),
            sym("get", SymbolKind::Function),
            sym("request", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:os",
        module_import: Some("os"),
        symbols: &[
            sym("EOL", SymbolKind::Variable),
            sym("arch", SymbolKind::Function),
            sym("cpus", SymbolKind::Function),
            sym("homedir", SymbolKind::Function),
            sym("hostname", SymbolKind::Function),
            sym("platform", SymbolKind::Function),
            sym("tmpdir", SymbolKind::Function),
            sym("userInfo", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:module",
        module_import: Some("module"),
        symbols: &[
            sym("Module", SymbolKind::Class),
            sym("builtinModules", SymbolKind::Variable),
            sym("createRequire", SymbolKind::Function),
            sym("isBuiltin", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:net",
        module_import: Some("net"),
        symbols: &[
            sym("Server", SymbolKind::Class),
            sym("Socket", SymbolKind::Class),
            sym("connect", SymbolKind::Function),
            sym("createConnection", SymbolKind::Function),
            sym("createServer", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:path",
        module_import: Some("path"),
        symbols: &[
            sym("basename", SymbolKind::Function),
            sym("delimiter", SymbolKind::Variable),
            sym("dirname", SymbolKind::Function),
            sym("extname", SymbolKind::Function),
            sym("format", SymbolKind::Function),
            sym("join", SymbolKind::Function),
            sym("normalize", SymbolKind::Function),
            sym("parse", SymbolKind::Function),
            sym("relative", SymbolKind::Function),
            sym("resolve", SymbolKind::Function),
            sym("sep", SymbolKind::Variable),
        ],
    },
    StdModule {
        qualifier: "node:readline",
        module_import: Some("readline"),
        symbols: &[
            sym("Interface", SymbolKind::Class),
            sym("createInterface", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:readline/promises",
        module_import: None,
        symbols: &[sym("createInterface", SymbolKind::Function)],
    },
    StdModule {
        qualifier: "node:process",
        module_import: Some("process"),
        symbols: &[
            sym("argv", SymbolKind::Variable),
            sym("cwd", SymbolKind::Function),
            sym("env", SymbolKind::Variable),
            sym("exit", SymbolKind::Function),
            sym("nextTick", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:querystring",
        module_import: Some("querystring"),
        symbols: &[
            sym("escape", SymbolKind::Function),
            sym("parse", SymbolKind::Function),
            sym("stringify", SymbolKind::Function),
            sym("unescape", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:stream",
        module_import: Some("stream"),
        symbols: &[
            sym("PassThrough", SymbolKind::Class),
            sym("Readable", SymbolKind::Class),
            sym("Transform", SymbolKind::Class),
            sym("Writable", SymbolKind::Class),
            sym("finished", SymbolKind::Function),
            sym("pipeline", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:stream/promises",
        module_import: None,
        symbols: &[
            sym("finished", SymbolKind::Function),
            sym("pipeline", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:stream/web",
        module_import: None,
        symbols: &[
            sym("ReadableStream", SymbolKind::Class),
            sym("TransformStream", SymbolKind::Class),
            sym("WritableStream", SymbolKind::Class),
        ],
    },
    StdModule {
        qualifier: "node:string_decoder",
        module_import: Some("string_decoder"),
        symbols: &[sym("StringDecoder", SymbolKind::Class)],
    },
    StdModule {
        qualifier: "node:test",
        module_import: Some("test"),
        symbols: &[
            sym("after", SymbolKind::Function),
            sym("before", SymbolKind::Function),
            sym("describe", SymbolKind::Function),
            sym("it", SymbolKind::Function),
            sym("mock", SymbolKind::Variable),
            sym("test", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:timers",
        module_import: Some("timers"),
        symbols: &[
            sym("clearImmediate", SymbolKind::Function),
            sym("clearInterval", SymbolKind::Function),
            sym("clearTimeout", SymbolKind::Function),
            sym("setImmediate", SymbolKind::Function),
            sym("setInterval", SymbolKind::Function),
            sym("setTimeout", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:timers/promises",
        module_import: None,
        symbols: &[
            sym("setImmediate", SymbolKind::Function),
            sym("setInterval", SymbolKind::Function),
            sym("setTimeout", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:tls",
        module_import: Some("tls"),
        symbols: &[
            sym("TLSSocket", SymbolKind::Class),
            sym("connect", SymbolKind::Function),
            sym("createSecureContext", SymbolKind::Function),
            sym("createServer", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:url",
        module_import: Some("url"),
        symbols: &[
            sym("URL", SymbolKind::Class),
            sym("URLSearchParams", SymbolKind::Class),
            sym("fileURLToPath", SymbolKind::Function),
            sym("pathToFileURL", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:util",
        module_import: Some("util"),
        symbols: &[
            sym("debuglog", SymbolKind::Function),
            sym("inherits", SymbolKind::Function),
            sym("inspect", SymbolKind::Function),
            sym("promisify", SymbolKind::Function),
            sym("types", SymbolKind::Variable),
        ],
    },
    StdModule {
        qualifier: "node:v8",
        module_import: Some("v8"),
        symbols: &[
            sym("deserialize", SymbolKind::Function),
            sym("getHeapStatistics", SymbolKind::Function),
            sym("serialize", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:vm",
        module_import: Some("vm"),
        symbols: &[
            sym("Script", SymbolKind::Class),
            sym("SourceTextModule", SymbolKind::Class),
            sym("SyntheticModule", SymbolKind::Class),
            sym("createContext", SymbolKind::Function),
            sym("runInContext", SymbolKind::Function),
            sym("runInNewContext", SymbolKind::Function),
        ],
    },
    StdModule {
        qualifier: "node:worker_threads",
        module_import: None,
        symbols: &[
            sym("Worker", SymbolKind::Class),
            sym("isMainThread", SymbolKind::Variable),
            sym("parentPort", SymbolKind::Variable),
            sym("workerData", SymbolKind::Variable),
        ],
    },
    StdModule {
        qualifier: "node:zlib",
        module_import: Some("zlib"),
        symbols: &[
            sym("createGunzip", SymbolKind::Function),
            sym("createGzip", SymbolKind::Function),
            sym("gunzip", SymbolKind::Function),
            sym("gzip", SymbolKind::Function),
        ],
    },
];
