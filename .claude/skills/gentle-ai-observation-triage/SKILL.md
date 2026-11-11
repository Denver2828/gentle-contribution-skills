---
name: gentle-ai-observation-triage
description: "Trigger: observation triage, recent observations, memory shortlist. Produce a bounded read-only shortlist for human selection."
license: Apache-2.0
metadata:
  author: Denver2828
  version: "1.0"
---

# Observation Triage

## Activation Contract

Use for a human-requested shortlist of recent project observations. Require
`project` and an explicit UTC/RFC3339 `as_of`; default `horizon_days: 28`,
`max_candidates: 5`, and `coverage_mode: strict`.

Before execution, read both normative references below in full.

## Hard Rules

- Remain read-only and project-scoped. Exclude personal and all-project sources
  unless the human explicitly requests them.
- Never promote authority, edit, publish, mutate memory, or invoke the ratchet.
- Read metadata first; read full observation bodies only for shortlisted
  candidates. Always read Claude's `MEMORY.md` as the index exception.
- Use `MEMORY.md` only for coverage and reconciliation. Never make the whole
  index a candidate or pass it to the ratchet as a source.
- Treat 28 days as an operating window, never a semantic relevance boundary.
- Never use direct SQLite access or an all-memory export as an enumerator.
- Apply selection criteria only from `selection-and-execution.md`.
- Express every complete enumeration as `coverage-receipt/v1` and verify it
  with `.claude/tools/audit/bin/verify-coverage.mjs --require-interval
  --require-stable-retrieval`. Prose never substitutes for the receipt.

## Decision Gates

| Condition | Result |
| --- | --- |
| Strict mode lacks an admissible enumerator | `blocked(enumeration_unavailable)` |
| Explicit partial opt-in uses a bounded source | `coverage: partial` with exact limits |
| Enumerator satisfies every coverage property | `coverage: complete` with receipt |
| Actionable content exists only inline in `MEMORY.md` | Emit `memory_index_gap`; require extraction before candidacy |
| Human selects one source ID | Describe the one-ID ratchet handoff; do not run it |

## Execution Steps

1. Normalize inputs and compute inclusive `since` and `until`.
2. Validate enumeration before reading observations.
3. Enumerate metadata and record and verify `coverage-receipt/v1` for both
   project stores. If a source cannot populate it, mark that source partial.
4. Read `MEMORY.md`; reconcile its references and headings against enumerated
   observation files, then record index gaps and stale, broken, or orphan links.
5. Cluster revisions, topics, and duplicates when supported.
6. Read `docs/recurrence-register.md` (Triage log and Occurrences). A source ID
   with a `selected`, `promoted`, or `archived` row is excluded unless the human
   asks for it; a `seen` row competes on its own merit and is labeled
   `previously_shown: <as_of>` in the report. An observation whose failure
   class has two or more Occurrence rows carries `recurrence: <class> x<count>`,
   with the count recomputed from the rows, never copied from prose.
7. Rank using the normative selection criteria, then retrieve only shortlisted
   bodies by source ID.
8. Return the bounded report and await human selection. The human, not this
   skill, appends one Triage-log row per shown candidate; this skill stays
   read-only and states the rows it expects.

## Output Contract

Follow `enumeration-and-output.md`. Emit `selected_observation: none` until a
human chooses. Describe older unresolved items as out of scope, never absent.

## References

- `references/enumeration-and-output.md` — normative coverage, terminals, and report schema.
- `../gentle-ai-observation-to-ratchet/references/selection-and-execution.md` — sole normative selection authority.
