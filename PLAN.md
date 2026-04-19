# vscode-auto-import — 설계 문서

## 1. 목적

VSCode 확장. 사용자가 심볼을 타이핑하면, **현재 파일에 아직 import 되지 않았지만 워크스페이스 내 다른 파일에 존재하는 importable 심볼**을 자동완성 후보에 추가하고, 선택 시 해당 언어 문법에 맞는 `import` 구문을 자동 삽입한다.

## 2. 스코프

### 지원 언어 (1차)
- TypeScript / JavaScript (TSX/JSX 포함)
- Python
- Java

### 인덱싱 대상: **import 가능한 심볼만**
| 언어 | 대상 |
|---|---|
| TS/JS | `export` 선언 (named/default), `export { }`, `export * from`, `export { } from` |
| Python | `__all__` 존재 시 해당 목록 / 부재 시 top-level 비-`_` 심볼 (`def`, `class`, 할당) |
| Java | `public class/interface/enum/record`, public static 멤버, public inner class |

내부 private 심볼은 제외 — 전체 심볼의 5-15%만 인덱싱 대상.

### 제외 경로 (기본)
- `node_modules/`, `.venv/`, `venv/`, `__pycache__/`
- `target/`, `build/`, `dist/`, `out/`
- `.git/`, VCS 메타
- 사용자 설정으로 추가 가능

## 3. 성능 목표

| 항목 | 목표 |
|---|---|
| 추천 결과 반환 (warm lookup) | **1-2 ms** |
| Cold start (캐시 로드 + 검증) | 100-300 ms |
| 편집 후 인덱스 반영 (debounce 포함) | < 300 ms |
| 디스크 캐시 총량 (초대형 레포 포함) | **≤ 10 MB** |
| Hot index RSS (초대형) | < 5 MB |

## 4. 아키텍처 개요

```
VSCode Editor
    │
    │ trigger character / manual
    ▼
CompletionItemProvider  ──►  Trigram/Prefix Index (mmap)  ──►  Hot Index (TypedArray)
    │                                                              │
    │ selected                                                     │ nameId → fileId
    ▼                                                              ▼
ImportInserter (per-language)                              String/Path Table (shared)
    │
    │ additionalTextEdits
    ▼
Document edits
```

백그라운드:
```
File System Watcher
    │ debounce 200 ms
    ▼
Dirty File Queue  ──►  Tree-sitter Parser  ──►  Export Extractor  ──►  Index Patcher
                          │                        │                        │
                          │ 언어별 query          │ 언어별 정책            │ Uint32Array mutate
                          ▼                        ▼                        ▼
                       stub 저장                   재export 평탄화         persistence (throttled)
```

## 5. 캐시 구조

### 5.1 String Table (문자열 인터닝)
- `Map<string, nameId:u32>` 양방향
- 심볼 이름, export alias 등에 사용
- 고유 이름은 프로젝트 당 수만 개 수준 (초대형도 ~200K)
- 직렬화: 길이 prefix + UTF-8 바이트 연속

### 5.2 Path Table
- 파일 경로는 디렉토리 prefix 공유 많음 → prefix trie 로 저장
- `pathId → string` 복원
- 초대형 레포 100K 파일도 ~2-3 MB

### 5.3 Hot Symbol Index
프로젝트 전역 평면 배열 (TypedArray):

```
Entry (12 bytes, 3 × u32):
  [0] nameId      (심볼 이름)
  [1] fileId      (정의된 파일)
  [2] kind:u8 | flags:u8 | sourceNameId:u16  (packed)
        - kind: class/func/var/type/enum/interface
        - flags: isDefault, isReExport, deprecated
        - sourceNameId: re-export alias 시 원본 이름 참조 (16bit 로 축약, overflow는 별도 테이블)
```

→ 심볼당 **12 bytes** (컴팩트)
→ 초대형 200K importable 심볼 × 12 = **2.4 MB**

### 5.4 Trigram Index
- 퍼지/서브스트링 매칭용
- `trigram(u24) → sorted posting list of nameIds` (delta + varint)
- 고유 trigram 수 제한적 (~30K)
- 전체 ~1-2 MB

### 5.5 File Stub (디스크, lazy load)
```
file record:
  pathId         : u32
  contentHash    : [16]byte (BLAKE3)
  mtime          : u64
  exports        : [N] {nameId, kind, flags, line, col}
```
- hot index 재구성·검증용
- 편집 시 해당 파일 레코드만 교체

### 5.6 디스크 레이아웃
`.vscode/.auto-import-cache/`
```
header.bin         # magic, version, tableOffsets
strings.bin        # string table
paths.bin          # path table
hot.bin            # hot symbol index (TypedArray dump)
trigrams.bin       # trigram postings
stubs/             # per-file stub (hash 기반 파일명)
    ab/cd/abcd123... .stub
```
- `header.bin` 읽기만으로 버전/무결성 확인
- 개별 파트 mmap 또는 스트리밍 read 선택

## 6. Re-export 체인 평탄화

`barrel/index.ts`:
```typescript
export * from './user';      // ./user 의 User, UserId 등
export { Order } from './order';
export { default as API } from './api';
```

### 정책
1. 재export 발견 시 원본 파일까지 추적 (최대 depth 8, 순환 감지)
2. barrel 경로와 원본 경로 **둘 다** hot index에 등록 (flags.isReExport 표시)
3. 완성 시 **경로 점수 = 짧을수록 / `index` 파일일수록 우선**
4. 사용자가 명시적으로 deep import 를 선호하도록 설정 가능

### TS 특수
- `export type { X }` 는 타입 전용 → import 시 `import type { X }` 유지
- `export default` 는 기본 이름을 파일명에서 유추

### Python 특수 (`__init__.py`)
- `from .sub import User` 가 `__init__.py` 에 있으면 `pkg import User` 도 가능으로 인덱싱
- `__all__ = ['User']` 있으면 그 목록만 노출

## 7. Java Inner Class

```java
// Outer.java
package com.example;
public class Outer {
    public static class Inner { }
    public static final class Config { }
}
```

인덱싱 엔트리:
- `Outer` (importable: `import com.example.Outer`)
- `Outer.Inner` (importable: `import com.example.Outer.Inner`)
- `Outer.Config` 동

검색 시 `Inner` 로 타이핑해도 `Outer.Inner` 후보가 나오도록 이름 분해 인덱스 유지.

## 8. 증분 업데이트

### 8.1 트리거
- `workspace.onDidChangeTextDocument` (debounced 200ms) — 열린 파일
- `FileSystemWatcher` — 디스크 변경 (외부 에디터/Git checkout)

### 8.2 파이프라인
```
change event
   ▼
path resolve (worker-eligible 확인)
   ▼
read + BLAKE3 hash
   ▼
hash == stored? ──yes─► skip
   │ no
   ▼
tree-sitter parse (increment parse with lastTree if available)
   ▼
export extraction
   ▼
diff vs old stub:
   - removed exports → index entries 제거
   - added/changed → 신규 entry 추가
   ▼
file stub 교체
   ▼
(throttled) 전체 persistence flush (최대 10s 주기)
```

### 8.3 Header-only skip
export는 보통 파일 상단/시그니처에만 영향. 변경된 라인이 export 선언 외 구역이면 **re-index 스킵** (MD5 of export regions 비교).

## 9. 파서: tree-sitter (WASM)

### 이유
- 언어 3종에 통일된 API
- 파싱 1-3 ms/파일, increment parse 지원
- 문법 오류에도 강건 (타이핑 중에도 파싱됨)
- `web-tree-sitter` → 플랫폼 독립, 네이티브 빌드 불필요

### Query 기반 추출
각 언어별 `.scm` query 파일 사용:
```scheme
; typescript/exports.scm
(export_statement
  declaration: (_) @export.declaration)

(export_clause
  (export_specifier
    name: (identifier) @export.name))
```

### 파서 의존성
- `web-tree-sitter`
- `tree-sitter-typescript` (WASM)
- `tree-sitter-python` (WASM)
- `tree-sitter-java` (WASM)

## 10. Completion Provider

### 10.1 등록
- language `typescript`, `typescriptreact`, `javascript`, `javascriptreact`, `python`, `java`
- trigger: `.` 는 member access 이므로 제외. 식별자 시작 시 자동 트리거

### 10.2 동작
1. 커서 왼쪽 단어(prefix) 추출
2. prefix 길이 < 2 면 반환 없음 (노이즈 방지)
3. Trigram index로 후보 후 prefix 확정 매칭
4. 현재 파일에 이미 import된 심볼은 제외
5. 점수 기준 상위 N(20)개 `CompletionItem` 반환
6. 각 아이템에 `additionalTextEdits` 로 import 삽입 텍스트 포함

### 10.3 스코어링
```
score = prefix_match_weight × 10
      + last_used_recency × 2
      + path_depth_penalty (-0.5 × depth)
      + is_default_export × 1
      + re_export_penalty (-0.3)
```

### 10.4 Import 삽입 (언어별)

**TypeScript**
```typescript
// 기존 import 그룹에 merge: `import { A, B } from 'pkg'` → `import { A, B, NEW } from 'pkg'`
// 없으면 새 라인 추가 (파일 상단, 다른 import 뒤, 정렬 옵션 존중)
```

**Python**
```python
# from pkg import X, Y  →  from pkg import NEW, X, Y
# 없으면 기존 import 섹션 뒤, PEP 8 그룹 순서(stdlib/3rd-party/local) 고려
```

**Java**
```java
// import com.example.Outer;  (정렬 위치에 삽입, 같은 패키지 중복 제외)
// 기존 import 정렬 규칙 존중 (wildcard import 는 건드리지 않음)
```

## 11. 파일 구조

```
vscode-auto-import/
├── package.json              # extension manifest
├── tsconfig.json
├── esbuild.js
├── .vscodeignore
├── .gitignore
├── PLAN.md                   # (this)
├── src/
│   ├── extension.ts          # activate / deactivate
│   ├── config.ts             # 설정 읽기
│   ├── logger.ts
│   ├── index/
│   │   ├── types.ts          # SymbolKind, Flags, StubFile …
│   │   ├── stringTable.ts
│   │   ├── pathTable.ts
│   │   ├── hotIndex.ts       # TypedArray 기반
│   │   ├── trigramIndex.ts
│   │   ├── persistence.ts    # disk load/save + header
│   │   └── hash.ts           # BLAKE3 wrapper
│   ├── parsers/
│   │   ├── base.ts           # ParsedExport, ParserResult
│   │   ├── treeSitter.ts     # WASM 초기화 공통
│   │   ├── typescript.ts
│   │   ├── python.ts
│   │   ├── java.ts
│   │   └── queries/          # .scm 파일
│   ├── workspace/
│   │   ├── scanner.ts        # 초기 풀스캔 (워커 풀)
│   │   ├── watcher.ts        # FileSystemWatcher + debounce
│   │   └── reExport.ts       # 체인 평탄화
│   ├── completion/
│   │   ├── provider.ts       # CompletionItemProvider
│   │   ├── scorer.ts
│   │   └── importInserter/
│   │       ├── typescript.ts
│   │       ├── python.ts
│   │       └── java.ts
│   └── test/
│       └── ...
├── resources/
│   └── wasm/                 # tree-sitter grammar binaries
│       ├── tree-sitter-typescript.wasm
│       ├── tree-sitter-python.wasm
│       └── tree-sitter-java.wasm
```

## 12. 구현 단계

### Phase 1 — 골격 ✅
- [x] package.json / tsconfig / esbuild / gitignore / .vscodeignore / .vscode/launch.json
- [x] extension entry (activate/deactivate) + 설정 읽기 + OutputChannel 로거
- [x] 타입 정의 (`SymbolKind`, `SymbolFlag`, `ExportedSymbol`, `ParsedFile`)

### Phase 2 — 코어 인덱스 ✅
- [x] StringTable (바이너리 직렬화; path도 동일 구현 사용)
- [x] HotIndex (Map 기반 byName + byFile 양방향)
- [x] PrefixIndex (소문자 정렬 바이너리 서치 + camelCase 매칭 헬퍼)
- [x] TrigramIndex (포스팅 교집합)
- [x] Persistence (`cache.bin` v2, header 28B + 섹션 오프셋 + atomic rename)
- [x] SHA-256 상위 16bytes 해싱

### Phase 3 — 파서 ✅
- [x] tree-sitter WASM loader (locateFile 패턴, parser 캐시)
- [x] TypeScript: 모든 export 종류 + re-export 4종 (`{}`, `*`, `*as`, type-only)
- [x] Python: top-level + `__all__` 필터 + `from . import` re-export
- [x] Java: public class/interface/enum/record/annotation + inner static class chain

### Phase 4 — 워크스페이스 스캔 & 증분 ✅
- [x] 초기 스캔 (8-way 병렬)
- [x] FileSystemWatcher + `onDidChangeTextDocument` debounce 200ms
- [x] Re-export 체인 평탄화 (TS relative + Python dot path)
- [x] 재귀 cascade: 타겟 파일 변경 시 의존 barrel 자동 re-flatten
- [x] Content hash 기반 no-op 스킵

### Phase 5 — 완성 제공 ✅
- [x] `CompletionItemProvider` (TS/TSX/JS/JSX/Python/Java)
- [x] Scorer (exact > prefix > camelCase, re-export 패널티, depth 패널티, default 가산)
- [x] TS inserter (default/named/type-only, 기존 named 그룹 merge)
- [x] Python inserter (`from X import Y`, 기존 그룹 merge, docstring skip)
- [x] Java inserter (FQCN + inner class `Outer.Inner`, wildcard 중복 회피)
- [x] 이미 import된 심볼 필터링 (language-specific regex)

### Phase 6 — 마감 ✅
- [x] 4종 smoke test 전부 통과 (persistence, parsers, workspace, completion)
- [x] `smoke:all` 통합 스크립트
- [x] Production build 검증 (`dist/extension.js` 104.7 KB)
- [x] WASM 번들 (`resources/wasm/` 4.8 MB, 5 files: runtime + TSX/JS/Python/Java)
- [ ] (선택) 대규모 레포 벤치 + .vsix 퍼블리시 — 현 구현으로 충분

## 13. 설정 (vscode config 초안)

```jsonc
{
  "autoImport.languages": ["typescript", "javascript", "python", "java"],
  "autoImport.excludeGlobs": ["**/node_modules/**", "**/.venv/**"],
  "autoImport.minPrefixLength": 2,
  "autoImport.maxResults": 20,
  "autoImport.preferBarrelImports": true,
  "autoImport.python.respectAllDunder": true,
  "autoImport.typescript.preferTypeImports": "auto",
  "autoImport.java.includeInnerClasses": true,
  "autoImport.cache.maxDiskMB": 20,
  "autoImport.cache.location": "workspace"  // or "global"
}
```

## 14. 비범위

- 언어 서버(LSP) 대체 아님 — VSCode 내장/Pylance/Java Extension 과 공존
- 타입 체크/시그니처 정보 제공 안 함
- 코드 포매터 아님 (import 삽입 위치만 최소한 결정)
- Cross-workspace (멀티 루트) 초기 미지원 — 1 워크스페이스 가정

## 14.5 Rust Daemon (v2 아키텍처)

V1(TypeScript + web-tree-sitter)이 대형 파이썬 site-packages에서 WASM abort 를 일으킨 것을 계기로 코어를 Rust 바이너리 데몬으로 이전. VSCode 확장은 얇은 IPC 클라이언트로 축소됨.

### 컴포넌트 레이아웃

```
daemon/                               Rust 크레이트 (~2,800 LOC)
├── Cargo.toml                       tree-sitter 0.22, rayon, tokio, bincode, ...
├── src/
│   ├── main.rs                      tokio runtime entry
│   ├── ipc/
│   │   ├── protocol.rs              Request/Response/Notification 타입
│   │   └── server.rs                stdio JSON-RPC loop + periodic save task
│   ├── index/                       StringTable / HotIndex / PrefixIndex / SymbolIndex(+IndexSnapshot)
│   ├── parsers/                     tree-sitter native + python_fallback (regex)
│   ├── persistence.rs               bincode save/load
│   └── workspace/
│       ├── indexer.rs               upsert/remove/cascade + mtime 단축경로 + dirty flag
│       ├── scanner.rs               walkdir + rayon 병렬 parse
│       ├── library.rs               node_modules / site-packages 확장 스캔
│       └── re_export_resolver.rs    TS 상대경로 + Python dot-path resolver

resources/bin/                        per-platform 배포 바이너리
└── autoimport-daemon-{darwin|linux|win32}-{arm64|x64}[.exe]

src/                                  VSCode 확장 (TS, ~500 LOC)
├── extension.ts                     daemon spawn + watcher + commands
├── daemon/client.ts                 JSON-RPC 래퍼, InitParams/InitResult 타입
└── completion/                      provider + per-language import inserter
```

### IPC 프로토콜

Line-delimited JSON-RPC over stdio. 단일 프로세스 내 단일 daemon.

| Method | 용도 |
|---|---|
| `init` | workspaceRoot, languages, excludeGlobs, libraries 옵션, cacheDir 전달. 응답: `{cacheLoaded, cachedFiles}` |
| `scan` | workspace + libraries full scan. 완료 시 cache 저장 |
| `indexFile` | debounced 단일 파일 (+선택적 source 문자열) |
| `removeFile` | 삭제 반영 |
| `query` | prefix 검색 → `Suggestion[]` |
| `stats` | 현재 인덱스/인덱서 카운터 |
| `shutdown` | dirty 플래그 검사 → 최종 cache flush → 종료 |

알림: `ready`, `log`, `scanProgress`, `scanComplete`, `librariesScanComplete`.

### 캐시

- 경로: `${workspaceRoot}/.vscode/.auto-import-cache/index.bin`
- 포맷: bincode (binary), 단일 파일 atomic rename
- 내용: `IndexSnapshot { version, names, paths, files: Vec<(FileId, IndexedFile)> }` + `reExportsByBarrel`
- 저장 시점: scan 완료, rebuildIndex, 10초 주기 dirty flush, shutdown 직전
- 로드: init 시 존재하면 복원 후 `reflatten_all_barrels()` 로 barrel 의존성 그래프 재구성
- 증분 최적화: `index_file_disk()` 에서 파일 mtime이 캐시된 값과 일치하면 read+parse 생략

### VSCode 확장 바인딩

- `resolveDaemonBinary(extensionPath)` → `resources/bin/autoimport-daemon-${platform}-${arch}${ext}`
- `DaemonClient`: ChildProcess + stdin/stdout + pending map + notification fan-out
- `DaemonCompletionProvider`: `() => DaemonClient` getter로 컨슈머에서 재시작 후에도 안전
- `FileSystemWatcher('**/*.{ts,tsx,...}')` 가 외부 파일 변경 시 `client.indexFile(path)` 트리거

### 관련 커맨드

- `autoImport.rebuildIndex` — 강제 full rescan
- `autoImport.showCacheStats` — `stats` 요청 결과 표시
- `autoImport.showLogs` — OutputChannel reveal
- `autoImport.daemonStatus` — `{running, lastInit}` 반환 (E2E 검증용)
- `autoImport.restartDaemon` — daemon shutdown + respawn + init (cacheLoaded 검증)

### E2E (15 테스트)

`src/test/e2e/` + `@vscode/test-electron` + Mocha. 임시 워크스페이스 setup 에서 TS/Python/Java/node_modules/extra-site-packages fixture 를 생성한 뒤 `executeCompletionItemProvider` 로 suggestions 검증. 커버리지:

- 15/15 통과, 총 3초
- 언어별 (TS/Python/Java) completion + import edit
- 라이브러리 (node_modules, pythonExtraPaths) 매핑
- 재export 평탄화, 이미 import된 심볼 필터링
- persistent cache 파일 존재
- daemon 재시작 시 cache reload + 동작 연속성
- 파일 외부 변경 (`fs.writeFile`) → FileSystemWatcher → re-index

### 크로스 플랫폼 CI

`.github/workflows/build.yml`:
- matrix build 5 타깃 (darwin-arm64/x64, linux-x64/arm64, win32-x64)
- artifact 병합 → `resources/bin/` 구성 → `vsce package`
- macOS / ubuntu 에서 E2E (Linux 는 xvfb-run)
- `v*` 태그 푸시 시 릴리스 자산 자동 업로드

## 15. 리스크 및 대응

| 리스크 | 대응 |
|---|---|
| tree-sitter WASM 번들 크기 (~5MB × 3언어) | lazy load — 해당 언어 파일이 워크스페이스에 있을 때만 로드 |
| 초대형 레포 초기 스캔 시간 | worker pool + 점진적 가용 (완료 전에도 부분 결과 제공) |
| Re-export 순환 | depth 제한(8) + visited set |
| 네트워크 드라이브/느린 FS | mtime 만 우선 비교, hash 는 샘플링 |
| 사용자 IDE 의 기본 auto-import 와 충돌 | 우선순위 낮게 기본 설정, 중복 심볼 dedup |
