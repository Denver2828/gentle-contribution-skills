#!/usr/bin/env node
// Workspace pre-commit VERIFICATION gate (not review).
//
// The workspace is the factory that guards the gentle-ai contributions; its
// suite is the only thing standing between an edit to the harness and a silent
// regression that every future contribution would inherit. Running it was, until
// now, purely voluntary. This gate makes it mandatory for any commit that touches
// operative surface.
//
// Fail-closed by design. The allowlist is INVERSE and narrow: only explicitly
// passive paths (documentation and burn-in logs under docs/) skip the suite.
// Anything else staged runs it -- so a NEW operative surface (a new schema, a new
// skill, a settings rewire) is protected automatically, without anyone
// remembering to add it to a list.
//
// SUBJECT: the suite runs on the WORKTREE, but the commit captures the INDEX.
// Those diverge exactly when someone stages a broken file and then fixes it in
// the worktree without re-staging (the suite would pass on bytes that never get
// committed), or the inverse. So before running the suite this gate refuses when
// any OPERATIVE path differs between index and worktree, or is operative and
// untracked. Only then is "worktree green" == "index green". Docs may differ.
//
// Two honest limits:
//   - It catches an ACCIDENTAL regression. It does NOT catch deliberate
//     manipulation: rewriting a test to pass is part of what is committed. Same
//     procedural boundary as the rest of the harness -- resists error, not a
//     determined actor.
//   - The suite verifies the AUDIT ENGINE. For a skill/settings/agent change it
//     only confirms the engine still passes; it does not validate that change.
//     This is verification, NOT independent review -- a separate debt.
//   - Bypassable with `git commit --no-verify`. Its kill switch and its hole.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Narrow, inverse allowlist: only these prefixes are passive (suite skipped).
const PASSIVE = [/^docs\//];
const isOperative = (p) => typeof p === 'string' && p.length > 0 && !PASSIVE.some((re) => re.test(p));

/**
 * Split staged paths into passive vs operative. `allPassive` is true only when
 * there is at least one path and every one is passive; an empty set is not
 * passive (there is nothing to clear).
 */
export function classifyStagedPaths(paths) {
  const clean = (paths || []).filter((p) => typeof p === 'string' && p.length > 0);
  const operative = clean.filter(isOperative);
  return { allPassive: clean.length > 0 && operative.length === 0, operative, count: clean.length };
}

/**
 * From `git status --porcelain --untracked-files=all` lines, the operative paths
 * whose WORKTREE differs from the index (second status column not a space:
 * unstaged modification, staged-then-modified, or untracked). These are exactly
 * the paths where the suite would measure something other than the index.
 */
export function operativeUncleanPaths(porcelainLines) {
  const bad = new Set();
  for (const line of porcelainLines || []) {
    if (line.length < 4) continue;
    if (line[1] === ' ') continue; // worktree matches index for this path
    const rest = line.slice(3);
    for (let seg of rest.split(' -> ')) {
      seg = seg.replace(/^"(.*)"$/, '$1'); // best-effort unquote
      if (isOperative(seg)) { bad.add(seg); break; }
    }
  }
  return [...bad];
}

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

function stagedPaths() {
  const r = git(['diff', '--cached', '--name-only']);
  if (r.status !== 0) return { paths: null, error: (r.stderr || '').trim() || `git exit ${r.status}` };
  return { paths: r.stdout.split(/\r?\n/).filter(Boolean), error: null };
}

function statusLines() {
  const r = git(['status', '--porcelain', '--untracked-files=all']);
  if (r.status !== 0) return { lines: null, error: (r.stderr || '').trim() || `git exit ${r.status}` };
  return { lines: r.stdout.split(/\r?\n/).filter(Boolean), error: null };
}

// Only the repository-local vars git injects into a hook, enumerated by git
// itself. Stripping ALL GIT_* would also drop unrelated controls like
// GIT_CONFIG_NOSYSTEM; this drops exactly the ones that would point the suite's
// own worktree/clone fixtures at the in-progress commit's repository. If git
// cannot enumerate them, this returns null and the caller fails closed rather
// than cleaning a guessed subset.
function localEnvVars() {
  const r = git(['rev-parse', '--local-env-vars']);
  if (r.status !== 0) return null;
  return r.stdout.split(/\s+/).filter(Boolean);
}

function runSuite(localVars) {
  const auditDir = join(process.cwd(), '.claude', 'tools', 'audit');
  const env = { ...process.env };
  for (const v of localVars) delete env[v];
  const t = spawnSync(process.execPath, ['--test'], { cwd: auditDir, stdio: 'inherit', env });
  return t.status === 0;
}

function fail(lines) {
  process.stderr.write('\n' + lines.join('\n') + '\n\n');
  process.exit(1);
}

function main() {
  const staged = stagedPaths();
  if (staged.paths === null) {
    fail([`pre-commit: BLOCKED — could not read the staged set (${staged.error}); failing closed.`]);
    return;
  }
  if (staged.paths.length === 0) process.exit(0); // nothing staged

  const { allPassive, operative, count } = classifyStagedPaths(staged.paths);
  if (allPassive) {
    process.stdout.write(`pre-commit: ${count} staged path(s), all under docs/ — passive, suite skipped\n`);
    process.exit(0);
  }

  // Subject guard: the operative surface must match between index and worktree,
  // or the suite would not be measuring the bytes being committed.
  const status = statusLines();
  if (status.lines === null) {
    fail([`pre-commit: BLOCKED — could not read git status (${status.error}); failing closed.`]);
    return;
  }
  const unclean = operativeUncleanPaths(status.lines);
  if (unclean.length > 0) {
    fail([
      'pre-commit: BLOCKED — operative paths differ between the index and the worktree',
      '(or are untracked). The suite runs on the worktree, so it would measure bytes other',
      'than the ones staged for this commit.',
      '',
      'Offending operative paths:',
      ...unclean.map((p) => `  ${p}`),
      '',
      'Fix:     git add <path>          # stage the worktree version you tested',
      '  or:    git stash --keep-index  # set unstaged changes aside, test the index',
      'Bypass:  git commit --no-verify  # procedural bypass, your call',
    ]);
    return;
  }

  // Enumerate git's local env vars BEFORE running; fail closed if we cannot.
  const localVars = localEnvVars();
  if (localVars === null) {
    fail([
      'pre-commit: BLOCKED — could not enumerate git\'s repository-local env vars',
      '(git rev-parse --local-env-vars failed). Failing closed rather than cleaning a',
      'guessed subset, which could leave the suite pointed at the commit\'s repository.',
    ]);
    return;
  }

  const shown = operative.slice(0, 6).join(', ') + (operative.length > 6 ? ` … (+${operative.length - 6})` : '');
  process.stdout.write(`pre-commit: operative surface staged (${operative.length}/${count}): ${shown}\n`);
  process.stdout.write('pre-commit: running the workspace suite (node --test)…\n');
  if (runSuite(localVars)) {
    process.stdout.write('pre-commit: suite green — commit allowed\n');
    process.exit(0);
  }
  fail([
    'pre-commit: BLOCKED — the workspace suite failed on a commit that touches operative',
    'surface. This gate VERIFIES the harness does not regress; it is not independent review.',
    '',
    'Recover:  node .claude/hooks/pre-commit-check.mjs   # re-run this gate, see the failures',
    'Bypass:   git commit --no-verify                    # procedural bypass, your call',
  ]);
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (invokedDirectly) main();
