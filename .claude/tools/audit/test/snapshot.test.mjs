// Snapshot fixtures, every one of them a real Git repository.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { takeSnapshot, snapshotHash, snapshotIntact, HASH_EXCLUDED_FIELDS } from '../lib/snapshot.mjs';
import { validateSnapshot } from '../lib/validate.mjs';
import { STATUS } from '../lib/status.mjs';
import { git, initRepo, makeDirectory, write, remove, commit, repoWithCommit, repoWithUpstream, cloneInto, cleanupAll } from './helpers/repo.mjs';

after(cleanupAll);

/** Take a snapshot and assert it succeeded and satisfies the contract. */
function snapshotOf(root) {
  const outcome = takeSnapshot({ cwd: root });
  assert.equal(outcome.status, STATUS.PASS, `expected a snapshot, got ${outcome.status}: ${outcome.reason}`);

  const { valid, errors } = validateSnapshot(outcome.snapshot);
  assert.equal(valid, true, JSON.stringify(errors));
  assert.equal(snapshotIntact(outcome.snapshot), true, 'the recorded hash must match a re-derivation');

  return outcome.snapshot;
}

// -- fixture 1: clean repository --------------------------------------------

test('fixture: a clean repository reports clean, with no changes of any kind', () => {
  const { root, head } = repoWithCommit({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
  const snapshot = snapshotOf(root);

  assert.equal(snapshot.worktree.clean, true);
  assert.equal(snapshot.worktree.conflicted, false);
  assert.equal(snapshot.identity.head, head);
  assert.equal(snapshot.identity.headKind, 'commit');
  assert.equal(snapshot.identity.branch, 'main');
  assert.equal(snapshot.identity.detached, false);
  assert.equal(snapshot.identity.operation, 'none');
  assert.deepEqual(snapshot.changes, { staged: [], unstaged: [], untracked: [], unmerged: [] });
  assert.equal(snapshot.counts.tracked, 2);
});

// -- fixture 2: staged and unstaged simultaneously ---------------------------

test('fixture: staged and unstaged changes are reported separately, not collapsed', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });

  write(root, 'a.txt', 'alpha\nstaged\n');
  git(root, 'add', 'a.txt');
  write(root, 'b.txt', 'beta\nunstaged\n');

  const snapshot = snapshotOf(root);

  assert.deepEqual(snapshot.changes.staged, [{ path: 'a.txt', status: 'modified', from: null }]);
  assert.deepEqual(snapshot.changes.unstaged, [{ path: 'b.txt', status: 'modified', from: null }]);
  assert.equal(snapshot.worktree.clean, false);

  assert.equal(snapshot.diffstat.staged.base, 'HEAD');
  assert.equal(snapshot.diffstat.staged.baseOid, snapshot.identity.head);
  assert.deepEqual(
    { files: snapshot.diffstat.staged.files, additions: snapshot.diffstat.staged.additions, deletions: snapshot.diffstat.staged.deletions },
    { files: 1, additions: 1, deletions: 0 }
  );

  assert.equal(snapshot.diffstat.unstaged.base, 'index');
  assert.equal(snapshot.diffstat.unstaged.baseOid, null);
  assert.equal(snapshot.diffstat.unstaged.additions, 1);
});

test('fixture: one file staged and then modified again appears in both lists', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });

  write(root, 'a.txt', 'alpha\nstaged\n');
  git(root, 'add', 'a.txt');
  write(root, 'a.txt', 'alpha\nstaged\nthen more\n');

  const snapshot = snapshotOf(root);
  assert.deepEqual(snapshot.changes.staged, [{ path: 'a.txt', status: 'modified', from: null }]);
  assert.deepEqual(snapshot.changes.unstaged, [{ path: 'a.txt', status: 'modified', from: null }]);
});

// -- fixture 3: untracked ----------------------------------------------------

test('fixture: untracked files are their own category, including nested ones', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  write(root, 'new.txt', 'new\n');
  write(root, 'nested/deep/other.txt', 'other\n');

  const snapshot = snapshotOf(root);

  assert.deepEqual(snapshot.changes.untracked, ['nested/deep/other.txt', 'new.txt']);
  assert.deepEqual(snapshot.changes.staged, []);
  assert.deepEqual(snapshot.changes.unstaged, []);
  assert.equal(snapshot.worktree.clean, false, 'untracked files make a tree not clean');
});

test('fixture: an ignored file is not reported as untracked', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n', '.gitignore': 'secret.txt\n' });
  write(root, 'secret.txt', 'ignored\n');

  const snapshot = snapshotOf(root);
  assert.deepEqual(snapshot.changes.untracked, []);
  assert.equal(snapshot.worktree.clean, true);
});

// -- fixture 4: rename and delete --------------------------------------------

test('fixture: a staged rename records both the new and the original path', () => {
  const { root } = repoWithCommit({ 'old-name.txt': 'content that is long enough to be detected as a rename\n' });
  git(root, 'mv', 'old-name.txt', 'new-name.txt');

  const snapshot = snapshotOf(root);

  assert.equal(snapshot.changes.staged.length, 1);
  assert.deepEqual(snapshot.changes.staged[0], { path: 'new-name.txt', status: 'renamed', from: 'old-name.txt' });
  assert.deepEqual(snapshot.changes.unstaged, []);
});

test('fixture: a staged delete and an unstaged delete are distinguished', () => {
  const { root } = repoWithCommit({ 'staged-gone.txt': 'x\n', 'worktree-gone.txt': 'y\n', 'keep.txt': 'z\n' });

  git(root, 'rm', '-q', 'staged-gone.txt');
  remove(root, 'worktree-gone.txt');

  const snapshot = snapshotOf(root);

  assert.deepEqual(snapshot.changes.staged, [{ path: 'staged-gone.txt', status: 'deleted', from: null }]);
  assert.deepEqual(snapshot.changes.unstaged, [{ path: 'worktree-gone.txt', status: 'deleted', from: null }]);
  assert.equal(snapshot.diffstat.staged.deletions, 1);
});

test('fixture: a staged addition is "added", not "modified"', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  write(root, 'added.txt', 'brand new\n');
  git(root, 'add', 'added.txt');

  const snapshot = snapshotOf(root);
  assert.deepEqual(snapshot.changes.staged, [{ path: 'added.txt', status: 'added', from: null }]);
});

// -- fixture 5: merge conflict ------------------------------------------------

test('fixture: an unresolved conflict is reported as conflicted, with the operation in progress', () => {
  const { root } = repoWithCommit({ 'conflict.txt': 'base\n' });

  git(root, 'checkout', '-q', '-b', 'other');
  write(root, 'conflict.txt', 'from other\n');
  git(root, 'add', '-A');
  commit(root, 'other side');

  git(root, 'checkout', '-q', 'main');
  write(root, 'conflict.txt', 'from main\n');
  git(root, 'add', '-A');
  commit(root, 'main side');

  // The merge is expected to fail; that is the fixture.
  try { git(root, 'merge', 'other'); } catch { /* conflict is the point */ }

  const snapshot = snapshotOf(root);

  assert.equal(snapshot.worktree.conflicted, true);
  assert.equal(snapshot.worktree.clean, false);
  assert.equal(snapshot.changes.unmerged.length, 1);
  assert.equal(snapshot.changes.unmerged[0].path, 'conflict.txt');
  assert.equal(snapshot.identity.operation, 'merge');
});

// -- fixture 6: detached HEAD -------------------------------------------------

test('fixture: detached HEAD reports no branch and no upstream', () => {
  const { root, head } = repoWithCommit({ 'a.txt': 'alpha\n' });
  write(root, 'b.txt', 'beta\n');
  git(root, 'add', '-A');
  commit(root, 'second');
  git(root, 'checkout', '-q', head);

  const snapshot = snapshotOf(root);

  assert.equal(snapshot.identity.detached, true);
  assert.equal(snapshot.identity.branch, null);
  assert.equal(snapshot.identity.head, head);
  assert.equal(snapshot.identity.upstream, null);
  assert.equal(snapshot.identity.ahead, null);
  assert.equal(snapshot.identity.behind, null);
});

// -- fixture 7: upstream, and its absence -------------------------------------

test('fixture: a branch with no upstream reports null rather than zero', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  const snapshot = snapshotOf(root);

  assert.equal(snapshot.identity.upstream, null);
  assert.equal(snapshot.identity.ahead, null, 'no upstream means no comparison, not "0 ahead"');
  assert.equal(snapshot.identity.behind, null);
});

test('fixture: a tracking branch reports its upstream and a real ahead/behind', () => {
  const { origin, clone } = repoWithUpstream();

  // One commit only in the clone, one only in the origin: ahead 1, behind 1.
  write(clone, 'local.txt', 'local\n');
  git(clone, 'add', '-A');
  commit(clone, 'local commit');

  write(origin, 'remote.txt', 'remote\n');
  git(origin, 'add', '-A');
  commit(origin, 'remote commit');
  git(clone, 'fetch', '-q', 'origin');

  const snapshot = snapshotOf(clone);

  assert.equal(snapshot.identity.upstream, 'origin/main');
  assert.equal(snapshot.identity.ahead, 1);
  assert.equal(snapshot.identity.behind, 1);
});

// -- fixture 8: unborn HEAD ---------------------------------------------------

test('fixture: an unborn HEAD is described, not treated as a failure', () => {
  const root = initRepo();
  write(root, 'staged.txt', 'one\ntwo\n');
  git(root, 'add', '-A');

  const snapshot = snapshotOf(root);

  assert.equal(snapshot.identity.head, null);
  assert.equal(snapshot.identity.headKind, 'unborn');
  assert.equal(snapshot.identity.branch, 'main');
  assert.deepEqual(snapshot.changes.staged, [{ path: 'staged.txt', status: 'added', from: null }]);
  assert.equal(snapshot.diffstat.staged.baseOid, null, 'the base is the empty tree, which has no HEAD oid');
  assert.equal(snapshot.diffstat.staged.additions, 2);
});

// -- fixture 9: binary files --------------------------------------------------

test('fixture: binary files are counted apart, never folded into the line totals as zero', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 7]));
  git(root, 'add', 'blob.bin');

  const snapshot = snapshotOf(root);

  assert.equal(snapshot.diffstat.staged.files, 1);
  assert.equal(snapshot.diffstat.staged.binaryFiles, 1);
  assert.equal(snapshot.diffstat.staged.additions, 0, 'a binary file contributes no line count');
});

// -- fixture 10: paths with spaces --------------------------------------------

test('fixture: paths containing spaces survive the -z parsing intact', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  write(root, 'a file with spaces.txt', 'content\n');
  git(root, 'add', '-A');

  const snapshot = snapshotOf(root);
  assert.deepEqual(snapshot.changes.staged, [{ path: 'a file with spaces.txt', status: 'added', from: null }]);
});

// -- inventory ----------------------------------------------------------------

test('inventory records manifests, lockfiles and CI workflows by path, at any depth', () => {
  const { root } = repoWithCommit({
    'go.mod': 'module example\n',
    'go.sum': '\n',
    'services/api/package.json': '{}\n',
    'services/api/pnpm-lock.yaml': '\n',
    '.github/workflows/ci.yml': 'name: CI\n',
    '.github/workflows/release.yaml': 'name: Release\n',
    '.github/ISSUE_TEMPLATE.md': 'x\n',
    'docs/readme.md': 'x\n',
  });

  const snapshot = snapshotOf(root);

  assert.deepEqual(snapshot.inventory.manifests, ['go.mod', 'services/api/package.json']);
  assert.deepEqual(snapshot.inventory.lockfiles, ['go.sum', 'services/api/pnpm-lock.yaml']);
  assert.deepEqual(snapshot.inventory.ciWorkflows, ['.github/workflows/ci.yml', '.github/workflows/release.yaml']);
});

// -- determinism ---------------------------------------------------------------

test('determinism: two snapshots of an unchanged repository are byte-identical', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  write(root, 'b.txt', 'beta\n');
  git(root, 'add', 'b.txt');
  write(root, 'c.txt', 'untracked\n');

  const first = snapshotOf(root);
  const second = snapshotOf(root);

  assert.equal(first.hash, second.hash);
  assert.deepEqual(first, second);
});

test('determinism: two clones of the same state in different directories hash identically', () => {
  const { root: origin } = repoWithCommit({ 'a.txt': 'alpha\n', 'sub/b.txt': 'beta\n' }, 'twin-origin');
  const left = snapshotOf(cloneInto(origin, 'twin-left'));
  const right = snapshotOf(cloneInto(origin, 'twin-right'));

  assert.notEqual(left.root, right.root, 'the clones must really live in different directories');
  assert.equal(left.identity.head, right.identity.head);
  assert.equal(left.hash, right.hash);
});

test('determinism: identical working trees under different commits do NOT collide', () => {
  // The HEAD oid is state, not decoration. Two repositories whose working
  // trees are byte-identical but whose history differs are different states,
  // and the hash must say so.
  //
  // The difference is made through the commit message rather than through
  // timing: Git timestamps have one-second resolution, so two fixtures built
  // in the same second would otherwise produce the same oid.
  const build = (label, message) => {
    const root = initRepo(label);
    write(root, 'a.txt', 'alpha\n');
    git(root, 'add', '-A');
    commit(root, message);
    return snapshotOf(root);
  };

  const left = build('distinct-left', 'first phrasing');
  const right = build('distinct-right', 'second phrasing');

  assert.notEqual(left.identity.head, right.identity.head);
  assert.notEqual(left.hash, right.hash);
});

test('determinism: the excluded fields are exactly root, reader and hash', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  const snapshot = snapshotOf(root);

  assert.deepEqual([...HASH_EXCLUDED_FIELDS], ['root', 'reader', 'hash']);

  const moved = { ...snapshot, root: 'C:/elsewhere', reader: { gitVersion: 'git version 0.0.0' } };
  assert.equal(snapshotHash(moved), snapshot.hash, 'neither location nor reader may move the hash');
});

test('the hash changes when relevant state changes, and only then', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  const clean = snapshotOf(root).hash;

  write(root, 'untracked.txt', 'x\n');
  const withUntracked = snapshotOf(root).hash;
  assert.notEqual(withUntracked, clean, 'an untracked file is a state change');

  git(root, 'add', 'untracked.txt');
  const withStaged = snapshotOf(root).hash;
  assert.notEqual(withStaged, withUntracked, 'staging the same file is a different state');

  commit(root, 'second');
  const committed = snapshotOf(root).hash;
  assert.notEqual(committed, withStaged);
});

test('the hash covers the config that decides what counts as modified', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  const before = snapshotOf(root);

  git(root, 'config', 'core.autocrlf', before.config['core.autocrlf'] === 'true' ? 'false' : 'true');
  const after = snapshotOf(root);

  assert.notEqual(after.config['core.autocrlf'], before.config['core.autocrlf']);
  assert.notEqual(after.hash, before.hash);
});

// -- fail-closed ---------------------------------------------------------------

test('a directory that is not a repository yields UNKNOWN, never a clean snapshot', () => {
  const outcome = takeSnapshot({ cwd: makeDirectory('not-a-repo') });

  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.snapshot, null);
  assert.match(outcome.reason, /not inside a Git work tree/);
  assert.equal(outcome.evidence.length, 1);
});

test('a corrupted git directory yields UNKNOWN, never a clean snapshot', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  // Replace HEAD with a ref that points nowhere.
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/does-not-exist\n');
  writeFileSync(join(root, '.git', 'index'), Buffer.from([0, 0, 0, 0]));

  const outcome = takeSnapshot({ cwd: root });

  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.snapshot, null);
});

test('a nested working directory still resolves to the repository root', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  mkdirSync(join(root, 'deep', 'nested'), { recursive: true });

  const fromNested = takeSnapshot({ cwd: join(root, 'deep', 'nested') });
  assert.equal(fromNested.status, STATUS.PASS);
  assert.equal(fromNested.snapshot.hash, snapshotOf(root).hash);
});

test('every snapshot outcome carries evidence, whatever its status', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' });
  assert.ok(takeSnapshot({ cwd: root }).evidence.length >= 1);
  assert.ok(takeSnapshot({ cwd: makeDirectory('no-repo') }).evidence.length >= 1);
});
