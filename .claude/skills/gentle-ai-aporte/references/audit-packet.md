# Audit Packet

Built by the Controller from repository state and returned artifacts. It is the auditor's entire input.

Every value is either read from the repository or copied verbatim from a returned artifact. Nothing here is written from memory, and nothing here explains why a choice was made.

Both sandboxes live outside the outer harness and nested `src` SUT. The
Controller records a read-only SUT attestation before and after the operation;
the packet never asks an auditor to modify or repair `src`.

## Binding

```
## Audit Binding

- subject_id:
- task_contract:
- task_contract_digest:
- base_sandbox:
- candidate_sandbox:
- contribution_type:
- repository_root:
- established_language:
- linked_issue:
- issue_status:
- merge_base_sha:
- candidate_head_sha:
- draft_path:
- draft_digest:
- title_path: (null for a comment)
- draft_title_sha256: (null for a comment)
- changed_paths:
- changed_lines:
- scope_sentence:
- explicit_non_goals:
- filter_result:
- evidence_manifest:
- not_run_checks:
- n_a_checks:
- lifecycle_applicability:
```

## Field Derivation

| Field | Source |
|---|---|
| `subject_id` | Exact stdout from `node .claude/skills/gentle-ai-aporte/scripts/ledger.mjs subject-id --base-tree <base_tree> --candidate-tree <candidate_tree> --paths <changed-paths-and-modes-file> --draft <draft_path> --policy <policy-file> --test-manifest <test-manifest-file> --task-contract <task-contract-file> [--title-file <title_path>]`; issue creation requires the title file; this is the same derivation used by `freeze` |
| `task_contract` | the accepted `task-contract/v1` document frozen with the candidate |
| `task_contract_digest` | native `taskContractDigest` from the frozen lineage; must match `task_contract` and is part of `subject_id` |
| `base_sandbox` | disposable standalone clone materialized at `base_tree` |
| `candidate_sandbox` | separate disposable standalone clone materialized at `candidate_tree` |
| `contribution_type` | `issue`, `pull-request`, or `issue-comment`; PR publication is unsupported |
| `repository_root` | `git rev-parse --show-toplevel` |
| `established_language` | the language of the active thread, or of comparable current repository artifacts for a new thread |
| `linked_issue` | issue number, or `none` for a new issue |
| `issue_status` | current labels, read from the repository at freeze time |
| `merge_base_sha` | `git merge-base <base> HEAD` |
| `candidate_head_sha` | `git rev-parse HEAD`; freeze committed trees only |
| `draft_path` | file holding the exact bytes to be published |
| `draft_digest` | `sha256sum <draft_path>` |
| `title_path` | exact title file for issue creation; null for comments |
| `draft_title_sha256` | frozen `draftTitleSha256`, recomputed with `bodyDigest` from the title file; null for comments |
| `changed_paths` | `git diff <merge_base_sha> --name-status` |
| `changed_lines` | `git diff <merge_base_sha> --numstat`, summed |
| `scope_sentence` | verbatim from the assignment |
| `explicit_non_goals` | verbatim from the assignment |
| `filter_result` | verbatim from the author, marked untrusted |
| `evidence_manifest` | commands and their decisive output, verbatim from the author, marked untrusted |
| `not_run_checks` | each unexecuted applicable check with its stated reason |
| `n_a_checks` | each inapplicable check with its stated justification |
| `lifecycle_applicability` | the lifecycle matrix rows marked applicable for this candidate |

## Exclusions

Never place any of these in the packet:

- the authoring transcript, or any part of it;
- the author's reasoning, intent, confidence, or self-assessment;
- conclusions about whether the candidate is good, ready, or safe;
- prior audit verdicts for other candidates;
- controller commentary that frames how the auditor should read the evidence.

`filter_result` and `evidence_manifest` are included precisely so the auditor can falsify them. They enter labelled as claims, never as findings. The same holds for any check or limit the author states: the auditor writes `verification` and `limit` for each acceptance row from what it ran itself, and the packet never suggests which limit to record.

## Freeze Integrity

The packet describes bytes that must not move while it is audited.

- Freeze before building the packet, not after.
- If the working tree changes during the audit, the verdict is void: freeze a new candidate, mint a new `subject_id`, and spawn a new auditor.
- Before publishing, re-verify that `candidate_head_sha`, `draft_digest`, and the normalized title digest still match. A mismatch means the human approved bytes that no longer exist.
