# Monash Study Agent

Monash Study Agent is a complete, local-first learning Agent product for Monash course materials. It owns the study workflow, course knowledge, product configuration, connectors, and study interface.

Project documentation is indexed in [`docs/README.md`](docs/README.md). The implementation reference is [`docs/PROJECT_CODEBASE_REFERENCE.md`](docs/PROJECT_CODEBASE_REFERENCE.md); design intent is recorded separately in the linked V3.0 architecture and Memory documents.

DeepSeek Harness (DSH) is the product's internal Agent Runtime. It supplies sessions, the Agent loop, model execution, tool calling, conversation, presets, and Web runtime. The Cordis plugin entry is therefore an internal Runtime Integration Layer rather than the identity of this repository.

## Implemented product capabilities

The resource foundation provides:

- recursive local resource discovery for the existing Ed and Moodle download libraries;
- unified Resource metadata and a versioned Resource Manifest;
- SHA-256 content hashes and matching downloader metadata;
- UTF-8 reading for Markdown, QMD, source code, structured text, and ordinary text;
- registration without parsing for PDF, archives, Office files, and other binary resources;
- Study Controller dependency interfaces; and
- a DSH/Cordis integration boundary that keeps product code outside DSH Core.

The normalization foundation additionally provides:

- a traceable `Resource → NormalizedDocument → original file` model;
- Markdown, QMD, text, source-code, and CSV normalization;
- one normalized document per Ed discussion thread;
- Docling-backed PDF, DOCX, and PPTX conversion, including PDF OCR and tables;
- incremental reuse based on source hash and normalizer version; and
- inspectable Markdown and JSON output under `data/normalized/`.

The current generated Manifest snapshot contains 344 resources: FIT2014 (120), FIT2102 (58), FIT2109 (92), ETW2001 (57), FIT2081 (16), and one unclassified resource. It remains at `resources/resources.json`; a durable Resource Catalog is still planned.

The long-term Memory capability provides canonical current-state resolution, append-oriented learning episodes, SQLite FTS plus independent BGE-M3 embeddings, explainable scoped hybrid recall, source-priority conflict handling, and bounded per-course Episode lifecycle management. DeepSeek Flash extraction and BGE-M3 have concrete adapters. `pnpm agent-memory-smoke` covers real post-turn formation, explicit memory management, and recall in a distinct Legacy SDK session; it does not certify the current Web research or session-resume path.

The Main Agent runtime provides a provider-neutral `StudyAgentRuntime` contract, a thin `StudyController`, versioned Main Study Agent prompting, logical model profiles, safe lifecycle events, stable runtime errors, a production Web adapter over the vendored DSH Agent/Session services, and a retained Legacy SDK adapter.

The Main Agent also has a replaceable `StudentContextBuilder`, automatic Memory-backed context injection, the `search_knowledge`, `get_resource`, and `recall_memory` read tools, `manage_memory`, and `Evidence[]` propagation through `StudyTurnResult`. In the production Web path, DSH tool calls reach product services through an in-process `StudyToolBridge`; the Legacy SDK path retains a local authenticated loopback bridge. The prompt version and active tool surface are documented in the Codebase Reference.

The current Web UI provides a course list, chat, activity, and Evidence view. Its current worktree adds course-scoped DSH Session creation, listing, and persisted user/assistant message restoration. Those conversation-history changes are uncommitted and their post-restart browser search path still needs real-browser verification. Session history belongs to DSH; Activity and Evidence presentation remain transient UI state.

## Repository structure

```text
monash-study-agent/
├── packages/
│   ├── shared-types/          Resource, Evidence, and Study state types
│   ├── runtime-database/      Shared SQLite connection and migrations
│   ├── study-core/            Knowledge, decision, model, and tool capabilities
│   ├── study-controller/      Study workflow orchestration interface
│   ├── dsh-integration/       Cordis, Harness, and UI Remote boundary
│   └── dsh-ui-plugin/         DSH browser page and slot registration
├── services/
│   ├── knowledge-service/     Discovery, normalization, Docling, and LightRAG seam
│   └── memory-service/        Long-term Memory schema and deterministic store
├── connectors/
│   ├── ed/                    Future Ed sync and live connector
│   └── moodle/                Future Moodle sync and live connector
├── config/                    Local source registration
├── scripts/                   Product maintenance commands
├── resources/                 Generated Resource Manifest
├── data/normalized/           Generated normalized content and incremental state
├── docs/                      Product architecture
└── tests/                     Cross-module behavior tests
```

Runtime-generated databases, indexes, logs, and caches will live under `data/runtime/` and are excluded from Git.

## Commands

```sh
pnpm install
uv sync --project services/knowledge-service --python 3.12
pnpm run scan
pnpm normalize -- all
pnpm normalize -- course FIT2109
pnpm normalize -- resource <resourceId>
pnpm run typecheck
pnpm run build
pnpm test
pnpm agent-smoke -- --course FIT2109 --query "Briefly explain what a Git branch is."
pnpm agent-smoke -- --course FIT2109 --query "Briefly explain what a Git branch is." --continuity
pnpm agent-tools-smoke
pnpm agent-memory-smoke
pnpm agent-research-smoke
```

`pnpm agent-smoke` is currently a legacy SDK/model-only smoke. It does not
prove the Single Runtime Web path, Knowledge retrieval, or product tools.
The production Web path is the vendored DSH Web profile using
`InProcessDshRuntime` and `createStudyApplication()`.

### Development Start

Terminal:

```sh
pnpm ui
```

macOS: double-click `Start Monash Study Agent.command`. It uses the existing
Node.js, pnpm, and `node_modules`; it does not install or upgrade dependencies.

`config/sources.local.json` identifies the current machine's local course directories and is ignored by Git. Use `config/sources.example.json` as the portable template when configuring another machine. Scanning reads source files and downloader manifests without modifying the course libraries. Non-secret LightRAG runtime settings are shared through `config/runtime.json`; `.env` contains only `DEEPSEEK_API_KEY`.

### LightRAG model runtime

The real LightRAG model runtime requires a local DeepSeek API key. Copy `.env.example` to `.env`, fill in `DEEPSEEK_API_KEY`, and run:

```sh
pnpm lightrag -- health
pnpm lightrag -- model-health
pnpm lightrag -- ingest-document <documentId>
pnpm smoke:lightrag
```

The CLI loads the repository-root `.env` automatically. The file is ignored by Git; do not commit the key.

The Python environment is local to `services/knowledge-service/.venv` and is not committed. Docling is pinned in `services/knowledge-service/uv.lock`; on macOS the project uses its native OCR backend, while other platforms use RapidOCR. The LightRAG bridge uses the versioned JSON stdin/stdout contract in `services/knowledge-service/contracts/lightrag-worker.v1.schema.json`. Normalized Markdown is intended for inspection and LightRAG ingestion, and the adjacent JSON files retain complete metadata and locators. Generated output and state remain untracked.

The Memory BGE-M3 adapter reuses this pinned local Python environment for model dependencies, but stores vectors in `memory_embeddings`; it does not write to or query the LightRAG index.

LightRAG index state and long-term Memory share `data/runtime/monash-study-agent.sqlite`. The small `runtime-database` package owns the SQLite connection and ordered migrations; Knowledge and Memory services remain responsible for their own behavior. Existing state is migrated in place and the database is not recreated during normal upgrades.

## Runtime integration

`packages/dsh-integration` is the only module that imports Cordis and is the DSH adapter boundary. The Web Host registers `InProcessDshRuntime` and `MonashStudyUiService`; one shared `StudyApplication` provides turn execution, course summaries, DSH-backed conversation creation/listing/loading, and the AgentEvent stream. The UI Remote contributes the `monash-study` sidebar/main slots. Product code selects logical `fast`/`strong` profiles, and the Web adapter maps them to the pinned DSH provider/model route. Web tool calls execute through the in-process `StudyToolBridge`; the Legacy SDK adapter still uses `config/main-agent-tools.mjs` and an authenticated loopback bridge. Retrieved Evidence is deduplicated by `evidenceId` and returned in `StudyTurnResult`; the bridge does not own Knowledge or Memory persistence.

## Remaining planned product work

Development will continue within the same product boundaries:

- Durable Resource Catalog to replace the generated manifest snapshot;
- live Ed/Moodle connectors and synchronization inside this repository;
- broader course, source, indexing, and sync management screens; and
- a desktop shell (Electron is not implemented).

The intended dependency direction is Source Connectors → Resource Catalog → Knowledge Service → Evidence → Study Controller → Model generation. DSH hosts that product flow but does not own Monash course logic.
