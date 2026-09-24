# DSH UI Plugin Implementation Reference

This document records the verified implementation surface used by Round 1 of
the Monash Study Agent UI. It is based on the local DeepSeek Harness checkout
pinned to `0.1.6-alpha.2`, not on a generic React assumption.

## DSH findings used by the implementation

### Plugin entry and bundle discovery

- A host plugin exposes an `apply(ctx, config)` entry. The profile bundle patch
  inserts the package by id and package name.
- A browser plugin declares `dsh.client.inject` in its package metadata. The
  Round 1 package is `@monash-study/dsh-ui-plugin`; its host half delegates to
  `@monash-study/dsh-integration`, while its browser half is `./client`.
- The browser plugin injects the existing DSH services for Remote, layout,
  locale, slots, renderer, sidebar, theme, and primitives.

### Slots and route identity

The DSH UI is slot-based rather than a standalone React router:

1. `sidebar.panellist` is a list slot. Its item `id` is the navigation key.
2. `main` is the root keyed slot. Its registration `key` is selected by the
   layout service and must match the sidebar item id.
3. `ctx.layout.selectPanel()` is the host-side selection mechanism used by the
   DSH shell; the plugin only contributes the keyed entry.

Round 1 therefore uses the stable identity `monash-study` for both slots and
does not introduce a parallel router or shell.

### Remote transport

DSH Typert has two faces for the same Remote contract:

- Host: a `TypertRemoteService` registered in Cordis and methods marked with
  `@Remote`.
- Client: a `TYPERT_REMOTE` contribution mounted with
  `ctx.remote.$mount(contribution)`.

The product implementation publishes:

| Endpoint | Shape | Purpose |
| --- | --- | --- |
| `monashStudy/runTurn` | unary Remote | Runs `StudyApplication.runTurn()` and returns a safe completed/failed projection. |
| `monashStudy/listCourses` | unary Remote | Reads the existing Resource Manifest statistics and returns course summaries. |
| `monashStudy/runEvents` | native Remote stream | Streams safe product `AgentEvent` values for one `runId`. |

The stream uses DSH's native Typert Remote transport. No new DSH core event
forwarding allowlist is added, and raw Harness notifications never cross the
product boundary.

### Reusable UI surface

The implementation reuses the pinned DSH packages rather than recreating the
shell:

- `@deepseek-ai/dsh-client-ui-slots` for slot registration and standard props.
- `@deepseek-ai/dsh-client-ui-layout` for the root `main` keyed panel contract.
- `@deepseek-ai/dsh-client-ui-primitives` for `Button`, `Tag`, icons, and
  `MarkdownText`.
- `@deepseek-ai/dsh-client-ui-theme` tokens, including `--dsw-alias-*` color,
  label, border, brand, and state variables.
- `@deepseek-ai/dsh-client-ui-renderer` and sidebar contracts for browser
  registration compatibility.

## Product ownership and runtime boundary

The product-owned path remains:

```text
MonashStudyPage
  → DSH Client Remote
  → MonashStudyUiService
  → StudyApplication.runTurn()
  → StudyController / DeepSeek Harness / Knowledge / Memory
```

`packages/dsh-integration` owns the DSH-specific Host service and the Remote
contract. `packages/dsh-ui-plugin` owns the bundle entry, browser slot
registration, page rendering, and client-side presentation mapping. Product
logic remains in `StudyApplication`, `StudyController`, Knowledge, Memory, and
the existing stable DTOs.

`MonashStudyUiService` creates one shared `StudyApplication` per Cordis service
instance and closes it from the Cordis lifecycle disposer. It does not create a
second runtime per request. The event queue is per `runId`, is completed with
the turn, and is cleaned up after a short retention window so a Client stream
can drain the terminal event.

## Round 1 UI contract

### Courses and conversations

`listCourses` returns `{ courseCode, resourceCount }` from
`resources/resources.json`. The page keeps a separate in-memory state for each
course, so switching courses does not discard the previous conversation. Each
course state owns its `messages`, `conversation`, activity list, evidence, and
error. `New Chat` resets only the selected course state and removes its
conversation continuation reference.

### Three-column page

The keyed `monash-study` page renders:

```text
Courses              Chat + Activity + Composer             Evidence
courseCode/count     messages, Markdown, textarea            cards, metadata
course selection     Agent Activity, New Chat, Send         collapsed/expanded
```

The page is responsive: the Evidence column hides on narrower layouts while
the course selector and chat remain usable.

### Agent Activity mapping

`AgentEvent` is projected to user-facing activity labels without exposing raw
provider payloads:

| AgentEvent | UI label |
| --- | --- |
| `run_started` | Starting |
| `model_started` | Thinking |
| `model_completed` | Reasoning completed |
| `subagent_started` | Researching course materials |
| `subagent_completed` | Research completed |
| `subagent_failed` | Research step unavailable |
| `memory_observation_started` | Updating learning memory |
| `memory_observation_completed` | Learning memory updated |
| `memory_observation_failed` | Memory update unavailable |
| `student_context_failed` | Continuing without saved student context |
| `answer_completed` | Answer ready |
| `run_completed` | Completed |
| `run_failed` | Run failed |

The Research badge is shown when `StudyTurnResult.subagentsUsed` includes
`research`; its count is the product-owned `researchActions` value.

### Evidence

Evidence cards preserve the product fields `evidenceId`, `resourceId`,
`title`, `course`, `sourceSystem`, `retrievalProvider`, `content`, `score`,
and safe `metadata` including locator data. Cards are collapsed by default and
expand to show content and locator metadata. The UI does not reconstruct
Evidence from raw Harness output.

### Error presentation

The page maps the stable runtime codes as follows:

| Code | UI label |
| --- | --- |
| `INVALID_INPUT` | Invalid question |
| `SESSION_ERROR` | Conversation could not be continued |
| `MODEL_ERROR` | Model returned no answer |
| `HARNESS_ERROR` | Agent runtime failed |
| `ABORTED` | Request cancelled |
| `CONCURRENT_RUN` | Another study request is running |
| `UNKNOWN` | Something went wrong |

The server response contains the stable code and a bounded safe message. It
does not return secrets, local paths, raw prompts, raw model output metadata,
or DSH internal errors.

## Implementation files

| File | Responsibility |
| --- | --- |
| `packages/dsh-integration/src/ui-contract.ts` | Course, turn, response, and event boundary types. |
| `packages/dsh-integration/src/ui-service.ts` | Shared `StudyApplication` Host service, course listing, turn execution, and event stream. |
| `packages/dsh-integration/src/remote.ts` | Typert Remote descriptors and strict boundary codecs. |
| `packages/dsh-ui-plugin/src/index.ts` | Host half and bundle plugin identity. |
| `packages/dsh-ui-plugin/src/client/index.ts` | Browser page, Remote client, styling, and lifecycle mounting. |
| `packages/dsh-ui-plugin/src/client/registration.ts` | Sidebar/main slot registration and disposal. |
| `packages/dsh-ui-plugin/src/client/presenters.ts` | AgentEvent, Evidence, and error presentation mapping. |
| `packages/dsh-ui-plugin/cordis.patch.yml` | Profile overlay inserting the host plugin. |
| `tests/dsh-ui-plugin.test.ts` | Remote, UI mapping, slot registration, and disposal integration coverage. |

## Verification

The Round 1 repository checks are:

```text
pnpm run typecheck
pnpm run build
pnpm test
git diff --check
```

The UI-specific tests verify every AgentEvent mapping, stable error labels,
Evidence provenance/locator preservation, Remote endpoint descriptors, and the
sidebar/main registration lifecycle. A real DSH UI run still requires a local
web profile with the plugin bundle enabled and the normal local runtime
configuration. The bundled profile patch reads the product paths from
`MONASH_STUDY_AGENT_RUNTIME_CONFIG` and
`MONASH_STUDY_AGENT_RESOURCE_MANIFEST`; this keeps profile-local configuration
out of the product bundle. That flow is intentionally separate from unit tests
because it uses the user's local course manifest and model credentials.

The final local integration attempt used a uniquely named, freshly packed
tarball and those two environment variables. The installed host bundle passed
Node syntax validation, and `--dump-config` showed the `monash-study-ui` entry
and both path expressions. The DSH web launcher nevertheless reported
`monash-study-ui (@monash-study/dsh-ui-plugin): failed to import`; the launcher
did not expose the nested import stack. This is recorded as an unresolved
profile-local activation boundary, not as a passing browser UI check. No
further cache-bust or DSH-core changes are part of Round 1.

## Known Round 1 limitations

- The pinned DSH release does not provide a separate verified mid-turn cancel
  control; the page uses the existing Remote `AbortSignal` seam and does not
  claim stronger cancellation semantics.
- The Remote contribution is maintained as a small source artifact beside the
  DSH integration because the product repository does not run the DSH Typert
  generator. Its descriptors and strict codecs mirror the generated
  `typert.remote-client` contract and are covered by tests.
- The current page keeps UI conversation state in the browser for the active
  page. Harness conversation continuity remains owned by the returned
  `StudyConversationRef`; no duplicate product conversation store is added.
