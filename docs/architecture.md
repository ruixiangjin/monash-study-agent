# Product architecture

Monash Study Agent is the product. DeepSeek Harness is its internal Agent Runtime, and the Cordis module under `packages/dsh-integration` connects product-owned capabilities to that runtime.

The product follows six layers:

1. Product: launcher and Study UI.
2. Runtime: a pinned DeepSeek Harness distribution.
3. Orchestration: Study Controller and presets.
4. Intelligence: TypeSafe JEV decisions and DeepSeek model policy.
5. Knowledge: Resource Catalog, Knowledge Service, and LightRAG.
6. Sources: local course files plus Ed and Moodle connectors.

Raw course files remain outside this repository and are registered through the ignored local file `config/sources.local.json`, using `config/sources.example.json` as a template. The current JSON Resource Manifest is a rebuildable catalogue snapshot. SQLite currently owns LightRAG index state, schema migrations, and the recoverable sync journal; a future Resource Catalog remains a separate planned concern. LightRAG remains a derived retrieval index.

Dependencies point inward through stable capability interfaces. Study Controller consumes decision, knowledge, model, and tool capabilities, and its runtime composition root selects the configured knowledge provider. Providers implement those capabilities without importing the Controller. DSH integration adapts the application runtime into Cordis services and tools, but product modules do not depend on DSH Core.
