use crate::index::{ExportedSymbol, SymbolFlag, SymbolKind};
use crate::parsers::ParserLanguage;

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
            sym("BitSet", SymbolKind::Class),
            sym("Calendar", SymbolKind::Class),
            sym("Collections", SymbolKind::Class),
            sym("Comparator", SymbolKind::Interface),
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
            sym("Scanner", SymbolKind::Class),
            sym("Set", SymbolKind::Interface),
            sym("SplittableRandom", SymbolKind::Class),
            sym("StringJoiner", SymbolKind::Class),
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
            sym("Callable", SymbolKind::Interface),
            sym("CompletableFuture", SymbolKind::Class),
            sym("ConcurrentHashMap", SymbolKind::Class),
            sym("CountDownLatch", SymbolKind::Class),
            sym("Executor", SymbolKind::Interface),
            sym("ExecutorService", SymbolKind::Interface),
            sym("Executors", SymbolKind::Class),
            sym("Future", SymbolKind::Interface),
            sym("Semaphore", SymbolKind::Class),
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
        qualifier: "javax.crypto",
        module_import: None,
        symbols: &[
            sym("Cipher", SymbolKind::Class),
            sym("SecretKey", SymbolKind::Interface),
        ],
    },
];

const NODE_MODULES: &[StdModule] = &[
    StdModule {
        qualifier: "node:assert/strict",
        module_import: None,
        symbols: &[
            sym("deepEqual", SymbolKind::Function),
            sym("equal", SymbolKind::Function),
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
        qualifier: "node:timers/promises",
        module_import: None,
        symbols: &[
            sym("setImmediate", SymbolKind::Function),
            sym("setInterval", SymbolKind::Function),
            sym("setTimeout", SymbolKind::Function),
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
