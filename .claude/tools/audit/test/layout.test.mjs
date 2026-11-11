// Repository layouts this snapshot does not cover, and the encoding boundary.
//
// Both are the same rule seen twice: a reading that does not describe the
// whole repository, or that describes it with altered names, must not be
// reported as a snapshot.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';

import { takeSnapshot } from '../lib/snapshot.mjs';
import { decodeGitOutput, readLayout, GitUndecodableOutputError } from '../lib/adapters/git.mjs';
import { STATUS } from '../lib/status.mjs';
import { git, write, commit, repoWithCommit, addSubmodule, addWorktree, makeDirectory, cleanupAll } from './helpers/repo.mjs';

after(cleanupAll);

// -- submodules ---------------------------------------------------------------

test('a repository with a submodule yields UNKNOWN, with the gitlink named', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'with-submodule');
  addSubmodule(root, 'vendor/inner');

  const outcome = takeSnapshot({ cwd: root });

  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.snapshot, null);
  assert.match(outcome.reason, /submodule gitlink\(s\) present/);
  assert.match(outcome.reason, /vendor\/inner/);
  assert.deepEqual(outcome.evidence[0].observed.submodulePaths, ['vendor/inner']);
  assert.equal(outcome.evidence[0].observed.submodules, 1);
});

test('the submodule remains detected after it is committed', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'committed-submodule');
  addSubmodule(root, 'vendor/inner');
  commit(root, 'add submodule');

  const outcome = takeSnapshot({ cwd: root });
  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.evidence[0].observed.submodules, 1);
});

test('a tracked .gitmodules with no live gitlink still blocks, and says why', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'stale-gitmodules');
  write(root, '.gitmodules', '[submodule "gone"]\n\tpath = gone\n\turl = ../gone\n');
  git(root, 'add', '.gitmodules');
  commit(root, 'declare a submodule without adding it');

  const outcome = takeSnapshot({ cwd: root });

  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.match(outcome.reason, /stale is a judgement rather than an observation/);
  assert.equal(outcome.evidence[0].observed.hasGitmodules, true);
});

test('readLayout finds no submodule in a plain repository', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'plain-layout');
  const layout = readLayout(root);

  assert.deepEqual(layout.submodulePaths, []);
  assert.equal(layout.hasGitmodules, false);
});

// -- linked worktrees ---------------------------------------------------------

// A sibling worktree was refused for as long as its state went unread, and the
// refusal was never about the layout: it was about the omission. Reading each
// registration removes the omission, so what follows is an observation where
// there used to be a block. What still blocks is a registration nobody could
// read, which is the same rule stated the same way.

test('a second worktree is read rather than refused, from the main tree', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'main-with-worktree');
  addWorktree(root, 'side');

  const outcome = takeSnapshot({ cwd: root });

  assert.equal(outcome.status, STATUS.PASS);
  assert.equal(outcome.snapshot.layout.linkedWorktrees.length, 1);

  const [sibling] = outcome.snapshot.layout.linkedWorktrees;
  assert.equal(sibling.name, 'tree');
  assert.equal(sibling.present, true);
  assert.equal(sibling.branch, 'side');
  assert.equal(sibling.clean, true);
  assert.equal(sibling.unreadable, null);
  assert.match(sibling.head, /^[0-9a-f]{40}$/);

  // The audited directory is the main worktree, so there is nothing separate
  // to read for it.
  assert.equal(outcome.snapshot.layout.mainWorktree, null);
});

test('from inside a linked worktree, the main working tree is read too', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'inside-worktree');
  const linked = addWorktree(root, 'side');

  const outcome = takeSnapshot({ cwd: linked });

  assert.equal(outcome.status, STATUS.PASS);
  assert.equal(outcome.snapshot.layout.insideLinkedWorktree, true);

  // The main worktree is not registered under <common>/worktrees, so reading
  // only the registrations would leave exactly one tree unread. That is the
  // omission this covers.
  const main = outcome.snapshot.layout.mainWorktree;
  assert.notEqual(main, null, 'the main working tree must not be the one tree left unread');
  assert.equal(main.name, '(main)');
  assert.equal(main.present, true);
  assert.equal(main.bare, false);
  assert.equal(main.clean, true);
  assert.equal(main.unreadable, null);
});

test('a dirty sibling is reported as dirty, not hidden and not fatal', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'dirty-sibling');
  const linked = addWorktree(root, 'side');
  write(linked, 'a.txt', 'changed\n');

  const outcome = takeSnapshot({ cwd: root });

  assert.equal(outcome.status, STATUS.PASS, 'another tree being dirty is a fact about it, not a refusal to observe');
  assert.equal(outcome.snapshot.layout.linkedWorktrees[0].clean, false);
});

test('a registration whose path is gone reads as absent, which is a complete observation', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'prunable-registration');
  const linked = addWorktree(root, 'side');

  // Delete the working tree without pruning: the registration survives and
  // points at nothing. It can hold no uncommitted work, so it is not a gap.
  rmSync(linked, { recursive: true, force: true });

  const outcome = takeSnapshot({ cwd: root });

  assert.equal(outcome.status, STATUS.PASS);
  const [stale] = outcome.snapshot.layout.linkedWorktrees;
  assert.equal(stale.present, false);
  assert.equal(stale.clean, null, 'an absent tree has no cleanliness to report, and null says so');
  assert.equal(stale.unreadable, null, 'absent is read, not unread');
});

test('a registration nobody can read still blocks, and names itself', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'unreadable-registration');
  addWorktree(root, 'side');

  // Empty the pointer. The registration exists, and what it points at can no
  // longer be established: that is an omission, not an absence.
  const commonDir = join(root, '.git');
  writeFileSync(join(commonDir, 'worktrees', 'tree', 'gitdir'), '');

  const outcome = takeSnapshot({ cwd: root });

  assert.equal(outcome.status, STATUS.UNKNOWN, 'an unread worktree is exactly what the original refusal was about');
  assert.equal(outcome.snapshot, null);
  assert.match(outcome.reason, /worktree\(s\) could not be read/);
  assert.match(outcome.reason, /tree: /, 'the refusal names which one');
});

test('removing the second worktree leaves the layout with nothing to report', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'worktree-removed');
  const linked = addWorktree(root, 'side');

  assert.equal(takeSnapshot({ cwd: root }).snapshot.layout.linkedWorktrees.length, 1);

  git(root, 'worktree', 'remove', '--force', linked);

  const after = takeSnapshot({ cwd: root });
  assert.equal(after.status, STATUS.PASS, 'the reading is a fact about the layout, not a sticky flag');
  assert.deepEqual(after.snapshot.layout.linkedWorktrees, []);
});

// -- the affirmative record ----------------------------------------------------

test('a supported snapshot states the absence positively, and it is part of the hash', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'affirmative-layout');
  const outcome = takeSnapshot({ cwd: root });

  assert.equal(outcome.status, STATUS.PASS);
  assert.deepEqual(outcome.snapshot.layout, {
    submodules: 0,
    hasGitmodules: false,
    insideLinkedWorktree: false,
    linkedWorktrees: [],
    mainWorktree: null,
  });
});

// -- path decoding --------------------------------------------------------------

test('strict decoding accepts valid UTF-8, including multi-byte characters', () => {
  assert.equal(decodeGitOutput(Buffer.from('plain.txt', 'utf8')), 'plain.txt');
  assert.equal(decodeGitOutput(Buffer.from('acentuado-ñ.txt', 'utf8')), 'acentuado-ñ.txt');
  assert.equal(decodeGitOutput(Buffer.from('emoji-🚀.txt', 'utf8')), 'emoji-🚀.txt');
});

test('strict decoding refuses byte sequences that are not valid UTF-8', () => {
  const invalid = {
    'lone continuation byte': Buffer.from([0x61, 0x80, 0x62]),
    'truncated two-byte sequence': Buffer.from([0xc3]),
    'truncated three-byte sequence': Buffer.from([0xe2, 0x82]),
    'latin-1 accented byte': Buffer.from([0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74]),
    'overlong encoding of "/"': Buffer.from([0xc0, 0xaf]),
    'unpaired surrogate': Buffer.from([0xed, 0xa0, 0x80]),
    'invalid start byte': Buffer.from([0xff, 0xfe]),
  };

  for (const [label, bytes] of Object.entries(invalid)) {
    assert.throws(
      () => decodeGitOutput(bytes, ['status', '-z']),
      GitUndecodableOutputError,
      `${label} must be refused, not replaced`
    );
  }
});

test('strict decoding does not silently substitute U+FFFD', () => {
  // The failure this guards against: Node's default decoding turns 0xE9 into
  // U+FFFD, producing a DIFFERENT file name that would then be hashed and
  // reported as the file that was observed.
  const latin1Name = Buffer.from([0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74]);
  assert.equal(new TextDecoder('utf-8').decode(latin1Name).includes('�'), true, 'the lossy path really does alter the name');
  assert.throws(() => decodeGitOutput(latin1Name), GitUndecodableOutputError);
});

test('a real file name with multi-byte characters survives a full snapshot', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'utf8-names');
  write(root, 'ñandú-🚀.txt', 'content\n');
  git(root, 'add', '-A');

  const outcome = takeSnapshot({ cwd: root });
  assert.equal(outcome.status, STATUS.PASS);
  assert.deepEqual(outcome.snapshot.changes.staged, [{ path: 'ñandú-🚀.txt', status: 'added', from: null }]);
});

/**
 * Can this filesystem hold a name that is not valid UTF-8?
 *
 * Detected, never assumed from process.platform. Two systems refuse for two
 * different reasons -- Windows names are UTF-16 at the API level, and APFS
 * validates UTF-8 -- and a third (ext4) accepts any byte but NUL and "/". A
 * skip is only honest when it carries the reason THIS platform gave.
 *
 * Acceptance is not enough on its own: a system may take the bytes and store
 * something else. The probe requires them to round-trip.
 */
const UNDECODABLE_NAME = (() => {
  const directory = makeDirectory('undecodable-probe');
  const raw = Buffer.from([0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74]); // f<0xe9>.txt, invalid UTF-8
  const full = Buffer.concat([Buffer.from(`${directory}${sep}`), raw]);

  try {
    writeFileSync(full, 'x');
  } catch (error) {
    return { supported: false, raw, reason: `this filesystem refused a non-UTF-8 file name (${error.code ?? error.message})` };
  }

  const stored = readdirSync(directory, { encoding: 'buffer' });
  if (!stored.some((name) => name.equals(raw))) {
    return {
      supported: false,
      raw,
      reason: `this filesystem accepted the name but did not store those bytes (it holds ${JSON.stringify(stored.map((name) => name.toString()))})`,
    };
  }
  return { supported: true, raw, reason: null };
})();

test('an undecodable file name makes the whole snapshot UNKNOWN', {
  skip: UNDECODABLE_NAME.supported ? false : UNDECODABLE_NAME.reason,
}, () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'undecodable-name');
  writeFileSync(Buffer.concat([Buffer.from(`${root}${sep}`), UNDECODABLE_NAME.raw]), 'x');

  const outcome = takeSnapshot({ cwd: root });

  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.snapshot, null);
  assert.match(outcome.reason, /could not be decoded without loss/);
});

test('the capability probe reports what this platform actually did', () => {
  // Always runs. Whatever the answer, it is recorded rather than assumed, and
  // an unsupported platform must say why in its own terms.
  if (UNDECODABLE_NAME.supported) {
    assert.equal(UNDECODABLE_NAME.reason, null);
  } else {
    assert.equal(typeof UNDECODABLE_NAME.reason, 'string');
    assert.notEqual(UNDECODABLE_NAME.reason.trim(), '');
  }
});
