# Contribution Readiness Filter

Answer every applicable item explicitly. Do not collapse warnings, unavailable checks, and policy violations into a single pass/fail result.

## Result States

These states report **readiness to publish**. Every checklist item in this file resolves to one of them, except the comment classification in *Before Posting a Comment*, which is a separate vocabulary describing **how a thread finding was answered**. The two never substitute for each other: a comment classified `DECLINED` can still be `PASS` for readiness, and a comment classified `APPLIED` can still be `BLOCKED` if its verification did not run.

| State | Meaning |
|---|---|
| `PASS` | Supported by current evidence. |
| `BLOCKED` | Violates current policy, duplicates active work, or has failing required evidence. |
| `NEEDS_MAINTAINER` | Requires design approval, ownership coordination, a label, or an exception. |
| `WARNING` | Review-risk heuristic; does not independently prohibit publication. |
| `NOT_RUN` | Applicable verification was not executed; reason and remaining risk are stated. |
| `N/A` | Not applicable, with a concrete justification. |

## Before an Issue

1. Search open and closed issues and PRs for the same mechanism.
2. Use a precise Conventional Commit-shaped title where appropriate; do not imitate another title merely to look approved.
3. Cite relevant code paths as `file:line` against an exact commit or tag.
4. Provide reproduction steps runnable exactly as written.
5. Show decisive observed output, not only a description of it.
6. State one affected mechanism and route adjacent findings separately.
7. Describe alternatives and tradeoffs when the solution requires a design choice.
8. Preserve the language established by the surrounding conversation; for a new thread, follow comparable current repository artifacts.
9. Pass the privacy scan.

## Before a Pull Request

1. The linked issue carries `status:approved`, and the PR body contains `Closes`, `Fixes`, or `Resolves #N`.
2. The issue was claimed before implementation, and no competing PR owns the same mechanism. Claiming is `CONTRIBUTING.md` step 3 -- a comment on the linked issue saying you are working on it -- and it applies to every issue, including one you opened yourself; the workflow there is not conditioned on `up-for-grabs`. This row is no longer answered by reading: `evaluateIntake` refuses a `pull-request` intake whose `gh-issue-comments` reading found no claim, so the answer here is whatever the intake recorded. The exact claim must meet the explicit two-line declaration and metadata contract in `../SKILL.md`; a count of own comments is insufficient. Report `NOT_RUN` if you are answering it without that reading.
3. The scope sentence names the mechanism, observable outcome, and explicit non-goals.
4. A regression is RED on the merge base and GREEN on the candidate head, or equivalent evidence is justified.
5. The diff is at or below 400 changed lines, or a maintainer approved `size:exception`. Historical medians are warnings, not gates.
6. The Test Plan lists exact commands. Executed failures block; unexecuted checks remain unticked and explain why.
7. Benchmark validation is completed or marked `N/A` with a reason consistent with the current contribution guide.
8. Guard-population requirements are answered when production Go changes touch `internal/cli`, `internal/reviewtransaction`, or `internal/sddstatus`.
9. Commits are reviewable work units containing the code, tests, and documentation for one behavior.
10. The title and commits follow Conventional Commits and contain no `Co-Authored-By` or AI-attribution trailers.
11. Exactly one PR type is selected. If the contributor cannot apply its `type:*` label, report `NEEDS_MAINTAINER` and request it instead of claiming it was added.
12. Test, assertion, golden, skip, and fixture changes are classified using the evidence matrix below.
13. Persistent-state changes complete the conditional lifecycle check below.
14. The PR presentation follows the language and cognitive-load contract below.
15. The final privacy scan passes immediately before publication.

## Before Posting a Comment

1. Read the full active thread and identify the exact finding or decision being answered.
2. Verify the claim against current code or evidence before agreeing or rejecting it.
3. Classify the response as `APPLIED`, `DECLINED`, `FOLLOW_UP`, or `QUESTION`. This vocabulary describes the answer to a thread finding, not publication readiness; report the readiness state separately when the comment accompanies a candidate.
4. For `APPLIED`, link the commit and name the verification command and result.
5. For `DECLINED`, explain the technical reason, tradeoff, and remaining risk without becoming defensive.
6. For `FOLLOW_UP`, link a dedicated issue; do not expand the current PR.
7. Preserve the thread's established language.
8. Keep the actionable point first; do not recap the entire PR.
9. Group related findings into one response instead of posting multiple fragmented comments.
10. Run the privacy scan before posting logs or environment evidence.

## Evidence Matrix

| Change | Required evidence |
|---|---|
| New regression | Same test RED on base and GREEN on head. |
| Semantic expectation inverted | Explain why the old expectation pinned the defect; show RED on base; account for the old coverage. |
| Golden regenerated | Name the canonical generator command, source of truth, and inspected generated diff. |
| Assertion refactored without behavior change | Demonstrate that the observed behavior and coverage remain equivalent. |
| Test or check skipped/disabled | Explain why; normally classify as `NEEDS_MAINTAINER`. |
| Local failure suspected to be pre-existing | Reproduce it on a clean checkout of the exact merge base before calling it baseline. |

## RED/GREEN Recipe

Prefer, in order:

1. A black-box regression that compiles and runs on both base and head.
2. A clean merge-base worktree with the complete test-only patch applied, including its fixtures and helpers.
3. When the test requires a new API and cannot compile on base, a runnable external reproduction or fixture with the limitation stated explicitly.

Never copy only an isolated assertion when doing so changes the fixture, dependencies, or failure mechanism.

RED/GREEN is pertinent only when the test exercises the behavior the claim is about. A test that is also green on the base does not, by itself, show that the candidate introduces a fix; it can be evidence of behavior that already existed or was preserved. A test that is red on the base for an unrelated reason does not show it either. To show a fix, the test must tell the relevant failure on the base apart from the corrected behavior on the head. A RED/GREEN pair shows that the tested inputs changed outcome between base and head. It is not a guarantee about inputs, platforms, or call paths the test does not reach; say which ones stay outside.

## Claim, Pertinent Check, Result, Limit

Every acceptance condition is answered as a chain, and the auditor records it per condition in `auditor-result/v4`.

| Link | What it holds |
|---|---|
| Claim | One concrete statement about the system or the thread. |
| Pertinent check | What was executed, inspected, or contrasted, and the observation that contradicts the claim: the one that would have and did not occur when the claim held, the one actually observed when it failed. |
| Result | What happened, without reading more into it. |
| Limit | What that check does not demonstrate. |

Valid checks by contribution type:

| Contribution | Pertinent check |
|---|---|
| Code change | RED on the merge base and GREEN on the head for the behavior claimed; targeted and full suites. |
| Issue | A reproduction runnable as written; a contrast of each `file:line` and quoted fragment with the anchor commit. |
| Comment | A contrast with the current code or documentation; a reading of remote state with its `observedAt`, the source's `updatedAt`, and the head SHA. |

Do not stage an execution for a claim whose proof is a reading or a contrast. A green suite demonstrates the cases it runs, nothing more. "None", "fully verified", or a restatement of the result is not a limit: a true observation narrower than the claim it supports is itself the limit, and when that gap is material the condition does not pass. No tool here judges this; the auditor does.

Record evidence compactly:

| Check | Merge base | Candidate head |
|---|---|---|
| Regression | Expected failure and decisive excerpt | PASS |
| Targeted package | Control result | PASS |
| Full suite | PASS / `NOT_RUN` with reason | PASS / `NOT_RUN` with reason |
| Benchmark | Before / `N/A` | After / `N/A` |

## Conditional Lifecycle Check

Use this only when the change reads, writes, migrates, verifies, backs up, restores, or removes persistent state.

| Operation | Affected? | Evidence or reason |
|---|---:|---|
| Install/create | Yes/No | Test or `N/A` reason |
| Sync/update | Yes/No | Test or `N/A` reason |
| Verify/readback | Yes/No | Test or `N/A` reason |
| Backup/restore | Yes/No | Test or `N/A` reason |
| Uninstall/cleanup | Yes/No | Test or `N/A` reason |
| Concurrent writer | Yes/No | Test, mitigation, or accepted risk |

## Verification Before Publishing

Run the applicable commands and record their actual result:

```bash
go build ./...
go vet ./...
go run ./internal/gofmtcheck
go test <affected-packages> -count=1
go test ./...
cd e2e && ./docker-test.sh
git diff <merge-base> --numstat
git diff --check
```
