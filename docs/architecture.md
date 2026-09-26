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
- The path/database milestone checks passed at the time they were added.
  Current verification is recorded in the Codebase Reference: typecheck
  passes, while the latest restricted-environment full test run has five
  loopback `EPERM` failures and one OCR assertion failure.
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

## Current Validation Limits

- Browser verification on 2026-09-22 passed Fresh A, same-process B, and
  persisted Resume C. Resume C restored session history after restart, but
  its fresh Knowledge search failed to bind product services and reused
  earlier Evidence.
- The current uncommitted worktree adds lazy product-service initialization
  and restored-session tool-bridge binding. Targeted tests exercise this code
  path. A real browser restart followed by a fresh search has not been run
  since these changes, so post-fix Web Knowledge E2E remains unverified.
- Course-scoped conversation create/list/load and persisted user/assistant
  message projection are also present in the current worktree. Their targeted
  tests and typecheck pass; post-change browser validation remains pending.
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

1. Verify the current course-scoped conversation UI in the real Web profile:
   create a session, send a turn, restart Web, restore it, and confirm a new
   `search_knowledge` call returns fresh Evidence.
2. Re-run the full tests in an environment that permits required local
   listeners and investigate the scanned-PDF OCR assertion independently.
3. Keep legacy SDK smoke results labeled as Legacy; they do not prove current
   Web Research, tools, or memory behavior.
4. Persistent LightRAG workers, live course connectors, Resource Catalog,
   and desktop shell remain later product work.
