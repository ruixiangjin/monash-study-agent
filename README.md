# Monash Study Agent

Monash Study Agent is a complete, local-first learning Agent product for Monash course materials. It owns the study workflow, course knowledge, product configuration, connectors, and future study interface.

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

## Repository structure

```text
monash-study-agent/
├── packages/
│   ├── shared-types/          Resource, Evidence, and Study state types
│   ├── study-core/            Knowledge, decision, model, and tool capabilities
│   ├── study-controller/      Study workflow orchestration interface
│   └── dsh-integration/       Cordis service and future DSH tool registration
├── services/
│   └── knowledge-service/     Discovery, normalization, Docling, and LightRAG seam
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
```

`config/sources.json` identifies the current local course directories. Copy `config/sources.example.json` when configuring another machine. Scanning reads source files and downloader manifests without modifying the course libraries.

### LightRAG model runtime

The real LightRAG model runtime requires a local DeepSeek API key. Copy `.env.example` to `.env`, fill in `DEEPSEEK_API_KEY`, and run:

```sh
pnpm lightrag -- health
pnpm lightrag -- model-health
pnpm lightrag -- ingest-document <documentId>
```

The CLI loads the repository-root `.env` automatically. The file is ignored by Git; do not commit the key.

The Python environment is local to `services/knowledge-service/.venv` and is not committed. Docling is pinned in `services/knowledge-service/uv.lock`; on macOS the project uses its native OCR backend, while other platforms use RapidOCR. Normalized Markdown is intended for inspection and later LightRAG ingestion, and the adjacent JSON files retain complete metadata and locators. Generated output and state remain untracked.

## Runtime integration

`packages/dsh-integration` is the only module that imports Cordis. It currently registers `ctx.monashStudyKnowledge`, backed by the product-owned `LocalKnowledgeService`. Later DSH tool schemas, presentation metadata, preset composition, and UI extensions belong in this integration layer or their product modules, not in DSH Core.

## Next architecture stages

Development will continue within the same product boundaries:

- `services/knowledge-service`: Python service, normalization, Resource Catalog, and LightRAG indexing/query;
- `packages/study-core`: TypeSafe JEV decisions and DeepSeek Flash/Pro model policy;
- `connectors/ed` and `connectors/moodle`: synchronization and live Evidence providers;
- `presets`: Study Assistant and Knowledge Maintenance modes;
- `packages/study-ui`: course, source, knowledge, evidence, and sync views; and
- `vendor/deepseek-harness`: a pinned DSH runtime when the upstream import stage begins.

The intended dependency direction is Source Connectors → Resource Catalog → Knowledge Service → Evidence → Study Controller → Model generation. DSH hosts that product flow but does not own Monash course logic.
