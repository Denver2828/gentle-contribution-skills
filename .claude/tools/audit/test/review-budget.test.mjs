// The review budget measures the publishable candidate.
//
// It used to measure `git diff --cached` -- the index against HEAD -- which on
// a clean tree is zero however large the contribution is. Every fixture here
// exists to pin the difference between those two questions, and the last one
// pins the exact case that exposed it: a withdrawn branch carrying 355 changed
// lines that the old check reported as 0.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadCheckModules } from './helpers/checks.mjs';
import { takeSnapshot } from '../lib/snapshot.mjs';
import { readTrackedPaths, readTrackedCount, resolveMergeBase } from '../lib/adapters/git.mjs';
import { STATUS } from '../lib/status.mjs';
import { git, write, remove, commit, repoWithCommit, repoWithUpstream, cloneInto, cleanupAll } from './helpers/repo.mjs';

after(cleanupAll);

const ADAPTERS = { readTrackedPaths, readTrackedCount };
const LIMIT = { limit: 400 };

let catalogue;
before(async () => { catalogue = await loadCheckModules(); });

/** Take a snapshot and evaluate the budget check over it. */
function budget(root, params = LIMIT) {
  const outcome = takeSnapshot({ cwd: root });
  assert.equal(outcome.status, STATUS.PASS, outcome.reason);
  return {
    snapshot: outcome.snapshot,
    verdict: catalogue.get('diff.within-review-budget').evaluate({
      snapshot: outcome.snapshot, snapshotOutcome: outcome, params, tooling: { commands: [] }, adapters: ADAPTERS,
    }),
  };
}

/** A clone that tracks an upstream, ready to receive a contribution. */
function contributionClone(label) {
  const { origin, clone } = repoWithUpstream(label);
  return { origin, clone };
}

const lines = (prefix, count) => `${Array.from({ length: count }, (_, index) => `${prefix}-${index}`).join('\n')}\n`;

// -- what is measured -----------------------------------------------------------------

test('FIXTURE committed only: a contribution in a commit is measured, not reported as zero', () => {
  const { clone } = contributionClone('budget-committed');
  write(clone, 'feature.txt', lines('new', 40));
  git(clone, 'add', '-A');
  commit(clone, 'the whole contribution, committed');

  const { snapshot, verdict } = budget(clone);

  assert.equal(snapshot.worktree.clean, true, 'the tree is clean, which is exactly when the old check said zero');
  assert.equal(snapshot.diffstat.staged.additions + snapshot.diffstat.staged.deletions, 0, 'index against HEAD really is zero here');
  assert.equal(snapshot.diffstat.candidate.additions, 40, 'and the candidate is not');
  assert.equal(verdict.status, STATUS.PASS);
  assert.match(verdict.reason, /40 lines \(\+40\/-0\)/);
  assert.equal(verdict.evidence[0].observed.stagedAgainstHead, 0, 'the old measurement is recorded beside the new one');
});

test('FIXTURE staged only: an uncommitted contribution is measured', () => {
  const { clone } = contributionClone('budget-staged');
  write(clone, 'feature.txt', lines('new', 12));
  git(clone, 'add', '-A');

  const { snapshot, verdict } = budget(clone);

  assert.equal(snapshot.diffstat.candidate.additions, 12);
  assert.equal(verdict.status, STATUS.PASS);
});

test('FIXTURE commits plus staged: both halves are counted once', () => {
  const { clone } = contributionClone('budget-both');
  write(clone, 'committed.txt', lines('c', 30));
  git(clone, 'add', '-A');
  commit(clone, 'first half');

  write(clone, 'staged.txt', lines('s', 20));
  git(clone, 'add', '-A');

  const { snapshot, verdict } = budget(clone);

  assert.equal(snapshot.diffstat.candidate.additions, 50, '30 committed plus 20 staged');
  assert.equal(snapshot.diffstat.candidate.files, 2);
  assert.equal(snapshot.diffstat.staged.additions, 20, 'the index alone would have seen only half');
  assert.equal(verdict.status, STATUS.PASS);
});

test('FIXTURE no changes: an untouched branch measures zero, and that zero is real', () => {
  const { clone } = contributionClone('budget-empty');
  const { snapshot, verdict } = budget(clone);

  assert.equal(snapshot.diffstat.candidate.additions, 0);
  assert.equal(snapshot.diffstat.candidate.files, 0);
  assert.equal(verdict.status, STATUS.PASS);
  assert.match(verdict.reason, /0 lines/);
});

// -- the branch's position relative to the upstream -------------------------------------

test('FIXTURE behind and ahead: the base is the merge point, so upstream commits are not counted', () => {
  const { origin, clone } = contributionClone('budget-diverged');

  // The clone contributes; the origin moves on independently.
  write(clone, 'mine.txt', lines('mine', 25));
  git(clone, 'add', '-A');
  commit(clone, 'my contribution');

  write(origin, 'theirs.txt', lines('theirs', 500));
  git(origin, 'add', '-A');
  commit(origin, 'a large upstream change that is not mine');
  git(clone, 'fetch', '-q', 'origin');

  const { snapshot, verdict } = budget(clone);

  assert.equal(snapshot.identity.ahead, 1);
  assert.equal(snapshot.identity.behind, 1);
  assert.equal(snapshot.diffstat.candidate.additions, 25, 'only my 25 lines; the upstream 500 are not my contribution');
  assert.equal(verdict.status, STATUS.PASS);
});

test('FIXTURE behind only: a branch that contributed nothing measures zero even when far behind', () => {
  const { origin, clone } = contributionClone('budget-behind');

  write(origin, 'theirs.txt', lines('theirs', 800));
  git(origin, 'add', '-A');
  commit(origin, 'upstream moves');
  git(clone, 'fetch', '-q', 'origin');

  const { snapshot, verdict } = budget(clone);

  assert.equal(snapshot.identity.behind, 1);
  assert.equal(snapshot.diffstat.candidate.additions, 0);
  assert.equal(verdict.status, STATUS.PASS);
});

// -- when it cannot be measured ------------------------------------------------------------

test('FIXTURE no upstream: the check is UNKNOWN, and never falls back to the index', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'budget-no-upstream');
  write(root, 'feature.txt', lines('new', 10));
  git(root, 'add', '-A');

  const { snapshot, verdict } = budget(root);

  assert.equal(snapshot.identity.upstream, null);
  assert.equal(snapshot.identity.mergeBase, null);
  assert.equal(snapshot.diffstat.candidate, null);
  assert.match(snapshot.diffstat.candidateUnavailable, /tracks no upstream/);

  assert.equal(verdict.status, STATUS.UNKNOWN, 'and it does NOT report the 10 staged lines as if they were the candidate');
  assert.match(verdict.reason, /cannot be measured/);
});

test('FIXTURE unresolvable merge base: unrelated histories yield UNKNOWN', () => {
  const { origin, clone } = contributionClone('budget-unrelated');

  // An orphan branch shares no ancestor with the upstream at all.
  git(clone, 'checkout', '-q', '--orphan', 'orphan-branch');
  write(clone, 'only-here.txt', lines('x', 5));
  git(clone, 'add', '-A');
  commit(clone, 'an unrelated history');
  git(clone, 'branch', '--set-upstream-to=origin/main', 'orphan-branch');

  const { snapshot, verdict } = budget(clone);

  assert.equal(snapshot.identity.upstream, 'origin/main');
  assert.equal(snapshot.identity.mergeBase, null, 'there is no common ancestor');
  assert.equal(snapshot.diffstat.candidate, null);
  assert.match(snapshot.diffstat.candidateUnavailable, /no merge base could be resolved/);
  assert.equal(verdict.status, STATUS.UNKNOWN);
  assert.notEqual(origin, null);
});

// -- shapes of change ------------------------------------------------------------------------

test('FIXTURE rename and delete: both are counted in the candidate', () => {
  // The base state lands in the ORIGIN, so the merge base really is upstream
  // of the change rather than part of it.
  const { origin, clone } = contributionClone('budget-rename-delete');
  write(origin, 'to-rename.txt', lines('body', 20));
  write(origin, 'to-delete.txt', lines('gone', 15));
  git(origin, 'add', '-A');
  commit(origin, 'set up the files upstream of the change');
  git(clone, 'fetch', '-q', 'origin');
  git(clone, 'reset', '--hard', 'origin/main');

  git(clone, 'mv', 'to-rename.txt', 'renamed.txt');
  git(clone, 'rm', '-q', 'to-delete.txt');
  commit(clone, 'rename one file and delete another');

  const { snapshot, verdict } = budget(clone);

  assert.equal(snapshot.diffstat.candidate.deletions, 15, 'the deleted file contributes its lines');
  assert.equal(snapshot.diffstat.candidate.files >= 1, true);
  assert.equal(verdict.status, STATUS.PASS);
});

test('FIXTURE binary: a binary file makes the total incomplete, so the budget is UNKNOWN', () => {
  const { clone } = contributionClone('budget-binary');
  writeFileSync(join(clone, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 7]));
  git(clone, 'add', '-A');
  commit(clone, 'add a binary');

  const { snapshot, verdict } = budget(clone);

  assert.equal(snapshot.diffstat.candidate.binaryFiles, 1);
  assert.equal(verdict.status, STATUS.UNKNOWN);
  assert.match(verdict.reason, /carry no line counts/);
});

// -- the budget itself -------------------------------------------------------------------------

test('a candidate over the limit fails, naming the measured number', () => {
  const { clone } = contributionClone('budget-over');
  write(clone, 'big.txt', lines('line', 500));
  git(clone, 'add', '-A');
  commit(clone, 'a large contribution');

  const { verdict } = budget(clone, { limit: 400 });

  assert.equal(verdict.status, STATUS.FAIL);
  assert.match(verdict.reason, /500 lines \(\+500\/-0\)/);
  assert.match(verdict.reason, /over the 400-line budget/);
});

// -- the case that exposed the defect --------------------------------------------------------------

test('REGRESSION: the withdrawn branch shape measures 355 lines, not 0', () => {
  // fix/1868-engram-registry-rebased carried ONE commit of 10 files,
  // +265/-90 = 355 changed lines, on a clean working tree. The old check
  // measured the index against HEAD, saw 0, and would have passed a 400-line
  // budget while reporting nothing about the actual contribution.
  const { origin, clone } = contributionClone('budget-withdrawn-shape');

  // Ten files of nine lines each land UPSTREAM of the change: 90 lines to remove.
  for (let file = 0; file < 10; file += 1) write(origin, `file-${file}.go`, lines('old', 9));
  git(origin, 'add', '-A');
  commit(origin, 'the state the contribution starts from');
  git(clone, 'fetch', '-q', 'origin');
  git(clone, 'reset', '--hard', 'origin/main');

  // One commit rewrites all ten: 265 lines added, 90 removed.
  write(clone, 'file-0.go', lines('new', 31));
  for (let file = 1; file < 10; file += 1) write(clone, `file-${file}.go`, lines('new', 26));
  git(clone, 'add', '-A');
  commit(clone, 'fix(engram): register Claude Code Engram MCP in ~/.claude.json');

  const { snapshot, verdict } = budget(clone, { limit: 400 });

  // The exact shape of the withdrawn branch.
  assert.equal(snapshot.worktree.clean, true, 'clean tree, one commit, exactly as the branch stood');
  assert.equal(snapshot.identity.ahead, 1);
  assert.equal(snapshot.diffstat.candidate.files, 10);
  assert.equal(snapshot.diffstat.candidate.additions, 265);
  assert.equal(snapshot.diffstat.candidate.deletions, 90);

  const total = snapshot.diffstat.candidate.additions + snapshot.diffstat.candidate.deletions;
  assert.equal(total, 355, 'the publishable candidate is 355 lines');

  // What the old check would have seen, recorded so the difference is visible.
  assert.equal(snapshot.diffstat.staged.additions + snapshot.diffstat.staged.deletions, 0);
  assert.equal(verdict.evidence[0].observed.stagedAgainstHead, 0);
  assert.equal(verdict.evidence[0].observed.total, 355);

  assert.equal(verdict.status, STATUS.PASS, 'still within 400, but now for a measured reason');
  assert.match(verdict.reason, /355 lines \(\+265\/-90\) across 10 file\(s\)/);

  // And under the budget the branch would actually have been held to, it fails.
  const strict = catalogue.get('diff.within-review-budget').evaluate({
    snapshot, snapshotOutcome: { snapshot }, params: { limit: 300 }, tooling: { commands: [] }, adapters: ADAPTERS,
  });
  assert.equal(strict.status, STATUS.FAIL, '355 lines is over a 300-line budget, which 0 never would have been');
});

test('the merge base the candidate is measured from is the one git reports', () => {
  const { clone } = contributionClone('budget-base-oid');
  write(clone, 'mine.txt', lines('mine', 5));
  git(clone, 'add', '-A');
  commit(clone, 'contribution');

  const { snapshot } = budget(clone);
  assert.equal(snapshot.diffstat.candidate.baseOid, resolveMergeBase(clone, 'origin/main'));
  assert.equal(snapshot.identity.mergeBase, snapshot.diffstat.candidate.baseOid);
});
