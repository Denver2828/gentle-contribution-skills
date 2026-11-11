---
name: gentle-ai-aporte
description: "Trigger: gentle-ai issue, PR, upstream contribution. Control the three-role contribution workflow: route state, spawn author and auditor, freeze candidates, and gate publication."
license: Apache-2.0
metadata:
  author: "Denver2828"
  version: "2.0"
---

## Security Boundary

This workflow provides procedural protection against mistakes and convenience bypasses. It does not provide adversarial isolation. The publication guard is a `PreToolUse` hook on the `Bash` tool. For `gh` commands naming the upstream repository it allows only an enumerated set of read shapes and denies everything else; `curl` and the HTTP-mutation flags stay a denylist of known shapes. Deny-by-default on the `gh` side exists because the denylist decided outcomes by what nobody had enumerated -- `gh pr ready` flipped a real pull request out of draft while matching no write token. It reduces accidental shortcuts and now covers unenumerated `gh` verbs, including ones that do not exist yet; it is still a string judgment, not a shell parser, not a security boundary, and not proof that every upstream write is mediated. It does not cover other shells, connectors/browser/API planes, obfuscated or dynamic shell construction, hook bypass or modification, or an actor that can read publication credentials. Agents with unrestricted host shell or publication credentials remain trusted actors. Authoritative prevention against a determined concurrent actor requires credential and domain separation through a Level 2 broker; that broker remains unbuilt and unapproved.

| Resists | Does not resist |
|---|---|
| Accidental error | An auditor with `Bash` leaving its sandbox |
| Involuntary contamination of the candidate | Deliberate edition of the ledger |
| Author bias | A controller that skips the isolation |
| Convenient shortcuts | Forged receipts, while `requireSignedReceipts` stays off. Once on, a receipt signature closes offline forgery by a writer without the passphrase — and only that |
| Accidental reuse of a stale `PASS` | Publishing directly, bypassing the flow entirely |

Read the right-hand column as the honest inventory of what a determined actor can do here, not as a backlog. Do not answer it with more instructions: a sandbox named in a prompt restricts intent, never capability, and a ledger anyone can edit is a record, never an authority. The decisive boundary is who holds the publication credentials, not who runs the checks.

## Activation Contract

The controlled publisher supports `issue-create` and `issue-comment` only. PR
implementation may be reviewed, but `pr-create` is unsupported and must stop before
publication; do not bypass the publisher. Current shipped enforcement is stage 2
with optional signatures, not mandatory signed publication.

You are the **Controller**. Run this skill for any issue, pull request, or review reply directed at `Gentleman-Programming/gentle-ai` or `Gentleman-Programming/engram`. The target repository selects the policy (`--policy gentle-ai` or `--policy engram`) and the anchor; the store, the publisher and the receipt bind whichever repository the ticket names. The Bash publish guard enumerates only gentle-ai, so on engram the procedural protection is the publisher path itself, not the hook.

Three roles with separate contexts. Tool grants and hooks provide procedural guardrails, not capability isolation:

| Role | Runs as | May | May never |
|---|---|---|---|
| Controller | this session | route, freeze, spawn, request approval, publish | draft or implement the candidate; audit it |
| Author | `gentle-ai-author` subagent | draft, implement, test, return evidence | spawn, audit, waive audit, publish |
| Auditor | `gentle-ai-auditor` subagent, fresh per candidate | verify against repository state, return a verdict | edit, publish, spawn, see authoring rationale |

You are the only role that routes. Never perform the author's or the auditor's work yourself, and never let a returned artifact route on your behalf.

## Hard Rules

- Treat the repository's current `CONTRIBUTING.md`, templates, labels, and CI as authoritative. Historical observations are advisory.
- Never open a PR without a linked issue carrying `status:approved`, claimed before implementation, with no active competing work. **Claiming means posting the comment `CONTRIBUTING.md` step 3 asks for, on the linked issue, BEFORE the author is assigned implementation** -- not before publication. The intake evaluator and freeze operation enforce this requirement.
- The only pre-approval exception is an explicitly named `pre-approval-design-comment`. It is eligible only when the linked issue exists, is `OPEN`, does not carry `status:approved`, the complete three-source intake has passed, and no unresolved competing work exists. Claim comments, implementation, and PR preparation or opening remain on the existing approval-first route.
- Its candidate is the exact comment body plus supporting read-only evidence only. It may report bounded evidence or ask for scope, placement, or approval. It may not claim or reserve work, change repository files as the contribution, implement, prepare or open a PR, or grant approval, claim, ownership, implementation, code-receipt, or PR authority.
- Intake requires three independent readings — `gh search issues`, `gh issue list`, `gh pr list`. One source is never sufficient, and a zero from the text search is not absence: its index lags, so it can report nothing about an issue that has been open for hours.
- Routing is deterministic and derived from repository state, never from anyone's opinion about importance. Anything undeterminable fails closed.
- The auditor is spawned by you, per candidate, in a new subagent. Never reuse an auditor context, and never continue a previous auditor after the candidate changed.
- The auditor never executes against the author's checkout. Build two disposable environments from the frozen trees, `base_sandbox` and `candidate_sandbox`, and destroy both afterwards. Prefer standalone clones over worktrees that share `.git`: a shared object store is a shared blast radius.
- The candidate is a content-addressed `subject_id`, not a branch and not a worktree. Freeze committed trees, never live bytes. A branch that moves later does not change the trees that were audited.
- The correction budget is enforced by `scripts/ledger.mjs`, not by this text. A transition the ledger refuses is refused. Never edit the store by hand to reach a state it would not grant. Closing a lineage is a transition too: `retire --lineage <L> --reason-file <F> [--superseded-by <L2>]` moves it to the terminal `RETIRED` state, archives its receipt, and refuses while a live ticket exists. A superseded body that must never be published is retired, not left in `AUTHORIZED`.
- A passing preflight is required before evidence may be recorded, while `.claude/tools/audit/enforcement.json` declares stage 2 or higher. Read that file first; a stage it does not declare, or one it cannot state, blocks. `FAIL`, `UNKNOWN`, or a required `NOT_RUN` stops the flow, and nothing is synchronised, rebased or modified to make it pass -- the gate reports the state, it does not repair it.
- Evidence never authorises. It records what was verified for any state, including a failing one; permission is a separate act with its own preconditions, and it refuses on any `FAIL`, `UNKNOWN` or required `NOT_RUN`.
- Attempt numbers come from the store, never from you. Reserve one, publish, record the attempt.
- The store's index and artifacts carry no cryptographic signature: anyone able to write into it can write a consistent record. The one exception is the authorization receipt, which the HUMAN may sign with `bin/sign-receipt.mjs` — that signature closes offline forgery of receipts by a writer without the passphrase, and closes exactly that. Receipt = qué publicación autorizaste. Ticket = derecho consumible para ejecutarla. Attempt = qué ocurrió realmente.
- The signer and the keygen are run by the human, in the human's own terminal, never through you or any agent tool. The passphrase must never pass through the agent's tools: both binaries refuse a passphrase in argv or env and refuse piped stdin, and those refusals are the enforcement of this rule, not a substitute for it.
- Pass no authoring transcript, private reasoning, or conclusions into the audit. The Audit Packet is built from repository state and returned artifacts only.
- Route only from the auditor's structured verdict. A verdict is not negotiable and is not re-argued.
- A `PASS` is bound to its candidate. Any change to the candidate invalidates it and requires a new freeze and a new auditor.
- At most one bounded correction per candidate. A second correction is a new candidate, not a retry.
- Human approval is mandatory immediately before publication, and applies to the exact bytes audited.
- Never report an unexecuted check as passing. `NOT_RUN` and `N/A` carry their reason.
- A textual match only locates evidence; it never proves meaning. Before asserting that a published body, comment, or thread contradicts (or matches) a candidate: read the relevant section in full, quote the exact fragment that carries the conclusion, classify that fragment as current scope, historical context, or non-target, and compare it against the paths actually changed. Probing a text for your own draft's markers tests authorship, not content. For example, a mention of a rename may explain that it was dropped rather than implemented. Record every remote-state assertion with its `observedAt`, the source's `updatedAt`, and the head SHA, so a misread can be told apart from a state that genuinely moved between readings.

## Routing States

```mermaid
stateDiagram-v2
    [*] --> Intake
    Intake --> PreApprovalDiscussion: pre-approval-design-comment; OPEN; status:approved absent; intake clear
    Intake --> BlockedApproval: No approved, claimed, uncontested issue
    Intake --> Drafting: Approved and claimed
    BlockedApproval --> [*]: Stop; open or claim the issue
    PreApprovalDiscussion --> Filtered: Author returns comment-only candidate
    Drafting --> Filtered: Author returns artifacts
    Filtered --> CandidateFrozen: Audit required for every publication
    CandidateFrozen --> Auditing: Controller spawns isolated auditor
    Auditing --> Passed: PASS
    Auditing --> Correction: NEEDS_CHANGES
    Auditing --> MaintainerDecision: NEEDS_MAINTAINER
    Auditing --> MissingEvidence: BLOCKED_INCOMPLETE
    Correction --> CandidateFrozen: One bounded correction
    Correction --> MaintainerDecision: Correction allowance already spent
    MissingEvidence --> CandidateFrozen: Evidence supplied; re-freeze
    MaintainerDecision --> [*]: Stop; surface to the human
    Passed --> Evidence: Record what was verified
    Evidence --> Authorized: Every required check PASS, candidate identified
    Evidence --> [*]: Anything unresolved; stop
    Authorized --> HumanApproval
    HumanApproval --> Drafting: Changes requested
    HumanApproval --> [*]: Declined
    HumanApproval --> Published: Explicit approval, candidate revalidated
    Published --> [*]
```

| State | Held by | Leaves when |
|---|---|---|
| `Intake` | Controller | Policy, approval, claim, and absence of competing work are established, or the named pre-approval exception's eligibility is proven |
| `BlockedApproval` | Controller | Terminal. The issue must be opened, approved, or claimed first |
| `PreApprovalDiscussion` | Author subagent | The exact comment body and supporting read-only evidence are returned |
| `Drafting` | Author subagent | Artifacts are returned |
| `Filtered` | Controller | Audit scope is derived from the candidate |
| `CandidateFrozen` | Controller | Binding computed and Audit Packet built |
| `Auditing` | Auditor subagent | A structured verdict is returned |
| `Correction` | Author subagent | One bounded correction only; a second is a new candidate |
| `MaintainerDecision` | Human | Terminal here. An unresolved decision, label, or exception blocks publication |
| `MissingEvidence` | Controller | The missing evidence is supplied, which requires a new freeze |
| `Passed` | Controller | Verdict bound to this exact candidate |
| `Evidence` | Controller | The evidence record is stored and bound to this lineage's `candidateId` |
| `Authorized` | Controller | A receipt exists for this exact candidate. It expires the moment the candidate moves |
| `HumanApproval` | Human | Explicit approval of these exact bytes, or a decline, or requested changes |
| `Published` | Controller | Terminal. One authorized action, after re-verifying the binding |

`PreApprovalDiscussion` takes precedence over `BlockedApproval` only for the named exception while `status:approved` is absent. Once that label is present, the exception is ineligible and the original approval-first states apply.

Any change to the candidate invalidates `Passed` and returns to `CandidateFrozen` with a new `subject_id` and a new auditor.

## Audit Scope Derivation

Every publication requires a frozen candidate and a fresh auditor PASS. There is no audit exemption for low-risk work. The following observations determine audit scope, not whether to audit. Record each answer with the command or path that produced it; an unknown observation requires investigation.

| Observable fact | How it is determined |
|---|---|
| The diff changes non-test Go outside documentation and assets | changed-path manifest |
| The diff changes `_test.go`, `testdata/`, fixtures, skips, or assertions | changed-path manifest |
| The diff changes files that read, write, migrate, verify, back up, restore, or remove persistent state | changed paths plus the lifecycle matrix in `references/filtro.md` |
| The diff touches `internal/cli`, `internal/reviewtransaction`, or `internal/sddstatus` | changed-path manifest |
| Changed lines reach or exceed the review budget, or span more than one reviewable area | `git diff <merge-base> --numstat` |
| The draft states a performance, benchmark, security, or permissions claim | the draft text |
| The draft proposes a solution or design rather than reporting an observed defect | the draft text |
| The draft disputes, declines, or reinterprets a reviewer finding | the thread and the draft |
| Any of the above cannot be determined | record `unknown` |

Never record a row as `no` because the change is small, obvious, or already reviewed by its author.

## Execution Steps

1. **Intake.** Read the current contribution guide and the applicable template. Then take **all three** readings below, every time. One source is a source, not a search:

   ```bash
   # gh-search-issues: the text index. Covers the history, including closed items, and lags behind the repository.
   # Omit --state: it accepts only open|closed, and omitting it is what searches both.
   # --include-prs is what surfaces a competing pull request that never became an issue.
   gh search issues --repo Gentleman-Programming/gentle-ai --include-prs --limit 25 "<terms of the mechanism>" \
     --json number,title,state,isPullRequest \
     --template '{{range .}}{{.number}}  {{.state}}  pr={{.isPullRequest}}  {{.title}}{{"\n"}}{{end}}'
   # Query terms are conjunctive: every term must match. Prefer two or three broad terms
   # over a long specific phrase, which returns zero and reads as absence when it is not.
   # gh-issue-list: what the index does not have yet. No text filter; it is read by eye.
   gh issue list --repo Gentleman-Programming/gentle-ai --state open --limit 60 \
     --json number,title,author,createdAt \
     --template '{{range .}}{{.number}}  {{.createdAt}}  {{.author.login}}  {{.title}}{{"\n"}}{{end}}'
   # gh-pr-list: the same, for work already in flight as a pull request.
   gh pr list --repo Gentleman-Programming/gentle-ai --state open --limit 60 \
     --json number,title,author,createdAt \
     --template '{{range .}}{{.number}}  {{.createdAt}}  {{.author.login}}  {{.title}}{{"\n"}}{{end}}'
   # gh-issue-comments: REQUIRED on the pull-request route, and on no other. The three
   # readings above all answer "what has upstream already published?". None of them
   # answers "what did WE announce?", and on the PR route that announcement is the only
   # thing that stops the work being done twice.
   # Retrieve full comment bodies and metadata; paginate until coverage is complete.
   gh api --paginate repos/Gentleman-Programming/gentle-ai/issues/<N>/comments
   ```

   The record must also declare its route as `contributionType`: `pull-request`, `issue`
   or `issue-comment`. It is not optional and nothing is inferred from the readings
   present -- a record that omits both its route and its claim reading would otherwise
   pass by looking exactly like an issue, which is the shape of the mistake this field
   exists to catch. On the PR route also record `linkedIssue` (integer), `contributor`
   (GitHub login), and a one-line `scope`. `matches` counts all returned comments,
   consistently with the coverage receipt; it does not establish a claim.

   The `gh-issue-comments` reading must carry `claim` with `id` (numeric comment id),
   `url` (the issue-comment permalink), `author` (login), `body` (the complete body),
   and UTC `createdAt`, `updatedAt`, `observedAt` timestamps. Map GitHub API fields
   `html_url`, `user.login`, `created_at`, `updated_at` to those names. The intake
   checks the issue/repository, author, timestamps and exact explicit body:

   ```text
   I am implementing #<linkedIssue>.
   Scope: <scope>
   ```

   Use this complete two-line body for the claim publication; do not infer intent
   from a count, substring, thank-you or decline. A missing or different declaration
   is `UNKNOWN`; an empty complete comment listing is `FAIL`. A historical free-form
   claim needs an explicit declaration through the ordinary reviewed publication
   path before a new PR intake can pass. These are validations of supplied readings;
   they do not independently authenticate GitHub observations.

   **Post the claim comment before assigning implementation, not before publishing.** The
   comment is what stops a second implementer -- the maintainer included -- from starting
   while you verify yours. `issue-comment` is a supported publisher operation, so it goes
   out through the controlled path like any other publication.

   An empty `gh search issues` result is **forbidden** as evidence of absence. It describes the index, not the repository: `#2213` was open for hours while that search returned zero. Any reading that failed, or that could not be read in full, is `PARTIAL` or `FAILED`, which yields `UNKNOWN` and stops the flow — nothing is inferred from a reading that did not finish. Matches you did not read are not matches you cleared: record `reviewed: true` only for readings you actually went through.

   Record the three readings and the numbers of any competing item in an intake record, and check it before doing anything else:

   ```bash
   node .claude/skills/gentle-ai-aporte/scripts/ledger.mjs intake --intake <intake.json>
   ```

   Exit `0` continues through the existing approved route. As the only exception, an explicitly eligible `pre-approval-design-comment` continues to `PreApprovalDiscussion` when the linked issue exists and is `OPEN`, `status:approved` is absent, the complete three-source intake passed, and no unresolved competing work exists. Every other unapproved path remains `BLOCKED_APPROVAL`; `UNKNOWN` stops at `Intake`. The same record is passed to `freeze`, which refuses to open a lineage without a passing intake — this is not a reminder, it is a precondition of the store.
2. **Assign.** Spawn `gentle-ai-author` with the contribution type, linked issue and status, scope sentence, explicit non-goals, target branch, and merge base. Assign one candidate at a time. Every `file:line` the brief hands the author is measured from an undecorated numbered listing of the file bytes alone (`bat --decorations=always --style=numbers <file>` or `cat -n <file>`, or `git cat-file -p <blob>` piped into one of them; plain `bat --style=numbers` prints no numbers once its output is piped), never from a stream with anything prepended, and the brief carries the printed numbered lines next to each citation. Measure from the actual candidate and verify the recorded identity.

   For `pre-approval-design-comment` only, assign the author comment-only work with the linked issue and status, completed intake, scope sentence, and explicit non-goals. The author does not need the repository anchor. Require the exact body and supporting read-only evidence, enforce the candidate limits above, and preserve Controller/Author/fresh-Auditor separation. The Controller creates the existing network anchor in the Freeze step before audit binding, then reuses the original issue-comment path unchanged: exact-body freeze with no title binding, `preflight-issue`, evidence, exact-body `issue-comment` authorization, human approval, and the controlled publisher.
3. **Route.** On return, derive and record audit scope from the candidate. Always continue to freeze and a fresh auditor; even a candidate with every scope flag set to `no` needs a PASS.
4. **Freeze.** Commit the candidate so its trees exist as Git objects, then resolve `base_tree` and `candidate_tree`, capture the changed paths with their modes, write the draft to `draft_path`, and capture the policy, test manifest, and explicit `task-contract/v1`. Mint the identity and open the ledger:

   ```bash
   node .claude/skills/gentle-ai-aporte/scripts/ledger.mjs freeze \
     --lineage <lineage> --candidate-id <snapshot-hash> --base-tree <tree> --candidate-tree <tree> \
     --paths <file> --draft <file> --policy <file> --test-manifest <file> \
     --task-contract <task-contract.json> \
     --intake <intake.json>
   ```

   For issue creation, also pass `--title-file <title.txt>` to `freeze`, `refreeze`
   and `subject-id`. Its normalized digest is part of the subject identity and
   the auditor packet. Changing the title requires a new candidate and auditor.
   An untitled or historical audit cannot mint a new issue-create authorization.
   Historical receipts remain readable and keep their existing binding.

   `refreeze` takes both `--intake` and `--task-contract`. The contract states `goal`, `constraints`, stable-id `done_when` conditions, and `escalate_when`; empty or duplicate acceptance ids refuse before a lineage exists. Its canonical `taskContractDigest` is part of `subject_id`, so changing what the candidate is supposed to accomplish creates another subject. Write each `done_when` condition as something a check could contradict. A condition may group related claims, but material claims that need different checks get separate conditions: "the reproduction fails on the anchor" and "no other caller is affected" are proven by different evidence, and one row cannot carry an honest limit for both. Do not turn every sentence into a condition; split only where the proof differs. The intake is re-evaluated too: a `PASS` from the first freeze describes an earlier reading of upstream, and upstream moves.

   `--paths`, `--policy` and `--test-manifest` are parsed before they are hashed, and an unparseable one stops the freeze. `--draft` is not: it is the bytes to be published and is never constrained to a format. The freeze also records the draft's normalized digest (`draftBodySha256`, the same `bodyDigest` the receipt, the ticket and the publisher apply) beside `subject_id`, never inside it; `authorize` refuses any `--body-file` that does not reproduce it, so the body that reaches the receipt is the draft that was audited. Hashing is not reading -- a manifest with invalid JSON once passed a freeze and a full audit and surfaced two rounds later, because the identity was sound and nothing else ever opened the file. Write these three with a tool that serialises, never with a shell heredoc: a quoted delimiter still consumed one backslash level under Git Bash on Windows, which is exactly how that manifest broke.

   **A test manifest that claims must prove.** Parsing is not verifying: a manifest declaring `10 subtests, 0 skips` over a run that skipped four parses cleanly and mints a sound `subject_id`, and an undisclosed skip is a false green. So declaring any of `subtests`, `skip`, `fail` or `stream` -- either nested under `testClaim` or at the manifest root -- obliges naming the `go test -json` stream those counts came from, and the freeze judges them against it before any identity exists:

   ```json
   { "suite": "go test ./internal/cli -json", "testClaim": { "subtests": 10, "skip": 4, "fail": 0, "stream": "go-test.jsonl" } }
   ```

   `stream` resolves against the manifest's own directory, never the working directory. A manifest that declares no counts is unaffected; this refuses false records, not quiet ones. The boundary is the verifier's own: it proves the counts match the stream it was handed, never that the stream came from the run the manifest describes. Capture it directly from the Go process, unfiltered, and state that you did -- that claim is the auditor's to falsify.

   **The anchor comes from the network, never from a local ref.** A candidate that changes no repository path -- an issue or a comment -- still needs a repository state to bind `candidateId` and to run the gate against. Build it with:

   ```bash
   node .claude/skills/gentle-ai-aporte/scripts/anchor.mjs \
     --repo Gentleman-Programming/gentle-ai --clone <clone> --worktree <path>
   ```

   Both paths must be outside the outer harness and its nested `src` SUT. Take
   a read-only SUT attestation before work and compare it after work with
   `.claude/tools/audit/bin/sut-attest.mjs --baseline <before.json>`; a mismatch
   stops for inspection and is never repaired with reset or clean.

   `--candidate-id` for the freeze is that worktree's snapshot: `audit.mjs snapshot --cwd <the anchor worktree> --format json`, field `hash`. Recompute it at `gate-publish` and `reserve-attempt` rather than reading a file you wrote earlier -- the value is a snapshot of the repository, not of the draft, so it survives edits to the candidate text and goes stale only when the repository moves.

   It reads the tip through the API, guarantees the clone holds that exact commit, and pins a detached worktree to the SHA. `git worktree add --detach <path> origin/main` must not be used for this: it resolves a LOCAL pointer and never touches the network, so a stale clone yields a silently different answer instead of a failure. Historical examples are omitted from this public edition.

   The same run exposed why the staleness was invisible: `git fetch origin main --quiet 2>&1 | tail -1` reports `tail`'s exit code, not `fetch`'s, so a fetch exiting 128 looked identical to one exiting 0. Never pipe a command whose status you rely on.

   **Re-verify every live value immediately before publication, not at freeze.** The interval between freezing and publishing is measured in tens of minutes, and any "current X" measured at the start is a claim about the past by the end. For a candidate that names live state, list the values it depends on in order of fragility and re-read them at the moment of publication.

5. **Build the sandboxes.** Materialize `base_sandbox` from `base_tree` and `candidate_sandbox` from `candidate_tree`, disposable and separate from the author's checkout. Record how to destroy them before you spawn anything.
6. **Bind and packet.** Build the Audit Packet in `references/audit-packet.md` from repository state and returned artifacts. Exclude every authoring transcript, rationale, and conclusion.
7. **Spawn the auditor.** Start `gentle-ai-auditor` as a new subagent with the packet as its entire input, then destroy both sandboxes when it returns. One auditor per candidate, never continued and never reused.
8. **Route from the verdict.** Record it in the ledger, which owns the transition:

   ```bash
   node .claude/skills/gentle-ai-aporte/scripts/ledger.mjs record-audit \
     --lineage <lineage> --result <auditor-result.json>
   ```

   The store validates and content-addresses `auditor-result/v4`, derives its
   coverage identity, verdict, correction eligibility, and coverage remediation,
   and rejects caller-supplied authority. Every `done_when` id must appear exactly
   once with bounded evidence. A row that reached `PASS` or `FAIL` is a completed
   evaluation; `NOT_RUN`, `N/A`, a missing, duplicate or unexpected row is not.
   Completeness is not satisfaction: only all-`PASS` coverage can derive `PASS`,
   and a demonstrated `FAIL` routes by causality (`NEEDS_CHANGES` with an
   introduced severe finding, otherwise `NEEDS_MAINTAINER`), never to `PASS`. A
   `subject_id` mismatch moves the lineage to `STALE`. Authorization binds the
   SHA-256 of both the accepted task contract and exact persisted result bytes in
   `receipt.artifacts`, and every forward publication step revalidates them.

   **Claim, pertinent check, result, limit.** In `auditor-result/v4` every `PASS`
   and `FAIL` acceptance row carries `verification.method` (what was executed,
   inspected or contrasted), `verification.falsifier` (the observation that contradicts
   the claim as the contract states it: the one that would have and did not occur
   on a `PASS` row, the one actually observed on a `FAIL` row; never what would
   make the claim true) and `limit` (what stays outside what was
   demonstrated), each as non-blank text of at most 2048 characters. `NOT_RUN`
   and `N/A` rows may carry `null` for both and keep their `reason` and `remediation`:
   nobody is asked to describe a check that did not happen. These fields are part
   of `acceptanceCoverageDigest`, of `auditResultId` and of the result bytes the
   receipt binds. An in-place edit is refused at once; after authorization any
   rewrite is refused on every forward path and by the trace command. Before a
   receipt exists the index is the only anchor and it is unsigned, as stated in
   Security Boundary. They never enter the verdict. The store validates structure and
   presence; it cannot establish that a method is pertinent or that a limit is
   true, and it does not approximate that with a word list. That review is the
   fresh auditor's, and the human reads the result of it at approval.

   `designCoverage` and `maintainerDecisions` sit outside the five-finding cap: a
   missing or material unassessed design aspect derives `BLOCKED_INCOMPLETE`, and
   any pending maintainer decision derives `NEEDS_MAINTAINER`, in that order.
   `record-audit` refuses v2 and v3 for new audits. Historical `AUDITED_PASS`
   lineages and `auditor-result/v1`, `/v2` and `/v3` remain readable and keep
   verifying under the contract they were written with; none is migrated, no old
   `subject_id` or `auditResultId` is reinterpreted, and no limit is written into
   them after the fact. A lineage without a task contract cannot mint a new
   authorization. Freeze a new lineage instead.
9. **Correct, if the ledger grants it.** `reserve-correction` succeeds only from `NEEDS_CHANGES` and only while the budget holds; a re-audit that returns `NEEDS_CHANGES` after the correction was spent escalates to `NEEDS_MAINTAINER`. Completing missing evidence does not spend or restore a correction. Re-assign the author with the findings and the unchanged scope, then `refreeze` and spawn a new auditor against new sandboxes.
10. **Approval.** Present the draft, the derivation, the verdict with its `subject_id`, and every `BLOCKED`, `NEEDS_MAINTAINER`, `WARNING`, `NOT_RUN`, and `N/A` item. When several contributions are ready at once, present them together and let the human decide order and spacing.

    Open the presentation with the **acceptance trace**, one block per `done_when` condition, in this order: claim → check → result → limit. Take it from the store, never from memory or from the auditor's prose:

    ```bash
    node .claude/skills/gentle-ai-aporte/scripts/ledger.mjs decision-package --lineage <lineage> --format text
    ```

    The command reads the lineage's durable auditor result and task contract after verifying them, and refuses a result that does not verify. Present every row, `PASS` and `FAIL` alike, with its limit as the auditor wrote it: do not shorten a limit, merge rows, or reword a check into something stronger. A `NOT_RUN` or `N/A` row is presented with its reason. For a lineage audited before `auditor-result/v4` the command prints `not recorded by this version` for the check and the limit; say exactly that to the human ("no registrado por esta versión"), and never reconstruct a check or a limit from the evidence text. The text form shows any terminal control, line break, bidirectional control or hidden-text character (tag characters, zero-width space and the like) found in the recorded text as a visible `<U+XXXX>` mark instead of sending it to the terminal, and the JSON form writes the same characters as `\uXXXX` escapes; present those marks as printed and treat their presence in an auditor's text as something to tell the human, not something to clean up. The marks are display only and change no artifact. The trace shows what the auditor recorded. It is not proof that the method was pertinent or the limit complete, and the presentation must not suggest it is.

    Close the presentation with the **decision package**: reasons FOR and reasons AGAINST publishing this candidate. The Controller does not assess the candidate itself; it assembles the package from the auditor's `designCoverage` rows, its `maintainerDecisions`, its findings, and the recorded checks, and every entry cites that source (a verdict finding, a `designCoverage` aspect, a check result, a `file:line`, a thread link). Cover the three cost axes: **system** (maintenance, complexity, coupling, review load on the maintainer), **user** (defaults, prompts, waits, error quality, migration), and **product** (support burden, roadmap fit, overlap with an existing mechanism). Both sides are always evaluated, but neither list needs filler: when a side has nothing material, state "no material reason found" with what was examined. The package is judged by the coverage of the evaluation, not by the symmetry of the lists. A material unassessed aspect never reaches this step: the store derives `BLOCKED_INCOMPLETE`, and the audit is completed first. An aspect declared `not_applicable` is presented with its justification; one declared `not_assessed` with `material: false` is presented as residual uncertainty with its justification and impact. A lineage audited under `auditor-result/v3` has `designCoverage` but no per-condition check or limit; present its design rows as recorded and its trace as not recorded. A historical lineage audited under `auditor-result/v2` has no `designCoverage`: present every design aspect and cost axis as not assessed, and say the audit predates that coverage. Never fill a gap from the Controller's own judgment. Never leave out a cost to steer the decision: the human decides with the full picture. The three cost axes and the package of reasons for and against are adapted from [`decode2/pr-review-discipline`](https://github.com/decode2/pr-review-discipline) v1.6 by decode2 (Apache-2.0), `references/five-fold-evaluation.md`, "cost balance and verdict package"; see `NOTICE` for what was changed.
11. **Run the preflight, and stop if it does not pass.** Check the stage first, then run the gate over the candidate's repository:

    ```bash
    node .claude/tools/audit/bin/audit.mjs enforcement
    node .claude/tools/audit/bin/audit.mjs check --policy gentle-ai --gate <gate> --cwd <repository>
    ```

    **The candidate's own type selects the gate, and picking the wrong one fails on checks the candidate cannot satisfy.** Policy `gentle-ai` declares two, and policy `engram` mirrors them:

    | Candidate | Gate | Why |
    |---|---|---|
    | pull request | `preflight` | It has a branch and a diff, so the branch, upstream and review-budget checks have a subject |
    | issue, comment | `preflight-issue` | It changes no file. The five checks that measure a branch or a diff are recorded `NOT_RUN` with that motive rather than failing on a subject that does not exist |

    Run `preflight` over an issue or a comment and it reports FAIL on `git.branch-allowed` and `git.upstream-configured`, because the anchor is a detached worktree with no branch and no upstream, and UNKNOWN on `diff.within-review-budget`, because there is no base to measure against. None of that is about the candidate. Select the gate appropriate to the candidate type.

    Exit `0` continues. `1` (FAIL), `2` (UNKNOWN or a required NOT_RUN), `3` (configuration) and `4` (contract) all stop the flow. Present the failing checks with their reasons and their remediation verbatim, and let the human decide -- do not fetch, rebase, stage, stash or otherwise move the repository so the gate goes green. A gate that gets its own preconditions arranged for it is not measuring anything.

    Record the run in `docs/burn-in-stage-2.md`: the result, whether any finding turned out to be a false positive, whether the gate was bypassed and on whose decision, and anything that interrupted the run. The burn-in exists to decide whether stage 2 stays; a run nobody wrote down is a run that cannot inform that. A false positive, a burned lineage, or a prose finding the auditor returned also gets one row in `docs/recurrence-register.md`, under its class or under Pending classification; the burn-in entry narrates, the register counts.

    **Kill switch:** set `"stage": 1` in `.claude/tools/audit/enforcement.json`. The preflight goes back to informative and this step stops being required. No code changes, no reinstall, no argument.

12. **Record the evidence.** It exists for any state, including one nobody should publish, and it authorises nothing on its own. It must name this lineage's `candidateId`, decision and snapshot, or the store refuses it:

    ```bash
    node .claude/skills/gentle-ai-aporte/scripts/evidence.mjs \
      --gate-result <the stdout of audit.mjs check> --subject-id <sha256:...> \
      --reason-file <file> --out <evidence.json>

    node .claude/skills/gentle-ai-aporte/scripts/ledger.mjs record-evidence \
      --lineage <lineage> --evidence <evidence.json>
    ```

    The helper derives `evidenceId` over the record itself, fills the binding from the gate result, and always writes `authorises: false`. It enforces one thing: **the reason must name the `subject_id` it describes.** Measure from the actual candidate and verify the recorded identity.

13. **Ask for authorization — two phases, and the second belongs to the human.** Phase one mints the receipt, and since authorization 1.1.0 the receipt binds the exact publication: operation, target, and the hashes of the exact bytes. Authorizing without that binding is refused — a receipt that does not say what it authorizes publishing is a blank check. Granted only when the gate passed, the repository did not move during it, the candidate was identified, and every required check reached `PASS`:

    ```bash
    node .claude/skills/gentle-ai-aporte/scripts/ledger.mjs authorize --lineage <lineage> \
      --operation issue-create|issue-comment --target-repo Gentleman-Programming/gentle-ai \
      [--target-number <N>] --body-file <draft> \
      [--title-file <title>]   # required for issue-create; issue-comment has no title
      [--depends-on <lineage>[,<lineage>...]]   # lineages that must have published first
    ```

    `--body-file` must be the frozen draft. Byte variants that normalize equal (BOM, CRLF, trailing newlines) are the same body; anything else refuses with `draft-mismatch` and mints nothing, and a lineage frozen before draft binding refuses with `missing-draft-binding`. That lineage has no way back: `AUDITED_PASS` and `REAUDITED` admit no `refreeze`, so the recovery is a new lineage -- freeze it, audit it, authorize it -- never a reinterpretation of the old subject. A body that changed after the audit is a new candidate, not a new argument to `authorize`.

    `--depends-on` declares that this body is only true once the named lineages have published (for example a comment that says "I left a note on #4078"). The list is bound into the receipt's `publication.dependsOn` and into the ticket; the store refuses an unknown, self, duplicate, closed or cyclic dependency at authorize, and refuses gate-publish, reserve-attempt and the publisher with `dependency-unpublished` (or `dependency-closed`) until every dependency has a recorded attempt with outcome `published` and `bodyIdentical: true`. The order is held by the store, not by a live read before gate-publish.

    issue-create binds its title hash into the receipt — a title outside the binding would let a valid signed receipt publish under a changed title, and the publisher verifies the title file against the ticket before consuming. **These two are the only supported operations. `pr-create` is retired**: its result cannot be fully bound under the current contract (the publisher's argv carried no `--base`/`--head`, so the proposed commits and target branch sat outside the signature, and a valid receipt could have been spent from any branch). *Retirarla es reducción de superficie; dejarla parcialmente ligada es deuda disfrazada de capacidad.* Any surface asked for pr-create refuses with `operation-unsupported` and the reason; for the documented literal `gh pr create ... --repo Gentleman-Programming/gentle-ai` shape routed through the Bash hook, the guard also denies it. That is useful asymmetry inside the matcher's measured scope, not universal coverage. The requirements bar a future bound pr-create must meet (baseRef; headRef with owner:branch semantics; immutable commit identity — SHA, never only branch names; mandatory `--base`/`--head` in the executed argv; post-publish verification of effective body, title, base and head/commits) is recorded next to the negative in the audit README, explicitly not designed today.

    This also writes a `pending-signature/` request and prints the phase-two command. Phase two is the HUMAN signer, run by the human in their own independent terminal, never through you: **the passphrase must never pass through the agent's tools** — the signer refuses a passphrase in argv or env and refuses piped stdin, and you never invoke it, wrap it, or relay its prompts:

    ```bash
    # HUMAN ONLY, own terminal:
    node .claude/tools/audit/bin/sign-receipt.mjs --lineage <lineage>
    ```

    The signer recomputes the receiptId from the record itself, displays what is being authorized next to the anchored key fingerprint, and demands the last 6 hex characters of the recomputed id — a bare "y" signs nothing. Afterwards, back on your side:

    ```bash
    node .claude/skills/gentle-ai-aporte/scripts/ledger.mjs attach-signature --lineage <lineage>
    ```

    which verifies the signature against the anchored public key and records it. While `requireSignedReceipts` in `enforcement.json` is `false` (its shipped state), an unsigned receipt does not block — verification still runs and its state (`valid`/`absent`/`invalid`) is recorded in every forward-path result. Re-authorizing the same candidate to a DIFFERENT target replaces the receipt (new receiptId, new signature needed); the old receipt is archived untouched and recorded attempts keep naming it.

14. **Publish, through the controlled publisher.** Recompute the candidate identity from current state, take the gate, then reserve an attempt. The reservation takes no operation, target or hashes: the ticket is DERIVED from the receipt's publication binding, field for field. Both steps revalidate the receipt and the candidate, because `PUBLISHABLE` is informative and never a durable token:

    ```bash
    node .claude/skills/gentle-ai-aporte/scripts/ledger.mjs gate-publish \
      --lineage <lineage> --current-candidate-id <recomputed>
    node .claude/skills/gentle-ai-aporte/scripts/ledger.mjs reserve-attempt \
      --lineage <lineage> --current-candidate-id <recomputed>
    ```

    A mismatch marks the lineage `STALE`, and it does not come back: freeze again and audit again. A receipt without a publication binding (authorization 1.0.0) refuses here, naming re-authorization as the way through. The reservation emits a one-shot ticket (30-minute expiry, one live ticket per lineage, so a duplicate `reserve-attempt` refuses instead of burning a number). Then, after human approval of these exact bytes, the ticket is spent by the sanctioned write path for this workflow:

    ```bash
    node .claude/tools/audit/bin/publish.mjs --lineage <lineage> --body-file <draft> [--title-file <title>]
    ```

    The publisher takes no operation, repository or target from you — the ticket IS the command. It reads the body file ONCE, canonicalizes immediately (BOM stripped, line endings folded to LF, trailing newlines dropped), verifies the hash over that canonical content before consuming (a wrong file spends nothing), and hands exactly that canonical content to gh over stdin (`--body-file -`): the signature authorizes los bytes canónicos, and exactly that value crosses to gh by value — never as a path gh re-reads (a second read was a window a swapped file could win) and never as raw file bytes (a second representation byte-variant files could exploit; CRLF/BOM/trailing-newline variants share one hash). Detectar no equivale a impedir. It then consumes the ticket, runs the exact gh operation the ticket names, fetches the published body back and compares canonical to canonical (the independent post-publication confirmation, not a compensation), and records the attempt itself — `record-attempt` by hand is only for an attempt whose ticket this store already consumed (typically a publisher run whose own record step failed and printed the JSON to keep), and it refuses a duplicate attempt number, a record that does not match its own `attemptId`, a number whose consumption the index never confirmed (`attempt-unconsumed`: a live ticket, a `consumed/` artifact prepared by a run whose manifest write failed, or a consumption made before the store recorded confirmations), and a `receiptId`, `candidateId` or `evidenceId` that is not the *consumed ticket's* (`attempt-binding-mismatch`; the lineage's current receipt or evidence do not count, because re-authorization and `record-evidence` move them). A publication that never spent a ticket has no attempt to record and cannot satisfy a `--depends-on` by hand; never re-publish to recover a record, it could duplicate a real publication. Exit `0` means published **and** verified canonical-identical (the fetched body reproduces the signed hash — a CRLF-echoing API legitimately returns different raw bytes); anything else is non-zero and recorded loudly.

    A failed attempt changes neither the evidence nor the receipt: it is a third artifact beside them, and a second attempt sits beside the first. Consumption before the network is the honest accounting: a gh failure after consuming still spends the attempt. The gate is not approval — the human still approves these exact bytes, and the harness still prompts. Record every publisher run in `docs/burn-in-stage-3.md`: that log is the gate for flipping stage 3 on.

## Output Contract

Return:

- routing state and contribution type;
- scope sentence and explicit non-goals;
- audit scope derivation, fact by fact, with how each was determined;
- audit verdict with its candidate binding, or the derived facts that left it untriggered;
- filter result grouped by result state, and the decisive verification evidence;
- draft body in the thread's established language;
- acceptance trace: for every `done_when` condition, claim → check → result → limit as `ledger.mjs decision-package` prints it, or "not recorded by this version" for an audit older than `auditor-result/v4` (step 10);
- decision package: reasons FOR and AGAINST publishing, each sourced from the audit and the recorded checks or stated as "no material reason found" with its scope, covering the system, user, and product axes, with every `not_applicable` and immaterial `not_assessed` aspect presented with its justification (step 10);
- for `pre-approval-design-comment`, proof that the linked issue is `OPEN`, `status:approved` is absent, the complete three-source intake passed with no unresolved competing work, and the comment-only candidate grants none of the excluded authorities;
- exact next action, published only on explicit human approval of these bytes.

## License and Credits

This skill and its two role definitions (`gentle-ai-author`, `gentle-ai-auditor`) are licensed under the Apache License, Version 2.0: see `LICENSE` and `NOTICE` in this directory. You may use, copy and adapt them under those terms, which include keeping the license and the attribution notices and stating what you changed.

The auditor's four design questions, the three cost axes and the for-and-against decision package are adapted from [`decode2/pr-review-discipline`](https://github.com/decode2/pr-review-discipline) v1.6 by decode2, also Apache-2.0. `NOTICE` lists the adapted portions and the changes made to them.

## References

- [references/filtro.md](references/filtro.md) — operational checklists and evidence recipes.
- [references/audit-packet.md](references/audit-packet.md) — the standardized Audit Packet.
- [scripts/ledger.mjs](scripts/ledger.mjs) — records the candidate state machine, the `subject_id`, the correction budget, the intake record, and the three artifacts of a decision. Subcommands: `freeze`, `record-audit`, `reserve-correction`, `refreeze`, `intake`, `record-evidence`, `authorize`, `attach-signature`, `gate-publish`, `reserve-attempt`, `record-attempt`, `retire`, `migrate`, `status`, `decision-package`, `subject-id`. `decision-package` is read-only: it prints the acceptance trace from the verified durable artifacts and changes nothing. `retire` is the only way a lineage closes: `RETIRED` is terminal, reachable from any non-terminal state, never from `STALE`, and every other subcommand refuses a retired lineage with `lineage-retired`. It refuses the transitions it is asked to make; it cannot stop anyone from working around it. Declared evidence, not authority.
- `../../tools/audit/lib/intake.mjs` — the three required readings and the rules that refuse a freeze. `evaluateIntake` is the only thing that decides whether the intake concluded.
- `../../state/audit/` — the store: `store.json` plus `evidence/`, `authorizations/`, `attempts/` and `retirements/` as separate content-addressed artifacts. Anchored to the workspace, never to the working directory, and never inside the audited clone.
- `../../tools/audit/enforcement.json` — which adoption stage is in force, and the kill switch that reverts it. Stage 3 (persistence and gate-publish mandatory) is NOT enabled: the burn-in of the controlled publisher in `../../../docs/burn-in-stage-3.md` is the gate for flipping it, and rollback from 3 goes to 2, never to 1.
- `../../tools/audit/bin/publish.mjs` — the controlled publisher: consumes the lineage's ticket, runs the exact operation the ticket names, verifies the published bytes, records the attempt. It re-verifies the receipt signature cryptographically before consuming, and records the signature state (`valid`/`absent`/`invalid`) in every attempt. `bin/publish-guard.mjs` is the `PreToolUse` hook on `Bash`; its `gh` branch allows only enumerated read shapes and denies every other verb naming the upstream repository, while `curl` and the HTTP-mutation flags stay a denylist. It is a string judgment and only a procedural mitigation, with the limitations named in Security Boundary.
- `../../tools/audit/bin/keygen.mjs` and `../../tools/audit/bin/sign-receipt.mjs` — HUMAN-RUN, own terminal, never through an agent. Keygen mints the passphrase-encrypted Ed25519 key (outside the repo) and prints the elevated commands that install the anchor under `C:\Program Files\GentleAporte\`; the signer produces one detached signature over one recomputed receiptId. Human-only execution is an operational rule — isTTY cannot demonstrate it cryptographically; the argv/env/piped-stdin refusals close the accidental paths.
- `../../tools/audit/lib/anchor.mjs` — the admin-write-only trust anchor: verification refuses any repo public key whose fingerprint is not the anchored one. What signing closes and what remains is spelled out in the audit README's "Receipt signing" section; nothing there claims a hole "dies".
- `../../../docs/burn-in-stage-2.md` — the burn-in log for stage 2: every preflight run, its result, false positives, bypasses and interruptions.
- `../../../docs/burn-in-stage-3.md` — the burn-in log for the publisher path: every publisher run, its ticket, its verification verdict, bypasses and interruptions.
- `../../tools/audit/` — the deterministic engine that produces snapshots, candidate identities, evidence and receipts. Read its README before changing anything here.
- `gentle-ai-author` — author subagent; drafts and implements, never routes or publishes.
- `gentle-ai-auditor` — auditor subagent; read-only, spawned fresh per candidate.
- `../../../REGLAS-APORTE.md` — public-edition notes; private historical observations are not distributed. This skill and the ledger remain the operational authority.
