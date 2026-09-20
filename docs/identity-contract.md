# Identity Contract

This document records the identity algorithms used by the current repository.
It is descriptive: changing an algorithm requires an explicit migration decision
because the existing FIT2109 LightRAG index is keyed by these identifiers.

## Resource identity

Implemented in `/Users/example/Desktop/Monash-Agent-Dev/monash-study-agent/services/knowledge-service/src/local/local-knowledge-service.ts`.

```text
resourceId = resource_<sha256(source + NUL + rootId + NUL + relativePath)[0:24]>
```

Consequences:

- Renaming or moving a file changes `relativePath`, so it creates a new
  `resourceId`.
- Changing file content does not change `resourceId`; it changes `hash`.
- Changing the configured root id or source also changes `resourceId`.

## Document identity

Implemented in `/Users/example/Desktop/Monash-Agent-Dev/monash-study-agent/services/knowledge-service/src/normalization/resource-normalizer.ts`.

For ordinary one-document resources:

```text
documentId = document_<resourceId without the resource_ prefix>
```

This is used by text, code, CSV, and Docling document normalizers.

Consequences:

- A resource rename or move produces a new document id.
- A content change keeps the document id and changes `sourceHash` and/or
  `normalizedHash`.
- A normalization version change keeps the document id but invalidates the
  current index state comparison.

## Forum thread identity

Implemented in `/Users/example/Desktop/Monash-Agent-Dev/monash-study-agent/services/knowledge-service/src/normalization/forum-normalizer.ts`.

Forum resources are split into one document per thread. The id is derived from
the normalized course part and the Ed thread id:

```text
forum-ed-<course-part>-<thread-id>
```

The resource id and source hash remain attached to every generated thread
document. A thread content change keeps the thread document id. A changed Ed
thread id creates a new document id.

## Evidence identity

Implemented in `/Users/example/Desktop/Monash-Agent-Dev/monash-study-agent/services/knowledge-service/src/lightrag/lightrag-knowledge-service.ts`.

```text
evidenceId = evidence_lightrag_<sha256(course + LF + documentId + LF + dedupeKey)[0:24]>
```

The dedupe key is the LightRAG chunk id when available, otherwise the document
id plus a SHA-256 of the returned chunk content.

Evidence now separates the two previously conflated concepts:

- `sourceSystem`: `ed`, `moodle`, or `local`.
- `retrievalProvider`: `lightrag`, `live-ed`, `live-moodle`, or `local`.

Current LightRAG Evidence uses the normalized document source as
`sourceSystem` and the literal value `lightrag` as `retrievalProvider`.
