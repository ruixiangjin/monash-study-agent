# Monash Study Agent Documentation

`docs/` is the single project-level entry point for design intent, development conventions, and the verified implementation reference.

## Start here

- [Codebase Reference](./PROJECT_CODEBASE_REFERENCE.md) — the actual repository structure, interfaces, runtime flows, persistence, tests, history, and maintenance protocol.
- [DSH UI Implementation Reference](./UI_IMPLEMENTATION_REFERENCE.md) — verified DSH 0.1.6-alpha.2 plugin, slot, Remote, UI contract, and Round 1 limitations.
- [Overall Architecture V3.0](./Monash%20Study%20Agent%20整体架构设计%20V3.0.md) — product architecture, module responsibilities, technology choices, and planned development direction.
- [Memory Design Supplement](./Monash_Study_Agent_Memory_设计补充.md) — long-term Memory types, scope, persistence, recall, lifecycle, and test design.
- [Commit Message Guidelines](./Commit%20Message%20Guidelines.md) — commit subject/body format and imperative style requirements.
- [Identity Contract](./identity-contract.md) — stable Resource, Document, Forum Thread, and Evidence identity algorithms.
- [Architecture Notes](./architecture.md) — concise implementation-oriented architecture notes.

The architecture and Memory documents describe intended design. The Codebase Reference records what is actually implemented at its `Last verified commit`; when they differ, use the Codebase Reference for current behavior and update the design documents only when the design intent itself changes.
