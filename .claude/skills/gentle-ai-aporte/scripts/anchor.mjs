#!/usr/bin/env node
// Public edition: private incident history omitted. See the operational contract.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertExternalSandboxPath } from '../../../tools/audit/lib/sut-boundary.mjs';

const usage = `usage:
  anchor.mjs --repo <owner/name> --clone <path> --worktree <path> [--branch main]

Resolves <branch>'s tip through the GitHub API, guarantees the local clone holds
that exact commit, and creates a detached worktree pinned to the SHA.

stdout is JSON: { sha, tree, worktree, branch, repo }.
exit 0 anchored; 1 stale or unreachable; 2 usage.`;

function die(code, message) {
  process.stderr.write(`anchor: ${message}\n`);
  process.exit(code);
}

/** Run a command and return its result. The exit status is never discarded. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) return { ok: false, status: null, stdout: '', stderr: String(result.error.message) };
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith('--')) die(2, `unexpected argument ${JSON.stringify(token)}\n\n${usage}`);
  const key = token.slice(2);
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) die(2, `--${key} needs a value\n\n${usage}`);
  args[key] = value;
  i += 1;
}

const repo = args.repo;
const clone = args.clone;
const worktree = args.worktree;
const branch = args.branch || 'main';

if (!repo || !clone || !worktree) die(2, `--repo, --clone and --worktree are all required\n\n${usage}`);
const outerRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
const sutRoot = resolve(outerRoot, 'src');
try {
  assertExternalSandboxPath({ outerRoot, sutRoot, candidate: clone, label: 'clone' });
  assertExternalSandboxPath({ outerRoot, sutRoot, candidate: worktree, label: 'worktree' });
} catch (error) {
  die(1, error.message);
}
if (!existsSync(clone)) die(1, `the clone path does not exist: ${clone}`);

// 1. Network truth. Not a local ref, not a cached value, not a previous reading.
const tip = run('gh', ['api', `repos/${repo}/commits/${branch}`, '--jq', '.sha']);
if (!tip.ok) {
  die(1, `could not read ${repo}@${branch} from the API (gh exit ${tip.status}). `
    + `Refusing to fall back to a local ref, because a local ref is exactly what goes stale.\n${tip.stderr}`);
}
const sha = tip.stdout;
if (!/^[0-9a-f]{40}$/.test(sha)) die(1, `the API returned something that is not a commit SHA: ${JSON.stringify(sha)}`);

// 2. Does this clone hold that commit? Ask about the object, not about a name.
const has = () => run('git', ['-C', clone, 'cat-file', '-e', `${sha}^{commit}`]).ok;

if (!has()) {
  const fetched = run('git', ['-C', clone, 'fetch', 'origin', branch]);
  if (!fetched.ok) {
    die(1, `the clone lacks ${sha.slice(0, 8)} and the fetch failed (git exit ${fetched.status}). `
      + `This is the failure the old pattern hid behind a pipe.\n${fetched.stderr}`);
  }
  if (!has()) {
    die(1, `the clone still lacks ${sha.slice(0, 8)} after a successful fetch of ${branch}. `
      + `Stale beyond what a fetch repairs; investigate rather than proceed.`);
  }
}

// 3. Pin the worktree to the SHA. Never to a ref name -- a name is the bug.
if (existsSync(worktree)) die(1, `the worktree path already exists: ${worktree}. Remove it and prune first.`);

const pruned = run('git', ['-C', clone, 'worktree', 'prune']);
if (!pruned.ok) die(1, `worktree prune failed (git exit ${pruned.status})\n${pruned.stderr}`);

const added = run('git', ['-C', clone, 'worktree', 'add', '--detach', worktree, sha]);
if (!added.ok) die(1, `worktree add failed (git exit ${added.status})\n${added.stderr}`);

// 4. Read back what was actually created. Trust the disk, not the intent.
const head = run('git', ['-C', worktree, 'rev-parse', 'HEAD']);
if (!head.ok) die(1, `could not read HEAD in the new worktree (git exit ${head.status})\n${head.stderr}`);
if (head.stdout !== sha) die(1, `the worktree is at ${head.stdout.slice(0, 8)} but was pinned to ${sha.slice(0, 8)}`);

const tree = run('git', ['-C', worktree, 'rev-parse', 'HEAD^{tree}']);
if (!tree.ok) die(1, `could not read the tree (git exit ${tree.status})\n${tree.stderr}`);

process.stdout.write(`${JSON.stringify({ sha, tree: tree.stdout, worktree, branch, repo }, null, 1)}\n`);
process.stderr.write(`anchor: ${repo}@${branch} pinned at ${sha.slice(0, 8)}, tree ${tree.stdout.slice(0, 8)}\n`);
