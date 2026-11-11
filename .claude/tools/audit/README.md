# Deterministic audit layer

An engine that turns objective facts about a repository into a reproducible
verdict, with optional signed authorization receipts. Publication decisions use
recorded evidence rather than an agent's recollection.

**Scope.** This governs *our* contributions to `Gentleman-Programming/gentle-ai`.
It is not part of gentle-ai, is not proposed upstream, and never modifies the
upstream working tree.

**Current surface.** Use `catalogue` to discover checks, `selftest --all` to
prove the operational failure paths, and the test command below to derive the
current suite result. This document describes stable contracts rather than a
manually maintained delivery counter.

## Why it exists

Assertions about changed lines, tests or approval state require measured evidence. This layer records those checks before publication.

> Every objective fact about the repository comes from a reproducible tool and
> carries verifiable evidence. The model interprets results; it does not invent
> state.

## Layout

```
schema/result.v1.json    the versioned structural shape of a result
schema/snapshot.v1.json  the versioned snapshot contract
schema/policy.v1.json    the versioned policy contract
schema/evidence.v1.json  what was verified; never permission
schema/authorization.v1.json    a 1.0.0 receipt: decision + candidate (history)
schema/authorization.v1.1.json  a 1.1.0 receipt: decision + candidate + one exact publication
schema/signature.v1.json        a detached Ed25519 signature over one receiptId
schema/publication.v1.json    one attempt to act on a receipt
schema/ticket.v1.json         one reserved attempt bound to one exact publication
schema/retirement.v1.json     the record that one lineage was closed, from which state and why
schema/coverage-receipt.v1.json  common proof that enumeration terminated
schema/task-contract.v1.json  authored goal, constraints, acceptance and escalation
schema/auditor-result.v1.json historical no-code auditor output (read compatibility)
schema/auditor-result.v2.json historical task-bound coverage (read compatibility)
schema/auditor-result.v3.json historical design coverage and maintainer decisions (read compatibility)
schema/auditor-result.v4.json task-bound coverage with per-row verification and limit, design coverage, maintainer decisions, native verdict and identity
lib/canonical.mjs        deterministic serialization and content digests
lib/redact.mjs           secret redaction, applied before hashing or printing
lib/status.mjs           the four states, aggregation, exit codes
lib/evidence.mjs         the evidence model
lib/check.mjs            check definition and fail-closed execution
lib/gate.mjs             orchestration: run, aggregate, build the result
lib/jsonschema.mjs       minimal fail-closed JSON Schema validator
lib/validate.mjs         structural validation plus result cross-field invariants
lib/report.mjs           human summary, derived from the result
lib/snapshot.mjs         repository snapshot and its canonical hash
lib/adapters/git.mjs     read-only Git adapter
lib/registry.mjs         check discovery and the parameter contract
lib/policy.mjs           policy loading, validation and gate resolution
lib/repository-identity.mjs  the target a policy declares, decided before any check
lib/orchestrator.mjs     snapshot -> policy -> checks -> result
lib/preflight.mjs        the gate: one snapshot, isolation, a second reading
lib/isolate.mjs          terminable worker isolation with a real timeout
lib/isolate-worker.mjs   worker body: evaluates one check
lib/discover-worker.mjs  worker body: imports check modules and reports metadata
lib/candidate.mjs        content-addressed candidate identity, no writes
lib/evidence-record.mjs  act one: what was verified
lib/authorization.mjs    act two: the receipt, its publication binding, and what refuses it
lib/publication.mjs      act three: attempts, isolated and separate
lib/publish-worker.mjs   worker body: runs one publisher
lib/ticket.mjs           the one-shot publication ticket, derived from the receipt
lib/retirement.mjs       the retirement record: how a lineage closes
lib/signing.mjs          Ed25519 over receiptIds; the encrypted key; the leak-path refusals
lib/anchor.mjs           the admin-write-only trust anchor for the public key
lib/coverage.mjs         shared coverage arithmetic and termination proof
lib/auditor-result.mjs   causal admission, native verdict and result identity
lib/decision-package.mjs acceptance trace (claim, check, result, limit) projected from a durable result
lib/task-contract.mjs    task admission, canonical digest, exact acceptance coverage
lib/sut-boundary.mjs     external sandbox validation and read-only SUT attestation
lib/scope-fit.mjs        ratchet ownership/route/consumer coherence
lib/enforcement.mjs      which adoption stage is in force, and requireSignedReceipts
lib/store/               the contribution store: lineages, artifacts, tickets, signatures
bin/publish.mjs          the controlled publisher: ticket in, one exact gh operation out
bin/publish-guard.mjs    Bash PreToolUse guard: gh read-allowlist, curl/HTTP write denylist
bin/sut-boundary-guard.mjs  early deny for writes targeting nested src
bin/sut-attest.mjs       read-only before/after SUT state proof
bin/verify-coverage.mjs  shared intake/triage/scout coverage verifier
bin/verify-scope-fit.mjs ratchet decision coherence verifier
bin/keygen.mjs           HUMAN-RUN: mints the encrypted pair, prints the anchor install
bin/sign-receipt.mjs     HUMAN-RUN: one detached signature over one recomputed receiptId
keys/receipt-signing.pub the committed public key (written by keygen; absent until then)
lib/parity.mjs           citation parsing and location-anchored comparison
lib/adapters/files.mjs   read-only, strictly decoded file reading
lib/checks/*.mjs         one invariant per file; discovered, never listed
policies/gentle-ai.json  the policy governing our contributions to gentle-ai
policies/engram.json     the same gate shape for Gentleman-Programming/engram; branch pattern is our own policy (its CONTRIBUTING.md names none), plugin manifests exempt
bin/audit.mjs            CLI
test/                    node:test suite; derive the current count from its output
test/helpers/repo.mjs    real disposable Git repositories for the fixtures
```

No dependencies, no lockfile, no build. Node 22+ (`node:test`, `structuredClone`).

## The four states

| State | Meaning | Proceeds? |
|---|---|---|
| `PASS` | The check ran and the condition held, with evidence. | Yes |
| `FAIL` | The check ran and the condition was violated. | No |
| `UNKNOWN` | No reliable conclusion was possible. | No |
| `NOT_RUN` | The check did not run. Always carries its motive. | No, unless a versioned policy declares it optional |

Aggregation takes the worst *required* state: `FAIL` > `UNKNOWN` > `NOT_RUN` >
`PASS`. Optional checks are recorded and never block.

A gate with no required checks is `UNKNOWN`, not `PASS`. A gate that verifies
nothing must not authorise anything.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | gate `PASS` — or, for `validate`, a contract-valid document |
| `1` | gate `FAIL` |
| `2` | gate `UNKNOWN` or `NOT_RUN` — it did not conclude |
| `3` | usage or configuration error |
| `4` | the result violates the contract |

`2` deliberately covers both inconclusive states: they are distinct in the JSON,
and the JSON is the machine-readable authority. At the process boundary they
mean the same actionable thing.

## Streams

`stdout` is canonical JSON and nothing else — safe to pipe. `stderr` carries the
human summary and diagnostics, and is never parsed. The human text is always
derived from the structured result, never the reverse.

## Evidence

Every `PASS` and every `FAIL` must cite at least one evidence item. A check that
concludes without evidence is downgraded to `UNKNOWN` by the engine itself.

```json
{
  "type": "git",
  "source": "git rev-parse --show-toplevel",
  "observed": { "insideWorkTree": true },
  "hash": "sha256:…"
}
```

`hash` is the digest of `observed` *after* redaction, so the digest always
describes exactly what is stored.

## Determinism

`runId` is derived from the gate, policy, repository description and check ids —
not from a random source. Two runs over identical state produce the same id.

Volatile by contract, and ignored when comparing runs: `runId`, `startedAt`,
`finishedAt` at the root, and `durationMs` per check. `equivalent(a, b)` in
`lib/canonical.mjs` performs that comparison.

Serialization refuses `undefined`, `NaN`, `Infinity` and non-plain objects
instead of silently dropping or mangling them. A silent drop turns a partial
observation into a complete-looking one.

## Fail-closed, concretely

- A check that throws becomes `UNKNOWN` and is also surfaced in `errors[]`.
- A check returning a malformed outcome becomes `UNKNOWN`.
- A `PASS` or `FAIL` citing no evidence becomes `UNKNOWN`.
- A required `FAIL`, `UNKNOWN` or `NOT_RUN` without non-empty remediation
  becomes a tool-contract `UNKNOWN`; the original evidence is retained.
- A `NOT_RUN` without a motive is refused at construction.
- The JSON Schema validator throws on any keyword it does not implement, so a
  schema can never appear to enforce a constraint it silently ignores.
- The CLI validates its own output before printing it, and exits `4` rather than
  emit a document that violates the contract.

`schema/result.v1.json` owns the structural document shape. `validateResult()`
applies that schema and then enforces cross-field semantics, including the
required-blocking-remediation invariant. Keeping those roles explicit avoids
pretending the lean schema expresses conditionals it does not implement.

## The snapshot

`audit.mjs snapshot` produces one reproducible reading of repository state. It
states facts and judges none of them.

**Read-only, enforced three ways.** An allowlist of Git subcommands refuses
anything else before spawning. `GIT_OPTIONAL_LOCKS=0` stops `git status` from
refreshing and rewriting the index — without it the read-only claim would be
false in the most literal sense. And a test asserts the index mtime, size and
the `.git` directory listing are unchanged after a snapshot.

**Staged, unstaged and untracked are separate lists.** Porcelain v2 reports two
independent status letters per entry, `X` for the index and `Y` for the working
tree. Collapsing them is what makes "the repo is dirty" ambiguous. A file staged
and then modified again appears in both lists, correctly.

**The hash.** Computed by `canonicalJson` over the snapshot with three fields
removed:

| Excluded | Why |
|---|---|
| `root` | absolute path of the checkout — the same state in two directories is the same state |
| `reader` | the Git binary that read it — environment, not state |
| `hash` | cannot contain itself |

Everything else is covered, including `config`: `core.autocrlf` and
`core.filemode` change what Git considers modified, so they belong to the state
being read. Two clones of one repository hash identically; the same files under
a different `core.autocrlf` do not, because Git itself would treat them
differently.

**Numbers are never presented as complete when they are not.** Binary files
report no line counts, so they are counted in `binaryFiles` rather than folded
into the totals as zero.

**Fail-closed.** Not a repository, an unparseable Git output, a failing Git
command, a corrupted index, an undecodable path, an unsupported layout, or a
change landing mid-read all produce `UNKNOWN` with evidence. No path returns an
empty change list for a repository that could not be read.

**Paths are decoded strictly.** Git emits raw path bytes under `-z`, and a path
is not always valid UTF-8 — a file created on a Linux filesystem may carry any
byte except NUL and `/`. Node's default decoding replaces those bytes with
U+FFFD, which produces a *different* name, hashes it, and reports it as the file
that was observed. The adapter captures bytes and decodes with
`TextDecoder('utf-8', {fatal: true})`, so an undecodable path becomes `UNKNOWN`.

> Integration limit, stated plainly: on Windows, file names are UTF-16 at the
> API level, so a name that is invalid UTF-8 cannot be created and the
> end-to-end leg of that test is skipped there with that reason recorded. The
> refusal itself — the decoder — is covered by byte-level tests that run
> everywhere.

**Layouts.** Submodules (gitlinks or a tracked `.gitmodules`) remain unsupported
and return `UNKNOWN`. Linked worktrees are supported: the snapshot records the
main and sibling worktree observations, and refuses an unreadable registration.
An absent prunable registration is recorded as absent, not silently omitted.
Detection is read-only; it does not run `git worktree` or `git submodule` commands.

**Concurrency, stated honestly.** The state is read twice and the readings
compared; a difference means no single snapshot describes the repository. This
narrows the window, it does not close it. A change that lands and reverts
between the two readings is invisible, and a test pins that limitation so it
cannot later be mistaken for a guarantee.

## Checks and policies

A check is one file in `lib/checks/`. The registry discovers the directory, so
adding a check means adding a file — no central list, no edit to `gate.mjs`, no
edit to the orchestrator. A test asserts `gate.mjs` mentions no check id at all.

```js
export default {
  id: 'diff.within-review-budget',
  title: 'The staged change stays within the review budget',
  needsSnapshot: true,
  params: { limit: { type: 'integer', required: true, minimum: 1 } },
  evaluate({ snapshot, params, tooling, adapters }) { /* → {status, reason, evidence} */ },
};
```

Checks read a snapshot or a read-only adapter, and nothing else. A check that
declares `needsSnapshot` never sees a missing one: the orchestrator
short-circuits it to `UNKNOWN` carrying the snapshot's own reason, so a check
cannot invent state it could not read.

A policy is a versioned JSON document validated against
`schema/policy.v1.json`. It selects checks per gate, marks each required or
optional, and supplies parameters:

```json
{ "id": "diff.within-review-budget", "required": true, "with": { "limit": 400 } }
```

**Everything that can be wrong with a policy blocks.** An unsupported
`policyVersion`, a schema violation, an unknown gate, an unknown check, a
duplicate selection, an unknown parameter, a missing required parameter, a
parameter of the wrong type — each exits `3` and emits no result document. A
policy that does not mean what it says must not decide whether something gets
published.

**A policy names the repository it audits, and runs nowhere else.** Every
policy declares one target:

```json
"repository": { "remote": "origin", "expected": { "host": "github.com", "owner": "Gentleman-Programming", "name": "gentle-ai" } }
```

The field is required, because of what its absence produced: the `gentle-ai`
policy — which cites that repository's `CONTRIBUTING.md`, the exact line
numbers of its `ci.yml` and its `go.mod` — was run against a different
repository and emitted 2 `FAIL` and 3 `UNKNOWN` rows about files that were
never meant to exist there. Each row was arithmetically correct and
semantically meaningless.

Identity is read from that remote's url and from **nothing else** — never from
the directory name, because a checkout lives wherever it was cloned to.

Exactly three remote forms are supported, as an allowlist:

| Form | Transport |
|---|---|
| `https://host/owner/name(.git)` | `https` |
| `ssh://[user@]host[:port]/owner/name(.git)` | `ssh-url` |
| `[user@]host:owner/name(.git)` | `ssh-scp` |

All three resolve to the same identity — the transport is reported but is never
part of it, so a policy never passes or fails on how you connect. Everything
else is `UNKNOWN`: `http://`, `git://`, `file://`, any unknown scheme, any local
path, and any url carrying a `?` or a `#`. That last one is a security rule, not
a parsing convenience — a query or fragment routinely carries a token, and a
permissive parser folds it into the last path segment and reports it as the
repository name.

**The url itself is never recorded** — not raw, not redacted, not hashed, not
truncated, in evidence, reasons, remediations or errors. Pattern-based redaction
removes credentials matching known shapes; it is not a proof that no secret is
present. The evidence carries only `{remote, expected, observed, transport}`,
plus a bounded `{name, exitCode}` when the read itself failed. Git's stderr is
not interpolated either: it quotes the url when it complains about one, and
asking a redactor whether that text is safe is the assumption this design
removes.

It is decided **between the snapshot and discovery**, before a single check
module is imported. A mismatch is `FAIL` — a fact about the repository. An
absent, unreadable or unparseable remote is `UNKNOWN` — a gap in the reading.
Either way the run ends there with one `gate.repository-identity` row and a
`gate.repository-identity-failed` error, and no check runs at all. When it
holds, it adds **no** row: a precondition that appears as a passing check
invites being marked optional, and an optional identity is no identity.

**The report covers the whole catalogue.** Checks the policy did not select
appear as `NOT_RUN` with that reason, because a check silently absent from a
report is indistinguishable from one that passed. A check with an explicit
`skip` keeps its `required` flag, so a skip blocks unless the policy also
declares it optional — that is what stops a skip from being a silent waiver.

## Commands are declared, never inferred

The engine holds no idea of what a project runs. A policy declares each command
with the exact file it was read from:

```json
{ "id": "test", "run": "go test ./...", "source": ".github/workflows/ci.yml", "appliesTo": ["go.mod"] }
```

`tooling.commands-declared` verifies each `source` is a tracked path — a
declaration pointing at nothing fails. `tooling.manifests-covered` fails when
the snapshot found a manifest that no declaration covers, naming it instead of
guessing its command; an exemption must be declared, never assumed. With no
declarations at all the result is `UNKNOWN`, not `PASS`: silence about a
project's commands is not evidence that it has none.

**This delivery executes nothing.** Commands are detected and declared; running
them belongs to a later delivery.

## Parity

Two things that should agree, compared without executing anything.

### Declaration ↔ cited source

A citation names a **location**, and the location is what gets checked.

```
path              no location -> UNKNOWN. A file-level match would not prove the citation.
path#L245         one line
path#L10-L20      a range
```

Parsing is strict: `#245`, `#Labc`, `#L0`, `#L10-L5`, a trailing separator, or a
second `#` are all refused rather than coerced.

**A match found elsewhere in the file does not validate a wrong line number.**
When the declared value sits at line 58 and the citation says 59, the result is
`FAIL`, and the line it was actually found at is reported as diagnosis — never
as absolution. That distinction is the whole point: the citation is wrong, not
the value.

**Comparison is exact, not containment.** `go test ./...` is a substring of
`go test ./... -count=1`, and those are different commands. Each declaration
states how its cited region holds the value — the policy says it, the engine
never infers it from a file extension:

| `format` | Comparison |
|---|---|
| `yaml-run` | the region's `run:` field is read and its complete value compared |
| `literal` | the whole cited region is compared |

Both are exact after normalising line endings and trailing whitespace. A
`run:` block scalar is supported when the citation cites its whole range; a
citation covering only the block's opening line is `UNKNOWN`, as are a region
with two `run:` entries, a region with none, a folded (`>`) scalar, and a plain
scalar containing ` #`, which YAML reads as a comment and this reader will not
disambiguate.

`UNKNOWN`, never `PASS` or `FAIL`, when: the cited file is untracked, the range
points past the end of the file, the file is not valid UTF-8, the declared value
is empty, the reference is malformed, or there is no location at all. Across a
set of declarations, one proven divergence outranks everything, and an
unverifiable one outranks a pass: a partially verified set is not a verified set.

Line endings are normalised before comparison, so the same document under
`core.autocrlf=true` and `false` verifies identically and hashes identically.

Evidence carries source, path, lines, expected, observed, `expectedHash`,
`observedHash`, `fileHash` and `fileLines`. Excerpts are redacted and capped;
the hashes cover the whole redacted value, so truncation never weakens them.

### go.mod ↔ go.sum — our policy, not a Go rule

An earlier version of this check asserted that Go needs a `go.sum` whenever a
`require` exists. **That is false.** A module whose requirements are all
satisfied by `replace` directives pointing at local directories downloads
nothing and needs no `go.sum`; and a `go.sum` may retain hashes for versions no
longer needed, since nothing prunes it until `go mod tidy` runs.

So the rule is stated as ours, and the evidence says so in a `notAGoRule` field:

> we require a tracked `go.sum` from any module that declares a requirement not
> resolved to a local directory by a `replace`.

It stops where static reading stops:

| Observed | Result |
|---|---|
| a requirement not resolved locally, no tracked `go.sum` | `FAIL` |
| a requirement not resolved locally, `go.sum` tracked | `PASS` (presence only) |
| every requirement replaced by a **local** directory | `UNKNOWN` — the transitive requirements of those local modules are invisible without executing Go |
| a `replace` pointing at another **module** | still a remote dependency |
| no requirement at all | `PASS`, with presence or absence of `go.sum` **observed**, not assumed |
| a `go.sum` beside a module declaring nothing | recorded, **not judged** |
| `go.mod` unreadable or unparseable | `UNKNOWN` |

**Scope, so it cannot be overread:** this never verifies `go.sum` *contents*
against the required modules. That needs `go mod verify` or `go mod tidy`,
which execute and download.

### Read-only

Parity never runs `go mod tidy`, never downloads a dependency, never
regenerates a file and never repairs a divergence. It reports and stops. The
file adapter refuses absolute paths and `..` segments, so nothing outside the
repository is ever read.

## The preflight gate

```bash
node bin/audit.mjs check --policy gentle-ai --gate preflight [--timeout-ms <n>]
```

Three properties define it, and each exists because its absence is a way to
authorise something that was never true.

### One snapshot

The repository is read **once**, and every check receives that exact reading.
Checks that each look at the world separately can agree about a repository that
never existed in that combination. A test asserts two checks report the same
snapshot hash, and that it equals `binding.snapshotHash`.

### Nothing is imported in the main process

Importing a module runs its top-level code, and a check file is exactly the
extension point an author is invited to drop something into. Discovery
therefore happens in a terminable worker: `discoverChecks()` receives
**serializable metadata** — id, title, parameters, whether it needs a snapshot,
and the module path — validates it, and returns descriptions. The parent never
holds a check's code.

That closes four reachable grants: a module could freeze the main process, call
`process.exit`, throw before any worker was spawned, or write to the repository
before the authorised reading existed.

**The snapshot is taken before any check module loads.** Anything a module does
to the repository during import therefore lands after that reading and diverges
the second one, which blocks. A regression writes a file from a module's
top-level code and asserts exactly that.

A catalogue that cannot be built is a **blocking result**, not an exception and
never a partial catalogue: a catalogue that silently omits a check is
indistinguishable from one whose checks passed. The result carries
`gate.catalogue-loadable`, the `catalogue.discovery-failed` error, and the
snapshot taken before loading.

> Tests that evaluate a check directly use `test/helpers/checks.mjs`, which
> imports the module in the test process on purpose and says so. That helper
> exists so the crossing is explicit instead of hidden inside a catalogue that
> quietly carries executable code.

### Terminable isolation

Each check runs in a `worker_threads` worker with a wall-clock budget. On
expiry the worker is **terminated**, not merely stopped being awaited.

> `Promise.race` only stops *waiting*. The work keeps running, and if that work
> is a synchronous loop — a catastrophic regular expression is the case this
> layer actually ships — the process stays frozen while the race "times out".

That closes the ReDoS risk left open in delivery 4: a policy pattern like
`^(a+)+$` against a 40-character branch name is killed at the budget, and the
gate reports a timeout instead of hanging. There is a regression for exactly
that, end to end through the real `git.branch-allowed`.

Four failure modes stay distinguishable, each with structured evidence and its
own error code:

| Observed | `errors[].code` | `evidence.observed.failure` |
|---|---|---|
| the worker was killed at the budget | `check.timeout` | `timeout` |
| the check threw | `check.exception` | `exception` |
| the worker died on its own | `check.worker-terminated` | `terminated` |
| the check returned an unusable outcome | `check.malformed-result` | — |

**No automatic retries.** A check that timed out is reported as having timed
out; running it again is a decision for a human. A test asserts the check body
executes exactly once.

### Two budgets, resolved independently

| Budget | Bounds | Default | Flag |
|---|---|---|---|
| `discoveryTimeoutMs` | building the **whole** catalogue | 10000 ms | `--discovery-timeout-ms` |
| `checkTimeoutMs` | **one** check | 10000 ms | `--check-timeout-ms` |

They are separate because they bound different things. Building the catalogue
is one operation whose cost grows with the number of modules; evaluating a
check is one operation per check. Sharing a budget meant a larger catalogue
quietly consumed the allowance designed for a single check, so adding a check
made every other check stricter — a coupling nobody declared and nobody could
see.

Each flag may only **harden** its own limit: the effective value is
`min(policy, override)`, per budget, with no leakage between them. A person in
a hurry, or an agent acting for one, must not be able to widen a limit the
versioned policy authorised from a command line. Lowering is always allowed —
a stricter run that blocks is never the dangerous direction.

### What isolation is, and is not

`worker_threads` gives **terminable** isolation: a thread with its own isolate
that `terminate()` really kills, mid-loop. That is the whole of what it gives.

It is **not** a filesystem sandbox and **not** a defence against malicious code.
A check module runs with the process's full permissions: it can read and write
any path the user can, open sockets, and spawn processes. The structural guard
against writing (`no check module imports a writing capability`) is a source
grep, not a runtime confinement.

The second-reading check protects the **decision**, not the repository: it
detects that something changed and refuses to authorise anything on a reading
that no longer holds. It does not prevent the write. Real confinement would
need an OS-level sandbox, and this tool does not provide one.

### A second reading

After the checks finish, the repository is read again and the two snapshot
hashes compared. **If it moved, the result is `UNKNOWN` even when every check
passed** — those passes describe a repository that is no longer there. The
report carries a first-class `gate.repository-stable` entry saying so, plus a
`repository.changed-during-gate` error. Regressions cover a moved `HEAD` and a
staged, unstaged or untracked change appearing mid-gate.

### Binding

Every result names what it was decided over:

```json
"binding": {
  "snapshotHash": "sha256:…",
  "snapshotHashAfter": "sha256:…",
  "stable": true,
  "policyHash": "sha256:…",
  "toolVersion": "0.1.0",
  "decisionId": "sha256:…"
}
```

`decisionId` is the digest of gate + snapshot hash + policy hash + tool version.
A result that does not name the state, the policy and the tool it came from
cannot authorise a later action: there is nothing to compare the later state
against.

### What may differ between two runs

Exactly three things, and a test pins the list:

```
startedAt   finishedAt   checks[].durationMs
```

Everything else — status, per-check statuses and reasons, evidence, `runId`,
`binding` — is identical over identical state.

## Candidate identity

`lib/candidate.mjs` computes a `candidateId`: a content-addressed identity of
the candidate as it stands right now.

```
candidateId = digest({
  headOid,
  indexEntries: [{ mode, blobSha, stage, path }, …],   sorted by path, then stage
  snapshotHash,
  policyHash,
  toolVersion,
  artifacts: [{ path, sha256 }, …],                    sorted by path
})
```

The index is read with `git ls-files --stage -z`. **The objects it names
already exist** — `git add` wrote them. Nothing here writes an object, and the
allowlist still contains no writer: `hash-object`, `write-tree`, `commit-tree`,
`update-ref` and `update-index` are all absent, and a test pins their absence.
`cat-file --batch-check` was added, which reports on objects and creates none.

Modes and paths are kept. The same bytes staged executable, or staged under a
different name, are different candidates — and a test proves the shared case is
real: Git stores identical bytes as **one** object, so two fixtures under
different names share a blob, and the path is what still distinguishes them.

`UNKNOWN`, never an id: any entry whose stage is not `0` (an index mid-merge
holds several versions of one path and describes no single candidate), an empty
index, a gitlink, an object Git can no longer produce, an object that is not a
blob, or a declared artifact that cannot be read.

An authorisation is valid **only while the current state reproduces the same
`candidateId`**. It is never repaired; it is recomputed, and anything that
moved makes it stop applying.

### The tradeoff, stated

This **identifies and validates** the candidate. It does **not** keep it and
cannot reconstruct it once the index moves. It is not a recoverable snapshot
and not storage — the evidence says so in its own `scope` field.

The alternative was freezing with `git write-tree` / `commit-tree`. Measured on
a temporary repository, `write-tree` took `.git/objects` from 3 files to 4:
that writes into the repository, contradicting the read-only invariant proven
from delivery 2 onward. And to survive `git gc` those objects need a **ref**,
which is a real modification of someone else's repository — not a narrow
exception. The identity was chosen instead; the retrievability was given up
deliberately.

## Task-bound subject identity

Every new `freeze`, `refreeze`, and `subject-id` invocation requires
`--task-contract <task-contract.json>`. The authored contract has four
substantive fields: `goal`, `constraints`, `done_when`, and `escalate_when`;
each `done_when` item carries a stable `id` and its acceptance condition. Empty
or whitespace-only values and duplicate acceptance ids are refused before a
lineage exists.

```json
{
  "schemaVersion": "task-contract/v1",
  "goal": "Publish the reviewed correction.",
  "constraints": ["Do not change the approved scope."],
  "done_when": [
    { "id": "scope-fit", "condition": "The candidate stays inside the approved scope." }
  ],
  "escalate_when": ["A required product decision is unresolved."]
}
```

Admission computes `taskContractDigest` with canonical JSON, stores the accepted
contract under `task-contracts/<digest>.json`, and includes that digest in
`subject_id`. Formatting and object-key order therefore do not move identity;
changing the task does. The auditor echoes the digest and returns exactly one
bounded evidence row per `done_when` id in `auditor-result/v4`. Missing,
duplicate, unexpected, `NOT_RUN`, or `N/A` coverage derives
`BLOCKED_INCOMPLETE` with remediation. A row that reached `PASS` or `FAIL` is a
completed evaluation, and completeness is not satisfaction: only exact
all-`PASS` coverage can derive `PASS`, and a demonstrated `FAIL` never does.

### Claim, pertinent check, result, limit

`auditor-result/v4` makes each acceptance row a chain. Besides `acceptanceId`,
`status`, `evidence`, `reason` and `remediation`, a row carries:

| Field | Holds |
|---|---|
| `verification.method` | what was executed, inspected or contrasted |
| `verification.falsifier` | the observation that contradicts the claim as the task contract states it |
| `limit` | what stays outside what was demonstrated |

`falsifier` always refers to the original claim, whatever the row's status. On
a `PASS` row it is the observation that would have contradicted the claim and
did not occur. On a `FAIL` row it is the contradicting observation itself, the
one that did occur. It is never turned around into what would make the claim
true, and it never argues against the row's own status. The field's shape is
the same for both, so this is a statement of meaning, not a schema change, and
no stored result is re-read under it.

| Row | Claim | `falsifier` |
|---|---|---|
| `PASS` | The command in the body prints the output shown. | Any exit code other than 0, or stdout differing from the block in the body. |
| `FAIL` | No statement claims more than the evidence shows. | The summary asserts the effect for every runtime, while the body ran one. |

`PASS` and `FAIL` rows must carry all three as non-blank text of at most 2048
characters each. `NOT_RUN` and `N/A` rows may carry `null` for `verification`
and `limit`, keep `reason` and `remediation` mandatory, and still derive
`BLOCKED_INCOMPLETE`: a check that did not happen is not described. A value
that is given must not be blank.

Three statements about what this does and does not do:

- **It is bound, as far as the store's own anchors reach.** The three fields
  are inside `acceptanceCoverage`, so they are hashed into
  `acceptanceCoverageDigest` and `auditResultId`, and they are part of the
  result bytes the receipt binds. Editing one in place fails
  `artifact-bytes-mismatch`; a rewrite that leaves the coverage digest stale
  fails `audit-coverage-mismatch`; and once a receipt exists, any rewrite, however
  consistent, fails `audit-artifact-binding-mismatch` on `gate-publish`,
  `reserve-attempt`, the ticket steps and the trace itself. Before a receipt
  exists the only anchor is the index, which is unsigned: a writer who rewrites
  the result, its digests and the index together is not detected, here or on
  any other pre-authorization step. That is the store's declared trust model,
  not something v4 changes.
- **It does not enter the verdict.** `deriveAuditDecision` reads no method, no
  falsifier and no limit. Precedence is the one below, unchanged.
- **It is presence, not truth.** `validate.mjs` checks structure and non-blank
  text. Nothing in this engine can tell a pertinent method from an irrelevant
  one, or an honest limit from "none"; there is deliberately no keyword filter
  standing in for that judgment. It is the fresh auditor's review, and a weak
  auditor produces a well-formed, bound, useless limit.

`lib/decision-package.mjs` projects the chain per condition, taking the claim
from the frozen task contract and the rest from the durable result.
`store.acceptanceTrace(lineage)` builds it only after verifying both artifacts,
and `ledger.mjs decision-package --lineage <L> [--format text]` prints it. For
a result older than v4 the check and the limit read
`not recorded by this version`: nothing is inferred from the evidence text.
Every non-PASS row shows its recorded reason in every version.

The text form is read in a terminal, and everything it interpolates comes from
an artifact. `inline()` in `lib/decision-package.mjs` replaces each code point
in a fixed, enumerated set with a visible mark `<U+XXXX>`, one for one. The
set is: C0 controls (tab, line feed, carriage return and escape among them),
DEL, C1 controls (the 8-bit CSI, OSC and ST among them), the line and
paragraph separators, the bidirectional marks, embeddings, overrides and
isolates, unpaired surrogates, and the characters that hide text from the eye
without driving a terminal: tag characters, the zero-width space, the word
joiner and invisible operators, the byte order mark, the Mongolian vowel
separator, the deprecated format characters and the interlinear annotation
characters. So an escape sequence that would clear the screen prints
as `<U+001B>[2J`, a line break cannot continue a value into lines that read as
another condition's block, and a right-to-left override cannot reorder a line.
Nothing is interpreted or stripped, a literal `<U+` in the text has its `<`
marked too so the mapping stays reversible, and every other character is left
as written: the zero-width joiner and non-joiner, variation selectors and
combining marks that scripts and emoji need, and ordinary spaces. The method
and the falsifier print on separate lines (`Check:` then `Would refute:` on a
`PASS` row or `Refuted by:` on a `FAIL` row), so a separator typed into one
cannot make it read as the other.

The JSON output of `ledger.mjs` goes to a terminal too, and `JSON.stringify`
leaves DEL, C1, the separators, the bidirectional controls and the hidden-text
characters raw. `terminalJson()` writes each of them as a JSON `\uXXXX` escape.
The output is valid JSON that parses back to exactly the recorded value, and
every JSON output and every refusal message of the ledger prints through it or
through `inline()`. The two informational `next:` lines `authorize` writes
echo the lineage name from the command line as typed.

That is presentation only. It changes no stored artifact, hash, signature or
identity, the trace object returned by `store.acceptanceTrace` carries the
recorded text unchanged, and no historical result is rewritten to be displayed.
It makes those characters visible. It says nothing about whether the text
around them is true, and it is not a filter on what an auditor may write: text
with a control in it is still admitted. It does not stop text that merely
looks misleading either. A long run of spaces can still push words to the
start of a wrapped line, a filler letter can still look blank, and a sentence
can still say "all checks passed". Whoever calls `store.acceptanceTrace` or
reads an artifact file directly and prints it gets the raw text.

The blank check on these three fields also refuses text made only of
invisible characters (controls, zero-width and format characters, Hangul
fillers, the blank braille pattern). It applies to the v4 trace fields alone.
The refusal of blank acceptance `evidence` likewise applies to v4 only: it was
added after v3 results had been written without it, and v3 can no longer be
admitted, so enforcing it on v3 would only refuse history on read.

`auditor-result/v3` added two fields that sit outside the five-finding cap, and
v4 keeps them:

- `designCoverage` declares each of seven aspects exactly once
  (`design.over-engineering`, `design.side-effects`, `design.user-qol`,
  `design.shrinkability`, `cost.system`, `cost.user`, `cost.product`) as
  `assessed` with evidence, `not_applicable` with a justification, or
  `not_assessed` with a justification and `material: true|false`. The code
  requires the declaration to be whole; it does not judge the assessment.
- `maintainerDecisions` lists decisions the maintainer must make, each with its
  options, evidence and its true `causalDisposition`.

Verdict precedence, highest first: incomplete (acceptance coverage, declared
completeness, or a missing, duplicated or material `not_assessed` aspect) →
`BLOCKED_INCOMPLETE`; any pending maintainer decision → `NEEDS_MAINTAINER`;
then the unchanged finding rules (severe `external`/`unknown` →
`NEEDS_MAINTAINER`, severe `introduced` → `NEEDS_CHANGES`); then a decisive
acceptance `FAIL` with no introduced severe finding → `NEEDS_MAINTAINER`; else
`PASS`. A decision never hides incompleteness and is persisted either way;
neither `BLOCKED_INCOMPLETE` nor `NEEDS_MAINTAINER` opens a correction.

New task-bound audits must submit `auditor-result/v4`; `record-audit` refuses
v2 and v3. Each stored result is validated by the schema of its own version,
never by a later one, so a v3 result is not asked for a limit and a v3 row that
carries one is invalid. Stored v2 results stay readable and keep authorizing
with the verdict they were admitted with: they are never re-derived. Every
forward path re-derives a stored v3 or v4 verdict and refuses one its own
decisions and design coverage contradict (`audit-verdict-mismatch`). No
historical result is migrated, re-hashed or completed: `test/fixtures/pre-v4-store`
is a store written by the pre-v4 code, and `test/v3-receipt-continuity.test.mjs`
walks it forward and compares every historical byte.

`NEEDS_MAINTAINER` admits only `retire`. Once the maintainer resolves the
decision, the work continues as a new lineage: freeze it, audit it again.

The receipt binds both the accepted task-contract bytes and the full auditor
result bytes in `artifacts`; `auditResultId` also hashes the coverage itself.
Later mutation is detected on every publication forward path. Historical
stores and `auditor-result/v1` artifacts remain readable as history, but a
lineage without a task contract cannot mint a new authorization. Its old
`subject_id` is never silently reinterpreted; freeze a new lineage.

## Evidence → authorization → publication

Three acts, three artifacts, three modules. They are separate because when
producing evidence and granting permission are the same act, a
thorough-looking report *becomes* the permission, and "we checked" starts
meaning "go ahead".

### Evidence

Exists for **any** state, including one nobody should publish. It records what
passed, what failed, what could not be concluded and what was skipped — every
check lands in exactly one bucket, because a check in none is a verification
nobody can account for.

It carries `authorises: false` as a **constant in the schema**. The document
cannot claim otherwise even if someone edits it, and editing it breaks its own
`evidenceId`.

### Authorization

Issued only when nothing is left unresolved: the gate reached `PASS`, the
repository did not move during it, the candidate was identified, and **every
required check reached `PASS`**. A `FAIL`, an `UNKNOWN`, or a required check
that never ran each refuse, and the refusal names what stood in the way.

**The claimed status must be what the verifications say.** "Every required
check reached `PASS`" is vacuously true of zero required checks, and the
engine's rule that a gate with no required checks is `UNKNOWN` lived only in
the engine: a gate result whose `status` had been edited to `PASS` over
`checks: []` went through `scripts/evidence.mjs`, `record-evidence` and
`authorize` and minted a receipt (ASTRA-04, corroborated 2026-09-05; no honest
input reaches it, `audit.mjs check` emits `UNKNOWN` and exit 2 for that gate).
The evidence record now derives its gate status from its own verifications
(`derivedGateStatus`, the engine's aggregation rule), and the helper, the
store's admission (`evidence-verifies-nothing`) and the receipt each refuse a
record whose claimed status differs from that derivation. Historical records
in the store are unaffected: none carries a contradiction.

The receipt binds `evidenceId`, `candidateId`, `decisionId`, `snapshotHash`,
`policyHash`, `toolVersion`, the exact artifacts (including the accepted task
contract and task-covered auditor result) and — since 1.1.0 — the
**publication**: `{operation, targetRepo, targetNumber, bodySha256,
titleSha256}`, inside the record *before* `receiptId` is computed.

**The body is the audited draft.** `freeze` records `draftBodySha256`: the
digest of `--draft` after the same normalization the receipt, the ticket and
the publisher apply (`bodyDigest`). It lives *beside* `subject_id`, never
inside it — the raw `draftDigest` stays in the identity, so no identity ever
minted moves. `authorize` refuses `draft-mismatch` when
`publication.bodySha256` is any other value, and `missing-draft-binding` for a
lineage frozen before the field existed: history stays readable, but cannot
mint a new authorization. There is no `refreeze` out of `AUDITED_PASS` or
`REAUDITED` (the correction budget is for a rejected candidate, never for a
passed one), so the recovery for a historical lineage is a **new lineage**:
freeze it, audit it, authorize it. Until this binding existed,
`--draft` and `--body-file` were two unrelated reads, and a body nobody
audited could be authorized — and published through the controlled publisher —
under the PASS audit of the draft (Astra corroboration, 2026-09-05). The
ticket ↔ body-file binding at the publisher was never the gap; draft ↔ ticket
was.
Artifact paths are unique: a duplicate path is refused before any receipt is
issued, so no signed mapping can carry two hashes for the same artifact.
`titleSha256` is required for `issue-create`, which publishes a title, and
null for `issue-comment`: a title outside the binding would let a valid
signed receipt publish under a changed title without invalidating anything,
and the title sits inside the heart of the promise. The block also carries
`dependsOn`, the lineages that must have published before this one may (a
body that says "I left a note on #4078" is true only once the note exists).
The field is additive: a 1.1.0 receipt written before it existed validates
unchanged and reads as `[]`, so the version constant did not move. At
authorization the store refuses `dependency-unknown`, `dependency-self`,
`dependency-duplicate`, `dependency-closed` (STALE or RETIRED) and
`dependency-cycle` (the dependency's current receipt, or any receipt down
its chain, depends back on this lineage). The ticket copies the list and
binds it in its id; gate-publish, reserve-attempt, the publisher (before it
consumes) and consumption itself refuse `dependency-unpublished` until each
dependency has a recorded attempt with outcome `published` and
`detail.bodyIdentical: true` under its current receipt, or
`dependency-closed` if it was retired meanwhile. Re-evaluated every time:
`PUBLISHABLE` remembers nothing. It is frozen: a
correction produces **another** receipt, never an amended one, and publishing
the same candidate to a *different target* is a **new** authorization with a
new `receiptId` — the previous receipt is archived untouched under
`authorizations/superseded/`, any live ticket is superseded, and attempts
already recorded keep referring to the old `receiptId`.

### Supported operations: two, and one explicit negative

#### Publication guard scope

`bin/publish-guard.mjs` is a `PreToolUse` hook on the `Bash` tool. Its string
matcher reduces accidental shortcuts and catches the documented literal
direct-write cases. It is not a shell parser, a security boundary, or evidence
that every upstream write is mediated. It does not cover other shells,
connectors/browser/API planes, obfuscated or dynamic shell construction, hook
bypass or modification, or an actor with access to publication credentials.
Authoritative prevention against a determined concurrent actor requires
credential and domain separation through the Level 2 broker described in the
project docs; that broker is not built or approved.

Within that scope, the guard judges the command as one flattened string, with
no segmentation: a round-one correction (ASTRA-06, 2026-09-07) replaced the
prior per-segment design after both judges confirmed that a quote- or
redirection-blind splitter could separate a write token from the repository
mention it belonged with, letting each half allow on its own. Denials are
evaluated first, over the whole command: a write shape (`issue create`,
`pr merge`, `gh api -f …`, curl's `-d`/`--form`, and the rest of the
enumerated list) denies no matter where in the string it sits — past a
redirection, inside a quoted argument, or inside a trailing `#` comment.
Only once no write shape matches does every `gh` invocation in the command
have to prove it is a read, at its own verb position; a read shape found
elsewhere — a comment, a second chained command, a subshell — proves nothing
for an unlisted verb. There is no publisher exception any more: the
publisher never takes the repository as an argument, so its own invocation
simply reaches allow on its own merits, the same as any other command that
never matches a write shape.

A read-only repro on 2026-10-01 found upstream writes that matched no shape;
they now deny. `git push` (also `send-pack`, `http-push`, with up to six
global-option tokens before the verb) in a command that names the upstream
repository. Any `--request`/`--method`/`-X` method other than `GET` or `HEAD`,
including a quoted or variable one (`-X "POST"`, `-X $M`) and bundled short
options (`-sX POST`). curl and wget payload carriers: `--json`, `-T`,
`--upload-file`, `-K`/`--config`, `--post-data`/`--post-file`,
`--body-data`/`--body-file`, and bundled or glued data and form flags
(`-sSd`, `-d@file`, `-sF`). Write shapes and `gh` invocations are also matched
over a quote-free copy of the whole command (every `"`, `'` and `\` removed,
as the shell does), so `c''url -X P''OST` and `g''h pr ready` deny, and a
repository name split by quotes still counts as a mention. That copy is never
judged instead of the command, only in addition, so it can only add denies,
and it is still the whole string: no segmentation.

curl's long data flags (`--data*`, `--expand-data`, `--form*`) and the
unambiguous payload carriers (`--upload-file`, `--post-data`, `--post-file`,
`--body-data`) deny whether or not a client is named: the client can hide
behind a variable (`$C`), ANSI-C quoting (`$'\x63url'`), a command
substitution, httpie, xh or a script. Short `-d` in any spelling (`-d`,
`-d@file`, bundled `-sSd`) denies too, with one exemption: the `-d` directly
follows `base64`, `ls`, `tr`, `eza`, `[` or `test`, and that tool stands as
its own command (at the start, after a shell separator, inside `$(…)` or
`<(…)`, or after a shell keyword such as `if` that itself does). The
exemption must hold for every `-d` in both the flat string and its quote-free
copy, and it is void when the command defines a function or alias, sets
`PATH`, or sources a file. Command position matters because `$C base64 -d
@b <url>` hands `base64` to curl as a URL. Only the flags other tools reuse for
reads (`--json`, `--config`, `--body-file`, bundled `-F`/`-T`/`-K`) still
need an HTTP client (`curl`, `wget`, in any spelling the quote-free copy
resolves to) or a GitHub API host (`api.github.com`, `uploads.github.com`)
named in the command; that condition only adds denies over the pre-2026-10-01
guard. Replaying 220 historical denials, 45 allow, every one a read whose `-d`
belonged to `base64`, `ls`, `tr`, `eza`, `[` or `test`. Five G1 rows in
`docs/recurrence-register.md` named the wrong cause: four were this `-d`, one
the `[ -f` below. The deny reason says when a shape matched only after
removing quotes, when it counted only because an HTTP client was named, and
for a `-d`, which exemption it missed.

Accepted false positives, documented and not fixed, because narrowing them
would open a write path: `gh api -f ref=…` (any `-f`/`-F` field turns `gh
api` into a POST, so use `?ref=` in the path), the shell test `[ -f` beside
an upstream mention (the same `-f` shape), `find` or `fd` over the nested SUT,
remote paths written as a bare `src/…` argument (`commits?path=src/x`), `fd
… -d N` and any other tool's `-d` outside the six read tools (`[ ! -d` too),
and a `-d` read in a command that also contains `()` (an inline `()=>` in
`node -e` counts as a function definition).

Residual write gaps, present before and after 2026-10-01, out of reach of
this string matcher: anything that never names the upstream repository in
the command text (a remote alias, a variable holding the name, a URL-encoded
name, a numeric repository id); wget's abbreviated long options
(`--post-d=`, `--post-f=`, `--meth=`); `git` with more than six global-option
tokens before `push`, or a quoted verb (`git $'push'`); a POST from `python
-c` or `node -e`; `xh POST`/`http POST` with a literal API host (no flag to
match); a hidden client that uses only flags outside the shapes above;
method-override headers; and a `~/.curlrc` that sets a method or data.

The SUT boundary guard (`bin/sut-boundary-guard.mjs`) treats any `|`, `<` or
`>` in a command that names the nested SUT as possible composition, including
redirects that write no file (`2>&1`, `>&2`, `2>/dev/null`, `&>/dev/null`).
A 2026-10-01 change that stripped those redirects first was reverted the
same day: it left a command looking simple, so `cp`, `sed -i`, `perl -pi`,
`python`, `dd` or `install` writing into `src` beside a harmless redirect
reached allow. `git -C src … 2>&1` and every other SUT read with a redirect
are accepted false positives: drop the redirect.

Every deny reason ends with a `Cause:` suffix naming what decided it (G1 in
`docs/recurrence-register.md`). A write-shape deny names the matched shape
(for example `pr create`). When the upstream name appears only inside a
`github.com/<owner>/<repo>` URL in the command text and `-R`/`--repo` names a
different repository, the suffix adds a conditional hint: if the target is
not upstream, put that text in a file (`--body-file`, written with the Write
tool). A read-shape deny names the offending `gh` invocation and the verb it
read, or says it has no verb; when a leading flag such as `--version`
consumed a shell operator as its value, or has nothing after it, the suffix
says to run that `gh` invocation as its own command. The suffix is computed
by pure helpers only after `decide()` has chosen deny, and is appended after
the sanctioned-path text: no allow/deny decision changed, and every reason
still names `publish.mjs`.

The operations this contract supports are **`issue-create`** and
**`issue-comment`**. **`pr-create` is retired**, not pending and not partial:
its result cannot be fully bound under the current contract. The publisher's
argv carried no `--base`/`--head`, so gh resolved the head from whatever
branch the CWD had checked out and the base from the repository default — the
commits being proposed and the target branch sat entirely outside the signed
binding, and a valid receipt could have been spent from any branch.

> Retirarla es reducción de superficie; dejarla parcialmente ligada es deuda
> disfrazada de capacidad.

A binding naming `pr-create` refuses with its own failure
(`operation-unsupported`) and the full reason; a ticket minted before the
retirement fails closed at the publisher with that same reason, consuming
nothing. The documented literal `gh pr create ... --repo
Gentleman-Programming/gentle-ai` shape is still denied when it is routed through
the Bash hook. Within that measured matcher scope, the guard blocks more than
the publisher offers; this is useful asymmetry, not universal coverage.

**Requirements bar for a future bound pr-create — recorded, explicitly not
designed today.** Whoever adds PR support meets this bar or argues with it in
writing:

- `baseRef`;
- `headRef` with owner:branch semantics;
- immutable commit identity — ideally SHA, never only branch names: *la firma
  debe identificar el contenido propuesto, no etiquetas que pueden moverse*;
- mandatory `--base`/`--head` in the executed argv;
- post-publish verification of effective body, title, base and head/commits.

### The boundary-crossing rule, and how the body crosses

The enumeration question that retired pr-create has a stronger form, learned
from the body itself — twice: **it is not enough to enumerate fields — each
datum must be followed to the exact point where it crosses the external
boundary, in the exact representation the hash covered.** The body used to
cross twice: verified on the publisher's first read, then published from a
*second* read gh performed itself when handed a path — the window between
those reads let a swapped file publish unverified bytes. And even with one
read, hash and wire once looked at *different representations*: the hash
covered the normalized form while stdin carried the raw file bytes, so
byte-variant files (CRLF vs LF, BOM vs none, one vs many trailing newlines)
shared one signed hash yet sent different bytes to gh. Detectar no equivale a
impedir: the read-back caught unauthorized bytes AFTER they published, and
the guarantee demands they never publish.

So the publisher's flow is: read the body file **once**; canonicalize
**immediately** (BOM stripped, line endings folded to LF, trailing newlines
dropped) and let the raw text die on that line; verify the hash over the
**canonical content**; never touch the path again; build the argv with
`--body-file -`; hand exactly that canonical content to gh's stdin. The
signature authorizes the canonical content, and exactly that value crosses —
by value (the title in argv, already canonical; the body over stdin), never
as a path gh re-reads, never in a raw representation the hash did not cover.
Canonicalization stays valid as the thing to hash, because the API does not
reliably preserve line endings; the defect was never normalizing — it was
hashing one form and sending another. The post-publish read-back compares
canonical to canonical and stays as the independent confirmation of what
actually landed; it compensates for nothing, because both gaps it once would
have compensated for no longer exist. (This closes the delta audit's warning
about the body's second crossing.)

The three artifacts, in one sentence each: **Receipt = qué publicación
autorizaste. Ticket = derecho consumible para ejecutarla. Attempt = qué
ocurrió realmente.**

> **The receipt itself is still not a signature.** By itself it proves nothing
> about who issued it — anyone able to write the document can write a
> consistent one, and it says so in its own `notASignature` field. The
> signature is a separate artifact, described next.

### Receipt signing — what it closes, and what it does not

An Ed25519 signature over the `receiptId` — produced by the **human-run**
signer `bin/sign-receipt.mjs`, with a private key encrypted under a passphrase
and stored *outside* the repository — expresses exactly one sentence: *"I
authorize publishing these exact bytes, via this operation, to this target."*
The binding is inside the record before the id is computed, so signing the id
signs the target.

**This signs authorization receipts, not the whole store.** It closes offline
forgery of receipts by a writer without the passphrase. It does NOT by itself
resolve:

- **public-key substitution** — mitigated by the admin-write-only anchor at
  `C:\Program Files\GentleAporte\receipt-signing.anchor.json` and by the
  externally recorded fingerprint, not resolved;
- **modification of the verifier or the signer** — residual; mitigation: the
  signer is small and readable, and its sha256 may be recorded in the anchor
  for human spot-checks (`Get-FileHash`, run by the human, never by the signer
  on itself);
- **store rollback or deletion** — residual; a future candidate is an
  externally anchored hash chain;
- **session compromise while signing** — residual.

None of those holes "dies"; each is either closed as named or remains, as
named. The passphrase never travels through argv or env — both are scanned and
refused — and the muted prompt refuses piped stdin. Stated honestly: that TTY
requirement is *hygiene* against a passphrase landing in a pipeline, a CI log
or an agent transcript. It is not proof of a human: a pseudo-TTY can be
allocated by tooling, and `isTTY` identifies the channel type, not who
controls it. Human-only execution is an operational rule — the human opens an
independent terminal and invokes this binary themselves; isTTY cannot
demonstrate it cryptographically.

Enforcement is staged exactly like stage 3: `requireSignedReceipts` in
`enforcement.json` ships **false** — verification always runs and its state
(`valid` / `absent` / `invalid`) is recorded in every forward-path result and
attempt, but nothing blocks until the flag's own burn-in flips it. Its kill
switch: set the flag to false; the verification code stays.

### Publication

Consumes an authorization; it never produces one and never completes evidence
that is missing. Before acting it **recomputes the candidate identity and
demands exact equality** with the one the receipt names.

There is **no default publisher**. Nothing publishes by omission: the caller
names a module, and in tests that module is a fake — no network, no push, no
tag, no release, no PR. The publisher runs in the same terminable worker
isolation as a check, so a publisher that throws, exits or hangs is observed
from outside instead of taking the process with it.

| Outcome | Meaning |
|---|---|
| `published` | the publisher reported success |
| `refused` | the gate would not act; **the publisher was never reached** |
| `failed` | the publisher was reached and did not succeed |

**A failed attempt changes nothing.** The evidence and the receipt are frozen
documents produced earlier; an attempt is a third artifact that refers to them.
That is what stops a publishing failure from retroactively turning a gate into a
`FAIL`, and what lets a second attempt exist beside the first instead of
overwriting it. A regression asserts both documents are byte-identical after a
failure.

**An attempt is bound to the consumed ticket, and records a spent right.**
`consume-ticket` writes, in the same manifest transaction that clears the live
ticket, a `consumedAttempts` entry carrying the ticket's immutable identity:
`{attemptNumber, ticketId, receiptId, candidateId, evidenceId}`. The index is
the only authority for consumption: `tickets/consumed/<lineage>-<n>.json` is
prepared *before* the manifest write, so a failure between the two leaves that
artifact on disk with no consumption having happened, and the store does not
read it as one. `record-attempt` refuses `attempt-unconsumed` when the number
has no confirmed consumption, and `attempt-binding-mismatch` when the record's
`receiptId`, `candidateId` or `evidenceId` is not the *consumed ticket's* —
never the lineage's current values, which re-authorization and
`record-evidence` can move after the consumption. Consequences: a live ticket
admits no record; a prepared-only consumption admits no record until the real
consumption confirms it; a consumption under receipt A cannot be reported under
receipt B; evidence re-recorded after the consumption neither breaks the
ticket's own report nor admits a report carrying the new evidence; and a
hand-written report for another candidate cannot satisfy a `dependsOn`
(the consumed ticket binding is required). `record-attempt` by hand
remains the path for an attempt whose ticket this store confirmed consumed —
typically a publisher run whose own record step failed and printed the JSON to
keep — never for a publication that bypassed the ticket.

**Documented limitation, accepted fail-closed.** Consumptions made before
`consumedAttempts` existed have no confirmation the store can trust: the
`consumed/` artifact alone does not distinguish a confirmed consumption from a
prepared one. Attempts already recorded for them keep counting; no new manual
record is admitted for them. Nothing re-publishes automatically to recover a
record — that could duplicate a real publication. A migration for that history
is separate work, and needs independent evidence or an explicit human
exception; it must not be presented as demonstrated historical consumption.
The first, never-integrated candidate of this fix recorded `consumedAttempts`
as a bare list of numbers. That experimental format is not supported: the
shape check refuses such a store with `invalid-draft` naming `consumedAttempts`,
and no migration reads it (legacy experimental shape).

### Retirement

The store has two terminal states. `STALE` is reached by refusal: the candidate
moved after authorization. `RETIRED` is reached by decision: `ledger.mjs retire
--lineage <L> --reason-file <F> [--superseded-by <L2>]`, from any non-terminal
state (`FROZEN`, `AUDITED_PASS`, `NEEDS_CHANGES`, `CORRECTION_RESERVED`,
`REFROZEN`, `REAUDITED`, `AUTHORIZED`, `PUBLISHABLE`, `NEEDS_MAINTAINER`,
`BLOCKED_INCOMPLETE`), never from `STALE` or from `RETIRED`. Before it existed
no command could close a lineage: `AUTHORIZED` kept a live unsigned receipt
forever, and `PUBLISHABLE` could mint attempt after attempt.

A retirement is a fourth artifact, `retirements/<retirementId>.json`
(`schema/retirement.v1.json`): the prior state, the reason (read from a file,
never from argv, and canonicalized like a body), the optional successor
lineage (which must exist in the same store), the receipt and ticket the
lineage held, and the attempt count. Manifest-last, like everything else: the
record is prepared at its content address, the index moves the lineage to
`RETIRED` naming it, and only then is the receipt archived under
`authorizations/superseded/` exactly as re-authorization archives one, never
deleted. `receiptId` stays on the entry for history, attempts already recorded
are untouched and still listable, and `status` reads the retirement record
back with the same validation every artifact gets.

A live, unexpired ticket refuses the retirement with `ticket-pending`: a
reserved right is not voided silently; publish it or let it expire. From
`RETIRED`, every transition, the ticket reads, and the publisher refuse with
`lineage-retired`, naming the retirement id. The publisher checks the lineage
before it consults any ticket file, so a ticket that happens to exist on disk
decides nothing.

## Security

Redaction covers GitHub tokens and PATs, AWS access key ids, PEM private key
blocks, bearer headers, and credentials embedded in URLs. Keys named
`authorization`, `token`, `password`, `secret`, `api_key` and similar are
replaced wholesale; keys named `env` or `environment` are never recorded.

Stated honestly: this removes credentials matching known shapes. It is not a
proof that no secret can reach the output. The primary defence is upstream of
it — checks observe narrow, named facts and never capture whole environments,
whole files or raw command lines.

## Usage

```bash
node bin/audit.mjs snapshot [--cwd <path>] [--format json]
node bin/audit.mjs check --policy <name|path> --gate <name> [--cwd <path>]
node bin/audit.mjs catalogue
node bin/audit.mjs validate --input <file> [--kind result|snapshot|policy]
node bin/audit.mjs selftest --scenario pass|fail|unknown|not-run|throw|malformed|empty
node bin/audit.mjs selftest --all
node --test test/*.test.mjs
```

`selftest --scenario` exposes one synthetic gate and preserves its natural exit
code. `selftest --all` is the fast operational canary: it expects inner
`FAIL`, `UNKNOWN` and `NOT_RUN` results, malformed and thrown outcomes, missing
remediation, an empty required set, and a real terminated worker timeout. The
aggregate exits `0` only when every observation matches that expectation.
Expected inner blocking outcomes do not fail the aggregate. It is offline,
read-only and creates no persistent state.

The pre-commit hook already runs the complete suite whenever an operative path
is staged, so changes to the canary or audit engine exercise this path without
another hook. The controlled publisher runs only the fast aggregate canary,
before it opens the store, reads a ticket or reaches the network.

### Context doctor (explicit and advisory)

`context-doctor.mjs` measures Claude and Codex instruction surfaces without
adding another hook or standing prompt. Repository discovery includes
`CLAUDE.md`, `AGENTS.md`, path-scoped rules and project skills, while excluding
the nested `src/**` SUT. User-level files are read only with the explicit
`--include-user-scope` option.

Every repository, state, receipt, config and user-root path is physically
resolved before use and refused when it or an existing ancestor resolves into
`src/**`, including through a symlink or junction. An explicit `--work` path
must additionally remain outside both the outer harness and requested repository.

```bash
node bin/context-doctor.mjs --cwd <outer-repository>
node bin/context-doctor.mjs --cwd <outer-repository> --include-user-scope
node bin/context-doctor.mjs --cwd <outer-repository> --work <external-private-directory>
node bin/context-doctor.mjs --cwd <outer-repository> --config <thresholds.json>
```

The first run records a private v2 baseline. Later runs report standing-context
growth within each co-load domain. A v1 baseline is never reinterpreted: use a
new `--work` directory (preferred) or remove only the old context-doctor state
and establish a v2 baseline. The 28-day burn-in is always advisory; reaching
day 28 changes the phase to `awaiting-human-decision`, never to blocking.
Promotion is a separate human decision, not a timer action.

The receipt separates the complete inventory from effective loading:

- `inventory` is a non-standing corpus total. It is useful for ownership and
  storage analysis, not as a model-session context claim.
- `standingContext.domains` reports startup bytes by client/co-load domain.
  Claude and Codex totals are never combined into a synthetic session.
- Every source declares `client`, `coLoadDomain`, `loadPhase`, `loadCondition`,
  `rawBytes`, `effectiveBytes`, and `evidenceStatus`.
- Skills report listing metadata separately from their on-invocation bodies.
  Frontmatter is excluded from duplicate instruction blocks.

Codex project instruction documents use configured `project_doc_max_bytes`;
when it is absent, the documented 32 KiB default is recorded. Both raw and
effective bytes remain visible. This models the native Codex contract and does
not claim that every desktop wrapper enforces it identically. Codex applies
`project_doc_max_bytes` only to project-level AGENTS.md; the global user file
and `model_instructions_file` are uncapped (codex-rs `agents_md.rs`,
rust-v0.144.0). Concretely: only Codex `agents.md` sources with repository/project
scope carry `budgetSource`/`budgetBytes`; user-scope AGENTS.md and the
instruction-file sources below always report `budgetSource: 'none'` and
`budgetBytes: null`. The `codex:startup` domain derives its own budget metadata
only from budgeted sources, so a user-scope-only run reports `budgetSource: 'none'`
for that domain too. Skill listing bytes use name/description/path metadata and
`agents/openai.yaml` interface metadata when present.

With `--include-user-scope`, the doctor also parses the top-level
`model_instructions_file` and `experimental_compact_prompt_file` keys from
`~/.codex/config.toml` (same top-level-only TOML discipline as
`project_doc_max_bytes`: keys declared before the first `[table]` header,
exactly once — declaring the same key twice always throws, regardless of
which string form each declaration uses). `model_instructions_file` is
measured as `sourceClass: model-instructions-file`, `loadPhase: startup_full`,
co-loaded with `codex:startup` — Codex documents this key as overriding the
built-in model instructions, so its bytes are real standing context.
`experimental_compact_prompt_file` is measured as `sourceClass:
compact-prompt-file`, `loadPhase: compact_dynamic`, its own conditional
`codex:compact` co-load domain with standing bytes always `0` (it only loads
when Codex triggers compaction). Because both channels are user-scope
(`scope: 'user'`), neither is ever capped by `project_doc_max_bytes`: both
instruction-file sources report `budgetSource: 'none'` and `budgetBytes:
null`, and the `codex:startup` domain reports the same `none`/`null` budget
when this channel is the only source contributing to it (for example, a
user-scope run with no repository or user AGENTS.md present). Both
instruction-file sources report `evidenceStatus: 'MEASURED'`.

A declared value accepts a TOML basic string (`"..."`, with `\\`, `\"`, `\n`,
`\t`, `\r`, `\b`, `\f`, `\uXXXX` and `\UXXXXXXXX` escapes, each required to
decode to a Unicode scalar value — a `\uXXXX`/`\UXXXXXXXX` escape whose code
point falls in the surrogate range `U+D800`–`U+DFFF` is rejected, matching
the TOML spec) or a TOML literal string (`'...'`, verbatim, no escape
processing — useful for a Windows path written with single backslashes). A
relative declared value resolves against `~/.codex` (the Codex user root),
never against the doctor's own working directory. A multi-line string
(`"""..."""` or `'''...'''`), an empty right-hand side, any other
unparseable value shape, or a basic string containing an escape sequence TOML
does not define (anything other than the ones listed above, including a
surrogate code point) never throws and never silently disappears: it records
a `checks[]` entry (`codex-model-instructions-file` or
`codex-compact-prompt-file`) with status `UNMEASURED` and reason `unsupported
TOML string form` or `unsupported TOML escape`, and emits no source for that
key. When a key is declared with a
supported string form but its target file is missing, unreadable, is a
directory, resolves outside the physical path boundary (for example inside
the read-only `src/**` SUT), or is empty, the doctor likewise never throws: it
records the same kind of `checks[]` entry with a reason describing which of
those conditions applied, and emits no source for that key. When a
`model-instructions-file` source exists, the doctor also emits one
`model-instructions-override` finding (`action: inspect`, `severity:
advisory`) so the override is visible without having to read `config.toml` by
hand; its receipt detail is limited to `{ coLoadDomain, observedBytes }`, and
the private report additionally carries the config path and the instructions
file path.

Claude `CLAUDE.md` and unscoped rules are startup-full. Scoped rules are read on
reference, skill bodies load on invocation, and eligible skill metadata may be
listed at startup; `disable-model-invocation: true` suppresses that eligible
listing contribution. Claude memory, plugin, and system context are outside
this tool's scope.

| Heuristic default | Value | Required response when crossed |
| --- | ---: | --- |
| Always-on context | 20,000 UTF-8 bytes | `extract` |
| Growth from baseline | 2,048 UTF-8 bytes | `prune` |
| Co-loaded duplicate normalized block | 80 characters | `prune` |
| Emphasis saturation | 5 tokens and ratio above 0.04 | `prune` |
| Dated/changelog accretion | More than 5 lines per source | `extract` |
| Aggregate history | Last 56 observations | inspect the bounded trend |

These are configurable operational heuristics, not model limits. The standing
budget and growth heuristic are evaluated per co-load domain, never across
clients. In particular,
Claude's published line guidance is not treated as causal evidence for Codex.
Estimated tokens are labelled `ceil(utf8-bytes/4)` and are not tokenizer output.
Duplicate blocks produce `prune` only when redundant occurrences share a
co-load domain and phase and can coexist. Exact cross-client skill mirrors are
one informational `keep` observation per family/content identity. Cross-skill
boilerplate without a proven co-load path is conditional `keep`, with zero
confirmed runtime saving.

Every finding carries one closed action: `prune`, `extract`, `scope`,
`convert-to-hook`, `keep`, or `inspect`. Unsupported semantic checks are
`UNMEASURED`, never implicit PASS. `UserPromptSubmit` hooks are parsed by event,
type, and output channel. Without measured stdout or `additionalContext`, their
dynamic payload remains `UNMEASURED` and the action is `inspect`; configuration
presence alone is not labelled prompt injection.

Private state lives under the already-ignored
`.claude/state/context-doctor/`: baseline, bounded aggregate history and detailed
reports containing local paths or samples. The JSON receipt printed to stdout
contains only aggregates, source classes, opaque IDs/hashes, thresholds,
finding categories/actions and dates. It contains no raw paths, rule text,
snippets, usernames, hostnames, session IDs or environment values. This first
slice does not parse transcripts and reports Codex/Engram behavioral backtesting
as unsupported. The CLI prints the private report location separately to local
stderr; it never adds that path to the receipt. Dead-reference checks are
deliberately limited to explicit `@...` local-reference syntax.

Rollback remains isolated. Before a commit, restore `.gitignore` and this README
from baseline `f8dee964a1035969ff9e9ea46a3734551fb3c5ce`, then remove only
`bin/context-doctor.mjs`, `lib/context-doctor.mjs`,
`test/context-doctor.test.mjs`, and
`.claude/skills/gentle-ai-context-doctor/`; do not reset or clean the repository.
Ignored `.claude/state/context-doctor/` may be removed independently. After a
commit, revert the context-doctor commit instead of rewriting history.

## Tests

```bash
cd .claude/tools/audit && node --test
```

Covers canonical serialization, redaction, the state machine, check execution
contracts, schema acceptance and rejection, gate aggregation, determinism, and
the process boundary.

## Rollback

Do not delete `.claude/tools/audit/` in isolation. The contribution ledger,
skill scripts, agents and configured hooks depend on it. Revert a specific change
as a coherent Git change, preserving private state and existing receipts. Disabling
a gate is a separate decision through `enforcement.json`; it is not an uninstall.
Before a full uninstall, inventory and remove or replace every dependent hook and
script reference, then verify the remaining workflow. Never delete the audit store
as part of a code rollback.

## Contribution workflow contracts

Every publication needs a frozen candidate and a fresh structured auditor PASS;
there is no low-risk audit exemption. Audit-scope observations decide what to
inspect, not whether to inspect it. The publisher supports `issue-create` and
`issue-comment`; PR creation remains unsupported. Stage 2 and optional signatures
are the shipped defaults. Role tool grants and shell hooks are procedural controls,
not isolation from a trusted actor with Bash or publication credentials.

For issue creation, pass `--title-file` at freeze/refreeze/subject-id, include that
file and its normalized `draftTitleSha256` in the audit packet, then supply the same
title to authorization and publication. Its digest extends `subject_id`; an omitted
or null title keeps historical/untitled identities unchanged. A different title
requires another candidate and audit. Existing receipts retain their old identity
and remain readable, but an audit without a frozen title cannot mint a new
issue-create receipt. Comments continue without a title.

Missing-evidence recovery uses `refreeze` without spending or restoring the
correction allowance. Routing after an audit checks `corrections_used`, not merely
whether its state is `REFROZEN`.

Acceptance coverage distinguishes a completed assessment from a satisfied
condition: evidenced `PASS` and `FAIL` both complete a row. A decisive `FAIL`
with an introduced severe finding routes to `NEEDS_CHANGES`, allowing the one
bounded correction. Without such a finding it routes to `NEEDS_MAINTAINER`,
never `PASS`. Missing, duplicate or unexpected rows, `NOT_RUN`, and `N/A` remain
incomplete; design gaps and pending maintainer decisions retain precedence.
Publication still requires every acceptance condition to pass.

PR intake requires a full explicit implementation-claim observation, in addition
to complete comment-list coverage. The exact fields and two-line body are specified
in `../../skills/gentle-ai-aporte/SKILL.md`. A positive comment count is insufficient;
free-form historical comments must be followed by an explicit claim before new
implementation work is assigned. This validates recorded evidence; it is not an
independent GitHub authentication mechanism.

Tests use disposable Git repositories with signing disabled locally for fixture
commits, never by changing the user's Git configuration. When a host refuses
symlink/junction creation, that integration check reports a reasoned skip, not a
verified alias boundary. A release claiming that coverage must run it on a capable
host and report its actual result.
