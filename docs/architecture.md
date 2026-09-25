# Product architecture

Monash Study Agent is the complete product. DeepSeek Harness is its internal
Agent Runtime. The product keeps the existing `study-application` composition
root; this stabilization does not add a second bootstrap package or move the
existing package boundaries.

## Current Architecture

```text
pnpm ui
  → repository-vendored DSH CLI
  → DSH Web profile (declarative base/web bundles only)
  → --patch config/single-runtime.cordis.patch.yml
  → repository-local staged Monash UI plugin
  → Monash Agent Preset
  → InProcessDshRuntime
  → createStudyApplication()
  → Resource / Knowledge / Memory / Tool services
```

The vendored DSH repository is the only DSH/Cordis runtime implementation for
the Web path. The patch loads the Monash plugin from the repository-local
staging directory under `vendor/deepseek-harness/.monash-study`; the profile
only supplies declarative DSH configuration. The profile's physical
`node_modules` directory is not part of Monash runtime resolution, and the
Monash plugin is not installed there.

The Web host receives the product application root explicitly. The DSH
profile directory is an installation location, not the Monash product root.
`createStudyApplication()` remains the single product Composition Root; DSH
integration only adapts product capabilities to Cordis and the Agent session.

Runtime data and executable worker resources are resolved from the explicit
application root. Package location, DSH profile location, and
`process.cwd()` are not application configuration. `runtime.json` retains
portable relative paths, while services consume the resolved absolute values.

The shared SQLite database is used by both LightRAG index state and Memory.
Opening a configured existing database is distinct from explicit initialization:
production paths fail fast when missing, while first-run setup and test
fixtures opt into initialization.

## Historical / Legacy

The older flow remains in the repository for compatibility and focused tests:

```text
StudyController
  → DeepSeekHarnessRuntime
  → DSH SDK child runtime
```

It is a legacy SDK/model smoke path, not the production Single Runtime Web
path, not a Knowledge E2E, and not proof that product tools or Memory work.
It is retained temporarily because deleting it would expand this stabilization
into unrelated cleanup.

## Validated

- Explicit application-root/config resolution is covered by path provenance,
  cwd-independence, and relocation-oriented tests.
- Runtime database opening fails without creating a missing database; tests and
  first-run initialization use an explicit initialization option.
- The existing automated suite passes after the path and database boundary
  changes.
- Web startup prints safe runtime path provenance only; no secret values are
  included.
- The Web launcher uses the repository-vendored DSH CLI and local patch; the
  resolved `SessionController`, `PresetTree`, `EntryTree`, `Entry`,
  `cordis:group`, and `agent-presets` identities all come from the same
  vendored DSH dependency graph.
- Fresh Session A passed in the real browser for FIT2109: `search_knowledge`
  ran, the LightRAG query returned Evidence, and the answer completed.
- Same-process Follow-up B passed in the same session without
  `entry._await`.
- Persisted Resume C passed after a normal Web restart: the new session's
  history restored and a third turn completed without `entry._await`.

## Known Issues

- The freshly-created post-fix session is
  `session-bb7d64d7-2719-4302-b5d2-131320aa13ac`. Its history and a third turn
  restored after Web restart without `entry._await`. However, the restarted
  third turn's fresh tool dispatch failed with `Study Agent services are not
  configured`; the UI completed using Evidence already retrieved earlier.
  The exact product boundary is
  `packages/dsh-integration/src/in-process-dsh-runtime.ts:75`, where
  `executeTool()` finds no restored `toolBridge`. This is a current product
  session/tool-binding boundary; do not modify DSH core in response.
- Therefore the package-graph and A/B/C session-resume checks pass, but full
  post-restart browser Knowledge E2E is not yet validated. The pre-fix
  `entry._await` failure is no longer reproduced on fresh creation or resume.
- `pnpm agent-smoke` still exercises the legacy SDK runtime and is explicitly
  model-only until a dedicated Single Runtime E2E is added.
- LightRAG Python startup remains a known cold-start performance cost; it is
  separate from the prior empty-database root cause.

## Root-cause history

The DSH Web profile installed the bundled Monash plugin under
`~/.dsh/profiles/web/node_modules`. Bundled code previously derived a product
root from `import.meta.url`, so Web opened a second empty SQLite database under
`~/.dsh/profiles/web/data/runtime`. FIT2109 therefore had zero index-state rows
in Web even though the intended product database contained 276 indexed
documents. Runtime/application paths are now resolved at the launcher/config
boundary instead of from package installation location.

## Next Steps

1. Keep the vendored Single Runtime path and package graph frozen; do not
   modify DSH core, upgrade dependencies, clear the profile, re-index, or enter
   Memory work.
2. The next bounded investigation is only the post-restart product
   `StudyToolBridge` binding/session restoration boundary, or a safe
   `SESSION_ERROR` behavior. Do not silently delete sessions.
3. Do not claim full browser Knowledge E2E until a post-restart turn performs
   a fresh `search_knowledge` call and returns new Evidence.
4. Reassess the legacy SDK smoke only after the current Web boundary is
   separately resolved. Persistent LightRAG workers remain a later round.
