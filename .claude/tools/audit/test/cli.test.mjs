// End-to-end tests over the real process boundary: exit codes, stdout/stderr
// separation, and the refusal to emit a contract-violating document.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { git, write, repoWithCommit, makeDirectory, FIXTURE_REPOSITORY, cleanupAll } from './helpers/repo.mjs';
import { discoverChecks } from '../lib/registry.mjs';

// Derived, never hardcoded: a count written by hand rots the moment a check
// file is added, and a rotted expectation is noise rather than a guard.
const CATALOGUE_SIZE = (await discoverChecks()).size;

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'audit.mjs');

const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

after(cleanupAll);

test('selftest maps every scenario to its documented exit code', () => {
  const expected = {
    pass: 0,
    fail: 1,
    unknown: 2,
    'not-run': 2,
    throw: 2,
    malformed: 2,
    empty: 2,
  };

  for (const [scenario, code] of Object.entries(expected)) {
    const out = run('selftest', '--scenario', scenario);
    assert.equal(out.status, code, `scenario "${scenario}" expected exit ${code}, got ${out.status}: ${out.stderr}`);
  }
});

test('selftest --all passes only when every expected inner outcome matches', () => {
  const out = run('selftest', '--all');
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(out.stdout);
  assert.equal(report.status, 'PASS');
  assert.equal(report.cases.every((entry) => entry.passed), true);
  assert.equal(report.cases.find((entry) => entry.scenario === 'fail').observed.status, 'FAIL');
  assert.equal(report.cases.find((entry) => entry.scenario === 'unknown').observed.status, 'UNKNOWN');
  assert.equal(report.cases.find((entry) => entry.scenario === 'not-run').observed.status, 'NOT_RUN');
  assert.deepEqual(
    report.cases.find((entry) => entry.scenario === 'timeout').observed,
    { kind: 'timeout', terminated: true, timeoutMs: 75 }
  );
  assert.match(out.stderr, /harness health: PASS/);
});

test('stdout carries only JSON and stderr only the human summary', () => {
  const out = run('selftest', '--scenario', 'pass');
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.status, 'PASS');
  assert.equal(parsed.gate, 'selftest');
  assert.match(out.stderr, /gate selftest: PASS/);
  assert.equal(out.stderr.trim().startsWith('{'), false);
});

test('stdout is canonical: keys sorted, one trailing newline', () => {
  const out = run('selftest', '--scenario', 'pass');
  const keys = Object.keys(JSON.parse(out.stdout));
  assert.deepEqual(keys, [...keys].sort(), 'top-level keys must be sorted');
  assert.equal(out.stdout.endsWith('}\n'), true);
});

test('two runs of the same scenario produce byte-identical stdout', () => {
  // startedAt/finishedAt are volatile by contract, so compare with them removed.
  const strip = (text) => {
    const parsed = JSON.parse(text);
    delete parsed.startedAt;
    delete parsed.finishedAt;
    for (const check of parsed.checks) delete check.durationMs;
    return JSON.stringify(parsed);
  };
  assert.equal(strip(run('selftest', '--scenario', 'pass').stdout), strip(run('selftest', '--scenario', 'pass').stdout));
});

test('an optional failing check does not stop the gate from passing', () => {
  const out = run('selftest', '--scenario', 'pass');
  const parsed = JSON.parse(out.stdout);
  const optional = parsed.checks.find((check) => check.required === false);
  assert.equal(optional.status, 'FAIL');
  assert.equal(parsed.status, 'PASS');
});

test('a throwing check exits inconclusive and reports a structured error', () => {
  const out = run('selftest', '--scenario', 'throw');
  assert.equal(out.status, 2);
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.status, 'UNKNOWN');
  assert.equal(parsed.errors[0].code, 'check.contract-violation');
});

test('a NOT_RUN required check exits inconclusive with its motive on record', () => {
  const out = run('selftest', '--scenario', 'not-run');
  assert.equal(out.status, 2);
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.status, 'NOT_RUN');
  assert.equal(parsed.checks[0].status, 'NOT_RUN');
  assert.match(parsed.checks[0].reason, /deliberately skipped/);
});

test('usage errors exit 3 and print the usage block', () => {
  assert.equal(run().status, 3);
  assert.equal(run('nonsense').status, 3);
  assert.equal(run('selftest').status, 3);
  assert.equal(run('selftest', '--scenario', 'banana').status, 3);
  assert.equal(run('selftest', '--all', '--scenario', 'pass').status, 3);
  assert.equal(run('validate').status, 3);
  assert.match(run('selftest', '--scenario', 'banana').stderr, /usage:/);
});

test('validate accepts a document the engine itself produced', () => {
  const directory = mkdtempSync(join(tmpdir(), 'audit-cli-'));
  try {
    const path = join(directory, 'result.json');
    writeFileSync(path, run('selftest', '--scenario', 'pass').stdout);

    const out = run('validate', '--input', path);
    assert.equal(out.status, 0);
    assert.equal(JSON.parse(out.stdout).valid, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('validate exits 4 on a contract violation and names it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'audit-cli-'));
  try {
    const path = join(directory, 'bad.json');
    const document = JSON.parse(run('selftest', '--scenario', 'pass').stdout);
    document.status = 'OK';
    writeFileSync(path, JSON.stringify(document));

    const out = run('validate', '--input', path);
    assert.equal(out.status, 4);
    assert.equal(JSON.parse(out.stdout).valid, false);
    assert.match(out.stderr, /expected one of/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('validate exits 3, not 4, when the input cannot be read at all', () => {
  const out = run('validate', '--input', join(tmpdir(), 'definitely-absent-audit-input.json'));
  assert.equal(out.status, 3);
});

// -- snapshot over the process boundary --------------------------------------

test('snapshot exits 0 inside a repository and emits a contract-valid document', () => {
  const { root, head } = repoWithCommit({ 'a.txt': 'alpha\n' });

  const out = run('snapshot', '--cwd', root);
  assert.equal(out.status, 0, out.stderr);

  const snapshot = JSON.parse(out.stdout);
  assert.equal(snapshot.snapshotVersion, '1.0.0');
  assert.equal(snapshot.identity.head, head);
  assert.match(snapshot.hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(out.stderr, /worktree {2}clean/);

  const directory = mkdtempSync(join(tmpdir(), 'audit-snap-'));
  try {
    const path = join(directory, 'snapshot.json');
    writeFileSync(path, out.stdout);
    const validated = run('validate', '--input', path, '--kind', 'snapshot');
    assert.equal(validated.status, 0, validated.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('snapshot exits 2 outside a repository and emits no snapshot at all', () => {
  const out = run('snapshot', '--cwd', makeDirectory('cli-no-repo'));

  assert.equal(out.status, 2);
  const payload = JSON.parse(out.stdout);
  assert.equal(payload.status, 'UNKNOWN');
  assert.equal(Object.hasOwn(payload, 'snapshot'), false, 'an absent snapshot must not be emitted as an empty one');
  assert.match(out.stderr, /snapshot UNKNOWN/);
});

test('snapshot stdout is canonical and stable across invocations', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  write(root, 'b.txt', 'beta\n');
  git(root, 'add', 'b.txt');

  const first = run('snapshot', '--cwd', root).stdout;
  const second = run('snapshot', '--cwd', root).stdout;

  assert.equal(first, second, 'two readings of unchanged state must be byte-identical');
  const keys = Object.keys(JSON.parse(first));
  assert.deepEqual(keys, [...keys].sort());
});

test('a validated snapshot is rejected when a field is tampered with', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  const directory = mkdtempSync(join(tmpdir(), 'audit-snap-'));
  try {
    const snapshot = JSON.parse(run('snapshot', '--cwd', root).stdout);
    snapshot.identity.operation = 'teleport';
    const path = join(directory, 'tampered.json');
    writeFileSync(path, JSON.stringify(snapshot));

    const out = run('validate', '--input', path, '--kind', 'snapshot');
    assert.equal(out.status, 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('snapshot refuses an unsupported --format instead of ignoring it', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  assert.equal(run('snapshot', '--cwd', root, '--format', 'yaml').status, 3);
});

// -- policy-driven checks over the process boundary ---------------------------

const POLICY_BASE = {
  policyVersion: '1.0.0',
  id: 'cli-policy',
  version: '1',
  repository: FIXTURE_REPOSITORY,
  gates: { preflight: { checks: [{ id: 'git.repository-readable', required: true }] } },
};

function policyOnDisk(document) {
  const directory = mkdtempSync(join(tmpdir(), 'audit-cli-policy-'));
  const path = join(directory, 'policy.json');
  writeFileSync(path, JSON.stringify(document));
  return { path, directory };
}

test('catalogue lists every check with its origin file', () => {
  const out = run('catalogue');
  assert.equal(out.status, 0);

  const { checks } = JSON.parse(out.stdout);
  assert.equal(checks.length, CATALOGUE_SIZE);
  assert.equal(checks.every((check) => typeof check.origin === 'string' && check.origin.endsWith('.mjs')), true);
  assert.ok(out.stderr.includes(`${CATALOGUE_SIZE} check(s) discovered`), out.stderr);
});

test('check exits 0 when the gate passes, and the report covers the whole catalogue', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'cli-check-pass');
  const { path, directory } = policyOnDisk(POLICY_BASE);
  try {
    const out = run('check', '--policy', path, '--gate', 'preflight', '--cwd', root);
    assert.equal(out.status, 0, out.stderr);

    const result = JSON.parse(out.stdout);
    assert.equal(result.status, 'PASS');
    assert.equal(result.checks.length, CATALOGUE_SIZE);
    assert.equal(result.summary.notRun, CATALOGUE_SIZE - 1);
    assert.match(out.stderr, /gate preflight: PASS/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('check exits 1 when a required check fails', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'cli-check-fail');
  const { path, directory } = policyOnDisk({
    ...POLICY_BASE,
    gates: { preflight: { checks: [
      { id: 'git.repository-readable', required: true },
      {
        id: 'git.branch-allowed',
        required: true,
        // Declared as ours, so the fixture does not need a tracked source file
        // for the rule to be established.
        with: { pattern: '^release\\/', source: 'REGLAS-APORTE.md', authority: 'ours' },
      },
    ] } },
  });
  try {
    const out = run('check', '--policy', path, '--gate', 'preflight', '--cwd', root);
    assert.equal(out.status, 1);
    assert.equal(JSON.parse(out.stdout).status, 'FAIL');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('check exits 2 when a required check does not run', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'cli-check-notrun');
  const { path, directory } = policyOnDisk({
    ...POLICY_BASE,
    gates: { preflight: { checks: [
      { id: 'git.repository-readable', required: true },
      { id: 'git.no-conflicts', required: true, skip: 'declared unavailable on this host' },
    ] } },
  });
  try {
    const out = run('check', '--policy', path, '--gate', 'preflight', '--cwd', root);
    assert.equal(out.status, 2);

    const result = JSON.parse(out.stdout);
    assert.equal(result.status, 'NOT_RUN');
    assert.equal(result.checks.find((c) => c.id === 'git.no-conflicts').reason, 'declared unavailable on this host');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a configuration error exits 3 and emits no result at all', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'cli-check-config');
  const cases = [
    { label: 'unknown check', document: { ...POLICY_BASE, gates: { preflight: { checks: [{ id: 'invented.check', required: true }] } } } },
    { label: 'incompatible version', document: { ...POLICY_BASE, policyVersion: '9.9.9' } },
    { label: 'unknown parameter', document: { ...POLICY_BASE, gates: { preflight: { checks: [{ id: 'git.no-conflicts', required: true, with: { nope: 1 } }] } } } },
    { label: 'missing required parameter', document: { ...POLICY_BASE, gates: { preflight: { checks: [{ id: 'diff.within-review-budget', required: true }] } } } },
  ];

  for (const { label, document } of cases) {
    const { path, directory } = policyOnDisk(document);
    try {
      const out = run('check', '--policy', path, '--gate', 'preflight', '--cwd', root);
      assert.equal(out.status, 3, `${label} must block as a configuration error`);
      assert.equal(out.stdout, '', `${label} must not emit a result document`);
      assert.match(out.stderr, /configuration error/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('an unknown gate exits 3 rather than running an empty gate', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'cli-check-gate');
  const { path, directory } = policyOnDisk(POLICY_BASE);
  try {
    const out = run('check', '--policy', path, '--gate', 'release', '--cwd', root);
    assert.equal(out.status, 3);
    assert.match(out.stderr, /defines no gate "release"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('check requires both --policy and --gate', () => {
  assert.equal(run('check').status, 3);
  assert.equal(run('check', '--policy', 'gentle-ai').status, 3);
});

test('the bundled policy validates through the CLI', () => {
  const out = run('validate', '--input', join(HERE, '..', 'policies', 'gentle-ai.json'), '--kind', 'policy');
  assert.equal(out.status, 0, out.stderr);
});
