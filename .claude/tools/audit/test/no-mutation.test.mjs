// Auditing must not change what it audits.
//
// The proof is a full fingerprint of the repository -- every tracked and
// untracked file, plus the whole .git tree -- taken before and after a
// complete gate run and compared byte for byte.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CHECKS_DIRECTORY } from '../lib/registry.mjs';

import { runPreflight } from '../lib/preflight.mjs';
import { policyPath } from '../lib/policy.mjs';
import { discoverChecks } from '../lib/registry.mjs';
import { SAFE_SUBCOMMANDS } from '../lib/adapters/git.mjs';
import { STATUS } from '../lib/status.mjs';
import { git, write, repoWithCommit, gentleAiFixtureFiles, cleanupAll } from './helpers/repo.mjs';

after(cleanupAll);

/** Recursive content fingerprint: path, size, mode and bytes of every file. */
function fingerprint(root) {
  const hash = createHash('sha256');

  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`D ${relative(root, absolute).replaceAll('\\', '/')}\n`);
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = statSync(absolute);
      hash.update(`F ${relative(root, absolute).replaceAll('\\', '/')} ${stats.size} ${stats.mode}\n`);
      hash.update(readFileSync(absolute));
    }
  };

  walk(root);
  return hash.digest('hex');
}

/** A repository shaped like a real candidate, dirty in every category. */
function candidateRepository(label) {
  const { root } = repoWithCommit(gentleAiFixtureFiles({
    'keep.txt': 'keep\n',
    'rename-me.txt': 'a long enough body for rename detection to fire\n',
  }), label);

  git(root, 'checkout', '-q', '-b', 'fix/999-candidate');
  write(root, 'staged.txt', 'staged\n');
  git(root, 'add', 'staged.txt');
  git(root, 'mv', 'rename-me.txt', 'renamed.txt');
  write(root, 'keep.txt', 'keep\nmodified in the worktree\n');
  write(root, 'untracked.txt', 'untracked\n');

  return root;
}

test('a full gate run changes nothing in the repository, working tree or .git', async () => {
  const root = candidateRepository('no-mutation');

  const before = fingerprint(root);
  const { result } = await runPreflight({ cwd: root, policy: policyPath('gentle-ai'), gate: 'preflight' });
  const after = fingerprint(root);

  assert.equal(after, before, 'auditing must leave the repository byte-identical');
  assert.notEqual(result.status, undefined);
});

test('the fingerprint really would notice a change, so the test above is not vacuous', () => {
  const root = candidateRepository('fingerprint-sensitivity');

  const before = fingerprint(root);
  write(root, 'untracked.txt', 'untracked\nplus one line\n');
  assert.notEqual(fingerprint(root), before, 'a single edited line must move the fingerprint');
});

test('running the same gate twice yields the same verdict and touches nothing', async () => {
  const root = candidateRepository('idempotent');

  const before = fingerprint(root);
  const first = await runPreflight({ cwd: root, policy: policyPath('gentle-ai'), gate: 'preflight' });
  const second = await runPreflight({ cwd: root, policy: policyPath('gentle-ai'), gate: 'preflight' });

  assert.equal(fingerprint(root), before);
  assert.equal(first.result.status, second.result.status);
  assert.equal(first.result.runId, second.result.runId, 'the run id follows what was audited, not when');
  assert.deepEqual(
    first.result.checks.map((check) => [check.id, check.status]),
    second.result.checks.map((check) => [check.id, check.status])
  );
});

test('no check reaches a Git subcommand that could write', async () => {
  // The adapter allowlist is the enforcement; this asserts the list itself has
  // not quietly grown a writer.
  const writers = ['add', 'commit', 'checkout', 'reset', 'clean', 'merge', 'rebase', 'push', 'fetch', 'gc', 'stash', 'worktree', 'submodule'];
  for (const subcommand of writers) {
    assert.equal(SAFE_SUBCOMMANDS.has(subcommand), false, `"${subcommand}" must never be on the read-only allowlist`);
  }
});

test('no check module imports a writing capability', async () => {
  // A check that reached for fs.writeFileSync or child_process directly would
  // bypass the adapter entirely. This is a structural guard, not a runtime one.
  const catalogue = await discoverChecks();
  const forbidden = /writeFileSync|appendFileSync|rmSync|unlinkSync|mkdirSync|renameSync|child_process|execSync|spawnSync/;

  for (const definition of catalogue.values()) {
    const source = readFileSync(join(CHECKS_DIRECTORY, definition.origin), 'utf8');
    assert.equal(forbidden.test(source), false, `${definition.origin} must not reach for a writing capability`);
  }
});

test('a gate run over an unreadable repository still mutates nothing', async () => {
  const root = candidateRepository('unreadable');
  git(root, 'checkout', '-q', '--detach');

  const before = fingerprint(root);
  const { result } = await runPreflight({ cwd: root, policy: policyPath('gentle-ai'), gate: 'preflight' });

  assert.equal(fingerprint(root), before);
  assert.equal(result.checks.find((check) => check.id === 'git.branch-allowed').status, STATUS.UNKNOWN);
});
