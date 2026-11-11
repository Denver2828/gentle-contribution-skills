---
name: gentle-ai-observation-to-ratchet
description: "Trigger: observation, lesson, Key Learning, promote learning, ratchet, convert note to procedure/test/skill. Turn one selected note into a verified ratchet."
license: Apache-2.0
metadata:
  author: Denver2828
  version: "1.0.0"
---

## Activation Contract

Load only for one explicitly selected observation that may deserve durable
authority. This manual prototype never sweeps memory, runs as a CI/hook trigger,
or proves more than its bounded invocation.

Before any other step, read `references/portable-lineage.v1.json`,
`references/selection-and-execution.md`, and
`references/verification-and-provenance.md`.

## Hard Rules

- Treat notes as hypotheses. Record selection rationale and memory hygiene;
  recency alone never resolves contradictions, current visible conversation
  outranks conflicting older memory, and persistent capture names applicable
  privacy, retention, and deletion constraints.
- Run `.claude/tools/audit/bin/verify-portable-skill-lineage.mjs` against the
  manifest and current repository before evaluation. Continue only from
  `current`; report `needs_review` or `blocked` with its actions and do not
  promote or mutate authority.
- Read the full source/lifecycle state and revalidate against a remote-derived
  current default-branch revision and time; a local ref is insufficient.
- Find the canonical authority, mandatory consumer, owner, and route. Record
  cross-boundary controls as partial coverage.
- Emit one coherent `scope_fit_decision` from the selection reference. Never
  implement a third-party target directly, create authority without a consumer,
  or accept a triage handoff that pre-decided scope or fit.
- Verify the block with `.claude/tools/audit/bin/verify-scope-fit.mjs`; a
  non-zero result blocks promotion and its `nextAction` is mandatory.
- Name decision and installation owners separately, whether they match, and
  whether the installer could reject the promotion. Never imply independence
  that did not occur.
- Choose exactly one disposition: update procedure/skill, add test/ratchet, add
  driven journey, consolidate authority, archive, or block for insufficient evidence.
- Do not edit, publish, capture memory, debug the original incident, or create parallel authority.
- Distinguish `policy_rejection` from `control_unavailable`. Before proof or
  consumer action, define attempts/time/cost budget, terminal states, durable
  stop evidence, and continuation. Retry only with new evidence and budget.
- Verify Go subtest-count claims with
  `.claude/tools/audit/bin/verify-test-claim.mjs` under the provenance reference.
  Refusal or unproven direct capture means blocked, unchanged authority, and
  proof not established.
- Call a ratchet installed only when its mandatory consumer invokes it.
- Use the downstream route map in the selection reference; do not perform
  routed work inside this read-only skill.
- Repair at most one stable manifest step per reviewed version. Recheck every
  affected consumer and proof, require human review, and supersede the prior
  content-bound version; never auto-repair.

## Decision Gates

| Target modality | Required counterfactual proof |
| --- | --- |
| Test/ratchet | Fail-before/pass-after or controlled mutation |
| Procedure/skill | Fresh-context replay |
| Bench journey | Driven bench execution; never `go test ./bench` alone |
| Consolidation | Consumer and reference sweep |

| Authority owner | Required route |
| --- | --- |
| Own space | Direct correction; single party decides and closes |
| Third-party repository | Proposal only: report, external approval, claim comment, implement, review — route to `gentle-ai-aporte`/RDD; rejection is a valid outcome |
| No applicable authority | Archive by default; creating new authority needs explicit justification |

## Execution Steps

1. Read all three normative runtime references.
2. Verify the portable lineage manifest against current local artifacts and
   stop on `needs_review` or `blocked`.
3. Validate selection rationale and memory hygiene for the full observation.
4. Record the remote default-branch revision/time and recheck evidence there.
5. Locate authority, owner, mandatory consumer, duplicates, and references;
   derive and validate the combined scope/fit decision.
6. Select one disposition; record owners, route, rejection authority, and
   execution contract; collect proportional proof without changing authority.
7. Classify consumer outcomes; block stale, irreproducible, unavailable, or
   incomplete cases.

## Output Contract

Return one record per observation with the exact chain `observation → evidence → decision → authority → consumer → proof`.

Include the reference-defined selection, memory, control-outcome, and execution
fields; current revision/reproduction; disposition; authority/consumer paths
and sweeps; ownership route; both owners and installer rejection authority;
proportional proof; and unresolved gaps.

Include exactly one `scope_fit_decision` block with a coherent route or a
blocked continuation.

Emit exactly one `verification_provenance` block per the provenance reference.
Exclude prompts, private reasoning, token counts, and tool transcripts.

Include `lineage_state`, the verified manifest `content_id`, and every
actionable drift reason. Never substitute a stored historical tool status for
the verifier's current artifact checks.

## References

- `references/selection-and-execution.md` — selection, memory, outcomes, execution, and routing.
- `references/verification-and-provenance.md` — verifier, provenance, and refusal.
- `references/portable-lineage.v1.json` — mandatory step lineage, artifact bindings, decision history, and repair contract.
- `references/skill-style-guide.md` — local LLM-first authoring guide.
