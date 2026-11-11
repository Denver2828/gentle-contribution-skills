// The read-only claim, verified rather than asserted.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  runGit, resolveRoot, resolveGitDir, readStatus, readNumstat, readTrackedPaths,
  readRelevantConfig, readOperation, SAFE_SUBCOMMANDS,
  GitCommandError, GitUnexpectedOutputError,
} from '../lib/adapters/git.mjs';
import { takeSnapshot } from '../lib/snapshot.mjs';
import { STATUS } from '../lib/status.mjs';
import { git, write, commit, repoWithCommit, makeDirectory, cleanupAll } from './helpers/repo.mjs';

after(cleanupAll);

test('mutating subcommands are refused before anything is spawned', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });

  for (const argv of [['commit', '-m', 'x'], ['add', '.'], ['checkout', 'main'], ['clean', '-fd'], ['reset', '--hard'], ['push'], ['gc']]) {
    assert.throws(
      () => runGit(root, argv),
      /not on the read-only allowlist/,
      `git ${argv[0]} must be refused`
    );
  }
});

test('the allowlist contains only reading subcommands', () => {
  // `cat-file` is used solely as --batch-check and `merge-base` computes an
  // ancestor from existing history: both are reads. The list is pinned so a
  // writer cannot join it unnoticed.
  assert.deepEqual(
    [...SAFE_SUBCOMMANDS].sort(),
    ['cat-file', 'config', 'diff', 'ls-files', 'merge-base', 'rev-list', 'rev-parse', 'status', 'version']
  );
});

test('taking a snapshot does not rewrite the git index', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
  const indexPath = join(root, '.git', 'index');

  // Make the index look stale, which is exactly when `git status` would
  // normally refresh and rewrite it.
  write(root, 'a.txt', 'alpha changed\n');

  const before = statSync(indexPath);
  const gitDirBefore = readdirSync(join(root, '.git')).sort();

  const outcome = takeSnapshot({ cwd: root });
  assert.equal(outcome.status, STATUS.PASS);

  const after = statSync(indexPath);
  assert.equal(after.mtimeMs, before.mtimeMs, 'GIT_OPTIONAL_LOCKS=0 must keep status from rewriting the index');
  assert.equal(after.size, before.size);
  assert.deepEqual(readdirSync(join(root, '.git')).sort(), gitDirBefore, 'no new control files may appear');
});

test('taking a snapshot leaves the working tree byte-identical', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  write(root, 'untracked.txt', 'x\n');

  const fingerprint = () => readTrackedPaths(root)
    .concat(['untracked.txt'])
    .map((path) => {
      const stats = statSync(join(root, path));
      return `${path}:${stats.size}:${stats.mtimeMs}`;
    })
    .join('|');

  const before = fingerprint();
  takeSnapshot({ cwd: root });
  assert.equal(fingerprint(), before);
});

test('resolveRoot returns null outside a work tree instead of guessing', () => {
  assert.equal(resolveRoot(makeDirectory('outside')), null);
});

test('resolveGitDir returns an absolute path inside the repository', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  const gitDir = resolveGitDir(root);
  assert.equal(gitDir.replaceAll('\\', '/').endsWith('/.git'), true, gitDir);
});

test('readOperation reports none on a settled repository', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  assert.equal(readOperation(resolveGitDir(root)), 'none');
});

test('readRelevantConfig reads set keys and reports null for absent ones', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  git(root, 'config', 'core.filemode', 'false');

  const config = readRelevantConfig(root);
  assert.equal(config['core.filemode'], 'false');

  for (const key of ['core.autocrlf', 'core.filemode', 'core.ignorecase', 'core.symlinks']) {
    assert.equal(Object.hasOwn(config, key), true, `${key} must always be present in the record`);
    assert.equal(config[key] === null || typeof config[key] === 'string', true, `${key} must be a string or null`);
  }

  // The null branch is real: `git config --get` exits non-zero for an unset key,
  // and the adapter turns that into null rather than into an empty string.
  assert.notEqual(runGit(root, ['config', '--get', 'audit.definitely.unset'], { allowFailure: true }).code, 0);
});

test('a failing git command raises GitCommandError rather than returning empty output', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  assert.throws(() => runGit(root, ['rev-parse', '--verify', 'refs/heads/nope']), GitCommandError);
});

test('a broken index makes the status read throw, never return an empty change list', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  writeFileSync(join(root, '.git', 'index'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));

  assert.throws(() => readStatus(root), (error) =>
    error instanceof GitCommandError || error instanceof GitUnexpectedOutputError);
});

test('numstat totals match a diff computed independently by git', () => {
  const { root } = repoWithCommit({ 'a.txt': 'one\ntwo\nthree\n' });
  write(root, 'a.txt', 'one\ntwo\nthree\nfour\nfive\n');
  git(root, 'add', 'a.txt');

  const totals = readNumstat(root, { cached: true });
  const reference = git(root, 'diff', '--cached', '--numstat').trim().split('\t');

  assert.equal(totals.files, 1);
  assert.equal(totals.additions, Number(reference[0]));
  assert.equal(totals.deletions, Number(reference[1]));
});

test('a concurrent change during the reading yields UNKNOWN, never a snapshot', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });

  const outcome = takeSnapshot({
    cwd: root,
    betweenReadings: () => write(root, 'appeared-mid-read.txt', 'x\n'),
  });

  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.snapshot, null);
  assert.match(outcome.reason, /changed while it was being read/);
  assert.equal(outcome.evidence[0].observed.firstReading !== outcome.evidence[0].observed.secondReading, true);
});

test('a change that lands and reverts between readings is not detected, and that limit is real', () => {
  // Documented residual race: the double read narrows the window, it does not
  // close it. This test pins the known limitation so it cannot be mistaken for
  // a guarantee later.
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });

  const outcome = takeSnapshot({
    cwd: root,
    betweenReadings: () => {
      write(root, 'transient.txt', 'x');
      git(root, 'status', '--porcelain'); // force the change to be observable
      rmSync(join(root, 'transient.txt'));
    },
  });

  assert.equal(outcome.status, STATUS.PASS, 'the reverted change is invisible to a two-point comparison');
});

test('a commit landing between readings is detected', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });

  const outcome = takeSnapshot({
    cwd: root,
    betweenReadings: () => {
      write(root, 'second.txt', 'x\n');
      git(root, 'add', '-A');
      commit(root, 'landed mid-read');
    },
  });

  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.match(outcome.reason, /changed while it was being read/);
});
