# Enumeration and Output (normative)

Read this file before every invocation. It defines the admissible source,
coverage claim, terminals, and report shape for observation triage.

## Inputs and window

Require:

- `project`: one explicit project identifier;
- `as_of`: an explicit UTC timestamp in RFC3339 form.

Defaults:

- `horizon_days: 28`;
- `max_candidates: 5`;
- `coverage_mode: strict`.

Require positive integer values for `horizon_days` and `max_candidates`. Compute
`until = as_of` and `since = as_of - horizon_days`, and state the interval
semantics. The horizon bounds the operating scan; it does not make older
observations irrelevant or resolved.

## Scope and read discipline

Use project-scoped observations only. Personal scope and cross-project queries
are excluded unless the human explicitly asks for that expanded scope. Record
the expansion as an input rather than silently widening the search.

Two project-scoped stores exist. Scan both unless the human bounds the request
to one, and record which were scanned. A source omitted from the scan is an
exclusion, never an absence of observations.

Enumerate metadata before retrieving observation content. Metadata must include
a stable source ID and timestamp. Retrieve full observation bodies only for
observations admitted to the final shortlist, and only through the source ID
promised by the enumerator. Reading Claude's complete `MEMORY.md` is the sole
exception: it is mandatory index input, not an observation-body read.

This skill never saves, updates, deletes, merges, reviews, pins, or captures
memory. It never edits or publishes artifacts, promotes authority, or invokes
`gentle-ai-observation-to-ratchet` automatically.

## Admissible complete enumerator

A source may support `coverage: complete` only when it guarantees all of:

1. an enforced project filter;
2. the requested `since`/`until` time range;
3. stable pagination or cursor semantics across the scan;
4. an explicit termination condition or authoritative total;
5. retrieval of each shortlisted body by its stable source ID.

Record `.claude/tools/audit/schema/coverage-receipt.v1.json`, including source,
effective scope, interval, page/cursor progression and counts, reviewed count,
authoritative total when available, termination, exclusions, and stable-ID
retrieval. Verify it with `.claude/tools/audit/bin/verify-coverage.mjs
<receipt.json> --require-interval --require-stable-retrieval`. A successful
command or prose summary without this verified receipt does not prove complete
coverage.

## Engram source: bounded, never complete

The exposed `mem_search` contract caps `limit` at 20 and provides no temporal
range or cursor. The Engram 1.20 CLI `timeline` command requires one
`observation_id` and only returns context around it; CLI help exposes no general
date-range observation listing. Neither surface can prove all project
observations in a 28-day interval.

Do not access Engram's internal SQLite database and do not export all memories
as a workaround.

Engram therefore supports `coverage: partial` at best. That bound is a property
of this source, never of the scan as a whole: do not report the whole scan
blocked because Engram alone cannot prove completeness.

In `strict` mode, a terminal `blocked(enumeration_unavailable)` requires that
NO admissible source is available. Continue when any admissible source is
available, or when the human explicitly opts into `coverage_mode: partial`.

In partial mode, name every bound exactly: query terms, project/scope filter,
result limit, unavailable interval filter, missing cursor or termination proof,
and any retrieval failures. Emit `coverage: partial`; never describe the result
as all, exhaustive, complete, or representative of the whole window.

## Claude file-based project memory: admissible complete enumerator

Path: `~/.claude/projects/<project-slug>/memory/`, where `<project-slug>` is the
working-directory slug Claude Code derives for the project. This store satisfies
all five admissibility properties:

1. project filter — the directory path IS the project scope;
2. time range — every file carries `metadata.modified` in its frontmatter;
3. pagination — none required; one directory listing returns the whole set;
4. termination — that listing is the authoritative total;
5. retrieval by ID — the file path is the stable source ID.

Enumerate with a directory listing, read frontmatter only, and record the exact
listing command plus the returned file count as the coverage receipt.

Frontmatter carries `name`, `description`, `metadata.type` (`user`, `feedback`,
`project`, or `reference`), `metadata.originSessionId`, and `metadata.modified`
as an ISO-8601 UTC timestamp. Rank from `description` and `type`; read a body
only for a shortlisted candidate.

`metadata.type` is a content category, NOT a scope. Every file in this
directory is project-scoped by its path, so a `user`-typed note is in scope by
default and must never be dropped as if it were Engram's `personal` scope. The
two axes share a vocabulary and mean different things; excluding a type
silently is a coverage defect, and any type-based exclusion the human requests
is recorded in `exclusions`.

## Claude MEMORY.md reconciliation

Read the complete `MEMORY.md` after enumerating individual observation-file
metadata. Use it only as an index, coverage receipt, and reconciliation input.
Never treat the whole index as a candidate, an observation source ID, or a
ratchet handoff source.

Extract explicit file references, links, and observation-naming headings from
the index. Compare them with the authoritative directory listing and record:

- matched references;
- `stale_index_reference`: the target resolves but its index label, heading, or
  described identity conflicts with the individual file;
- `broken_index_reference`: the reference is malformed or cannot resolve;
- `orphan_index_reference`: a heading or entry asserts a distinct observation
  but identifies no dedicated observation file;
- `unindexed_observation_file`: an enumerated individual file has no index
  reference.

These are coverage findings, not candidates. A broken or orphan reference caps
Claude-source coverage at `partial`. A stale reference does so when identity or
content correspondence cannot be reconciled; otherwise it has
`coverage_effect: none`. An unindexed file has `coverage_effect: none` because
directory enumeration still found it, but the inconsistency remains visible.

Inspect inline index prose for substantive actionable assertions that do not
exist in any enumerated individual observation file. An assertion is actionable
when it states a reusable decision, rule, failure, or follow-up that could be
evaluated by the selection criteria. Do not flag navigation labels, generated
metadata, or summaries that faithfully point to a dedicated file.

For each inline-only assertion, emit exactly one structured finding with
`code: memory_index_gap`, the exact `MEMORY.md` path, heading and line range,
the minimum verbatim evidence needed to identify the assertion, the comparison
evidence showing no individual-file match, and `coverage_effect: partial`.

An inline-only assertion cannot enter `candidates` and cannot be handed to the
ratchet. Its continuation is human-owned: extract the assertion and its
provenance into one dedicated observation file, then rerun triage so that file
receives its own source ID. This skill only reports the gap; it never performs
the extraction.

If `MEMORY.md` is missing or unreadable, emit `memory_index_unavailable` and cap
Claude-source coverage at `partial`; continue with individual-file enumeration
rather than inventing index evidence.

`metadata.modified` and filesystem mtime can disagree — one observed file
carries a rounded `2026-08-23T00:00:00.000Z` against a later mtime. Prefer the
in-band `metadata.modified` because it is explicit and UTC-qualified, record
both when they differ, and treat the disagreement as an unresolved
contradiction rather than resolving it by recency.

## Selection processing

Use only the criteria in
`../../gentle-ai-observation-to-ratchet/references/selection-and-execution.md`:
recurrence, silent cost, observable event, freshness, proportional verification
cost, and absence of existing authority-and-consumer coverage. Preserve its
manual-exception and memory-hygiene rules.

When source metadata supports it, cluster revisions, common topic keys, and
duplicates before ranking so repeated versions do not crowd out independent
failure classes. Record unresolved contradictions rather than choosing the
newest version automatically.

## Report schema

Return one structured report with:

```yaml
project: <project>
as_of: <UTC RFC3339>
since: <UTC RFC3339>
until: <UTC RFC3339>
coverage: complete | partial | blocked
enumeration:                       # one entry per scanned source
  - source: <name and version>
    coverage: complete | partial | unavailable
    limits: [<exact bound or none>]
    termination_receipt: <listing/cursor/page/total evidence or unavailable>
    coverage_receipt: <coverage-receipt/v1 object or unavailable>
    coverage_receipt_id: <sha256:... from verifier or unavailable>
memory_index:
  path: <MEMORY.md path>
  read_status: complete | unavailable
  reconciliation_receipt:
    headings_inspected: <integer>
    references_inspected: <integer>
    matched_references: <integer>
    enumerated_files_without_reference: <integer>
  coverage_findings:
    - code: memory_index_gap | stale_index_reference | broken_index_reference | orphan_index_reference | unindexed_observation_file | memory_index_unavailable
      locator:
        path: <exact path>
        heading: <exact heading or none>
        line_start: <integer>
        line_end: <integer>
      evidence:
        index_excerpt: <minimum verbatim assertion or reference>
        individual_file_comparison: <matched IDs or explicit no-match evidence>
      coverage_effect: partial | none
      continuation: <specific human-owned reconciliation or extraction action>
observed_count: <integer or unknown>
exclusions: [<scope, time, source, or retrieval exclusion>]
clusters:
  - cluster_id: <stable report-local ID>
    source_ids: [<source ID>]
    rationale: <revision/topic/duplicate relationship>
candidate_summary:
  eligible_count: <integer or unknown>
  shown_count: <integer>
  omitted_count: <integer or unknown>
  count_scope: complete_window | inspected_sample | unavailable
candidates:
  - source_id: <exactly one source ID>
    timestamp: <source timestamp>
    rationale: <selection criteria and evidence>
    freshness: <current, stale, needs_review, or source-native state>
    coverage_status: complete | partial
selected_observation: none
continuation: <actionable next step>
```

The top-level `coverage` is the WEAKEST coverage across every known
project-scoped store, not merely the ones scanned. A store left unscanned — or
one that could not prove completeness and was therefore skipped — counts as
`unavailable` and caps the report at `partial`. Report `complete` only when
every known store was enumerated with a receipt. Per-source coverage stays
visible in the `enumeration` list, so a fully enumerated store still shows
`complete` on its own row.

Apply every `memory_index.coverage_findings[].coverage_effect` before computing
top-level coverage. Index reconciliation never reduces the authority of the
directory listing as its enumeration receipt, but unresolved missing content
prevents a complete Claude-source coverage claim.

`candidate_summary.count_scope` follows the top-level coverage, never a single
source's: use `complete_window` only when the top-level coverage is complete.

Return no more than `max_candidates`. Set `shown_count` to the exact candidate
list length. With complete coverage, count every eligible candidate in the
window and set `omitted_count = eligible_count - shown_count` with
`count_scope: complete_window`. With partial coverage, count only candidates in
the inspected sample and use `count_scope: inspected_sample`; never imply a
window-wide total. If the available evidence cannot establish eligibility for
every inspected item, set both `eligible_count` and `omitted_count` to `unknown`
and use `count_scope: unavailable`.

When `omitted_count` is positive, state the exact overflow in `continuation` and
explain that the human may request another report with a larger
`max_candidates` while preserving `project`, `as_of`, `horizon_days`, and the
coverage source. Candidate rationale must distinguish observed metadata/body
evidence from inference. If older unresolved items are known, list them as
outside this scan's scope; never claim they do not exist.

After the human selects a candidate, describe a handoff to
`gentle-ai-observation-to-ratchet` containing exactly that one source ID. Keep
the handoff unevaluated and unexecuted.

## Terminal results

- `blocked(invalid_input)`: name the invalid or missing input; continue with a
  valid project, explicit UTC/RFC3339 `as_of`, and positive bounds.
- `blocked(enumeration_unavailable)`: name the missing coverage properties;
  continue with an admissible enumerator or explicit partial opt-in.
- `blocked(enumeration_incomplete)`: a purported complete scan lost stable
  pagination, termination, or total evidence; continue by repairing the source
  receipt or explicitly restarting in partial mode.
- `blocked(source_retrieval_unavailable)`: a shortlisted source ID cannot be
  retrieved; continue by restoring ID-based retrieval or removing the candidate
  with the exclusion recorded.

`memory_index_gap` and other index findings are non-terminal: preserve them in
the report, exclude inline-only assertions from candidacy, and continue with
eligible individual observations. Their continuations never authorize this
read-only skill to create or repair files.

Every terminal retains the coverage receipt and evidence collected before the
stop. No terminal authorizes mutation or automatic ratchet execution.
