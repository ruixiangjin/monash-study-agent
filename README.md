# Monash Study Agent

Monash Study Agent is a complete, local-first learning Agent product for Monash course materials. It owns the study workflow, course knowledge, product configuration, connectors, and future study interface.

Project documentation is indexed in [`docs/README.md`](docs/README.md). The implementation reference is [`docs/PROJECT_CODEBASE_REFERENCE.md`](docs/PROJECT_CODEBASE_REFERENCE.md); design intent is recorded separately in the linked V3.0 architecture and Memory documents.

DeepSeek Harness (DSH) is the product's internal Agent Runtime. It supplies sessions, the Agent loop, model execution, tool calling, conversation, presets, and Web runtime. The Cordis plugin entry is therefore an internal Runtime Integration Layer rather than the identity of this repository.

## Current foundation

The first implementation stage provides:

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

The current generated Manifest contains 344 resources and remains at `resources/resources.json` until the Resource Catalog replaces the JSON snapshot.

The long-term Memory capability now provides canonical current-state resolution, append-oriented learning episodes, SQLite FTS plus independent BGE-M3 embeddings, explainable scoped hybrid recall, source-priority conflict handling, and bounded per-course Episode lifecycle management. DeepSeek Flash extraction and BGE-M3 have concrete adapters; Memory's separate real-model smoke remains intentionally deferred to the stabilization round.

The first Main Agent Runtime round additionally provides a provider-neutral `StudyAgentRuntime` contract, a thin `StudyController`, versioned Main Study Agent prompting, logical model profiles, safe lifecycle events, stable runtime errors, and a real DeepSeek Harness SDK adapter with session continuity.

The second Main Agent Runtime round adds a replaceable `StudentContextBuilder`, automatic Memory-backed context injection, the read-only `search_knowledge`, `get_resource`, and `recall_memory` tools, a local authenticated bridge from the DSH child process to product services, and `Evidence[]` propagation back through `StudyTurnResult`. The prompt is versioned as `main-study-agent-v2`.

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
```

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

`packages/dsh-integration` is the only module that imports Cordis and is also the Harness-specific adapter boundary. It registers the backward-compatible `ctx.monashStudyKnowledge` service and the Round 1 `ctx.monashStudyUi` service. The UI service owns one shared `StudyApplication` and exposes the Typert Remote turn, course-list, and AgentEvent stream contract. `packages/dsh-ui-plugin` mounts that Remote and contributes the `monash-study` sidebar/main slots. Product code selects logical `fast`/`strong` profiles; the adapter maps them to the pinned DSH provider/model route and keeps Harness response types out of `shared-types` and `study-core`. Round 2 tool calls run in the DSH child through `config/main-agent-tools.mjs`, cross a loopback bearer-token bridge, and execute product-owned Knowledge, Resource, and Memory capabilities in the parent process. Retrieved Evidence is deduplicated by `evidenceId` and returned in `StudyTurnResult`; the bridge does not own Knowledge or Memory persistence.

## Next architecture stages

Development will continue within the same product boundaries:

- `services/knowledge-service`: Python service, normalization, Resource Catalog, and LightRAG indexing/query;
- `packages/study-core`: TypeSafe JEV decisions and DeepSeek Flash/Pro model policy;
- `connectors/ed` and `connectors/moodle`: synchronization and live Evidence providers;
- `presets`: Study Assistant and Knowledge Maintenance modes;
- `packages/study-ui`: course, source, knowledge, evidence, and sync views; and
- `vendor/deepseek-harness`: a pinned DSH runtime when the upstream import stage begins.

The intended dependency direction is Source Connectors → Resource Catalog → Knowledge Service → Evidence → Study Controller → Model generation. DSH hosts that product flow but does not own Monash course logic.
