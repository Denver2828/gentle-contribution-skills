// Candidate identity: what makes two candidates the same, and what does not.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join, relative } from 'node:path';

import { identifyCandidate, candidateStillHolds } from '../lib/candidate.mjs';
import { readIndexEntries, verifyObjects, ConflictedIndexError, SAFE_SUBCOMMANDS } from '../lib/adapters/git.mjs';
import { takeSnapshot } from '../lib/snapshot.mjs';
import { STATUS } from '../lib/status.mjs';
import { git, write, remove, commit, repoWithCommit, initRepo, cleanupAll } from './helpers/repo.mjs';

after(cleanupAll);

const POLICY_HASH = `sha256:${'a'.repeat(64)}`;
const TOOL_VERSION = '0.1.0';

/** Identify the candidate currently in `root`. */
function identify(root, options = {}) {
  const outcome = takeSnapshot({ cwd: root });
  assert.equal(outcome.status, STATUS.PASS, outcome.reason);
  return identifyCandidate({
    snapshot: outcome.snapshot,
    policyHash: options.policyHash ?? POLICY_HASH,
    toolVersion: options.toolVersion ?? TOOL_VERSION,
    artifacts: options.artifacts,
  });
}

const idOf = (root, options) => {
  const outcome = identify(root, options);
  assert.equal(outcome.status, STATUS.PASS, outcome.reason);
  return outcome.candidateId;
};

// -- reading the index ------------------------------------------------------------

test('the index is read with a read-only command, and no writer is on the allowlist', () => {
  for (const writer of ['hash-object', 'write-tree', 'commit-tree', 'update-ref', 'update-index', 'add', 'commit', 'mktree']) {
    assert.equal(SAFE_SUBCOMMANDS.has(writer), false, `"${writer}" must never be on the allowlist`);
  }
  assert.equal(SAFE_SUBCOMMANDS.has('ls-files'), true);
  assert.equal(SAFE_SUBCOMMANDS.has('cat-file'), true, 'cat-file --batch-check reports on objects and creates none');
});

test('every index entry carries mode, object, stage and path', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n', 'sub/b.txt': 'beta\n' }, 'candidate-entries');
  const entries = readIndexEntries(root);

  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.match(entry.mode, /^[0-7]{6}$/);
    assert.match(entry.blobSha, /^[0-9a-f]{40,64}$/);
    assert.equal(entry.stage, 0);
    assert.equal(typeof entry.path, 'string');
  }
  assert.deepEqual(entries.map((entry) => entry.path), ['a.txt', 'sub/b.txt'], 'sorted canonically by path');
});

test('the objects the index names already exist, because git add wrote them', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'candidate-objects');
  const entries = readIndexEntries(root);
  const verified = verifyObjects(root, entries.map((entry) => entry.blobSha));

  assert.equal(verified.get(entries[0].blobSha).present, true);
  assert.equal(verified.get(entries[0].blobSha).type, 'blob');
});

// -- what makes two candidates the same -------------------------------------------

test('the same state identifies the same candidate, twice', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'candidate-stable');
  const first = idOf(root);

  assert.equal(first, idOf(root));
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(candidateStillHolds(first, identify(root)), true);
});

// -- what makes them different -----------------------------------------------------

test('FIXTURE another commit: the same content under a different HEAD is a different candidate', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'candidate-head');
  const before = idOf(root);

  // An empty commit moves HEAD without touching the index at all.
  git(root, 'commit', '-q', '--allow-empty', '-m', 'moves HEAD only');

  assert.deepEqual(readIndexEntries(root).map((e) => e.blobSha), readIndexEntries(root).map((e) => e.blobSha));
  assert.notEqual(idOf(root), before, 'the commit is part of the identity');
  assert.equal(candidateStillHolds(before, identify(root)), false);
});

test('FIXTURE same content, different identity: the same bytes under another path are a different candidate', () => {
  const { root: left } = repoWithCommit({ 'name-one.txt': 'identical bytes\n' }, 'candidate-path-left');
  const { root: right } = repoWithCommit({ 'name-two.txt': 'identical bytes\n' }, 'candidate-path-right');

  assert.equal(
    readIndexEntries(left)[0].blobSha,
    readIndexEntries(right)[0].blobSha,
    'git stores identical bytes as one object, so the blob really is shared'
  );
  assert.notEqual(idOf(left), idOf(right), 'and the path still distinguishes the candidates');
});

test('FIXTURE executable mode: the same bytes staged executable are a different candidate', () => {
  const { root } = repoWithCommit({ 'script.sh': '#!/bin/sh\necho hi\n' }, 'candidate-mode');
  const before = idOf(root);
  const beforeSha = readIndexEntries(root)[0].blobSha;

  // --chmod stages a mode change without touching the bytes.
  git(root, 'update-index', '--chmod=+x', 'script.sh');
  const after = readIndexEntries(root)[0];

  assert.equal(after.blobSha, beforeSha, 'the bytes did not move');
  assert.equal(after.mode, '100755');
  assert.notEqual(idOf(root), before, 'the mode is part of the identity');
});

test('FIXTURE restaging other bytes: a modified staged file is a different candidate', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'candidate-restage');
  const before = idOf(root);

  write(root, 'a.txt', 'alpha\nplus one line\n');
  git(root, 'add', 'a.txt');

  assert.notEqual(idOf(root), before);
});

test('FIXTURE rename: staging a rename changes the candidate', () => {
  const { root } = repoWithCommit({ 'old.txt': 'a body long enough for rename detection\n' }, 'candidate-rename');
  const before = idOf(root);

  git(root, 'mv', 'old.txt', 'new.txt');

  const entries = readIndexEntries(root);
  assert.deepEqual(entries.map((entry) => entry.path), ['new.txt']);
  assert.notEqual(idOf(root), before);
});

test('FIXTURE delete: staging a delete changes the candidate', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' }, 'candidate-delete');
  const before = idOf(root);

  git(root, 'rm', '-q', 'b.txt');

  assert.deepEqual(readIndexEntries(root).map((entry) => entry.path), ['a.txt']);
  assert.notEqual(idOf(root), before);
});

test('FIXTURE paths with spaces survive the -z parsing and bind normally', () => {
  const { root } = repoWithCommit({ 'a file with spaces.txt': 'x\n', 'a.txt': 'y\n' }, 'candidate-spaces');
  const entries = readIndexEntries(root);

  assert.deepEqual(entries.map((entry) => entry.path), ['a file with spaces.txt', 'a.txt']);
  assert.match(idOf(root), /^sha256:/);
});

test('FIXTURE different snapshot: an untracked file changes the snapshot and the candidate', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'candidate-snapshot');
  const before = idOf(root);

  write(root, 'untracked.txt', 'x\n');

  assert.deepEqual(readIndexEntries(root).map((entry) => entry.path), ['a.txt'], 'the index did not move');
  assert.notEqual(idOf(root), before, 'but the snapshot did, and it is part of the identity');
});

test('FIXTURE different policy and different tool version each change the candidate', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'candidate-policy');
  const base = idOf(root);

  assert.notEqual(idOf(root, { policyHash: `sha256:${'b'.repeat(64)}` }), base);
  assert.notEqual(idOf(root, { toolVersion: '0.2.0' }), base);
});

// -- artifacts -----------------------------------------------------------------------

test('FIXTURE altered artifact: changing a declared artifact changes the candidate', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n', 'dist/app.bin': 'BUILD-1\n' }, 'candidate-artifact');
  const before = idOf(root, { artifacts: ['dist/app.bin'] });

  write(root, 'dist/app.bin', 'BUILD-2\n');
  const after = idOf(root, { artifacts: ['dist/app.bin'] });

  assert.notEqual(after, before);
});

test('declaring an artifact at all changes the candidate, and the order of declaration does not', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n', 'one.bin': '1\n', 'two.bin': '2\n' }, 'candidate-artifact-order');

  assert.notEqual(idOf(root, { artifacts: ['one.bin'] }), idOf(root));
  assert.equal(
    idOf(root, { artifacts: ['one.bin', 'two.bin'] }),
    idOf(root, { artifacts: ['two.bin', 'one.bin'] }),
    'artifacts are ordered canonically before hashing'
  );
});

test('FIXTURE incomplete evidence: a declared artifact that cannot be read yields UNKNOWN', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'candidate-artifact-missing');
  const outcome = identify(root, { artifacts: ['dist/never-built.bin'] });

  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.candidateId, null);
  assert.match(outcome.reason, /could not be read/);
});

test('an artifact path outside the repository is refused', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'candidate-artifact-escape');
  assert.equal(identify(root, { artifacts: ['../outside.bin'] }).status, STATUS.UNKNOWN);
});

// -- the blocking cases ----------------------------------------------------------------

test('FIXTURE conflicts: an index with unmerged entries yields UNKNOWN, never an id', () => {
  const { root } = repoWithCommit({ 'conflict.txt': 'base\n' }, 'candidate-conflict');

  git(root, 'checkout', '-q', '-b', 'other');
  write(root, 'conflict.txt', 'from other\n');
  git(root, 'add', '-A');
  commit(root, 'other side');

  git(root, 'checkout', '-q', 'main');
  write(root, 'conflict.txt', 'from main\n');
  git(root, 'add', '-A');
  commit(root, 'main side');

  try { git(root, 'merge', 'other'); } catch { /* the conflict is the fixture */ }

  assert.throws(() => readIndexEntries(root), ConflictedIndexError);

  const outcome = identifyCandidate({
    snapshot: takeSnapshot({ cwd: root }).snapshot,
    policyHash: POLICY_HASH,
    toolVersion: TOOL_VERSION,
  });
  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.candidateId, null);
  assert.match(outcome.reason, /describes no single candidate/);
  assert.deepEqual(outcome.evidence[0].observed.unmergedPaths, ['conflict.txt']);
});

test('FIXTURE empty index: nothing staged yields UNKNOWN, because nothing can be authorised', () => {
  const root = initRepo('candidate-empty');
  const outcome = identify(root);

  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.candidateId, null);
  assert.match(outcome.reason, /no entry/);
});

test('an object the repository can no longer produce yields UNKNOWN', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'candidate-missing-object');
  const entries = readIndexEntries(root);

  // Ask about an object that was never written.
  const invented = 'f'.repeat(entries[0].blobSha.length);
  assert.equal(verifyObjects(root, [invented]).get(invented).present, false);
});

test('no snapshot means no candidate', () => {
  const outcome = identifyCandidate({ snapshot: null, policyHash: POLICY_HASH, toolVersion: TOOL_VERSION });
  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.candidateId, null);
});

// -- the identity is not storage --------------------------------------------------------

test('the evidence says, in writing, that this is not a recoverable snapshot', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'candidate-scope');
  const outcome = identify(root);

  assert.match(outcome.evidence[0].observed.scope, /not a recoverable snapshot and not storage/);
});

// -- nothing is written -------------------------------------------------------------------

function fingerprint(root) {
  const hash = createHash('sha256');
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) { hash.update(`D ${relative(root, absolute)}\n`); walk(absolute); continue; }
      if (!entry.isFile()) continue;
      hash.update(`F ${relative(root, absolute)} ${statSync(absolute).size} ${statSync(absolute).mode}\n`);
      hash.update(readFileSync(absolute));
    }
  };
  walk(root);
  return hash.digest('hex');
}

test('identifying a candidate writes nothing: not .git, not the index, not the worktree', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n', 'dist/app.bin': 'BUILD\n' }, 'candidate-readonly');
  write(root, 'staged.txt', 'x\n');
  git(root, 'add', 'staged.txt');
  write(root, 'untracked.txt', 'y\n');

  const beforeObjects = readdirSync(join(root, '.git', 'objects')).sort();
  const beforeIndex = statSync(join(root, '.git', 'index'));
  const beforeHead = readFileSync(join(root, '.git', 'HEAD'), 'utf8');
  const beforeRefs = git(root, 'rev-parse', 'HEAD').trim();
  const beforeConfig = readFileSync(join(root, '.git', 'config'), 'utf8');
  const before = fingerprint(root);

  idOf(root, { artifacts: ['dist/app.bin'] });

  assert.equal(fingerprint(root), before, 'the whole repository must be byte-identical');
  assert.deepEqual(readdirSync(join(root, '.git', 'objects')).sort(), beforeObjects, 'no object may appear');
  assert.equal(statSync(join(root, '.git', 'index')).mtimeMs, beforeIndex.mtimeMs, 'the index must not be rewritten');
  assert.equal(statSync(join(root, '.git', 'index')).size, beforeIndex.size);
  assert.equal(readFileSync(join(root, '.git', 'HEAD'), 'utf8'), beforeHead, 'HEAD must not move');
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), beforeRefs, 'refs must not move');
  assert.equal(readFileSync(join(root, '.git', 'config'), 'utf8'), beforeConfig, 'configuration must not change');
});

test('the fingerprint would notice a single new object, so the test above is not vacuous', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'candidate-sensitivity');

  // Stage something new, so the tree about to be written does not already
  // exist from the commit -- otherwise write-tree is a no-op and the test
  // would pass for the wrong reason.
  write(root, 'newly-staged.txt', 'x\n');
  git(root, 'add', 'newly-staged.txt');

  const before = fingerprint(root);
  const objectsBefore = readdirSync(join(root, '.git', 'objects')).length;

  // Written by the fixture on purpose -- the adapter has no way to do this.
  git(root, 'write-tree');

  assert.notEqual(fingerprint(root), before, 'writing a tree object must move the fingerprint');
  assert.notEqual(readdirSync(join(root, '.git', 'objects')).length, objectsBefore, 'and it really did create an object');
});
