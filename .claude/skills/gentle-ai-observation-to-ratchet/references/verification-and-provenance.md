# Verification and Provenance (normative)

These rules are part of the skill contract, not background. Apply them verbatim
whenever a Go subtest-count claim is verified or a `verification_provenance`
block is emitted.

## Go subtest-count claims

Run `.claude/tools/audit/bin/verify-test-claim.mjs` over a complete, unfiltered
stream captured directly from the Go-produced `go test -json` process.

- The verifier counts terminal executions, not unique test definitions.
- Repeated names under `-count` or `-cpu` are legitimate.
- It checks subtest totals, skips, and failures, and requires passing top-level
  tests plus successful package completion.
- It cannot prove input provenance or completeness.

## The `verification_provenance` block

Emit exactly one compact block with these fields:

- `status`: `verified`, `refuted`, or `not_established`;
- `verifier`: `human`, `tool:<name/version>`, `ai:<client>/<exact-model>`, or
  `unknown`; never infer an unavailable identity;
- `subject_revision`: the immutable Git tree or commit checked, or
  `not_applicable` with its reason;
- `evidence_ref`: the exact command, test, receipt, or artifact path/hash.

Do not include prompts, private reasoning, token counts, or tool transcripts.

## Refusal and unproven capture

If the verifier refuses or direct-capture provenance cannot be demonstrated, use
the existing `block for stale/insufficient evidence` disposition, report the
canonical authority as unchanged and proof as not established, and name the
exact cause in unresolved gaps.

With verifier admission and demonstrated direct capture, continue to the
already-defined modality proof and downstream owner; admission alone never
establishes installation.
