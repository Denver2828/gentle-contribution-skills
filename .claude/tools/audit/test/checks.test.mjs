// The PASS / FAIL / UNKNOWN matrix, one section per invariant.
//
// The base snapshot is a REAL one taken from a real fixture repository, then
// copied and adjusted per case. Building it by hand would test the checks
// against a shape the snapshot might not actually produce.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { loadCheckModules } from './helpers/checks.mjs';
import { takeSnapshot } from '../lib/snapshot.mjs';
import { STATUS } from '../lib/status.mjs';
import { readTrackedPaths, readTrackedCount } from '../lib/adapters/git.mjs';
import { repoWithCommit, gentleAiFixtureFiles, BUNDLED_BRANCH_RULE, BUNDLED_BRANCH_RULE_SOURCE, cleanupAll } from './helpers/repo.mjs';

after(cleanupAll);

const ADAPTERS = { readTrackedPaths, readTrackedCount };

let catalogue;
let baseSnapshot;
let baseOutcome;

before(async () => {
  catalogue = await loadCheckModules();
  const { root } = repoWithCommit(gentleAiFixtureFiles(), 'checks-base');
  baseOutcome = takeSnapshot({ cwd: root });
  assert.equal(baseOutcome.status, STATUS.PASS);
  baseSnapshot = baseOutcome.snapshot;
});

/** A deep copy of the real snapshot with the given fields overridden. */
function snapshotWith(mutate) {
  const copy = structuredClone(baseSnapshot);
  mutate(copy);
  return copy;
}

function evaluate(id, { snapshot = baseSnapshot, params = {}, tooling = { commands: [] }, snapshotOutcome } = {}) {
  const definition = catalogue.get(id);
  assert.ok(definition, `check "${id}" must exist`);
  return definition.evaluate({
    snapshot,
    snapshotOutcome: snapshotOutcome ?? { ...baseOutcome, snapshot },
    params,
    tooling,
    adapters: ADAPTERS,
  });
}

/** Every conclusion must carry a reason, and PASS/FAIL must carry evidence. */
function assertWellFormed(outcome, id) {
  assert.equal(typeof outcome.reason, 'string', `${id}: reason`);
  assert.notEqual(outcome.reason.trim(), '', `${id}: reason must not be empty`);
  if (outcome.status === STATUS.PASS || outcome.status === STATUS.FAIL) {
    assert.ok((outcome.evidence ?? []).length > 0, `${id}: ${outcome.status} must cite evidence`);
  }
}

const expect = (id, status, outcome) => {
  assert.equal(outcome.status, status, `${id} expected ${status}, got ${outcome.status}: ${outcome.reason}`);
  assertWellFormed(outcome, id);
  return outcome;
};

// -- git.repository-readable ----------------------------------------------------

test('git.repository-readable: PASS when a snapshot exists', () => {
  expect('git.repository-readable', STATUS.PASS, evaluate('git.repository-readable'));
});

test('git.repository-readable: FAIL when the directory is not a work tree', () => {
  const outcome = evaluate('git.repository-readable', {
    snapshotOutcome: { status: STATUS.UNKNOWN, snapshot: null, reason: 'the working directory is not inside a Git work tree, so there is no repository state to describe', evidence: baseOutcome.evidence },
  });
  expect('git.repository-readable', STATUS.FAIL, outcome);
});

test('git.repository-readable: UNKNOWN when the repository could not be read for any other reason', () => {
  const outcome = evaluate('git.repository-readable', {
    snapshotOutcome: { status: STATUS.UNKNOWN, snapshot: null, reason: 'this repository layout is not supported yet: 1 submodule gitlink(s) present', evidence: baseOutcome.evidence },
  });
  expect('git.repository-readable', STATUS.UNKNOWN, outcome);
});

// -- git.no-operation-in-progress -----------------------------------------------

test('git.no-operation-in-progress: PASS, FAIL', () => {
  expect('git.no-operation-in-progress', STATUS.PASS, evaluate('git.no-operation-in-progress'));

  for (const operation of ['merge', 'rebase', 'cherry-pick', 'revert', 'bisect']) {
    const snapshot = snapshotWith((s) => { s.identity.operation = operation; });
    expect('git.no-operation-in-progress', STATUS.FAIL, evaluate('git.no-operation-in-progress', { snapshot }));
  }
});

// -- git.no-conflicts -------------------------------------------------------------

test('git.no-conflicts: PASS, FAIL', () => {
  expect('git.no-conflicts', STATUS.PASS, evaluate('git.no-conflicts'));

  const snapshot = snapshotWith((s) => {
    s.changes.unmerged = [{ path: 'conflict.txt', status: 'unmerged', from: null }];
  });
  const failed = expect('git.no-conflicts', STATUS.FAIL, evaluate('git.no-conflicts', { snapshot }));
  assert.match(failed.reason, /conflict\.txt/);
});

// -- git.branch-allowed ------------------------------------------------------------

// The rule exactly as written in the audited repository, cited at its line.
const CONTRIBUTING_RULE = {
  pattern: BUNDLED_BRANCH_RULE,
  source: BUNDLED_BRANCH_RULE_SOURCE,
  authority: 'repository',
};

test('git.branch-allowed: PASS when the branch matches the documented rule', () => {
  for (const branch of ['fix/1868-engram-registry-rebased', 'feat/user-login', 'ci/add-e2e-job', 'docs/api-reference']) {
    const snapshot = snapshotWith((s) => { s.identity.branch = branch; });
    const outcome = expect('git.branch-allowed', STATUS.PASS, evaluate('git.branch-allowed', { snapshot, params: CONTRIBUTING_RULE }));
    assert.ok(outcome.reason.includes(`the rule at ${BUNDLED_BRANCH_RULE_SOURCE}`), 'the PASS must attribute the rule to its source');
  }
});

test('git.branch-allowed: FAIL on branches the documented rule rejects', () => {
  // The last two are cases the inferred glob list got wrong: "archive/" was a
  // prefix I invented, and "fix/a/b" was accepted by "fix/**" while the real
  // rule forbids a second separator.
  for (const branch of ['main', 'Fix/Uppercase', 'archive/1868-full', 'fix/nested/path']) {
    const snapshot = snapshotWith((s) => { s.identity.branch = branch; });
    expect('git.branch-allowed', STATUS.FAIL, evaluate('git.branch-allowed', { snapshot, params: CONTRIBUTING_RULE }));
  }
});

test('git.branch-allowed: UNKNOWN on a detached HEAD, because there is no branch to answer about', () => {
  const snapshot = snapshotWith((s) => { s.identity.branch = null; s.identity.detached = true; });
  const outcome = expect('git.branch-allowed', STATUS.UNKNOWN, evaluate('git.branch-allowed', { snapshot, params: CONTRIBUTING_RULE }));
  assert.match(outcome.reason, /detached/);
  assert.match(outcome.remediation, /Check out the branch intended for publication/);
});

test('git.branch-allowed: a convention with no verifiable source authorises nothing', () => {
  // The branch would match the pattern. It still does not pass, because the
  // rule it is measured against cannot be located in the audited repository.
  const snapshot = snapshotWith((s) => { s.identity.branch = 'fix/would-have-matched'; });
  const outcome = expect('git.branch-allowed', STATUS.UNKNOWN, evaluate('git.branch-allowed', {
    snapshot,
    params: { ...CONTRIBUTING_RULE, source: 'docs/branch-rules-that-do-not-exist.md#L1' },
  }));

  assert.match(outcome.reason, /no verifiable source does not authorise anything/);
  assert.equal(outcome.evidence[0].observed.sourceTracked, false);
});

test('git.branch-allowed: a rule declared as ours is never attributed to the audited repository', () => {
  const snapshot = snapshotWith((s) => { s.identity.branch = 'internal/whatever'; });
  const outcome = expect('git.branch-allowed', STATUS.PASS, evaluate('git.branch-allowed', {
    snapshot,
    params: { pattern: '^internal\\/', source: 'REGLAS-APORTE.md', authority: 'ours' },
  }));

  assert.match(outcome.reason, /our own policy, which is not a rule of the audited repository/);
});

// -- git.worktree-clean --------------------------------------------------------------

test('git.worktree-clean: PASS on a clean tree', () => {
  expect('git.worktree-clean', STATUS.PASS, evaluate('git.worktree-clean', { params: { allowStaged: false, allowUntracked: false } }));
});

test('git.worktree-clean: FAIL on unstaged changes, whatever the policy allows', () => {
  const snapshot = snapshotWith((s) => { s.changes.unstaged = [{ path: 'a.txt', status: 'modified', from: null }]; });
  expect('git.worktree-clean', STATUS.FAIL, evaluate('git.worktree-clean', { snapshot, params: { allowStaged: true, allowUntracked: true } }));
});

test('git.worktree-clean: the policy decides whether staged and untracked are offences', () => {
  const staged = snapshotWith((s) => { s.changes.staged = [{ path: 'a.txt', status: 'modified', from: null }]; });
  expect('git.worktree-clean', STATUS.FAIL, evaluate('git.worktree-clean', { snapshot: staged, params: { allowStaged: false, allowUntracked: false } }));
  expect('git.worktree-clean', STATUS.PASS, evaluate('git.worktree-clean', { snapshot: staged, params: { allowStaged: true, allowUntracked: false } }));

  const untracked = snapshotWith((s) => { s.changes.untracked = ['new.txt']; });
  expect('git.worktree-clean', STATUS.FAIL, evaluate('git.worktree-clean', { snapshot: untracked, params: { allowStaged: true, allowUntracked: false } }));
  expect('git.worktree-clean', STATUS.PASS, evaluate('git.worktree-clean', { snapshot: untracked, params: { allowStaged: true, allowUntracked: true } }));
});

// -- git.upstream-configured -----------------------------------------------------------

test('git.upstream-configured: PASS, FAIL, UNKNOWN', () => {
  const tracking = snapshotWith((s) => { s.identity.branch = 'main'; s.identity.upstream = 'origin/main'; });
  expect('git.upstream-configured', STATUS.PASS, evaluate('git.upstream-configured', { snapshot: tracking }));

  const untracked = snapshotWith((s) => { s.identity.branch = 'main'; s.identity.upstream = null; });
  expect('git.upstream-configured', STATUS.FAIL, evaluate('git.upstream-configured', { snapshot: untracked }));

  const detached = snapshotWith((s) => { s.identity.branch = null; s.identity.detached = true; s.identity.upstream = null; });
  expect('git.upstream-configured', STATUS.UNKNOWN, evaluate('git.upstream-configured', { snapshot: detached }));
});

// -- git.not-behind-upstream -------------------------------------------------------------

test('git.not-behind-upstream: PASS when level with the upstream', () => {
  const snapshot = snapshotWith((s) => { s.identity.upstream = 'origin/main'; s.identity.ahead = 3; s.identity.behind = 0; });
  expect('git.not-behind-upstream', STATUS.PASS, evaluate('git.not-behind-upstream', { snapshot, params: { maxBehind: 0 } }));
});

test('git.not-behind-upstream: FAIL past the allowance, PASS within it', () => {
  const snapshot = snapshotWith((s) => { s.identity.upstream = 'origin/main'; s.identity.ahead = 1; s.identity.behind = 14; });
  expect('git.not-behind-upstream', STATUS.FAIL, evaluate('git.not-behind-upstream', { snapshot, params: { maxBehind: 0 } }));
  expect('git.not-behind-upstream', STATUS.PASS, evaluate('git.not-behind-upstream', { snapshot, params: { maxBehind: 20 } }));
});

test('git.not-behind-upstream: UNKNOWN when there is no upstream, because null is not zero', () => {
  const snapshot = snapshotWith((s) => { s.identity.upstream = null; s.identity.ahead = null; s.identity.behind = null; });
  const outcome = expect('git.not-behind-upstream', STATUS.UNKNOWN, evaluate('git.not-behind-upstream', { snapshot, params: { maxBehind: 0 } }));
  assert.match(outcome.reason, /no upstream to compare against/);
  assert.match(outcome.remediation, /Configure the branch upstream/);
});

// -- diff.within-review-budget ---------------------------------------------------------------

// The budget measures the PUBLISHABLE candidate -- own commits plus staged
// changes since the merge base -- not the index against HEAD. The full fixture
// matrix for that distinction lives in review-budget.test.mjs.
const withCandidate = (fields) => snapshotWith((s) => {
  s.diffstat.candidate = { base: 'merge-base', baseOid: 'a'.repeat(40), files: 1, additions: 0, deletions: 0, binaryFiles: 0, ...fields };
  s.diffstat.candidateUnavailable = null;
});

test('diff.within-review-budget: PASS at and under the limit', () => {
  for (const [additions, deletions] of [[0, 0], [200, 200], [399, 0]]) {
    const snapshot = withCandidate({ additions, deletions });
    expect('diff.within-review-budget', STATUS.PASS, evaluate('diff.within-review-budget', { snapshot, params: { limit: 400 } }));
  }
});

test('diff.within-review-budget: FAIL over the limit, with the measured number', () => {
  // The real case this was built for: a body claiming 100 lines over a 265-line diff.
  const snapshot = withCandidate({ files: 3, additions: 220, deletions: 45 });
  const outcome = expect('diff.within-review-budget', STATUS.FAIL, evaluate('diff.within-review-budget', { snapshot, params: { limit: 200 } }));
  assert.match(outcome.reason, /265 lines \(\+220\/-45\)/);
});

test('diff.within-review-budget: UNKNOWN when a binary file makes the total incomplete', () => {
  const snapshot = withCandidate({ files: 2, additions: 10, binaryFiles: 1 });
  const outcome = expect('diff.within-review-budget', STATUS.UNKNOWN, evaluate('diff.within-review-budget', { snapshot, params: { limit: 400 } }));
  assert.match(outcome.reason, /incomplete/);
});

// -- files.required-present ---------------------------------------------------------------------

test('files.required-present: PASS, FAIL', () => {
  expect('files.required-present', STATUS.PASS, evaluate('files.required-present', { params: { paths: ['CONTRIBUTING.md', 'go.mod'] } }));

  const outcome = expect('files.required-present', STATUS.FAIL, evaluate('files.required-present', { params: { paths: ['CONTRIBUTING.md', 'LICENSE', 'CODEOWNERS'] } }));
  assert.match(outcome.reason, /CODEOWNERS, LICENSE/);
});

test('files.required-present: UNKNOWN when the tracked list cannot be read', () => {
  const snapshot = snapshotWith((s) => { s.root = 'C:/definitely/not/a/repository'; });
  expect('files.required-present', STATUS.UNKNOWN, evaluate('files.required-present', { snapshot, params: { paths: ['anything'] } }));
});

// -- tooling.commands-declared --------------------------------------------------------------------

test('tooling.commands-declared: PASS when every source is tracked', () => {
  const tooling = { commands: [{ id: 'test', run: 'go test ./...', source: '.github/workflows/ci.yml', appliesTo: ['go.mod'] }] };
  expect('tooling.commands-declared', STATUS.PASS, evaluate('tooling.commands-declared', { tooling }));
});

test('tooling.commands-declared: a #Lnn suffix is accepted, only the path is verified', () => {
  const tooling = { commands: [{ id: 'test', run: 'go test ./...', source: '.github/workflows/ci.yml#L57', appliesTo: ['go.mod'] }] };
  expect('tooling.commands-declared', STATUS.PASS, evaluate('tooling.commands-declared', { tooling }));
});

test('tooling.commands-declared: FAIL when a declared source does not exist', () => {
  const tooling = { commands: [{ id: 'lint', run: 'golangci-lint run', source: '.golangci.yml', appliesTo: ['go.mod'] }] };
  const outcome = expect('tooling.commands-declared', STATUS.FAIL, evaluate('tooling.commands-declared', { tooling }));
  assert.match(outcome.reason, /lint -> \.golangci\.yml/);
});

test('tooling.commands-declared: UNKNOWN when nothing is declared, which is not evidence of nothing existing', () => {
  const outcome = expect('tooling.commands-declared', STATUS.UNKNOWN, evaluate('tooling.commands-declared', { tooling: { commands: [] } }));
  assert.match(outcome.reason, /not evidence that it has none/);
  assert.match(outcome.remediation, /Declare each applicable command/);
});

// -- tooling.manifests-covered ------------------------------------------------------------------------

test('tooling.manifests-covered: PASS when every manifest is covered or declared exempt', () => {
  const tooling = { commands: [{ id: 'test', run: 'go test ./...', source: '.github/workflows/ci.yml', appliesTo: ['go.mod'] }] };
  expect('tooling.manifests-covered', STATUS.PASS, evaluate('tooling.manifests-covered', { tooling, params: { exempt: ['bench/go.mod'] } }));
});

test('tooling.manifests-covered: FAIL naming the uncovered manifest, instead of inferring its command', () => {
  const snapshot = snapshotWith((s) => { s.inventory.manifests = ['go.mod', 'services/api/package.json']; });
  const tooling = { commands: [{ id: 'test', run: 'go test ./...', source: '.github/workflows/ci.yml', appliesTo: ['go.mod'] }] };
  const outcome = expect('tooling.manifests-covered', STATUS.FAIL, evaluate('tooling.manifests-covered', { snapshot, tooling, params: { exempt: [] } }));
  assert.match(outcome.reason, /services\/api\/package\.json/);
});

test('tooling.manifests-covered: an exemption must be declared, never assumed', () => {
  const snapshot = snapshotWith((s) => { s.inventory.manifests = ['go.mod', 'package.json']; });
  const tooling = { commands: [{ id: 'test', run: 'go test ./...', source: '.github/workflows/ci.yml', appliesTo: ['go.mod'] }] };

  expect('tooling.manifests-covered', STATUS.FAIL, evaluate('tooling.manifests-covered', { snapshot, tooling, params: { exempt: [] } }));
  expect('tooling.manifests-covered', STATUS.PASS, evaluate('tooling.manifests-covered', { snapshot, tooling, params: { exempt: ['package.json'] } }));
});

// -- catalogue-wide ---------------------------------------------------------------------------------------

test('every check in the catalogue has a matrix section somewhere', async () => {
  // Kept as a map rather than a set so a new check cannot be added without
  // someone stating, in writing, where its matrix lives.
  const covered = {
    'git.repository-readable': 'checks.test.mjs',
    'git.no-operation-in-progress': 'checks.test.mjs',
    'git.no-conflicts': 'checks.test.mjs',
    'git.branch-allowed': 'checks.test.mjs',
    'git.worktree-clean': 'checks.test.mjs',
    'git.upstream-configured': 'checks.test.mjs',
    'git.not-behind-upstream': 'checks.test.mjs',
    'diff.within-review-budget': 'checks.test.mjs + review-budget.test.mjs',
    'files.required-present': 'checks.test.mjs',
    'tooling.commands-declared': 'checks.test.mjs',
    'tooling.manifests-covered': 'checks.test.mjs',
    'parity.declaration-source': 'parity.test.mjs',
    'parity.go-module-lockfile': 'parity.test.mjs',
  };

  for (const id of catalogue.keys()) {
    assert.ok(covered[id], `check "${id}" has no matrix section in any test file`);
  }
  assert.equal(Object.keys(covered).length, catalogue.size);
});

test('no check mutates the snapshot it is given', () => {
  const before = JSON.stringify(baseSnapshot);
  evaluate('git.no-conflicts');
  evaluate('git.worktree-clean', { params: { allowStaged: true, allowUntracked: true } });
  evaluate('diff.within-review-budget', { params: { limit: 400 } });
  evaluate('files.required-present', { params: { paths: ['go.mod'] } });
  assert.equal(JSON.stringify(baseSnapshot), before);
});
