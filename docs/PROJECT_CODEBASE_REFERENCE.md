# Monash Study Agent — Codebase Reference

This document describes the actual implementation of the repository.

Architecture intent:
→ [Monash Study Agent 整体架构设计 V3.0](./Monash%20Study%20Agent%20整体架构设计%20V3.0.md)

Memory design intent:
→ [Monash Study Agent — Memory 设计补充](./Monash_Study_Agent_Memory_设计补充.md)

Actual implementation:
→ this document

This reference is being synchronized with the runtime-architecture
stabilization working tree on `refactor/single-dsh-runtime`. The current
architecture note in [`architecture.md`](./architecture.md) is authoritative
for the Web/Single Runtime path; older SDK details below are retained as
historical compatibility notes until the dedicated Single Runtime E2E lands.

Verified date:
`2026-09-22`

This is an implementation reference, not a second design proposal. When the design documents and the code differ, this document records the current behavior; the design documents remain the source of intended product direction.

## 1. Repository Snapshot

The repository is a private pnpm TypeScript workspace with Python workers for Docling, LightRAG, and BGE-M3. The tracked baseline at the verification commit contains 135 files, 95 TypeScript files, 6 Python files, 18 test files, and about 12,152 lines across tracked TypeScript, Python, and JavaScript source. Generated `lib/`, `data/`, local Python environments, node modules, `.env`, and machine-specific source configuration are ignored.

The current runtime foundation is:

- `@monash-study/shared-types`: cross-package domain contracts.
- `@monash-study/runtime-database`: one SQLite connection and ordered schema migrations.
- `@monash-study/study-core`: provider-neutral study capabilities, Main Agent contracts, prompt rendering, Memory context, and tool contracts.
- `@monash-study/study-controller`: validation, model selection, context assembly, event emission, and runtime orchestration.
- `@monash-study/knowledge-service`: Resource discovery, normalization, LightRAG worker boundary, indexing state, and Evidence retrieval.
- `@monash-study/memory-service`: long-term student Memory persistence, candidate extraction, deterministic resolution, embedding, recall, and lifecycle.
- `@monash-study/study-application`: the single outer composition root and UI-facing `StudyApplication` contract; it wires real or injected providers and owns shutdown.
- `@monash-study/dsh-integration`: current DSH Web Host/Remote registration and `InProcessDshRuntime`, plus the retained Legacy published SDK adapter and shared product tool bridge.
- `@monash-study/dsh-ui-plugin`: the DSH bundle entry, browser page, slot registration, and UI presentation mapping.

The stable Main Agent path now includes baseline Student Context, direct Knowledge/Resource/Memory tools, an optional native Research Subagent, a final answer, and awaited Post-turn Memory Observation. `manage_memory` provides deliberate hot-path formation during the Harness loop; the successful completed-turn path supplies the same `MemoryService` with a system-triggered observation. Research delegation is bounded and read-only: the child can use only `search_knowledge` and `get_resource`, and the Main Agent remains responsible for final synthesis. The outer `StudyApplication` is the only application composition root: it wires these capabilities, enforces an idempotent shutdown path, and exposes no raw Harness result types to the UI. All paths reuse the existing product-owned services and SQLite state.

## 2. Current Architecture

### Current Single Runtime Web Path

```text
Browser
        │
        ▼
pnpm ui → vendored DSH CLI → Web profile
        │ declarative base/web bundles only
        ▼
--patch config/single-runtime.cordis.patch.yml
        │ repository-local Monash plugin staging path
        ▼
Vendored DeepSeek Harness Web
        ▼
Monash Agent Preset
        ▼
InProcessDshRuntime
        │
        ▼
StudyApplication / createStudyApplication()
        │
        ├── Resource
        ├── Knowledge / LightRAG
        ├── Memory
        └── StudyToolBridge
```

The launcher passes `MONASH_STUDY_AGENT_ROOT`, the runtime config, and the
resource manifest into the DSH profile. `loadRuntimeConfig()` resolves all
relative runtime paths once. Package location, profile location, and
`process.cwd()` do not determine the product workspace.

`scripts/stage-dsh-ui-runtime.ts` builds the repository-local plugin staging
artifact, and `scripts/dsh-package-graph.ts` verifies the key
`SessionController`, `PresetTree`, `EntryTree`, `Entry`, `cordis:group`, and
`agent-presets` identities against the vendored DSH tree. The Web profile
manifest contains only declarative DSH bundles; its existing physical
`node_modules` is not used for Monash DSH/Cordis runtime resolution.

### Historical SDK flow

```text
StudyController → DeepSeekHarnessRuntime → DSH SDK child
```

`DeepSeekHarnessRuntime` remains for legacy model-only smokes and compatibility
tests. It is not the production Web/Single Runtime path and its smoke result
does not prove Knowledge, Memory, or product tools.

### Research Subagent Architecture

```text
Main Agent decides from the task prompt
        │ complex multi-resource / coverage question
        ▼
native DSH research_subagent tool
        │ fresh in-process child; strong logical model
        │ toolFilter = search_knowledge, get_resource
        │ maxDepth = 1; one bounded read-only task
        ▼
Research Subagent
        │ repeated retrieval actions, up to 8 per StudyRun
        ▼
StudyToolBridge
        │ LightRAG Evidence + ResourceText
        ▼
Research adapter
        │ validates ResearchResult and discards unknown Evidence IDs
        ▼
Main Agent final synthesis
        │ direct + Research Evidence deduplicated by evidenceId
        ▼
StudyTurnResult { answer, evidence, subagentsUsed, researchActions }
```

The product contract is provider-neutral: `ResearchTask` carries the delegated objective and course scope; `ResearchFinding` and `ResearchResult` carry the structured answer, Evidence ids, and limitations. DSH owns child execution and notifications, while the adapter maps those notifications into the product contract. `get_resource` remains a `ResourceText` read and never creates Evidence. The child has no Memory lifecycle access and cannot recursively delegate. Child failure emits safe `subagent_failed` metadata and leaves the Main Agent answer recoverable.

### Knowledge path

```text
Configured course roots
  → LocalKnowledgeService.scan()
  → ResourceManifest / resources/resources.json
  → NormalizationService
  → NormalizedDocument JSON + Markdown under data/normalized/
  → LightRAGSyncService
  → lightrag_worker.py / LightRAG runtime
  → LightRAGKnowledgeService.search()
  → NormalizedDocument metadata + returned chunks
  → Evidence
```

### Memory path

```text
Memory observation or management command
  → MemoryCandidateExtractor / MemoryCandidate
  → MemoryResolver
  → MemoryLifecycleManager
  → MemoryStore
  → SQLite memories, memory_embeddings, memory_events, memory_fts

Main Agent query
  → MemoryStudentContextBuilder
  → MemoryService.recall()
  → MemoryRetriever
  → global direct load + scoped FTS/BGE-M3 hybrid ranking
  → StudentContext
  → rendered Main Agent prompt
```

## 3. State Ownership

| State | Owner | Persistence | Main access path |
| --- | --- | --- | --- |
| Web DSH session | DSH Web `Agent`/`SessionController`, driven by `InProcessDshRuntime` | DSH-managed persisted session state | `SessionController.create({ sessionId?, cwd, agentPreset })` |
| Web conversation | Returned Web session identity; product exposes the same value as `conversationId` | DSH-managed; returned as `StudyConversationRef` | `InProcessDshRuntime.runTurn()` |
| Legacy SDK session | `DeepSeekHarnessRuntime` and the published DSH SDK child | Harness-managed session state | `DeepSeekHarnessRuntime.#getHarness()` and `harness.session(sessionId)` |
| Legacy SDK conversation | Legacy DSH SDK session identity; product exposes the same value as `conversationId` | Harness-managed; returned as `StudyConversationRef` | `DeepSeekHarnessRuntime.runTurn()` |
| Turn | Harness event stream plus one `StudyTurnResult`; Controller projects a safe completed-turn observation | Not persisted by product | `extractTurnId(result.events)`, `StudyPostTurnObserver` |
| `runId` / StudyRun | `StudyController` and `AgentEvent` payloads | In-memory for the turn | `StudyController.runTurn()` |
| Current course context | Product input DTO | Caller-owned; not persisted | `CourseContext` in `StudyTurnInput` and active bridge input |
| Student Context snapshot | `StudentContextBuilder`; actual current type is `StudentContext`, not a separate `StudentContextSnapshot` class | In-memory prompt projection | `MemoryStudentContextBuilder.build()` |
| Long-term Memory | `MemoryService` / `MemoryStore` | Shared SQLite database | baseline/targeted recall, `manage_memory`, and Post-turn Observation |
| Memory events | `MemoryStore` | `memory_events` table | `MemoryStore.#writeEvent()` and `listEvents()` |
| Resource state | `LocalKnowledgeService` and generated manifest | Source files plus `resources/resources.json` | `scan-resources.ts`, `loadManifest()` |
| Normalization state | `NormalizationService` | JSON state files under `data/normalized/.state/` and normalized JSON/Markdown | `normalizeWithStatus()` |
| LightRAG index state | `LightRAGIndexStateStore` | `lightrag_index_state`, sync run and operation tables in SQLite | `LightRAGSyncService` |
| Evidence | `LightRAGKnowledgeService` creates it; `StudyToolBridge` deduplicates it for the active run | In-memory for a turn; Memory tool results stay outside this layer | `StudyTurnResult.evidence` |
| Turn artifacts | DSH returns raw events internally; product returns answer, conversation, turn id, Evidence, tool names, and Research metadata | No product artifact store currently | `StudyTurnResult` |

Rows labeled Web are the current Single Runtime path. Rows labeled Legacy SDK
describe compatibility and model-only smoke coverage; they are not the Web
conversation path. The repository therefore has one durable cross-session
student state owner (`MemoryService`) and one durable derived course-retrieval
state owner (`Knowledge Service` plus LightRAG state). DSH conversation state
is deliberately not copied into either service.

## 4. Repository Directory Map

```text
monash-study-agent/
├── connectors/
│   ├── ed/                    Ed connector type seam; live implementation is not present
│   └── moodle/                Moodle connector type seam; live implementation is not present
├── config/
│   ├── main-agent-tools.mjs  DSH child-side tool registrations
│   ├── main-agent.cordis.patch.yml  Main Agent prompt/tool patch
│   ├── runtime.json           Shared LightRAG/runtime configuration
│   └── sources.example.json   Portable course-root configuration template
├── docs/
│   ├── README.md              Unified project documentation index
│   ├── PROJECT_CODEBASE_REFERENCE.md  Verified implementation reference
│   ├── UI_IMPLEMENTATION_REFERENCE.md  DSH 0.1.6-alpha.2 UI/API findings and Round 1 contract
│   ├── architecture.md        Concise implementation architecture notes
│   ├── identity-contract.md   Stable identity algorithms
│   ├── Commit Message Guidelines.md  Commit subject/body convention
│   ├── Monash Study Agent 整体架构设计 V3.0.md  Overall design intent
│   └── Monash_Study_Agent_Memory_设计补充.md  Memory design intent
├── packages/
│   ├── shared-types/          Shared Resource, Evidence, Memory, and Study DTOs
│   ├── runtime-database/      SQLite connection and migrations
│   ├── study-core/            Provider-neutral capabilities, Main Agent, and Research contracts
│   ├── study-controller/      Product turn orchestration
│   ├── study-application/     Outer composition root and stable application contract
│   ├── dsh-integration/       Cordis, Harness, Research adapter, and UI Remote boundary
│   └── dsh-ui-plugin/         DSH bundle entry, browser page, and slot registration
├── resources/
│   └── resources.json         Generated Resource Manifest snapshot
├── scripts/                   CLI and smoke entry points, including Research smoke
├── services/
│   ├── knowledge-service/     Resource discovery, normalization, LightRAG, Evidence
│   └── memory-service/        Long-term Memory implementation
├── tests/                     Cross-package unit/integration tests and fixtures
├── README.md                  Product overview and operational commands
├── package.json               Workspace scripts and root dependencies
├── pnpm-workspace.yaml        Workspace package globs and build permissions
└── tsconfig*.json             Strict TypeScript and build configuration
```

`data/` and `lib/` are important runtime/build directories locally but are generated and ignored. `config/sources.local.json` is also local and ignored because it contains machine-specific course paths.

## 5. Complete Important File Map

The tables below cover the tracked TypeScript and Python implementation, the product scripts, the configuration boundary, and all test files. Barrel files are listed because they define the public package surface even when they contain only exports.

### 5.1 Shared types and runtime database

| File | Main responsibility | Important exports | Depends on | Used by |
| --- | --- | --- | --- | --- |
| `packages/shared-types/src/evidence.ts` | Unified retrieved/live Evidence DTO | `Evidence`, source/provider unions | None | Knowledge, bridge, study-core, tests |
| `packages/shared-types/src/memory.ts` | Memory domain enums and DTOs | `StudentMemory`, `MemoryEmbedding`, `MemoryEvent`, operation types | None | Memory Service, study-core |
| `packages/shared-types/src/resource.ts` | Resource roots, metadata, filters, text | `Resource`, `ResourceRoot`, `ResourceManifest`, `ResourceText` | None | Knowledge Service, connectors, tools |
| `packages/shared-types/src/normalized-document.ts` | Normalized document and locator contracts | `NormalizedDocument`, `NormalizedLocator`, `NormalizedRegion` | `resource.ts` | Normalization, LightRAG |
| `packages/shared-types/src/resource-manifest.ts` | Manifest re-export surface | Resource manifest types | `resource.ts` | Root consumers |
| `packages/shared-types/src/runtime.ts` | Runtime configuration DTO | `RuntimeConfig` | None | Runtime config loader |
| `packages/shared-types/src/study.ts` | Study state and intent DTOs | Study state types and `Evidence` references | `evidence.ts` | Study-core services |
| `packages/shared-types/src/index.ts` | Public barrel export | All shared types | All files above | Every workspace package |
| `packages/runtime-database/src/runtime-database.ts` | Opens SQLite and applies ordered migrations 1–4 atomically | `RUNTIME_DATABASE_SCHEMA_VERSION`, `openRuntimeDatabase` | Node `sqlite` | Memory Store and LightRAG state stores |
| `packages/runtime-database/src/index.ts` | Runtime database barrel | `openRuntimeDatabase` | `runtime-database.ts` | Workspace consumers |

### 5.2 Study core and controller

| File | Main responsibility | Important exports | Depends on | Used by |
| --- | --- | --- | --- | --- |
| `packages/study-core/src/agent-runtime.ts` | Stable Main Agent runtime, completed-turn observer, tool capability, Research metadata, and event boundaries | `StudyAgentRuntime`, `StudyPostTurnObserver`, `StudyMemoryManager`, `StudyAgentToolServices`, `AgentEvent`, `StudyRuntimeError`, `StudyTurnResult` | Shared types, prompt `CourseContext` | Controller, DSH adapter, tests |
| `packages/study-core/src/research-subagent.ts` | Provider-neutral ResearchTask/ResearchFinding/ResearchResult contracts, prompt parsing, validation, and safe Evidence attribution | `ResearchSubagent`, `ResearchTask`, `ResearchFinding`, `ResearchResult`, `validateResearchTask`, `sanitizeResearchResult` | Shared `Evidence` and study types | DSH adapter, prompts, tests |
| `packages/study-core/src/prompts/main-study-agent-prompt.ts` | Versioned Main Agent instructions for direct tools, Research delegation, and Hybrid Memory behavior | `MAIN_STUDY_AGENT_PROMPT_VERSION`, tool/no-tool prompts, `CourseContext`, `renderMainStudyAgentPrompt` | `StudentContext`, Research constants | DSH adapter, tests |
| `packages/study-core/src/prompts/research-subagent-prompt.ts` | Independent bounded Research Subagent persona and strict JSON output rules | `RESEARCH_SUBAGENT_SYSTEM_PROMPT` | Research contracts | DSH patch, DSH runtime |
| `packages/study-core/src/student-context.ts` | Memory-backed context projection | `MemoryStudentContextBuilder` | Runtime context types | Controller, tool smoke |
| `packages/study-core/src/knowledge-service.ts` | Replaceable retrieval capability | `KnowledgeQuery`, `KnowledgeService` | `Evidence` | LightRAG service, controller composition |
| `packages/study-core/src/tools/study-tool.ts` | Product tool abstraction before DSH registration | `StudyToolRequest`, `StudyTool` | `Evidence` | Connectors and future controller tools |
| `packages/study-core/src/model-policy.ts` | Re-export of logical model policy | `ModelPolicy`, `DefaultModelPolicy` | `agent-runtime.ts` | Controller and callers |
| `packages/study-core/src/decision-service.ts` | Decision capability seam | `StudyDecisionService` | Shared study types | Controller boundary |
| `packages/study-core/src/decision/jev-decision-service.ts` | Current JEV naming alias | `JEVDecisionService` | Decision service | Future decision implementation |
| `packages/study-core/src/models/model-service.ts` | Model generation capability seam | `StudyGenerationRequest`, `StudyModelService` | Study state and Evidence | Controller dependencies |
| `packages/study-core/src/models/deepseek-model-service.ts` | DeepSeek model service type alias/seam | DeepSeek model service type | `StudyModelService` | Future model composition |
| `packages/study-core/src/index.ts` | Public study-core barrel | All core exports | Core files | Workspace consumers |
| `packages/study-application/src/index.ts` | Single outer composition root; wires real or injected providers and owns shutdown | `StudyApplication`, `StudyApplicationOptions`, `createStudyApplication` | DSH, Knowledge, Memory, Controller, study-core | UI entry point, integration tests |
| `packages/study-controller/src/study-controller.ts` | Validates a turn, builds context, invokes runtime, awaits non-fatal Post-turn Observation, and emits events | `StudyController`, dependency/options DTOs | Structural `study-core` capabilities | Smoke scripts, application entry |
| `packages/study-controller/src/runtime/study-runtime.ts` | Product composition root for Knowledge capability | `StudyRuntime`, `createStudyRuntime` | Knowledge Service, study-core | Cordis plugin |
| `packages/study-controller/src/runtime/index.ts` | Runtime barrel | Runtime exports | `study-runtime.ts` | Controller package |
| `packages/study-controller/src/index.ts` | Controller barrel | Controller and runtime exports | Controller files | Root callers |

### 5.3 DSH and Harness integration

This table separates the current Single Runtime Web path from the historical
SDK child path. `InProcessDshRuntime`, `MonashStudyUiService`, and the Remote
boundary are current Web code. Entries explicitly marked Legacy are retained
for compatibility and model-only smokes; they must not be read as the Web
turn path.

| File | Main responsibility | Important exports | Depends on | Used by |
| --- | --- | --- | --- | --- |
| `packages/dsh-integration/src/in-process-dsh-runtime.ts` | Current Web adapter over DSH Web `Agent` and `SessionController`; creates/continues the `monash-study-agent` preset session, executes tools in-process, and returns product results | `InProcessDshRuntime` | DSH Web Agent/Session services, study-core, `StudyToolBridge` | `ui-host`, `StudyApplication` runtime |
| `packages/dsh-integration/src/ui-host.ts` | Current Web Host plugin registration for `InProcessDshRuntime` and the UI service | `apply`, `name` | Cordis, current UI/runtime adapters | DSH UI bundle |
| `packages/dsh-integration/src/ui-contract.ts` | Stable UI request/response and course summary types | `CourseSummary`, `MonashStudyTurnRequest`, `MonashStudyTurnResponse`, `MonashStudyAgentEvent` | study-core DTOs | UI Host service, Remote contribution, browser plugin |
| `packages/dsh-integration/src/ui-service.ts` | Current Web Host service, lazy `StudyApplication` composition, course listing, turn execution, and AgentEvent stream | `MonashStudyUiService` | Cordis, Typert, StudyApplication, ResourceManifest | DSH profile and browser Remote |
| `packages/dsh-integration/src/remote.ts` | Typert Remote descriptors and strict boundary codecs | `TYPERT_REMOTE` | Typert protocol, zod, UI contract | `dsh-ui-plugin` browser client |
| `packages/dsh-integration/src/plugin.ts` | Current Web Cordis registration for product UI/application services; the Knowledge service export remains a compatibility seam | `MonashStudyKnowledgeService`, `MonashStudyUiService`, `apply`, plugin `name` | Cordis, `createStudyRuntime`, `StudyApplication` | DSH profile/patch |
| `packages/dsh-integration/src/study-tool-bridge.ts` | Product-owned tool dispatch and per-run Evidence/tool metadata; current Web calls it in-process, while the Legacy SDK path also exposes its authenticated loopback server | `StudyToolBridge`, `StudyToolRunSnapshot` | Node HTTP, shared Evidence, structural study-core services | Current `InProcessDshRuntime` and Legacy `DeepSeekHarnessRuntime` |
| `packages/dsh-integration/src/deepseek-harness-runtime.ts` | **Legacy SDK only:** maps product runtime to the published DSH SDK child, manages legacy profiles/sessions, native Research lifecycle events, prompt patch, and child bridge | `DeepSeekHarnessRuntime`, Harness driver/session/result contracts | DSH SDK, study-core, `StudyToolBridge`, Research adapter | Legacy Agent smokes and compatibility tests |
| `packages/dsh-integration/src/research-adapter.ts` | **Legacy SDK only:** maps native DSH child notifications and outputs into validated product Research executions | `collectResearchExecutions`, `ResearchExecutionSnapshot` | DSH-shaped notifications, study-core Research contracts, Evidence | Legacy `DeepSeekHarnessRuntime`, tests |
| `packages/dsh-integration/src/tools/local-resource-tool.ts` | Local resource-reader shape for future tool composition | `LocalResourceTool` | Shared Resource types | Future tool registry |
| `packages/dsh-integration/src/index.ts` | DSH package public barrel | DSH exports | Adapter files | Root scripts |
| `packages/dsh-ui-plugin/package.json` | DSH host bundle patch and browser injection metadata | `dsh.bundle.patch`, `dsh.client.inject` | Vendored DSH UI packages | Local staged runtime artifact |
| `scripts/dsh-web-profile.ts` | Keeps the Web profile declarative and removes the Monash plugin dependency/bundle declaration without deleting profile data | `ensureDeclarativeWebProfile` | DSH profile manifest | `ui`, `ui:setup` |
| `scripts/stage-dsh-ui-runtime.ts` | Stages the built Monash plugin and links its DSH externals to the vendored graph | `stageDshUiRuntime` | Built UI plugin, vendored DSH | `build`, `ui:setup` |
| `scripts/dsh-package-graph.ts` | Asserts runtime package identity, owner, and profile boundary | `assertDshPackageGraph` | Vendored DSH, Web profile manifest | `ui`, `ui:setup`, tests |
| `packages/dsh-ui-plugin/src/index.ts` | Host half of the UI bundle | `apply`, `name`, `Config` | `dsh-integration` | DSH bundle loader |
| `packages/dsh-ui-plugin/src/client/index.ts` | Three-column browser page and Remote client | `apply`, `inject` | DSH slots/layout/primitives, UI Remote | DSH browser loader |
| `packages/dsh-ui-plugin/src/client/registration.ts` | Keyed `main` and sidebar slot registration | `registerMonashStudySlots`, `inject` | DSH slot contract | Browser entry, UI tests |
| `packages/dsh-ui-plugin/src/client/presenters.ts` | Safe AgentEvent/Evidence/error presentation mapping | `toActivityItem`, `toEvidenceCards`, `errorLabel` | study-core and UI contract types | Browser page, UI tests |
| `config/main-agent-tools.mjs` | **Legacy SDK only:** child-side declarations for `search_knowledge`, `get_resource`, `recall_memory`, and `manage_memory` | `name`, `inject`, `apply` | DSH tool injection surface, bridge env | Patched Legacy DSH child |
| `config/main-agent.cordis.patch.yml` | **Legacy SDK only:** disables generic child delegation, supplies product prompts, and inserts Legacy Main tools/research child | `system-prompt`, `monash-study-agent-tools`, `monash-study-agent-research-subagent` patch entries | DSH patch format | `DeepSeekHarnessRuntime` |

### 5.4 Knowledge service and Python workers

| File | Main responsibility | Important exports | Depends on | Used by |
| --- | --- | --- | --- | --- |
| `services/knowledge-service/src/local/local-knowledge-service.ts` | Scans configured roots, loads manifest, reads text-readable Resources | `LocalKnowledgeService`, `UnsupportedResourceReadError`, scan/read options | Shared Resource types and filesystem | `scan-resources.ts`, normalization, tool smoke |
| `services/knowledge-service/src/normalization/normalization-service.ts` | Routes Resources, caches by source/normalizer hash, writes JSON/Markdown/state | `NormalizationService`, `NormalizationResult`, status types | Shared Resource/Document types, normalizers | `normalize.ts`, tests |
| `services/knowledge-service/src/normalization/resource-normalizer.ts` | Normalizer abstraction and stable document id | `ResourceNormalizer`, `NormalizedDocumentDraft`, `documentIdForResource` | Shared Resource types | All normalizers |
| `services/knowledge-service/src/normalization/text-normalizer.ts` | Markdown, QMD, and ordinary text conversion | `TextNormalizer` | Resource types | Normalization service |
| `services/knowledge-service/src/normalization/code-normalizer.ts` | Source-code conversion | `CodeNormalizer` | Resource types | Normalization service |
| `services/knowledge-service/src/normalization/csv-normalizer.ts` | CSV-to-readable-table conversion | `CsvNormalizer` | `csv-parse`, Resource types | Normalization service |
| `services/knowledge-service/src/normalization/forum-normalizer.ts` | Ed discussion JSON to one document per thread | `ForumNormalizer` | Resource/Document types | Normalization service |
| `services/knowledge-service/src/normalization/document-normalizer.ts` | PDF/DOCX/PPTX routing through Docling | `DocumentNormalizer` | `DoclingAdapter`, Resource types | Normalization service |
| `services/knowledge-service/src/normalization/docling-adapter.ts` | Starts the Docling Python worker and validates conversion response | `DoclingAdapter`, conversion contracts | Python worker, shared regions | Document normalizer |
| `services/knowledge-service/src/normalization/normalized-document-loader.ts` | Reads persisted normalized JSON without rerunning normalization | `NormalizedDocumentLoader`, filters | Shared Document types | LightRAG sync/query |
| `services/knowledge-service/src/runtime/runtime-config.ts` | Loads and validates `config/runtime.json` | `loadRuntimeConfig`, loaded config | Shared Runtime types | LightRAG service/worker |
| `services/knowledge-service/src/lightrag/lightrag-worker-protocol.ts` | Versioned JSON stdin/stdout request/response protocol | protocol version, commands, validators | Node UUID | Worker client and Python protocol |
| `services/knowledge-service/src/lightrag/lightrag-worker-client.ts` | Spawns project-local Python LightRAG worker | `LightRAGWorkerClient`, result DTOs | Runtime config, protocol, Python worker | LightRAG service/sync/scripts |
| `services/knowledge-service/src/lightrag/lightrag-knowledge-service.ts` | Queries LightRAG and maps chunks to metadata-rich Evidence | `LightRAGKnowledgeService`, search result types | Worker client, loader, index state, `KnowledgeService` | Study runtime, tool smoke |
| `services/knowledge-service/src/lightrag/lightrag-sync-service.ts` | Plans and executes incremental/course LightRAG sync with journal recovery | `LightRAGSyncService`, plan/result types | Loader, worker client, index store | `lightrag.ts`, tests |
| `services/knowledge-service/src/lightrag/lightrag-index-state-store.ts` | Persists document index state and recoverable sync journal | `LightRAGIndexStateStore` | Runtime SQLite | Sync service |
| `services/knowledge-service/src/lightrag/lightrag-index-state.ts` | Index-state DTO and currentness comparison | `LightRAGIndexState` | Normalized Document | State store/sync |
| `services/knowledge-service/src/lightrag/lightrag-database.ts` | Compatibility wrapper around shared runtime DB | `openLightRAGDatabase`, schema version | Runtime database | Index state store |
| `services/knowledge-service/src/index.ts` | Knowledge package barrel | All local, normalization, LightRAG, config exports | Service files | Workspace consumers |
| `services/knowledge-service/python/docling_worker.py` | JSON worker for PDF/DOCX/PPTX conversion and OCR/table regions | stdin/stdout worker entry | Docling environment | `DoclingAdapter` |
| `services/knowledge-service/python/lightrag_protocol.py` | Python-side protocol parsing/serialization | LightRAG request/response validation | Python stdlib | Python worker |
| `services/knowledge-service/python/lightrag_runtime.py` | Builds/configures LightRAG, DeepSeek LLM, BGE-M3 embeddings, ingest/query/delete | runtime functions | `lightrag-hku`, DeepSeek, BGE-M3 | `lightrag_worker.py` |
| `services/knowledge-service/python/lightrag_worker.py` | JSON command dispatcher for health, model health, ingest, delete, batch sync, query | worker main | Protocol/runtime | TypeScript worker client |
| `services/knowledge-service/python/runtime_config.py` | Python runtime config loading and validation | config helpers | Python JSON/path APIs | LightRAG worker/runtime |
| `services/knowledge-service/contracts/lightrag-worker.v1.schema.json` | Machine-readable worker protocol schema | JSON schema | None | Protocol maintenance/tests |

### 5.5 Memory service

| File | Main responsibility | Important exports | Depends on | Used by |
| --- | --- | --- | --- | --- |
| `services/memory-service/src/memory-service.ts` | Shared facade for recall, observe, manage, forget, consolidation, and bounded same-turn Episode deduplication | `MemoryService` | Store, extractor, resolver, retriever, lifecycle | Controller observer, tool bridge, context, smokes |
| `services/memory-service/src/memory-store.ts` | Transactional SQLite CRUD, FTS, embeddings, events, and scope queries | `MemoryStore`, add/update/filter DTOs | Runtime DB, shared Memory types | All Memory components |
| `services/memory-service/src/memory-key.ts` | Canonical key creation and kind inference | `createCanonicalMemoryKey`, `canonicalizeMemoryKey`, `kindForMemoryKey` | Shared Memory types | Extractor, resolver, store |
| `services/memory-service/src/memory-candidate.ts` | Candidate/observation contract including source turn and explicit Forget intent | `MemoryCandidate`, `MemoryObservation`, extractor interface | Shared Memory types | Provider/extractor/service |
| `services/memory-service/src/memory-resolver.ts` | Deterministic lifecycle decision with source priority and explicit Hard Delete authorization | `MemoryResolver`, `MemoryDecision` | Candidate, Store | Memory Service |
| `services/memory-service/src/memory-lifecycle-manager.ts` | Embeds writes and bounds active Episodes per course | `MemoryLifecycleManager` | Embedding provider, resolver, store | Memory Service |
| `services/memory-service/src/memory-retriever.ts` | Global direct load and scoped hybrid retrieval | `MemoryRetriever`, recall/result types | Store, embedding provider | Memory Service, Student Context |
| `services/memory-service/src/memory-embedding-provider.ts` | BGE-M3 embedding adapter through Python worker | `BgeM3MemoryEmbeddingProvider`, provider interface | Python worker, shared embedding DTO | Retriever/lifecycle |
| `services/memory-service/src/deepseek-memory-provider.ts` | OpenAI-compatible DeepSeek Flash completion adapter | `DeepSeekFlashMemoryProvider` | `.env` API key, fetch | Candidate extractor |
| `services/memory-service/src/deepseek-memory-candidate-extractor.ts` | Converts completed turns into validated full-lifecycle candidates, including explicit Forget intent | `DeepSeekFlashMemoryCandidateExtractor` | DeepSeek provider, key helpers | Memory Service |
| `services/memory-service/src/index.ts` | Memory package barrel | All Memory exports | Memory files | Root scripts and future adapters |
| `services/memory-service/python/memory_embedding_worker.py` | JSON embedding worker for BGE-M3 | worker entry | Python model environment | BGE-M3 provider |

### 5.6 Connectors, scripts, configuration, and manifests

| File | Main responsibility |
| --- | --- |
| `connectors/ed/src/ed-connector.ts` | Current Ed connector is a `StudyTool` type alias seam |
| `connectors/ed/src/index.ts` | Ed connector package entrypoint |
| `connectors/moodle/src/moodle-connector.ts` | Current Moodle connector is a `StudyTool` type alias seam |
| `connectors/moodle/src/index.ts` | Moodle connector package entrypoint |
| `scripts/scan-resources.ts` | Loads local source config, scans roots, writes Resource Manifest |
| `scripts/normalize.ts` | Normalizes all, one course, or one Resource from the manifest |
| `scripts/lightrag.ts` | LightRAG health, model health, ingest, delete, query, and course sync CLI |
| `scripts/smoke-lightrag.ts` | Real LightRAG health/model/retrieval smoke |
| `scripts/memory-smoke.ts` | Real Memory provider/lifecycle/recall smoke |
| `scripts/agent-smoke.ts` | Legacy SDK/model-only turn and optional legacy session continuity smoke |
| `scripts/agent-tools-smoke.ts` | Round 2 real Harness tool-calling and Evidence propagation smoke |
| `scripts/agent-memory-smoke.ts` | Round 3 real Post-turn, `manage_memory`, and cross-session Recall smoke over temporary SQLite |
| `scripts/agent-research-smoke.ts` | Round 4 real Main Agent delegation, native child retrieval, Research Evidence propagation, and final synthesis smoke |
| `config/runtime.json` | LightRAG working root, SQLite path, DeepSeek model URL, BGE-M3, query limits |
| `config/sources.example.json` | Portable Ed/Moodle root configuration example |
| `.env.example` | Secret-name template containing `DEEPSEEK_API_KEY` only |
| `resources/resources.json` | Generated current Resource Manifest snapshot; source of tool-smoke resource reads |
| `package.json` | Root scripts, workspace dependencies, and test/build commands |
| `pnpm-workspace.yaml` | Workspace globs and explicit native build permissions |
| `tsconfig.json` | Strict no-emit typecheck scope |
| `tsconfig.build.json` | Production declaration/source-map build scope excluding tests |

### 5.7 Tests and fixtures

| File | Scope |
| --- | --- |
| `tests/docling-normalizer.test.ts` | Docling conversion adapter/normalizer behavior |
| `tests/normalization-service.test.ts` | Normalizer routing, caching, stale output, and failure state |
| `tests/normalized-document-loader.test.ts` | Persisted normalized document loading/filtering |
| `tests/lightrag-worker-protocol.test.ts` | Versioned protocol parsing/validation |
| `tests/lightrag-worker-client.test.ts` | Worker client boundary behavior |
| `tests/lightrag-index-state.test.ts` | Index state currentness and metadata |
| `tests/lightrag-index-state-store.test.ts` | SQLite index state and sync journal persistence |
| `tests/lightrag-sync-service.test.ts` | Incremental/course sync planning and recovery |
| `tests/lightrag-knowledge-service.test.ts` | Query-to-Evidence mapping, scope, deduplication, and ranking |
| `tests/local-knowledge-service.test.ts` | Resource scan, manifest, and resource text reads |
| `tests/memory-key.test.ts` | Canonical Memory keys |
| `tests/memory-store.test.ts` | Memory CRUD, scope, embeddings, events, FTS, and lifecycle persistence |
| `tests/memory-intelligence.test.ts` | Candidate extraction fixtures, resolver priority, hybrid recall, lifecycle |
| `tests/study-runtime.test.ts` | Product Knowledge composition root |
| `tests/study-agent-runtime.test.ts` | Controller/runtime contracts, prompt, events, continuity, and error boundary |
| `tests/study-agent-tools.test.ts` | Student Context injection, three bridge tools, and Evidence snapshot behavior |
| `tests/study-application.test.ts` | Composition root, temporary Memory SQLite, lifecycle failure policy, Research recovery, concurrency, and cleanup |
| `tests/research-subagent.test.ts` | Research contracts, Evidence attribution, native lifecycle adaptation, bounded retrieval, failure recovery, and DSH tool restriction |
| `tests/fixtures/ed-discussions.json` | Forum normalization fixture |

## 6. Package Dependency Map

The intended and current workspace dependency direction is:

```text
@monash-study/shared-types
        ↑
@monash-study/runtime-database   (independent shared persistence utility)
        ↑
@monash-study/study-core
        ↑
@monash-study/study-controller
        ↑
@monash-study/dsh-integration
```

The service edges are:

```text
shared-types + runtime-database
        ├── services/memory-service
        └── services/knowledge-service

knowledge-service ──implements──> study-core.KnowledgeService
study-controller ──composes─────> knowledge-service
dsh-integration ──adapts────────> study-controller + study-core
dsh-ui-plugin ──uses────────────> dsh-integration Remote + DSH client UI slots
```

More precisely:

- `shared-types` has no workspace dependency and is the inward domain contract package.
- `runtime-database` owns the SQLite connection/migration mechanism and is used by Memory and LightRAG state code; it does not own service behavior.
- `study-core` imports only shared types among workspace packages. It owns abstractions, not the concrete Knowledge or Memory implementations.
- `study-controller` depends on Knowledge Service for its default runtime composition and on study-core for all stable orchestration contracts.
- `study-application` is the outer composition root. It depends on concrete Knowledge, Memory, Controller, DSH, and Core packages, supports injected fake/real capabilities, and returns only `StudyApplication.runTurn()` / `close()` above the UI boundary.
- `knowledge-service` implements the `KnowledgeService` interface and imports study-core only for that interface, preserving the controller boundary.
- `memory-service` is not a dependency of `study-controller` or `dsh-integration` at package level. Integration uses the structural `StudyMemoryReader`, `StudyMemoryManager`, and `StudyPostTurnObserver` capabilities; one `MemoryService` instance can satisfy all three without moving Memory policy into orchestration packages.
- `dsh-integration` is the only source package importing Cordis/DeepSeek Harness. The DSH child sees only `config/main-agent-tools.mjs`; the product parent owns actual service calls.
- `dsh-ui-plugin` is a separate bundle package. Its Host half delegates to `dsh-integration`; its browser half mounts the same Typert Remote contribution and registers the `monash-study` sidebar/main slots. It does not own StudyApplication or provider logic.
- Ed and Moodle connectors currently depend on the `StudyTool` abstraction only. They do not yet own live downloader synchronization in this repository.

## 7. Core Interfaces

These are the stable seams future work should use instead of importing provider internals.

### Main Agent runtime

```ts
interface StudyAgentRuntime {
  runTurn(input: StudyTurnInput, options?: StudyTurnOptions): Promise<StudyTurnResult>
}

interface StudyApplication {
  runTurn(input: StudyTurnInput, options?: StudyTurnOptions): Promise<StudyTurnResult>
  close(): Promise<void>
}

function createStudyApplication(options?: StudyApplicationOptions): Promise<StudyApplication>

interface StudyTurnInput {
  query: string
  courseContext?: CourseContext
  conversation?: StudyConversationRef
  studentContext?: StudentContext
}

interface StudyTurnResult {
  runId: string
  answer: string
  conversation: StudyConversationRef
  turnId: string
  modelProfile: 'fast' | 'strong'
  promptVersion: string
  evidence: readonly Evidence[]
  toolsUsed: readonly string[]
  subagentsUsed: readonly string[]
  researchActions: number
}

interface ResearchTask {
  taskId: string
  objective: string
  course: string
  topic?: string
  week?: number
  studentContext?: StudentContext
}

interface ResearchFinding {
  content: string
  evidenceIds: readonly string[]
}

interface ResearchResult {
  taskId: string
  summary: string
  findings: readonly ResearchFinding[]
  evidenceIds: readonly string[]
  limitations: readonly string[]
}

interface ResearchSubagent {
  research(task: ResearchTask): Promise<ResearchResult>
}

interface StudyPostTurnObserver {
  observe(input: StudyPostTurnObservation): Promise<readonly unknown[] | void>
}

interface StudyPostTurnObservation {
  userMessage: string
  assistantResponse: string
  sourceSessionId: string
  sourceTurnId: string
  runId: string
  conversationId: string
  turnId: string
  course?: string
  topic?: string
  week?: number
}
```

### Context and tools

```ts
interface StudentContextBuilder {
  build(input: { query: string; courseContext?: CourseContext }): Promise<StudentContext>
}

interface StudyResourceReader {
  readText(resourceId: string): Promise<ResourceText>
}

interface StudyMemoryReader {
  recall(input: {
    query: string
    course?: string
    topic?: string
    limit?: number
    globalLimit?: number
  }): Promise<readonly StudentMemoryContext[]>
}

interface StudyMemoryManager {
  manage(command: StudyMemoryManagementCommand): Promise<MemoryWriteResult>
}

interface StudyAgentToolServices {
  knowledgeService?: { search(input: KnowledgeQuery): Promise<readonly Evidence[]> }
  resourceReader?: StudyResourceReader
  memoryReader?: StudyMemoryReader
  memoryManager?: StudyMemoryManager
}

The Research boundary is provider-neutral. `ResearchSubagent.research()` accepts one bounded `ResearchTask`; the DSH adapter implements the native child execution and returns a validated `ResearchResult`. Only Evidence ids already collected by the parent bridge may appear in the result. `ResourceText` from `get_resource` remains outside the Evidence set.

interface StudyTool {
  name: string
  execute(request: StudyToolRequest): Promise<readonly Evidence[]>
}
```

`StudyTool` is the earlier product tool abstraction; the current DSH bridge uses the more specific `StudyAgentToolServices` structural capabilities because Resource and Memory results are not `Evidence[]`. `StudyMemoryManagementCommand` mirrors the existing `MemoryCandidate` fields used by the service. No separate `ToolRegistry`, `ToolExecutionContext`, or generic `ToolResult` interface exists yet; the child registration table and `StudyToolBridge.#execute()` switch remain the concrete registry/execution implementation.

### Knowledge and normalized content

```ts
interface KnowledgeService {
  search(query: KnowledgeQuery): Promise<readonly Evidence[]>
}

interface NormalizedDocument {
  documentId: string
  resourceId: string
  sourceHash: string
  title: string
  course: string | null
  week: number | null
  source: 'local' | 'ed' | 'moodle'
  contentType: 'code' | 'document' | 'forum-thread' | 'markdown' | 'table' | 'text'
  text: string
  sourcePath: string
  locator: NormalizedLocator
  normalizationVersion: string
  normalizedHash: string
}
```

`Resource` and `ResourceText` are the source/catalog boundary; `Evidence` is the retrieval/output boundary. `Evidence` carries `evidenceId`, optional course/resource, title/content, source system, retrieval provider, optional score, and metadata.

### Memory

The actual public Memory Service is:

```ts
class MemoryService {
  recall(query: MemoryRecallQuery): Promise<readonly MemoryContext[]>
  observe(input: MemoryObservation): Promise<readonly MemoryWriteResult[]>
  manage(command: MemoryCandidate): Promise<MemoryWriteResult>
  forget(memoryId: string): MemoryWriteResult
  consolidateEpisode(episodeId: string, higherMemoryId: string): void
}
```

`MemoryStore`, `MemoryResolver`, `MemoryRetriever`, and `MemoryLifecycleManager` remain separate seams. Memory kinds are `preference`, `study_progress`, `weakness`, `learning_episode`, and `study_strategy`; scopes are `global`, `course`, and `topic`.

### Other stable seams

- `ModelPolicy.selectModel('main_agent')` returns a logical `fast` or `strong` profile; `selectModel('research_agent')` returns the `strong` profile. The current Main Agent default remains `fast`, while the native DSH Research child is configured to `deepseek-v4-pro`.
- `AgentEventSink.emit(event)` receives safe lifecycle metadata without prompts, answers, or secrets.
- `LightRAGWorkerClient` is the TypeScript/Python protocol boundary.
- `MemoryCompletionProvider` and `MemoryEmbeddingProvider` isolate real DeepSeek and BGE-M3 providers from Memory policy.
- `ResourceNormalizer` isolates Markdown/text/code/CSV/forum/Docling conversion strategies.

## 8. Main Agent Turn Lifecycle

### Current Single Runtime Web Path

```text
Browser UI
  → Typert Remote `MonashStudyUiService.runTurn`
  → StudyApplication.runTurn(input, options)
  → StudyController.runTurn(input, options)
  → validateStudyTurnInput()
  → ModelPolicy.selectModel('main_agent')
  → optional StudentContextBuilder.build(); failure emits student_context_failed and uses empty context
  → InProcessDshRuntime.runTurn()
  → SessionController.create({ sessionId?, cwd: applicationRoot, agentPreset: 'monash-study-agent' })
  → SessionController.selectModel()
  → StudyToolBridge.begin(runId, input)
  → SessionController.prompt()
  → DSH Web Agent loop, direct tools, and optional native Research child
  → Agent session snapshot and `whenIdle()`
  → StudyToolBridge.snapshot(runId)
  → StudyTurnResult { answer, Evidence, toolsUsed, subagentsUsed, researchActions }
  → memory_observation_started
  → StudyPostTurnObserver.observe(completed turn)
  → MemoryService.observe()
  → memory_observation_completed or memory_observation_failed
  → StudyController emits run_completed
  → Typert Remote response
```

The Web path creates a new DSH session when `conversation` is absent and asks
`SessionController` to continue the supplied `sessionId` when it is present.
The product application root is passed as the session `cwd`; the DSH profile
directory is not the product root. Tools are executed through the current
Web Agent's in-process owner check and `StudyToolBridge.executeDirect()`.

### Historical / Legacy SDK Path

```text
CLI or legacy application caller
  → createStudyApplication(options)
  → StudyApplication.runTurn(input, options)
  → StudyController.runTurn(input, options)
  → DeepSeekHarnessRuntime.runTurn()
  → renderMainStudyAgentPrompt()
  → StudyToolBridge.begin(runId, input) when tools are configured
  → DeepSeekHarnessRuntime.#getHarness(profile)
  → harness.session(input.conversation?.sessionId).run(prompt.userPrompt)
  → DSH Main Agent loop, direct tools, and optional native Research child
  → collectResearchExecutions() validates child output and maps safe lifecycle metadata
  → extractTurnId(result.events)
  → StudyToolBridge.snapshot(runId)
  → StudyTurnResult
  → caller receives the legacy SDK result
```

The Legacy SDK flow is retained for compatibility and model-only smokes. It is
not the current production Web path and its successful continuity result does
not validate Web session creation, Web resume, Knowledge retrieval, or the UI.

Important details:

1. The controller trims and validates the query, course code, week, and topic. It generates `runId` unless the caller supplies one.
2. If the caller did not provide `studentContext` and a builder was injected, the controller builds it before the Harness call. A builder failure is non-fatal: the Controller emits `student_context_failed`, supplies `{ memories: [] }`, and continues.
3. The current Web runtime maps `fast` to `deepseek-official/deepseek-v4-flash` and `strong` to `deepseek-official/deepseek-v4-pro`. The current default policy selects `fast`.
4. A Web continuation passes the previous `conversation.sessionId` to `SessionController.create`; the returned DSH session identity is returned as both `sessionId` and `conversationId`. The Legacy SDK adapter uses its separate `harness.session(sessionId)` continuation call.
5. The Web preset supplies the DSH Agent prompt/runtime integration; the product turn contains the current course context, Student Context, and query. The `config/main-agent.cordis.patch.yml` prompt/child patch is Legacy SDK-only.
6. After a successful runtime result, the Controller awaits the injected structural observer with the user query, final answer, course/topic/week, real Harness session/conversation identity, turn id, and run id. The concrete `MemoryService` accepts this projection directly and owns extraction through persistence.
7. Observation success or failure completes before `run_completed`. A Memory observation failure emits safe metadata with `MEMORY_OBSERVATION_FAILED`, preserves the successful answer, and does not emit `run_failed`.
8. `StudyToolBridge.end(runId)` clears the active run in `finally`; Evidence and `toolsUsed` are not durable artifacts.

9. When the Main Agent calls `research_subagent`, DSH starts a fresh in-process child using the independent Research persona. The child is restricted to `search_knowledge` and `get_resource`, cannot recurse, and shares the active run's bounded eight-action retrieval budget. The Main Agent receives the native child output and remains responsible for the final answer.
10. The application/runtime allows one active turn. A second call receives `CONCURRENT_RUN`; bridge and runtime active state are cleared in `finally`, including Harness and tool failures. `StudyApplication.close()` is idempotent.

## 9. Student Context Flow

```text
User query + CourseContext
  → StudyController
  → MemoryStudentContextBuilder.build()
  → StudyMemoryReader.recall()
  → MemoryService.recall()
  → MemoryRetriever
  → direct global Memory + scoped course/topic hybrid recall
  → StudentMemoryContext[]
  → StudentContext { memories }
  → renderStudentContext()
  → Main Agent runtimeContext/userPrompt
```

The current implementation uses `StudentContext`, while the design task's phrase `StudentContextSnapshot` is a conceptual description rather than a code type. `MemoryStudentContextBuilder` defaults to `limit = 8` scoped memories and `globalLimit = 10` direct global memories. It forwards `courseContext.courseCode` as `course` and `courseContext.topic` as `topic`.

The prompt renders only `[scope/kind] content`. Scores and the `direct` flag remain available in the structural context/tool result but are not currently rendered in the default prompt. If Memory recall throws, the controller's normal turn fails; there is no special “empty context” fallback for a configured builder. If no builder is configured, the runtime proceeds without preloaded Memory.

The four Memory paths are related but distinct:

- Baseline recall happens before the model call, through the controller's injected `StudentContextBuilder`, and becomes prompt context.
- `recall_memory` is a model-invoked read-only tool during the Harness loop. It uses the same `StudyMemoryReader` capability, can receive query/course/topic/limits, and returns structured memory context to the model.
- `manage_memory` is the deliberate hot-path write tool. It passes a validated structural command through the authenticated bridge to `MemoryService.manage()` and records the tool name without creating Evidence.
- Post-turn Observation is the awaited system-triggered write path after a successful answer. It calls `MemoryService.observe()` and uses the real Harness session identity.

## 10. Knowledge Tool Flow

### `search_knowledge`

```text
DSH child tool call
  → config/main-agent-tools.mjs registration
  → POST /tool with Bearer token
  → StudyToolBridge.#handle()
  → StudyToolBridge.#execute('search_knowledge')
  → StudyAgentToolServices.knowledgeService.search()
  → LightRAGKnowledgeService.search()
  → LightRAG worker query-course
  → returned chunks + NormalizedDocumentLoader metadata
  → Evidence[]
  → bridge Evidence Map keyed by evidenceId
  → tool result returned to Harness
  → final StudyTurnResult.evidence
```

The bridge takes `course` from the tool argument or the active turn's `CourseContext.courseCode`; it rejects the call if no course is available. `week` and `limit` are optional integer filters. `LightRAGKnowledgeService` checks that the course has indexed state, loads normalized documents, filters by week after mapping document ids, deduplicates chunks, sorts scored Evidence, and returns at most 20 items. Evidence gets a stable `evidence_lightrag_<sha256-prefix>` id and metadata containing document/resource/source/normalization/LightRAG locator information.

### `get_resource`

```text
DSH child tool call
  → authenticated bridge
  → StudyAgentToolServices.resourceReader.readText(resourceId)
  → LocalKnowledgeService.readText()
  → ResourceText or read/unsupported error
  → JSON tool result
  → Harness
```

The tool reads a known stable Resource id. It does not create Evidence and therefore cannot add to `StudyTurnResult.evidence`.

### `research_subagent`

```text
Main Agent tool call with rendered ResearchTask
  → native DSH `dsh-tool-subagent` / `spawn` provider
  → fresh child with Research prompt and strong model profile
  → child can call only `search_knowledge` and `get_resource`
  → shared authenticated StudyToolBridge and per-run retrieval budget
  → DSH `subagent.started` / `subagent.finished` notifications
  → `collectResearchExecutions()` parses ResearchResult
  → unknown Evidence ids are discarded
  → Main Agent synthesizes final response
```

The child may perform multiple retrieval actions; the current product cap is eight per active `StudyRun`. `search_knowledge` contributes metadata-rich LightRAG Evidence to the shared parent snapshot. `get_resource` returns `ResourceText` only. A failed child produces a safe `ResearchResult` limitation and `subagent_failed` metadata without replacing a successful Main Agent answer.

### `manage_memory`

```text
DSH child tool call
  → authenticated bridge
  → validate MemoryCandidate-shaped command
  → StudyAgentToolServices.memoryManager.manage()
  → MemoryService.manage()
  → MemoryResolver
  → MemoryLifecycleManager
  → MemoryStore / SQLite
  → safe operation/id/key/status result
  → Harness
```

The tool accepts `ADD`, `UPDATE`, `RESOLVE`, `ARCHIVE`, and `DELETE`; the Resolver may return `NOOP`. The bridge derives current course/topic defaults where the selected scope uses them, attaches the active `runId` as `sourceTurnId`, and keeps service failures behind a stable safe error. DELETE requires both `sourceType = user_explicit` and `deleteIntent = explicit_user_forget`. Memory mutation results are tool data, not course Evidence.

The bridge collects Evidence only from the `search_knowledge` path, deduplicates by `evidenceId`, records every requested tool name in insertion order, and snapshots both values after Harness returns.

## 11. Memory Architecture

The implementation is a layered service, not a single Memory table wrapper:

```text
MemoryObservation / MemoryCandidate
  → DeepSeekFlashMemoryCandidateExtractor
  → MemoryResolver
  → MemoryLifecycleManager
  → MemoryStore
```

### Persistence and canonical state

- `MemoryStore.add()` and `update()` validate scope, kind/key compatibility, scores, and embeddings in transactions.
- Canonical Memory kinds use unique `memory_key` values. `learning_episode` is append-oriented and has no canonical key.
- `MemoryResolver` applies source priority: `agent_inferred < derived < system_observed < user_explicit`. Lower-priority candidates cannot overwrite stronger existing canonical state.
- Operations are `ADD`, `UPDATE`, `RESOLVE`, `ARCHIVE`, `DELETE`, and `NOOP`; the store writes an event for persisted operations.
- Hard Delete requires an existing target, `sourceType = user_explicit`, and `deleteIntent = explicit_user_forget`. Direct `forget(memoryId)` remains the explicit service-level Forget entry point.
- Active canonical Memory keeps its embedding and FTS row synchronized. Resolve/archive/delete remove the embedding/FTS representation as appropriate.
- `MemoryLifecycleManager` embeds new/updated content through `MemoryEmbeddingProvider` and bounds active course Episodes to 50 by default, archiving the least useful candidates after considering consolidation, importance, access count, and recency.
- `MemoryService` deduplicates an exact Learning Episode formed twice in one `sourceTurnId` using scope/course/topic and normalized content. The bounded in-memory turn map preserves independent Episodes from later turns and requires no new SQLite domain.

### Candidate extraction and providers

`DeepSeekFlashMemoryCandidateExtractor` uses `MemoryCompletionProvider` and validates the JSON result into candidates. `DeepSeekFlashMemoryProvider` calls the OpenAI-compatible DeepSeek `/chat/completions` endpoint with JSON response format, temperature 0, and disabled thinking. The API key comes from an explicit option or `DEEPSEEK_API_KEY` loaded from repository `.env`.

`BgeM3MemoryEmbeddingProvider` calls `services/memory-service/python/memory_embedding_worker.py`. Vectors are stored in `memory_embeddings`; this is independent from LightRAG's embedding/index state.

### Recall

`MemoryRetriever` direct-loads active global Memory up to `globalLimit`, then ranks course/topic candidates with:

```text
total = semantic * 0.55
      + keyword * 0.20
      + importance * 0.10
      + confidence * 0.10
      + recency * 0.05
```

Semantic score uses normalized cosine similarity over BGE-M3 vectors; keyword score comes from SQLite FTS5; recency decays with a 30-day scale. Returned memories increment `last_accessed_at` and `access_count`.

### Hybrid formation boundary

The same `MemoryService` instance now serves two write triggers. `manage_memory` calls `manage()` during the Harness loop; the Controller calls `observe()` after a successful completed turn. Both converge on the same Resolver, Lifecycle Manager, Store, embedding provider, and event history. The trigger and timing differ; the lifecycle operation set is shared. See [Memory Design Supplement](./Monash_Study_Agent_Memory_设计补充.md) for intended policy.

## 12. Knowledge / RAG Architecture

### Resource and normalization

`LocalKnowledgeService.scan()` recursively reads configured source roots, ignores hidden/generated names, uses downloader `last sync.json` hints when available, derives course/week/type metadata, and computes stable SHA-256 resource ids/hashes. `resources/resources.json` is a generated snapshot, not the future Resource Catalog.

`NormalizationService` chooses the first `ResourceNormalizer` that supports a Resource:

- `ForumNormalizer`: one document per Ed discussion thread.
- `TextNormalizer`: Markdown, QMD, and ordinary text.
- `CodeNormalizer`: source files.
- `CsvNormalizer`: CSV tables.
- `DocumentNormalizer` + `DoclingAdapter`: PDF, DOCX, and PPTX, including OCR/table region metadata.

Results are stored under `data/normalized/<course>/<source>/` as JSON plus inspectable Markdown. `.state/<resourceId>.json` records the source hash, normalizer version, status, and document references. Matching source hash/version and valid cached output produce `unchanged`.

### LightRAG runtime

`LightRAGWorkerClient` starts the repository-local Python environment and sends one versioned JSON request to `lightrag_worker.py` over stdin/stdout. Python `lightrag_runtime.py` owns LightRAG setup, DeepSeek LLM configuration, BGE-M3 embedding configuration, ingestion, deletion, batch synchronization, and mixed-mode query. The protocol is defined in `lightrag-worker.v1.schema.json` and validated on both sides.

`LightRAGSyncService` compares normalized documents to SQLite index state using source hash, normalized hash, normalization version, and course. It journals runs and operations so incomplete work can be recovered and prior runs can be marked recovered. `LightRAGIndexStateStore` owns the TypeScript persistence view.

`LightRAGKnowledgeService` is the stable Knowledge interface. It enriches returned chunks with authoritative `NormalizedDocument` metadata and builds `Evidence`; LightRAG never becomes the owner of Resource or Memory persistence.

## 13. DSH / DeepSeek Harness Integration

The pinned DSH packages are `0.1.6-alpha.2` for the SDK client, protocol,
session, and LLM packages. The repository has two deliberately separated
integration paths: the current Web-owned `InProcessDshRuntime` and the
historical `DeepSeekHarnessRuntime` SDK adapter. Only the former represents
the Single Runtime Web path.

### Current Single Runtime Web session and conversation

`InProcessDshRuntime` uses the DSH Web `SessionController` and `Agent` services
already owned by the Web host. It calls
`SessionController.create({ sessionId?, cwd: applicationRoot, agentPreset:
'monash-study-agent' })`, selects the logical model, prompts the returned
Agent, waits for `whenIdle()`, and reads the Agent session event snapshot. With
no `sessionId`, DSH creates a new Web session; with one, DSH attempts to
continue that persisted session. The returned DSH session id is mapped to both
product conversation fields.

### Historical / Legacy SDK session and conversation

`DeepSeekHarnessRuntime` caches one `DeepSeekHarnessDriver` per logical
profile. It calls `harness.session(sessionId).run(prompt.userPrompt)`. With no
`sessionId`, the Legacy SDK creates a session; with one, it continues it. The
adapter reads the last `turn/start` or `turn/end` event with a numeric
`data.turn`, returns that as `turnId`, and maps the SDK session id to both
product conversation fields. This adapter is not called by the current Web
path.

### Prompt and model mapping

`renderMainStudyAgentPrompt()` keeps system prompt, runtime context, and user
prompt separate. The current Web runtime supplies this product prompt to the
in-process Agent and dispatches product tools through
`InProcessDshRuntime.executeTool()`. The default tool-enabled prompt is
`main-study-agent-v5`; it defines the four direct tools plus
`research_subagent`, distinguishes hot-path management from Post-turn
Observation, preserves source-type semantics, requires a successful mutation
result before the Agent confirms persistence, and explicitly requires a
limitation when Knowledge returns no usable Evidence.

`config/main-agent.cordis.patch.yml` sets `personaPrefix` from
`MONASH_STUDY_AGENT_SYSTEM_PROMPT`, inserts `./main-agent-tools.mjs`, and
conditionally inserts the native DSH Research child for the **Legacy SDK
path**. It must not be read as the current Web turn wiring.

Product code sees only `fast`/`strong`. The current mapping is:

| Product profile | DSH provider | DSH model |
| --- | --- | --- |
| `fast` | `deepseek-official` | `deepseek-v4-flash` |
| `strong` | `deepseek-official` | `deepseek-v4-pro` |

The native Research entry is `@deepseek-ai/dsh-tool-subagent` with provider `spawn`, `backgroundMode: one-shot`, `maxDepth: 1`, and a `toolFilter.allow` list containing only `search_knowledge` and `get_resource`. The base profile's generic `subagent`, `subagent_fork`, control, and list-agents rows are disabled in the product patch, so Main Agent delegation cannot silently fall back to another child contract. Its independent persona is `research-subagent-v2`; the child model route is `deepseek-official/deepseek-v4-pro`. The product adapter consumes DSH `subagent.started` and `subagent.finished` notifications but exposes only safe task/status/count metadata through `AgentEvent`. The child prompt also requires empty/limited Evidence to remain explicit and forbids secrets, local absolute paths, stack traces, and internal runtime objects.

The pinned DSH `0.1.6-alpha.2` types/documentation expose no reliable wire-level mid-turn cancellation API: an active request continues until the runtime is closed. The product honors `AbortSignal` before Harness execution and does not claim unsupported mid-turn cancellation; future cancellation work must be verified against a newer DSH contract.

### Cordis boundary

`packages/dsh-integration/src/ui-host.ts` registers the current Web
`InProcessDshRuntime` and `MonashStudyUiService`. The service owns one shared
`StudyApplication` instance, exposes `monashStudy/runTurn`,
`monashStudy/listCourses`, and the native `monashStudy/runEvents` stream, and
closes the application through the Cordis lifecycle. `plugin.ts` remains a
compatibility registration surface for profiles that still load the older
integration entry. Product domain packages do not import Cordis, and DSH
response types do not cross into `shared-types`, `study-core`, or the UI.

The DSH findings and the full Round 1 UI contract are recorded in
[`UI_IMPLEMENTATION_REFERENCE.md`](./UI_IMPLEMENTATION_REFERENCE.md). The
browser package uses the DSH slot system rather than a parallel React router:
`sidebar.panellist.id` and `main.key` are both `monash-study`.

## 14. Tool Bridge and Authentication Mechanism

The bridge keeps Knowledge, Resource, and Memory services product-owned while
allowing the DSH Agent to request their capabilities. The transport differs by
runtime path.

### Current Single Runtime Web bridge

1. `MonashStudyUiService` lazily creates `StudyApplication` and configures the
   current `InProcessDshRuntime` with `StudyToolBridge`.
2. `InProcessDshRuntime.runTurn()` calls `begin(runId, input)` before prompting
   the DSH Web Agent. The Agent's owner is checked and tool calls use
   `StudyToolBridge.executeDirect()` in the same host process; no child bridge
   URL or bearer token is needed for this path.
3. `StudyToolBridge` dispatches the validated tool name and arguments, records
   per-run tool names/Evidence/research-action counts, and returns safe tool
   results. `snapshot(runId)` is copied into `StudyTurnResult`; `end(runId)`
   clears active state in `finally`.

### Historical / Legacy SDK bridge

1. `DeepSeekHarnessRuntime` constructs `StudyToolBridge` when `toolServices`
   is supplied.
2. Before the first Legacy SDK child creation, `StudyToolBridge.start()` binds
   an ephemeral TCP port on `127.0.0.1`, generates a random UUID bearer token,
   and returns URL/token.
3. `DeepSeekHarnessRuntime.#createDefaultHarness()` places URL and token in
   the child environment as `MONASH_STUDY_AGENT_TOOL_BRIDGE_URL` and
   `MONASH_STUDY_AGENT_TOOL_BRIDGE_TOKEN`.
4. The Legacy DSH child plugin reads those variables and registers the four
   direct tool schemas. The Legacy Cordis patch separately installs the native
   `research_subagent` tool when
   `MONASH_STUDY_AGENT_ENABLE_RESEARCH_SUBAGENT=1`.
5. The child sends `POST /tool` with `Authorization: Bearer <token>` and a
   JSON `{ name, arguments }` body. `StudyToolBridge.#handle()` checks the
   method/path, token, request size, JSON shape, and active run.
6. `begin()`, `snapshot()`, and `end()` enforce the same one-turn and bounded
   retrieval semantics as the Web path. This transport is Legacy SDK-only and
   is not the current Web Main Agent path.
8. Model-facing tool values are projections: Evidence keeps identity/course/title/content/source/score and safe locator metadata only; Resource text omits absolute path, root, size, hashes, and downloader metadata; recalled Memory omits timestamps, access counters, and source-session metadata. The parent retains full Evidence for Evidence-id validation and `StudyTurnResult` propagation.
9. Provider failures are converted to stable safe tool errors; error messages containing API keys, tokens, `.env`, SQLite, stack traces, or absolute paths are redacted.
10. `InProcessDshRuntime.close()` closes current Web bridge state; the Legacy
    `DeepSeekHarnessRuntime.close()` also closes cached SDK drivers. Both
    runtime and application close operations are idempotent.

The token is generated at runtime and never committed. The bridge is loopback-only by default. The current `#active` field intentionally rejects concurrent turns; a future concurrent runtime would need an explicit run-scoped registry rather than relaxing this check.

## 15. Agent Events

The actual event union is:

```text
run_started
student_context_failed
model_started
model_completed
answer_completed
subagent_started
subagent_completed
subagent_failed
memory_observation_started
memory_observation_completed
memory_observation_failed
run_completed
run_failed
```

`StudyController` emits run, context, observation, and failure events.
`student_context_failed` is emitted after `run_started` and before the runtime
starts; it carries only `STUDENT_CONTEXT_FAILED` and the turn continues with
empty context. Both current Web and Legacy adapters emit model events; the
Legacy adapter additionally maps native DSH Research notifications. Research
events include only `subagentName`, `taskId`, Evidence count when available,
and `SUBAGENT_FAILED` on failure. Observation completion may include a result
count; observation failure uses `MEMORY_OBSERVATION_FAILED`. Payloads contain
only `runId`, ISO timestamp, optional session/conversation/turn ids, optional
logical model profile, optional count, and optional stable error code. Prompts,
model answers, tool arguments, Memory content, Evidence content, child
output, and secrets are intentionally not included.

`NoopAgentEventSink` is the normal default; `InMemoryAgentEventSink` records safe events for tests. A future UI or tracing adapter should consume `AgentEventSink` rather than importing DSH event objects.

## 16. Error Model

`StudyRuntimeError` is the product boundary with codes:

| Code | Current meaning | Typical source | Turn behavior |
| --- | --- | --- | --- |
| `INVALID_INPUT` | Empty query or invalid course context | Controller/runtime validation | Terminates before/at runtime |
| `SESSION_ERROR` | Conversation identity cannot be continued | Web `SessionController` or Legacy Harness adapter identity check | Terminates |
| `MODEL_ERROR` | DSH Agent returned an empty answer | Current Web or Legacy DSH adapter | Terminates |
| `HARNESS_ERROR` | DSH could not complete or returned no turn identity | Current Web or Legacy DSH adapter/driver | Terminates |
| `ABORTED` | Abort signal was already set before execution | DSH adapter | Terminates |
| `CONCURRENT_RUN` | Another turn is active in the same application/runtime | Controller/runtime/bridge | Terminates only the second call; active turn continues |
| `SUBAGENT_FAILED` | Native Research child did not complete successfully | DSH notification adapter | Main Agent answer remains recoverable |
| `UNKNOWN` | Unclassified failure converted at controller boundary | Controller catch block | Terminates |

`STUDENT_CONTEXT_FAILED` and `MEMORY_OBSERVATION_FAILED` are `AgentEvent` lifecycle codes rather than fatal `StudyRuntimeError` values: they record recoverable pre-turn context or post-answer formation failures while the completed turn continues successfully.

Tool-level Knowledge, Resource, and Memory failures are caught inside the
product bridge and returned as safe tool results to the current Web Agent or
Legacy DSH child. They do not automatically throw through the parent runtime.
A Student Context builder failure emits `student_context_failed`, supplies
empty context, and continues. A Post-turn Memory observation failure is also
non-fatal after an answer: the Controller emits `memory_observation_failed`,
then `run_completed`, and returns the existing `StudyTurnResult`. Invalid
input, session identity errors, DSH/model failures, missing turn identity,
pre-execution abort, and `CONCURRENT_RUN` for the second call remain fatal for
that call.
Legacy Research child failures follow the same recoverability boundary: the
adapter emits `subagent_failed`, records a limitation, and preserves the Main
Agent's already-produced final answer. A successful child does not bypass Main
Agent synthesis.

## 17. CLI and Scripts

| Command | Purpose | Entry file | Main dependencies |
| --- | --- | --- | --- |
| `pnpm run scan` | Scan configured Ed/Moodle roots and write manifest | `scripts/scan-resources.ts` | `LocalKnowledgeService`, `config/sources.local.json` |
| `pnpm normalize -- all` | Normalize every manifest Resource | `scripts/normalize.ts` | `LocalKnowledgeService`, `NormalizationService` |
| `pnpm normalize -- course FIT2109` | Normalize one course | `scripts/normalize.ts` | Same |
| `pnpm normalize -- resource <id>` | Normalize one Resource | `scripts/normalize.ts` | Same |
| `pnpm lightrag -- health` | Check Python LightRAG runtime | `scripts/lightrag.ts` | `LightRAGWorkerClient` |
| `pnpm lightrag -- model-health` | Check DeepSeek/BGE-M3 model path | `scripts/lightrag.ts` | LightRAG worker |
| `pnpm lightrag -- ingest-document <id>` | Ingest one normalized document | `scripts/lightrag.ts` | Loader, worker |
| `pnpm lightrag -- sync-course <course>` | Plan/execute incremental course sync | `scripts/lightrag.ts` | `LightRAGSyncService` |
| `pnpm smoke:lightrag` | Real LightRAG smoke | `scripts/smoke-lightrag.ts` | Runtime config, local Python env |
| `pnpm smoke:memory` | Memory provider/lifecycle smoke | `scripts/memory-smoke.ts` | Memory Service, DeepSeek, BGE-M3 |
| `pnpm agent-smoke -- --course FIT2109 --query "..."` | Legacy SDK/model-only single turn; not Single Runtime or Knowledge E2E | `scripts/agent-smoke.ts` | Legacy DSH SDK runtime |
| `pnpm agent-smoke -- ... --continuity` | Add legacy SDK session continuity check | `scripts/agent-smoke.ts` | Legacy DSH session identity |
| `pnpm agent-tools-smoke` | **Legacy SDK:** real Main Agent tool calling + Evidence propagation | `scripts/agent-tools-smoke.ts` | Legacy DSH, bridge, Memory, local Resource reader |
| `pnpm agent-memory-smoke` | **Legacy SDK:** real Post-turn write, `manage_memory`, and new-session Recall | `scripts/agent-memory-smoke.ts` | Legacy DSH, DeepSeek Memory extraction, BGE-M3, temporary SQLite |
| `pnpm agent-research-smoke` | **Legacy SDK:** real Main Agent → native Research child → multi-step LightRAG retrieval → final synthesis | `scripts/agent-research-smoke.ts` | Legacy DSH 0.1.6-alpha.2, LightRAG, local manifest, DeepSeek |
| `pnpm run typecheck` | Strict no-emit TypeScript check | `tsconfig.json` | TypeScript |
| `pnpm run build` | Compile package/scripts/services declarations and JS | `tsconfig.build.json` | TypeScript |
| `pnpm test` | Run all tracked `tests/**/*.test.ts` | `package.json` | `tsx --test` |

## 18. Runtime Configuration

| Configuration | Purpose | Source/default behavior |
| --- | --- | --- |
| `config/runtime.json.schemaVersion` | Runtime config version | `1` |
| `knowledgeProvider` | Product Knowledge implementation selection | `lightrag`; composition rejects unsupported values |
| `MONASH_STUDY_AGENT_ROOT` | Explicit Monash product workspace anchor for Web/profile launch | Product launcher; never inferred from DSH profile location |
| `MONASH_STUDY_AGENT_RUNTIME_CONFIG` | Explicit runtime JSON path | Product launcher/profile; relative paths resolve against application root |
| `MONASH_STUDY_AGENT_RESOURCE_MANIFEST` | Explicit Resource Manifest path | Product launcher/profile; defaults under application root |
| `paths.*` | Normalized root, Python executable, and worker script locations | Relative to explicit application root; resolved once by `loadRuntimeConfig()` |
| `lightrag.workingRoot` | Python LightRAG working directory | `data/runtime/lightrag` |
| `lightrag.sqlitePath` | Shared SQLite path | `data/runtime/monash-study-agent.sqlite` |
| `lightrag.llm.model` | Python LightRAG LLM label | `deepseek-flash` |
| `lightrag.llm.baseUrl` | DeepSeek API base URL | `https://api.deepseek.com` |
| `lightrag.embedding` | BGE-M3 model, dimension, token/batch/concurrency settings | `BAAI/bge-m3`, 1024 dimensions, local worker |
| `lightrag.query` | Mixed retrieval mode and top-k bounds | `mix`, topK 20, chunkTopK 20, rerank false |
| `config/sources.local.json` | Machine-specific course roots | Ignored; copy from `sources.example.json` |
| `.env` / `DEEPSEEK_API_KEY` | Secret for real DeepSeek model calls | Ignored; loaded once by the launcher/bootstrap |
| DSH bridge environment | Child-side tool URL/token and prompt | Created only by `DeepSeekHarnessRuntime` |
| Research retrieval budget | Maximum combined direct/Research bridge retrieval actions per turn | `RESEARCH_SUBAGENT_ACTION_BUDGET = 8` |
| `services/knowledge-service/.venv` | Project-local Python environment | Ignored; Docling/LightRAG/BGE-M3 dependencies installed locally |

No secret value is part of this reference.

## 19. SQLite and Persistence

`packages/runtime-database/src/runtime-database.ts` currently reports schema version 4 and applies migrations atomically through `schema_migrations`.

| Table | Created by | Owner | Lifecycle |
| --- | --- | --- | --- |
| `schema_migrations` | Runtime database bootstrap | Runtime database | Records applied migration versions |
| `lightrag_index_state` | Migration 1 | `LightRAGIndexStateStore` | One current state per normalized document; deleted on document removal |
| `knowledge_sync_runs` | Migration 2 | `LightRAGIndexStateStore` / sync service | Run journal: running, incomplete, failed, completed, recovered |
| `knowledge_sync_operations` | Migration 2 | Sync service | Per-document journal rows for recovery/audit |
| `memories` | Migration 3 | `MemoryStore` | Canonical active/resolved state and active/archived Episodes |
| `memory_embeddings` | Migration 3 | `MemoryStore` + embedding provider | One embedding per active Memory; removed when deactivated |
| `memory_events` | Migration 3 | `MemoryStore` | Append-only persisted operation history |
| `memory_fts` | Migration 4 | `MemoryStore` | FTS5 content mirror for active Memory |
| `memory_episode_consolidations` | Migration 4 | `MemoryStore` | Episode-to-higher-Memory consolidation links |

There is no separate committed migration directory. Migrations are code constants in the runtime-database package. LightRAG and Memory share the same SQLite file through the shared connection/migration foundation; LightRAG does not read Memory tables and Memory does not read LightRAG index contents.

## 20. Tests and Verification

### Automated tests

The tracked test suite is organized around normalization, worker protocol, LightRAG state/sync/retrieval, Resource reads, Memory persistence/intelligence, runtime composition, Main Agent/bridge behavior, Research Subagent contracts, and DSH UI boundary behavior. Round 1 adds `tests/dsh-ui-plugin.test.ts` for AgentEvent mapping, Evidence metadata preservation, stable error labels, Typert descriptors, and sidebar/main registration disposal.

### High-value real smoke coverage

- `pnpm agent-smoke -- --course FIT2109 --query "Briefly explain what a Git branch is."` verifies only the legacy DeepSeek Harness SDK/model turn.
- `pnpm agent-smoke -- ... --continuity` verifies only legacy DSH session identity continuity; it is not a Web-equivalent or Knowledge E2E.
- `pnpm agent-tools-smoke` (**Legacy SDK**) verifies real Harness tool calls for `recall_memory` and `search_knowledge`, authenticated bridge dispatch, and Evidence propagation to `StudyTurnResult`. The verification fixture asserted Evidence id `smoke-evidence-ORANGE-731`; the smoke also uses the real Memory Service read path and local Resource reader.
- `pnpm agent-memory-smoke` (**Legacy SDK**) uses a temporary SQLite database and verifies real DSH answer completion followed by DeepSeek/BGE-M3 Post-turn persistence, a real authenticated `manage_memory` tool call, and baseline Memory Recall in a different Harness session. The temporary database is removed in `finally`.
- `pnpm agent-research-smoke` (**Legacy SDK**) was run with explicit authorization on 2026-09-22. It verified native `research_subagent` completion, 8 bounded retrieval actions, both `search_knowledge` and `get_resource`, 25 LightRAG Evidence items in the final result, and non-empty Main Agent synthesis. The smoke used the existing ignored LightRAG runtime database/cache; it created no separate temporary data requiring cleanup. An initial authorized run exposed the incorrect depth-0 setting and generic fallback; the corrected run is the result recorded here.
- Browser verification on 2026-09-22 passed Fresh A and Same-process B in FIT2109, including a real `search_knowledge` call, LightRAG query, non-empty Evidence, and answer completion. Persisted Resume C restored the freshly-created session after Web restart and completed a third turn without `entry._await`. The resumed third turn's fresh follow-up search then failed with `Study Agent services are not configured`, and the UI answered from Evidence already retrieved earlier. The exact product boundary is `packages/dsh-integration/src/in-process-dsh-runtime.ts:75`, where `executeTool()` has no restored `toolBridge`. The package-graph issue is fixed and the old `_await` error is not reproduced; full post-restart Knowledge browser E2E remains unvalidated until this product bridge binding boundary is resolved.
- `pnpm smoke:memory` and `pnpm smoke:lightrag` exercise real provider/runtime boundaries and require the local dependencies/API configuration appropriate to those services.

Unit/integration tests use injected fake Harness drivers, fake LightRAG clients, temporary SQLite stores, and deterministic fixtures where an external provider is not required. The real smoke scripts remain separate from the default `pnpm test` command.

## 21. Current Implementation Status

| Capability | Status | Main implementation |
| --- | --- | --- |
| Resource discovery/manifest | Complete | `LocalKnowledgeService`, `scan-resources.ts` |
| Markdown/text/code/CSV normalization | Complete | Normalization service and normalizers |
| Docling PDF/DOCX/PPTX conversion | Complete | `DoclingAdapter`, `docling_worker.py` |
| LightRAG runtime foundation | Complete | Worker protocol/client/runtime |
| Real DeepSeek LightRAG ingestion | Complete | `lightrag_runtime.py`, `lightrag.ts` |
| BGE-M3 LightRAG embeddings | Complete | LightRAG Python runtime config |
| Incremental/course LightRAG sync | Complete | `LightRAGSyncService`, SQLite journal |
| Evidence retrieval | Complete | `LightRAGKnowledgeService` |
| Long-term Memory persistence | Complete | `MemoryStore`, migrations 3–4 |
| DeepSeek candidate extraction | Complete | DeepSeek Memory provider/extractor |
| Deterministic resolver | Complete | `MemoryResolver` |
| Hybrid Memory recall | Complete | `MemoryRetriever`, FTS5, BGE-M3 |
| Episode lifecycle/forget | Complete | `MemoryLifecycleManager`, `MemoryService` |
| Main Agent provider-neutral runtime | Complete | `StudyAgentRuntime`, `StudyController` |
| Legacy SDK Harness conversation continuity | Complete; Legacy only | `DeepSeekHarnessRuntime` |
| Single Runtime Web session creation/resume | Partially validated; Fresh A, same-process B, and post-restart session history/turn resume pass without `_await`; post-restart fresh tool dispatch is not restored | `InProcessDshRuntime`, DSH Web `SessionController`, `StudyToolBridge` |
| Student Context integration | Complete | `MemoryStudentContextBuilder` |
| Knowledge/Resource/Memory tools | Complete | Four DSH tools + authenticated `StudyToolBridge` |
| Evidence propagation | Complete | Bridge snapshot → `StudyTurnResult` |
| Post-turn Memory observation | Complete | Awaited structural observer in `StudyController` with non-fatal failure events |
| Memory management tool | Complete | `manage_memory` → authenticated bridge → `MemoryService.manage()` |
| Hybrid formation idempotence | Complete | Canonical keys + Resolver; exact same-turn Episode deduplication |
| Research Subagent | Product contract complete; Legacy SDK smoke passed; current Web E2E not validated | `ResearchTask`/`ResearchResult`, native DSH `research_subagent`, restricted child tools, adapter, safe events |
| End-to-end multi-agent workflow | Legacy SDK smoke passed; current Web E2E not validated | Main prompt delegation → native child → bounded retrieval → Evidence-backed Main synthesis |
| Backend composition and contract freeze | Complete; Round 5 integration matrix passed | `createStudyApplication`, stable UI contract, failure policy, concurrency/cleanup, safe model payloads |
| DSH React UI plugin | Vendored single-graph boot and Fresh A/B browser turns pass; post-restart fresh tool dispatch remains pending | `packages/dsh-ui-plugin`, `packages/dsh-integration/src/ui-service.ts`, `tests/dsh-ui-plugin.test.ts` |
| Electron shell | Not implemented | No Electron package |

## 22. Development History

The repository history is the source of truth for how the current boundaries were introduced. The following milestone summaries are based on the actual commits and their changed-file sets.

All runtime chains in this section are historical snapshots of the milestone
being described. They are not claims about the current Single Runtime Web
path; for current Web behavior, use Sections 2, 8, 13, and 14.

### `65a37d5` — Add resource normalization pipeline

- Purpose: establish deterministic Resource-to-NormalizedDocument conversion.
- Added Markdown/QMD/text/code/CSV/forum normalizers, Docling adapter/worker, normalization CLI, persisted output/state, and tests.
- Architecture impact: created the `Resource → NormalizedDocument` boundary and retained source hashes/locators for later indexing.
- Main files: `services/knowledge-service/src/normalization/*`, `services/knowledge-service/python/docling_worker.py`, `scripts/normalize.ts`, `packages/shared-types/src/normalized-document.ts`.

### `3a40738` — Add LightRAG runtime foundation

- Purpose: create the TypeScript/Python LightRAG worker boundary and normalized document loader.
- Added worker protocol/client, Python worker, loader, and foundational tests.
- Architecture impact: made LightRAG a replaceable external runtime behind a versioned JSON protocol.

### `b979420` — Add real LightRAG model runtime and ingestion

- Purpose: connect the worker to real LightRAG, DeepSeek, and embedding configuration.
- Added real Python runtime setup, ingestion/deletion path, environment loading, and operational CLI behavior.
- Architecture impact: moved from a protocol stub to a real local LightRAG model runtime.

### `16263fb` — Add incremental LightRAG index state

- Purpose: avoid re-indexing unchanged normalized documents.
- Added `LightRAGIndexState`, SQLite state store, currentness checks, and tests.
- Architecture impact: indexing became hash/version aware and recoverable at the document-state boundary.

### `bfeb303` — Add course-level LightRAG synchronization

- Purpose: synchronize a whole course with index/replace/remove operations.
- Added course planning, batch worker operations, and sync tests.
- Architecture impact: introduced course-scoped sync as a first-class workflow.

### `1e9efee` — Add LightRAG evidence retrieval

- Purpose: expose retrieval as product-owned structured Evidence.
- Added `LightRAGKnowledgeService`, chunk-to-document mapping, deduplication, scoring, and retrieval tests.
- Architecture impact: stabilized the `KnowledgeService → Evidence` boundary and preserved source metadata.

### `f4993df` — Stabilize application and retrieval boundaries

- Purpose: make the application composition and retrieval smoke explicit.
- Added `StudyRuntime` composition behavior, retrieval smoke, README/architecture clarification, and provider selection validation.
- Architecture impact: separated product composition from the concrete LightRAG provider.

### `a83e707` — Build memory persistence foundation

- Purpose: create canonical Memory persistence over the shared runtime database.
- Added runtime database migrations, shared Memory types, `MemoryStore`, canonical keys, and persistence tests.
- Architecture impact: established Memory as an independent service owner with transactional SQLite state.

### `2b1a398` — Add memory intelligence and hybrid recall

- Purpose: add candidate extraction, deterministic resolution, embeddings, retrieval, and lifecycle.
- Added DeepSeek Flash provider/extractor, BGE-M3 provider, resolver, retriever, lifecycle manager, FTS/embedding tables, and tests.
- Architecture impact: changed Memory from CRUD persistence into a policy-bearing recall/lifecycle service.

### `63c6969` — Validate real memory runtime

- Purpose: exercise real DeepSeek/BGE-M3 Memory provider paths and stabilize the smoke.
- Added `scripts/memory-smoke.ts` and related provider/key handling and tests.
- Architecture impact: documented and validated the real provider seams without coupling them to the Main Agent yet.

### `41e5cdbb221a2f9e68fe39abcdc735c97dacee62` — Build main study agent runtime

- Purpose: establish the provider-neutral Main Agent turn boundary and real Harness adapter.
- Added `StudyAgentRuntime`, `StudyTurnInput/Result`, logical model policy, prompt versioning, lifecycle events, runtime errors, thin controller orchestration, DSH SDK integration, prompt patch, smoke script, build configuration, and tests.
- Runtime chain: `StudyController → StudyAgentRuntime → DeepSeekHarnessRuntime → DSH session → StudyTurnResult`.
- DSH mapping: product `fast`/`strong` profiles map to the pinned `deepseek-v4-flash`/`deepseek-v4-pro` routes; DSH session identity is returned as the product conversation reference.
- Stable boundary: provider-specific DSH types stop in `packages/dsh-integration`.

### `19b2440a2f7a842fc397ea1f2b54980ece865100` — Add main agent study context and tools

- Purpose: integrate Student Context and read-only product capabilities into the real Main Agent loop.
- Added `StudentContext`, `StudentContextBuilder`, Memory baseline recall injection, prompt version `main-study-agent-v2`, child-side tool registration, authenticated loopback `StudyToolBridge`, `search_knowledge`, `get_resource`, `recall_memory`, Evidence collection, `toolsUsed`, targeted tests, and real Harness tool-calling smoke.
- Runtime chain: `DSH tool call → bearer-token bridge → product reader/service → structured tool result → Harness → bridge Evidence snapshot → StudyTurnResult`.
- Stable boundary: the bridge owns transport and per-run artifact collection, while Knowledge and Memory services remain owners of their data.

### `6932562bb48b02995ee0ba1f98a53a80de3f609a` — Integrate hybrid memory formation

- Purpose: connect the Main Agent lifecycle to both system-triggered and agent-triggered Long-term Memory formation.
- Added structural completed-turn observer and Memory manager capabilities, awaited non-fatal observation events, the `manage_memory` DSH tool and bridge dispatch, prompt version `main-study-agent-v3`, explicit Forget authorization, and bounded exact same-turn Episode deduplication.
- Runtime chains: `StudyTurnResult → StudyPostTurnObserver → MemoryService.observe()` and `DSH manage_memory → authenticated bridge → MemoryService.manage()` converge on the existing Resolver, Lifecycle Manager, Store, embeddings, and SQLite event history.
- Verification: 63 tests, typecheck, build, real Hybrid Memory smoke, real Main Agent continuity smoke, and existing Agent Tool/Evidence smoke passed. The Hybrid smoke used temporary SQLite and proved a distinct new Harness session recalled the written strategy.

### `3bee2e0309995fd3373de42b1ab5e6490686ea18` — Integrate research subagent runtime

- Purpose: add the smallest product-owned multi-agent path for complex course research while keeping DSH responsible for native child execution.
- Added `ResearchTask`/`ResearchResult` contracts, an independent Research prompt, Main Agent delegation rules, native `dsh-tool-subagent` configuration, a strong child route, bounded read-only tool filtering, and a shared eight-action retrieval budget.
- Runtime chain: `Main Agent → research_subagent → native DSH spawn child → search_knowledge/get_resource → ResearchResult adapter → Main Agent synthesis → StudyTurnResult`.
- Added safe `subagent_started`/`subagent_completed`/`subagent_failed` events, Evidence-id validation, failure recovery, `subagentsUsed`, `researchActions`, unit coverage, and `agent-research-smoke.ts`.

### `f17f583fce328b9aacdc5e10ef199c30a5994a9f` — Harden native research smoke path

- Purpose: enforce one explicit native Research delegation route after the first authorized smoke exposed a `maxDepth: 0` rejection and a possible generic-subagent fallback.
- Disabled the base generic delegation rows, set the native child depth cap to one Main-Agent child level, strengthened smoke assertions for completed/no-failed lifecycle and both read tools, and corrected the retrieval-action counter to cap successful actions at eight.
- Verification: typecheck, build, 70 tests, and the authorized real `pnpm run agent-research-smoke` passed. The smoke recorded `subagentsUsed = [research]`, 8 research actions, `search_knowledge` + `get_resource`, 25 LightRAG Evidence items, and final synthesis.

### `bc42a00a34587d038a9f3dfd467b61a3e5cdd286` — Implement backend application freeze

- Purpose: finish the backend boundary before React UI work.
- Added `@monash-study/study-application` with `createStudyApplication()`, injectable real/fake Harness, Knowledge, Resource, Memory, event, and post-turn capabilities, plus idempotent shutdown.
- Hardened fatal/non-fatal policy: Student Context failures degrade to empty context; Knowledge/Resource/Memory tool failures return safe envelopes; Post-turn and Research failures remain recoverable; invalid input, Harness/model/session/turn identity, abort, and concurrent second runs remain fatal for that call.
- Added one-active-run enforcement, bridge cleanup in `finally`, bounded Research settings, cancellation limitation documentation for pinned DSH, and model-facing projections that omit absolute paths, hashes, secrets, stack details, and unnecessary Memory metadata.
- Verification: 78 tests, strict typecheck, and production build passed. The new integration matrix uses fake providers plus temporary SQLite and removes the temporary database in `finally`.

## 23. Where Do I Change X?

| I want to change... | Start here | Related files |
| --- | --- | --- |
| Main Agent system prompt | `packages/study-core/src/prompts/main-study-agent-prompt.ts` | `config/main-agent.cordis.patch.yml`, `DeepSeekHarnessRuntime` |
| Prompt version | `MAIN_STUDY_AGENT_PROMPT_VERSION` | Runtime result tests and smoke output |
| Model selection | `packages/study-core/src/agent-runtime.ts` (`ModelPolicy`) | `packages/study-controller/src/study-controller.ts`, DSH profile map |
| Course context validation/rendering | `StudyController.validateCourseContext` and prompt renderer | `CourseContext`, bridge active input |
| Student Context limits/shape | `packages/study-core/src/student-context.ts` | `StudyMemoryReader`, Memory Retriever |
| Add or change a Main Agent tool | Current Web: `InProcessDshRuntime.executeTool()` and `StudyToolBridge.#execute()`; Legacy SDK: `config/main-agent-tools.mjs` and `StudyToolBridge.#execute()` | `StudyAgentToolServices`, prompt, tool tests, real smoke |
| Add a durable tool registry | `packages/study-core/src/tools/study-tool.ts` | Replace current child schema/switch seam and update DSH bridge |
| Change Knowledge retrieval | `services/knowledge-service/src/lightrag/lightrag-knowledge-service.ts` | `KnowledgeService`, worker client, Evidence tests |
| Change Resource scan/read | `services/knowledge-service/src/local/local-knowledge-service.ts` | `scan-resources.ts`, Resource types |
| Change normalization | `services/knowledge-service/src/normalization/normalization-service.ts` | Relevant normalizer and Docling worker |
| Change LightRAG indexing | `services/knowledge-service/src/lightrag/lightrag-sync-service.ts` | Index state store, worker client, Python runtime |
| Change Memory recall | `services/memory-service/src/memory-retriever.ts` | `MemoryService`, BGE-M3 provider, FTS store |
| Change Memory write policy | `services/memory-service/src/memory-resolver.ts` | Candidate extractor, lifecycle manager |
| Change Memory persistence | `services/memory-service/src/memory-store.ts` | `runtime-database.ts`, shared Memory types |
| Change Memory extraction | `services/memory-service/src/deepseek-memory-candidate-extractor.ts` | DeepSeek provider, candidate contract |
| Change current Web DSH integration | `packages/dsh-integration/src/in-process-dsh-runtime.ts`, `src/ui-service.ts`, and `src/ui-host.ts` | `SessionController`, Web preset, Remote boundary, `StudyApplication`, current Web tests |
| Change Legacy SDK DSH integration | `packages/dsh-integration/src/deepseek-harness-runtime.ts` | Legacy prompt patch, child tools, bridge, legacy smokes |
| Change the DSH UI Host boundary | `packages/dsh-integration/src/ui-service.ts` and `src/ui-contract.ts` | `StudyApplication`, course summaries, UI error/event contract, `src/remote.ts` |
| Change the DSH Study page layout | `packages/dsh-ui-plugin/src/client/index.ts` | DSH slots/layout/primitives, `src/client/presenters.ts`, `UI_IMPLEMENTATION_REFERENCE.md` |
| Change DSH navigation identity or lifecycle | `packages/dsh-ui-plugin/src/client/registration.ts` and `packages/dsh-ui-plugin/src/index.ts` | `cordis.patch.yml`, UI integration tests |
| Add an Agent event | `packages/study-core/src/agent-runtime.ts` | Controller/DSH emission sites, event tests |
| Add a CLI command | Root `package.json` and a file under `scripts/` | Package entry exports and tests |
| Add a SQLite migration | `packages/runtime-database/src/runtime-database.ts` | Schema version, migration tests, service stores |
| Change post-turn Memory observation | `packages/study-controller/src/study-controller.ts` after runtime completion | `StudyPostTurnObserver`, `MemoryService.observe()`, event/error policy |
| Change `manage_memory` | Current Web: `InProcessDshRuntime.executeTool()` and `StudyToolBridge.#execute()`; Legacy SDK: `config/main-agent-tools.mjs` and `StudyToolBridge.#execute()` | `StudyMemoryManager`, `MemoryCandidate`, resolver safety tests |
| Add Research Subagent | Current Web: DSH `monash-study-agent` preset and `InProcessDshRuntime` event/result boundary; Legacy SDK: `packages/study-core/src/research-subagent.ts` and `packages/dsh-integration/src/research-adapter.ts` | Main prompt, Legacy native DSH patch entry, bounded bridge budget, tests, and Legacy smoke |
| Change the application composition root | `packages/study-application/src/index.ts` | `StudyApplicationOptions`, provider ownership, `StudyApplication.close()`, integration tests |
| Change backend failure policy | `packages/study-controller/src/study-controller.ts`, `packages/study-core/src/agent-runtime.ts` | Error codes, lifecycle events, `tests/study-application.test.ts` |
| Change model-facing payload safety | `packages/dsh-integration/src/study-tool-bridge.ts` | Tool tests, safe Evidence/Resource/Memory projections, error redaction |

## 24. Known Boundaries and Current Limitations

- Post-turn Observation is awaited for deterministic persistence. Its failure is non-fatal, while its latency remains part of the completed-turn response time.
- The same-turn Learning Episode deduplication registry is process-local and bounded to 256 turn ids. It addresses the Hybrid Formation double-write case without creating durable cross-run deduplication semantics.
- A first-turn `manage_memory` call may not yet know the newly created Harness session id at bridge-dispatch time; it carries the product `runId` as `sourceTurnId`. The completed-turn observer always carries the real returned Harness session id.
- `StudyToolBridge` and both `InProcessDshRuntime` and Legacy `DeepSeekHarnessRuntime` support one active turn per runtime instance; a second call receives `CONCURRENT_RUN` and the first call retains ownership.
- The pinned DSH release has no reliable mid-turn cancellation API. Only pre-execution `AbortSignal` handling is promised; active cancellation remains unsupported until the runtime is closed or DSH exposes a verified API.
- `StudyTurnResult` carries Evidence and tool names but does not persist a turn artifact or raw tool trace.
- `Tool Registry`, `Tool Execution Context`, and generic `Tool Result` abstractions are not yet separate TypeScript interfaces; the current child registration and bridge switch are concrete implementations.
- `connectors/ed` and `connectors/moodle` are type seams, not live synchronizers in this repository.
- `resources/resources.json` is a generated snapshot. A durable Resource Catalog is still planned.
- LightRAG index state and Memory share the SQLite file but not domain ownership or retrieval logic.
- Real provider smokes require local Python environments and, where applicable, `DEEPSEEK_API_KEY`; they are intentionally separate from the default unit test command.
- The real Round 4 smoke passed under explicit authorization using only the required FIT2109 research inputs. It used the existing ignored LightRAG runtime database/cache and created no separate temporary data requiring cleanup. Electron remains unimplemented.
- The Round 1 DSH UI is implemented in the separate `dsh-ui-plugin` package. A real web-profile run still depends on the local DSH profile, course manifest, and model configuration; the automated UI checks cover the Remote, mapping, and slot-registration boundaries.

## 25. Round 4 Research Integration Boundary

The implemented Round 4 boundary starts from the existing `StudyAgentRuntime` / DeepSeek Harness integration and returns a structured research result to the Main Agent:

```text
Main Study Agent
  → bounded research task
  → Research Subagent
  → repeated Knowledge retrieval
  → structured Evidence-backed research result
  → Main Study Agent synthesis
```

Round 4 preserves the current ownership model: Harness owns subagent execution, Knowledge Service owns retrieval and Evidence construction, Main Study Agent owns delegation and final synthesis, and Memory remains outside the Research child. The implementation is bounded to one native child task at a time with no recursive delegation and eight combined retrieval actions per active turn. The authorized real smoke passed on 2026-09-22 with 8 actions and 25 LightRAG Evidence items reaching the final result.

## 26. Round 5 Backend Hardening and Freeze

Round 5 establishes the final backend boundary before React UI work:

```text
UI
  → StudyApplication.runTurn()
  → StudyController
  → provider-neutral StudyTurnResult / AgentEvent / StudyRuntimeError
```

`createStudyApplication()` is the single outer composition root. It can construct the real LightRAG, Local Resource, MemoryService, and DeepSeek Harness path, or accept injected fakes for deterministic tests. The UI contract is frozen at `StudyTurnInput`, `StudyTurnResult`, `AgentEventSink`, and stable runtime error codes; raw DSH sessions, notifications, bridge tokens, tool arguments, Memory store internals, and provider exceptions remain behind the boundary.

The Round 5 integration matrix passed with 78/78 tests, strict typecheck, and production build. It covers direct turns, Knowledge/Resource/Memory tool failure envelopes, Student Context fallback, awaited Post-turn success/failure, Research success/failure recovery, one-active-run concurrency, bridge/runtime cleanup, idempotent close, safe model-facing projections, and temporary SQLite cleanup. The authorized real external course-data smoke remains the Round 4 FIT2109 Research smoke; Round 5's additional integration tests intentionally use fake providers and temporary local state to verify policy without sending additional course content.

### Round 1 DSH UI Plugin

Round 1 implements the first DSH browser surface on top of the frozen backend
contract. It adds a shared `MonashStudyUiService`, strict Typert Remote
descriptors, the `monash-study` sidebar/main route identity, per-course
conversation state, activity/evidence/error mapping, and the three-column
Courses/Chat/Evidence page. The UI-specific integration tests pass together
with strict typecheck and production build. The real DSH web-profile flow
remains a local runtime verification step because it depends on the user's
course manifest and model configuration.

## Maintenance Protocol

After every development round:

### Always update

- `Last verified commit`
- `Branch at verification` when it changes
- `Verified date`
- `Current Implementation Status`
- `Development History`

### If files are added, removed, or moved

Update:

- `Repository Directory Map`
- `Complete Important File Map`
- `docs/README.md` when a project-level document entry changes

### If an interface changes

Update:

- `Core Interfaces`
- `Package Dependency Map`
- the relevant file-map row

### If a runtime flow changes

Update:

- `Current Architecture`
- `Main Agent Turn Lifecycle`
- the relevant Student Context, Knowledge, Memory, or Tool flow

### If a Tool is added or changed

Update:

- `Knowledge Tool Flow` or a new tool-flow subsection
- `Where Do I Change X?`
- `Current Implementation Status`
- targeted and real smoke coverage references

Before committing this reference, re-run `git ls-files`, `git diff --check`, and the relevant repository verification commands. Do not put secret values, generated database contents, or machine-specific course paths in this document.
