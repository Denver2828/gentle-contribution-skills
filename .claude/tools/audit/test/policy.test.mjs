// Policy loading, resolution, and the rule that nothing degrades silently.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPolicy, resolveGate, policyPath, PolicyError, POLICY_DIRECTORY } from '../lib/policy.mjs';
import { discoverChecks } from '../lib/registry.mjs';
import { runPreflight } from '../lib/preflight.mjs';
import { validateResult } from '../lib/validate.mjs';
import { STATUS } from '../lib/status.mjs';
import { repoWithCommit, write, git, commit, cloneInto, gentleAiFixtureFiles, FIXTURE_REPOSITORY, cleanupAll } from './helpers/repo.mjs';

after(cleanupAll);

const scratch = mkdtempSync(join(tmpdir(), 'audit-policy-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function policyFile(document) {
  const path = join(scratch, `policy-${counter += 1}.json`);
  writeFileSync(path, JSON.stringify(document));
  return path;
}

const MINIMAL = {
  policyVersion: '1.0.0',
  id: 'test-policy',
  version: '1',
  repository: FIXTURE_REPOSITORY,
  gates: { preflight: { checks: [{ id: 'git.repository-readable', required: true }] } },
};

// -- loading -------------------------------------------------------------------

test('the bundled gentle-ai policy loads and validates', () => {
  const policy = loadPolicy(policyPath('gentle-ai'));
  assert.equal(policy.id, 'gentle-ai');
  assert.equal(policyPath('gentle-ai'), join(POLICY_DIRECTORY, 'gentle-ai.json'));
});

test('an incompatible policyVersion blocks with its own message', () => {
  const path = policyFile({ ...MINIMAL, policyVersion: '2.0.0' });
  assert.throws(() => loadPolicy(path), (error) =>
    error instanceof PolicyError && /only supports 1\.0\.0/.test(error.message));
});

test('a missing policyVersion blocks rather than defaulting to the supported one', () => {
  const { policyVersion, ...withoutVersion } = MINIMAL;
  assert.throws(() => loadPolicy(policyFile(withoutVersion)), PolicyError);
});

test('a policy that violates the schema blocks and names the violations', () => {
  const cases = [
    { label: 'unknown top-level key', document: { ...MINIMAL, extra: true } },
    { label: 'missing gates', document: { policyVersion: '1.0.0', id: 'x', version: '1' } },
    { label: 'selection without required', document: { ...MINIMAL, gates: { preflight: { checks: [{ id: 'git.no-conflicts' }] } } } },
    { label: 'non-boolean required', document: { ...MINIMAL, gates: { preflight: { checks: [{ id: 'git.no-conflicts', required: 'yes' }] } } } },
    { label: 'empty skip reason', document: { ...MINIMAL, gates: { preflight: { checks: [{ id: 'git.no-conflicts', required: true, skip: '' }] } } } },
    { label: 'command without source', document: { ...MINIMAL, tooling: { commands: [{ id: 'test', run: 'go test', appliesTo: ['go.mod'] }] } } },
    { label: 'command with unknown id', document: { ...MINIMAL, tooling: { commands: [{ id: 'deploy', run: 'x', source: 'y', appliesTo: ['z'] }] } } },
    { label: 'repository without expected', document: { ...MINIMAL, repository: { remote: 'origin' } } },
    { label: 'repository without remote', document: { ...MINIMAL, repository: { expected: FIXTURE_REPOSITORY.expected } } },
    { label: 'repository with an empty remote name', document: { ...MINIMAL, repository: { ...FIXTURE_REPOSITORY, remote: '' } } },
    { label: 'expected without a name', document: { ...MINIMAL, repository: { remote: 'origin', expected: { host: 'github.com', owner: 'x' } } } },
    { label: 'expected with an empty owner', document: { ...MINIMAL, repository: { remote: 'origin', expected: { host: 'github.com', owner: '', name: 'y' } } } },
    { label: 'expected with an unknown key', document: { ...MINIMAL, repository: { remote: 'origin', expected: { ...FIXTURE_REPOSITORY.expected, branch: 'main' } } } },
  ];

  for (const { label, document } of cases) {
    assert.throws(() => loadPolicy(policyFile(document)), PolicyError, label);
  }
});

test('a policy that declares no target repository does not load at all', () => {
  // The defect this rule answers: a policy citing one repository's files, run
  // against another, producing five confident rows about the wrong target. A
  // policy that names nothing can be pointed anywhere, so naming it is not
  // optional.
  const { repository, ...withoutRepository } = MINIMAL;
  assert.throws(() => loadPolicy(policyFile(withoutRepository)), (error) =>
    error instanceof PolicyError && /repository/.test(error.message));
});

test('the bundled policy is bound to the repository it was written for', () => {
  const policy = loadPolicy(policyPath('gentle-ai'));
  assert.deepEqual(policy.repository, {
    remote: 'origin',
    expected: { host: 'github.com', owner: 'Gentleman-Programming', name: 'gentle-ai' },
  });
});

test('an unreadable or unparseable policy blocks', () => {
  assert.throws(() => loadPolicy(join(scratch, 'absent.json')), PolicyError);
  const broken = join(scratch, 'broken.json');
  writeFileSync(broken, '{ not json');
  assert.throws(() => loadPolicy(broken), PolicyError);
});

// -- resolution ----------------------------------------------------------------

test('an unknown gate blocks and lists the gates that exist', async () => {
  await assert.rejects(() => resolveGate(MINIMAL, 'release'), (error) =>
    error instanceof PolicyError && /defines no gate "release"/.test(error.message));
});

test('an unknown check blocks and lists the catalogue', async () => {
  const document = { ...MINIMAL, gates: { preflight: { checks: [{ id: 'invented.check', required: true }] } } };
  await assert.rejects(() => resolveGate(document, 'preflight'), (error) =>
    error instanceof PolicyError && /selects unknown check "invented.check"/.test(error.message));
});

test('selecting the same check twice blocks', async () => {
  const document = {
    ...MINIMAL,
    gates: { preflight: { checks: [
      { id: 'git.no-conflicts', required: true },
      { id: 'git.no-conflicts', required: false },
    ] } },
  };
  await assert.rejects(() => resolveGate(document, 'preflight'), /more than once/);
});

test('a parameter the check does not offer blocks', async () => {
  const document = {
    ...MINIMAL,
    gates: { preflight: { checks: [{ id: 'diff.within-review-budget', required: true, with: { limit: 400, ceiling: 9 } }] } },
  };
  await assert.rejects(() => resolveGate(document, 'preflight'), /has no parameter "ceiling"/);
});

test('a required parameter the policy omits blocks', async () => {
  const document = {
    ...MINIMAL,
    gates: { preflight: { checks: [{ id: 'diff.within-review-budget', required: true }] } },
  };
  await assert.rejects(() => resolveGate(document, 'preflight'), /requires parameter "limit"/);
});

test('the plan records required and optional distinctly', async () => {
  const document = {
    ...MINIMAL,
    gates: { preflight: { checks: [
      { id: 'git.repository-readable', required: true },
      { id: 'git.no-conflicts', required: false },
    ] } },
  };
  const plan = await resolveGate(document, 'preflight');

  assert.deepEqual(plan.selected.map((entry) => [entry.definition.id, entry.required]), [
    ['git.repository-readable', true],
    ['git.no-conflicts', false],
  ]);
});

test('every catalogue check the policy did not select is recorded as NOT_RUN', async () => {
  const catalogue = await discoverChecks();
  const plan = await resolveGate(MINIMAL, 'preflight');

  assert.equal(plan.selected.length, 1);
  assert.equal(plan.notRun.length, catalogue.size - 1);
  for (const entry of plan.notRun) {
    assert.match(entry.skip, /not selected by policy test-policy@1 for gate preflight/);
    assert.equal(entry.required, false);
  }
});

test('an explicit skip keeps the required flag, so a skip is not a silent waiver', async () => {
  const document = {
    ...MINIMAL,
    gates: { preflight: { checks: [
      { id: 'git.repository-readable', required: true },
      { id: 'git.no-conflicts', required: true, skip: 'the runner cannot resolve conflicts on this host' },
    ] } },
  };
  const plan = await resolveGate(document, 'preflight');
  const skipped = plan.notRun.find((entry) => entry.definition.id === 'git.no-conflicts');

  assert.equal(skipped.required, true);
  assert.equal(skipped.skip, 'the runner cannot resolve conflicts on this host');
});

// -- end to end ------------------------------------------------------------------

test('the whole catalogue appears in the result, selected or not', async () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'policy-e2e');
  const catalogue = await discoverChecks();

  const { result } = await runPreflight({ cwd: root, policy: policyFile(MINIMAL), gate: 'preflight' });

  assert.equal(validateResult(result).valid, true);
  assert.equal(result.checks.length, catalogue.size, 'a check missing from the report is indistinguishable from one that passed');
  assert.equal(result.summary.notRun, catalogue.size - 1);
  assert.equal(result.status, STATUS.PASS);
});

test('a required skipped check blocks the gate with its declared reason', async () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'policy-skip');
  const document = {
    ...MINIMAL,
    gates: { preflight: { checks: [
      { id: 'git.repository-readable', required: true },
      { id: 'git.no-conflicts', required: true, skip: 'deliberately not executed for this fixture' },
    ] } },
  };

  const { result } = await runPreflight({ cwd: root, policy: policyFile(document), gate: 'preflight' });
  const skipped = result.checks.find((check) => check.id === 'git.no-conflicts');

  assert.equal(skipped.status, STATUS.NOT_RUN);
  assert.equal(skipped.required, true);
  assert.equal(skipped.reason, 'deliberately not executed for this fixture');
  assert.equal(result.status, STATUS.NOT_RUN, 'a required check that did not run blocks');
});

test('an optional failing check is recorded and does not block', async () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'policy-optional');
  const document = {
    ...MINIMAL,
    gates: { preflight: { checks: [
      { id: 'git.repository-readable', required: true },
      { id: 'git.upstream-configured', required: false },
    ] } },
  };

  const { result } = await runPreflight({ cwd: root, policy: policyFile(document), gate: 'preflight' });
  const optional = result.checks.find((check) => check.id === 'git.upstream-configured');

  assert.equal(optional.status, STATUS.FAIL, 'a fixture repo has no upstream');
  assert.equal(result.status, STATUS.PASS);
});

test('when the repository cannot be read, snapshot-dependent checks are UNKNOWN and none invents state', async () => {
  // The repository is the declared one -- its `origin` says so, and that
  // configuration is readable -- but its index is destroyed, so no snapshot
  // describes it. Identity passes; the reading does not.
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'policy-unreadable');
  writeFileSync(join(root, '.git', 'index'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));

  const document = {
    ...MINIMAL,
    gates: { preflight: { checks: [
      { id: 'git.repository-readable', required: true },
      { id: 'git.no-conflicts', required: true },
      { id: 'git.worktree-clean', required: true, with: { allowUntracked: true } },
    ] } },
  };

  const { result } = await runPreflight({ cwd: root, policy: policyFile(document), gate: 'preflight' });

  assert.equal(result.checks.find((c) => c.id === 'git.repository-readable').status, STATUS.UNKNOWN);
  for (const id of ['git.no-conflicts', 'git.worktree-clean']) {
    const check = result.checks.find((c) => c.id === id);
    assert.equal(check.status, STATUS.UNKNOWN, `${id} must not conclude without a snapshot`);
    assert.match(check.reason, /could not be read/);
  }
  assert.equal(result.status, STATUS.UNKNOWN);
});

test('a directory that is not the declared repository never reaches a check', async () => {
  // Previously this fixture reached the catalogue and produced one FAIL plus
  // two UNKNOWN rows about a directory that is not a repository at all. It now
  // stops at the identity precondition, which is the whole point: rows about
  // the wrong target are worse than no rows.
  const directory = mkdtempSync(join(tmpdir(), 'audit-not-a-repo-'));
  try {
    const document = {
      ...MINIMAL,
      gates: { preflight: { checks: [
        { id: 'git.repository-readable', required: true },
        { id: 'git.no-conflicts', required: true },
      ] } },
    };

    const { result } = await runPreflight({ cwd: directory, policy: policyFile(document), gate: 'preflight' });

    assert.deepEqual(result.checks.map((check) => check.id), ['gate.repository-identity']);
    assert.equal(result.status, STATUS.UNKNOWN);
    assert.equal(validateResult(result).valid, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// -- the bundled policy: upstream freshness blocks --------------------------------

/**
 * A repository shaped like a real candidate, on a branch the documented rule
 * accepts, carrying the files the bundled policy requires.
 */
function candidateForBundledPolicy(label, { branch = 'fix/999-example' } = {}) {
  const { root: origin } = repoWithCommit(gentleAiFixtureFiles(), `${label}-origin`);

  const clone = cloneInto(origin, `${label}-clone`);
  git(clone, 'checkout', '-q', '-b', branch);
  return { origin, clone };
}

const bundled = () => policyPath('gentle-ai');
const statusOf = (result, id) => result.checks.find((check) => check.id === id).status;

test('regression: a branch with no upstream blocks the gate', async () => {
  const { root } = repoWithCommit(gentleAiFixtureFiles(), 'no-upstream');
  git(root, 'checkout', '-q', '-b', 'fix/999-no-upstream');

  const { result } = await runPreflight({ cwd: root, policy: bundled(), gate: 'preflight' });

  assert.equal(statusOf(result, 'git.upstream-configured'), STATUS.FAIL);
  assert.equal(statusOf(result, 'git.not-behind-upstream'), STATUS.UNKNOWN, 'null is not zero');
  assert.equal(result.checks.find((c) => c.id === 'git.upstream-configured').required, true);
  assert.notEqual(result.status, STATUS.PASS, 'an untracked branch must never authorise publication');
  assert.equal(result.status, STATUS.FAIL);
});

test('regression: a branch behind its upstream blocks the gate', async () => {
  const { origin, clone } = candidateForBundledPolicy('behind');

  // Advance the origin only. The clone falls behind without touching it.
  write(origin, 'moved-on.txt', 'upstream moved\n');
  git(origin, 'add', '-A');
  commit(origin, 'upstream advances');
  git(clone, 'fetch', '-q', 'origin');
  git(clone, 'branch', '--set-upstream-to=origin/main', 'fix/999-example');

  const { result } = await runPreflight({ cwd: clone, policy: bundled(), gate: 'preflight' });

  assert.equal(statusOf(result, 'git.upstream-configured'), STATUS.PASS);
  assert.equal(statusOf(result, 'git.not-behind-upstream'), STATUS.FAIL);
  assert.equal(result.status, STATUS.FAIL, 'being behind the upstream must block publication');
});

test('regression: a branch level with its upstream passes both upstream checks', async () => {
  const { clone } = candidateForBundledPolicy('level');
  git(clone, 'branch', '--set-upstream-to=origin/main', 'fix/999-example');

  const { result } = await runPreflight({ cwd: clone, policy: bundled(), gate: 'preflight' });

  assert.equal(statusOf(result, 'git.upstream-configured'), STATUS.PASS);
  assert.equal(statusOf(result, 'git.not-behind-upstream'), STATUS.PASS);
  assert.equal(result.status, STATUS.PASS, result.checks.filter((c) => c.status !== STATUS.PASS).map((c) => `${c.id}: ${c.reason}`).join(' | '));
});

test('regression: the bundled policy cites the branch rule with its source, and the source is tracked', async () => {
  const policy = loadPolicy(bundled());
  const selection = policy.gates.preflight.checks.find((check) => check.id === 'git.branch-allowed');

  assert.equal(selection.with.authority, 'repository');
  assert.match(selection.with.source, /^CONTRIBUTING\.md(#L\d+)?$/);
  assert.equal(Object.hasOwn(selection.with, 'allowedBranches'), false, 'the inferred glob list must be gone');

  // And the rule blocks rather than authorising when that source is absent.
  const { clone } = candidateForBundledPolicy('missing-source');
  git(clone, 'rm', '-q', 'CONTRIBUTING.md');
  git(clone, 'branch', '--set-upstream-to=origin/main', 'fix/999-example');

  const { result } = await runPreflight({ cwd: clone, policy: bundled(), gate: 'preflight' });
  assert.equal(statusOf(result, 'git.branch-allowed'), STATUS.UNKNOWN);
  assert.notEqual(result.status, STATUS.PASS);
});

test('regression: both upstream checks are required in the bundled policy', () => {
  const policy = loadPolicy(bundled());
  for (const id of ['git.upstream-configured', 'git.not-behind-upstream']) {
    const selection = policy.gates.preflight.checks.find((check) => check.id === id);
    assert.equal(selection.required, true, `${id} must be required in the publication gate`);
  }
});

// -- the issue-only gate -------------------------------------------------------
//
// Run 006 of the stage 2 burn-in measured an issue candidate through the
// publication gate and produced rows about a branch the candidate had nothing
// to do with, plus one question no reading could answer: how many lines does a
// contribution that changes no file measure? The answer is not a smaller
// budget. It is that five of those checks have no subject here, so they are not
// selected -- and the check that carries a finding's whole weight, whether its
// citations hold, stays required.

/** A repository shaped like the real one, with nothing staged and no branch of our own. */
function issueShapedRepository(label) {
  const { root } = repoWithCommit(gentleAiFixtureFiles(), label);
  return root;
}

const ISSUE_GATE_SELECTS = [
  'git.repository-readable',
  'git.no-operation-in-progress',
  'git.no-conflicts',
  'files.required-present',
  'tooling.commands-declared',
  'tooling.manifests-covered',
  'parity.declaration-source',
  'parity.go-module-lockfile',
];

const ISSUE_GATE_OMITS = [
  'git.branch-allowed',
  'git.upstream-configured',
  'git.not-behind-upstream',
  'diff.within-review-budget',
  'git.worktree-clean',
];

test('the issue gate passes on a candidate that changes no file', async () => {
  const root = issueShapedRepository('issue-gate-pass');

  const { result } = await runPreflight({ cwd: root, policy: policyPath('gentle-ai'), gate: 'preflight-issue' });

  assert.equal(validateResult(result).valid, true);
  for (const id of ISSUE_GATE_SELECTS) {
    assert.equal(statusOf(result, id), STATUS.PASS, `${id}: ${result.checks.find((c) => c.id === id).reason}`);
  }
  assert.equal(result.status, STATUS.PASS, result.checks.filter((c) => c.status !== STATUS.PASS).map((c) => `${c.id}: ${c.reason}`).join(' | '));
});

test('the issue gate records the branch and diff checks as NOT_RUN, with the motive', async () => {
  const root = issueShapedRepository('issue-gate-notrun');

  const { result } = await runPreflight({ cwd: root, policy: policyPath('gentle-ai'), gate: 'preflight-issue' });

  // Absent and NOT_RUN are different things. A check missing from the report
  // is indistinguishable from a check that passed, which is the whole reason
  // the unselected ones still appear.
  for (const id of ISSUE_GATE_OMITS) {
    const row = result.checks.find((check) => check.id === id);
    assert.ok(row !== undefined, `${id} must still appear in the report, not vanish from it`);
    assert.equal(row.status, STATUS.NOT_RUN, id);
    assert.match(row.reason, /not selected by policy gentle-ai@1 for gate preflight-issue/, id);
    assert.equal(row.required, false, `${id} must not be required in a gate that does not run it`);
  }
});

test('the issue gate keeps the citation check required: a finding is worth what its citations are worth', () => {
  const policy = loadPolicy(policyPath('gentle-ai'));
  const gate = policy.gates['preflight-issue'];

  const parity = gate.checks.find((check) => check.id === 'parity.declaration-source');
  assert.ok(parity !== undefined, 'the issue gate must verify the citations it will publish');
  assert.equal(parity.required, true);

  // And it is a scope change, not a waiver: nothing it does select is optional.
  for (const selection of gate.checks) {
    assert.equal(selection.required, true, `${selection.id} must be required; a gate of optional checks decides nothing`);
  }
  assert.deepEqual(gate.checks.map((check) => check.id).sort(), [...ISSUE_GATE_SELECTS].sort());
});

test('the same repository fails the publication gate: the issue gate is a different scope, not a lenient one', async () => {
  const root = issueShapedRepository('issue-gate-contrast');

  const { result } = await runPreflight({ cwd: root, policy: policyPath('gentle-ai'), gate: 'preflight' });

  // This is run 006 reproduced: measured through the publication gate, a
  // contribution that changes nothing cannot answer for a branch it never had.
  assert.notEqual(result.status, STATUS.PASS);
  assert.equal(statusOf(result, 'diff.within-review-budget'), STATUS.UNKNOWN);
});

test('the real gentle-ai policy runs against a repository shaped like the real one', async () => {
  // A clone with an upstream: the budget measures the publishable candidate
  // against the merge base, so a repository tracking nothing has no base to
  // measure from and is inconclusive rather than passing.
  const { root: origin } = repoWithCommit(gentleAiFixtureFiles(), 'policy-real-shape-origin');
  const root = cloneInto(origin, 'policy-real-shape');

  git(root, 'checkout', '-q', '-b', 'fix/999-example');
  git(root, 'branch', '--set-upstream-to=origin/main', 'fix/999-example');
  write(root, 'change.txt', 'one\ntwo\n');
  git(root, 'add', '-A');

  const { result } = await runPreflight({ cwd: root, policy: policyPath('gentle-ai'), gate: 'preflight' });

  assert.equal(validateResult(result).valid, true);
  for (const id of ['diff.within-review-budget', 'tooling.manifests-covered', 'git.branch-allowed', 'parity.declaration-source', 'parity.go-module-lockfile']) {
    assert.equal(statusOf(result, id), STATUS.PASS, `${id}: ${result.checks.find((c) => c.id === id).reason}`);
  }
});
