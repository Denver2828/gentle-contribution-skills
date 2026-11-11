// Read-only Git adapter.
//
// Every command issued from this module is a read. That is enforced three
// ways, not assumed:
//
//   1. An allowlist of subcommands. Anything outside it throws before spawn.
//   2. GIT_OPTIONAL_LOCKS=0. Without it `git status` refreshes and rewrites
//      the index, which would make the "read-only" claim false in the most
//      literal sense.
//   3. No command in this file takes a writing flag, and a test enumerates the
//      commands actually used and asserts each one is on the allowlist.
//
// Environment handling is deliberate. Locale, pager and prompts are pinned so
// output is parseable, but the repository's own configuration is NOT
// suppressed: core.autocrlf and core.filemode change what Git considers
// modified, so they are part of the state being audited, not noise. They are
// read and recorded instead of being neutralised behind the reader's back.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** Subcommands this adapter may issue. Everything else is refused. */
// Every entry is a read. `cat-file` is here for --batch-check, which reports
// whether an object exists and what type it is; it writes nothing. The writers
// -- hash-object, write-tree, commit-tree, update-ref, add, commit -- are
// deliberately absent, and a test asserts they stay absent.
export const SAFE_SUBCOMMANDS = Object.freeze(new Set([
  'rev-parse', 'status', 'diff', 'ls-files', 'rev-list', 'config', 'version', 'cat-file', 'merge-base',
]));

export class GitUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitUnavailableError';
  }
}

export class GitCommandError extends Error {
  constructor(argv, code, stderr) {
    super(`git ${argv.join(' ')} exited ${code}: ${stderr.trim() || '(no stderr)'}`);
    this.name = 'GitCommandError';
    this.argv = argv;
    this.code = code;
  }
}

export class GitUnexpectedOutputError extends Error {
  constructor(argv, detail) {
    super(`git ${argv.join(' ')} produced output this adapter cannot parse: ${detail}`);
    this.name = 'GitUnexpectedOutputError';
    this.argv = argv;
  }
}

export class GitUndecodableOutputError extends Error {
  constructor(argv, detail) {
    super(`git ${argv.join(' ')} returned bytes that are not valid UTF-8: ${detail}`);
    this.name = 'GitUndecodableOutputError';
    this.argv = argv;
  }
}

/**
 * Strict UTF-8 decoding.
 *
 * Git emits raw path bytes under -z, and a path is not always valid UTF-8: a
 * file created on a Linux filesystem can carry any byte sequence except NUL
 * and '/'. Node's default decoding replaces those bytes with U+FFFD, which
 * would silently produce a DIFFERENT path name -- and then hash it, and then
 * report it as the file that was observed. A snapshot whose paths are altered
 * is worse than no snapshot, so this fails closed instead.
 */
export function decodeGitOutput(buffer, argv = ['(unknown)']) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    throw new GitUndecodableOutputError(argv, error.message);
  }
}

/** Lenient decoding, for diagnostic text that is never hashed or parsed. */
function decodeDiagnostic(buffer) {
  return new TextDecoder('utf-8').decode(buffer);
}

/** Environment overrides applied to every invocation. */
function gitEnv() {
  return {
    ...process.env,
    // Make `git status` a true read. Without this it rewrites the index.
    GIT_OPTIONAL_LOCKS: '0',
    // Never block on credentials or an editor.
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_PAGER: 'cat',
    // Stable, locale-independent messages and ordering.
    LC_ALL: 'C',
    LANG: 'C',
    TZ: 'UTC',
  };
}

/**
 * Run one git command.
 *
 * @param {string}  cwd
 * @param {string[]} argv        without the leading "git"
 * @param {object}  [options]
 * @param {boolean} [options.allowFailure]  return the failure instead of throwing
 */
export function runGit(cwd, argv, { allowFailure = false, input } = {}) {
  const subcommand = argv.find((arg) => !arg.startsWith('-'));
  if (!SAFE_SUBCOMMANDS.has(subcommand)) {
    throw new Error(`refusing to run "git ${argv.join(' ')}": "${subcommand}" is not on the read-only allowlist`);
  }

  // Captured as bytes on purpose: decoding is strict and explicit below, not
  // delegated to a lossy default.
  const outcome = spawnSync('git', ['--no-pager', ...argv], {
    cwd,
    env: gitEnv(),
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...(input === undefined ? {} : { input }),
  });

  if (outcome.error) {
    throw new GitUnavailableError(`git could not be executed: ${outcome.error.message}`);
  }

  const stderr = decodeDiagnostic(outcome.stderr ?? Buffer.alloc(0));
  if (outcome.status !== 0 && !allowFailure) {
    throw new GitCommandError(argv, outcome.status, stderr);
  }

  return { code: outcome.status, stdout: decodeGitOutput(outcome.stdout ?? Buffer.alloc(0), argv), stderr };
}

/** NUL-separated fields, with the trailing empty field removed. */
function splitNul(text) {
  const fields = text.split('\0');
  if (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
  return fields;
}

export function gitVersion(cwd) {
  return runGit(cwd, ['version']).stdout.trim();
}

/** Absolute repository root, or null when cwd is not inside a work tree. */
export function resolveRoot(cwd) {
  const inside = runGit(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null;

  const root = runGit(cwd, ['rev-parse', '--show-toplevel']).stdout.trim();
  return root === '' ? null : root;
}

/** Absolute path of the .git directory. */
export function resolveGitDir(root) {
  const raw = runGit(root, ['rev-parse', '--git-dir']).stdout.trim();
  if (raw === '') throw new GitUnexpectedOutputError(['rev-parse', '--git-dir'], 'empty output');
  return isAbsolute(raw) ? raw : join(root, raw);
}

const STATUS_CODE = Object.freeze({
  M: 'modified',
  T: 'typechange',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
});

function decodeCode(letter, argv) {
  if (letter === '.') return null;
  const decoded = STATUS_CODE[letter];
  if (!decoded) throw new GitUnexpectedOutputError(argv, `unknown status letter "${letter}"`);
  return decoded;
}

const byPath = (left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

/**
 * Parse `git status --porcelain=v2 --branch --untracked-files=all -z`.
 *
 * Staged and unstaged are separated at the source: porcelain v2 reports two
 * independent status letters per entry, X for the index and Y for the working
 * tree. Collapsing them, as `--porcelain=v1` invites, is what makes "the repo
 * is dirty" ambiguous.
 */
export function readStatus(root) {
  const argv = ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'];
  const { stdout } = runGit(root, argv);
  const fields = splitNul(stdout);

  const branch = { oid: null, head: null, upstream: null, ahead: null, behind: null };
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const unmerged = [];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === '') continue;

    if (field.startsWith('# ')) {
      const [, key, ...rest] = field.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') branch.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') branch.head = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') branch.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (!match) throw new GitUnexpectedOutputError(argv, `unparseable branch.ab "${value}"`);
        branch.ahead = Number(match[1]);
        branch.behind = Number(match[2]);
      }
      continue;
    }

    const kind = field[0];

    if (kind === '?') {
      untracked.push(field.slice(2));
      continue;
    }

    if (kind === '!') continue; // ignored entries are not requested, but tolerate them

    if (kind === '1' || kind === '2') {
      // "1 XY sub mH mI mW hH hI path" / "2 XY sub mH mI mW hH hI Xscore path"
      const parts = field.split(' ');
      const minimum = kind === '1' ? 9 : 10;
      if (parts.length < minimum) throw new GitUnexpectedOutputError(argv, `short entry "${field}"`);

      const xy = parts[1];
      if (xy.length !== 2) throw new GitUnexpectedOutputError(argv, `malformed XY "${xy}"`);

      const path = parts.slice(kind === '1' ? 8 : 9).join(' ');
      let from = null;
      if (kind === '2') {
        // With -z the original path is the next NUL-terminated field.
        index += 1;
        from = fields[index];
        if (from === undefined) throw new GitUnexpectedOutputError(argv, 'rename entry without an original path');
      }

      const indexStatus = decodeCode(xy[0], argv);
      const worktreeStatus = decodeCode(xy[1], argv);
      if (indexStatus) staged.push({ path, status: indexStatus, from });
      if (worktreeStatus) unstaged.push({ path, status: worktreeStatus, from: null });
      continue;
    }

    if (kind === 'u') {
      const parts = field.split(' ');
      if (parts.length < 11) throw new GitUnexpectedOutputError(argv, `short unmerged entry "${field}"`);
      unmerged.push({ path: parts.slice(10).join(' '), status: 'unmerged', from: null });
      continue;
    }

    throw new GitUnexpectedOutputError(argv, `unrecognised entry type "${kind}"`);
  }

  return {
    branch,
    staged: staged.sort(byPath),
    unstaged: unstaged.sort(byPath),
    untracked: untracked.sort(),
    unmerged: unmerged.sort(byPath),
  };
}

/**
 * Parse `git diff --numstat -z`.
 *
 * Binary files report "-" for both counts. They are counted separately rather
 * than folded into the totals as zero: a line count that silently excludes
 * binaries is a number presented as complete when it is not.
 */
export function readNumstat(root, { cached, base }) {
  const argv = ['diff', '--numstat', '-z', ...(cached ? ['--cached'] : []), ...(base ? [base] : [])];
  const { code, stdout, stderr } = runGit(root, argv, { allowFailure: true });

  // An unborn HEAD makes `diff --cached` fail; the caller decides what that means.
  if (code !== 0) throw new GitCommandError(argv, code, stderr);

  const fields = splitNul(stdout);
  const totals = { files: 0, additions: 0, deletions: 0, binaryFiles: 0 };

  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record === '') continue;

    const parts = record.split('\t');
    if (parts.length < 3) throw new GitUnexpectedOutputError(argv, `unparseable record "${record}"`);

    const [additions, deletions, path] = parts;

    // A rename emits an empty path, followed by two more NUL-terminated fields.
    if (path === '') {
      if (fields[index + 1] === undefined || fields[index + 2] === undefined) {
        throw new GitUnexpectedOutputError(argv, 'rename record missing its path pair');
      }
      index += 2;
    }

    totals.files += 1;
    if (additions === '-' || deletions === '-') {
      totals.binaryFiles += 1;
      continue;
    }
    if (!/^\d+$/.test(additions) || !/^\d+$/.test(deletions)) {
      throw new GitUnexpectedOutputError(argv, `non-numeric counts "${additions}/${deletions}"`);
    }
    totals.additions += Number(additions);
    totals.deletions += Number(deletions);
  }

  return totals;
}

/**
 * The commit both HEAD and `ref` descend from.
 *
 * `merge-base` is a read: it computes an answer from existing history and
 * writes nothing. Returns null when there is no common ancestor, or when the
 * ref does not resolve -- both are "no base", and neither is an error to
 * paper over.
 */
export function resolveMergeBase(root, ref) {
  if (typeof ref !== 'string' || ref.trim() === '') return null;
  const { code, stdout } = runGit(root, ['merge-base', 'HEAD', ref], { allowFailure: true });
  if (code !== 0) return null;
  const base = stdout.trim();
  return base === '' ? null : base;
}

/** Number of tracked files. */
export function readTrackedCount(root) {
  const { stdout } = runGit(root, ['ls-files', '-z']);
  return splitNul(stdout).length;
}

/** Tracked paths, sorted. Used for the path-based inventory. */
export function readTrackedPaths(root) {
  const { stdout } = runGit(root, ['ls-files', '-z']);
  return splitNul(stdout).sort();
}

/**
 * Configuration that changes what Git considers modified. Recorded because it
 * belongs to the state being read: the same bytes under a different
 * core.autocrlf are a different working tree as far as status is concerned.
 */
export function readRelevantConfig(root) {
  const keys = ['core.autocrlf', 'core.filemode', 'core.ignorecase', 'core.symlinks'];
  const config = {};
  for (const key of keys) {
    const { code, stdout } = runGit(root, ['config', '--get', key], { allowFailure: true });
    config[key] = code === 0 ? stdout.trim() : null;
  }
  return config;
}

/**
 * The url configured for one remote, or null when that remote is not configured.
 *
 * `git config --get` exits 1, and only 1, to say "this key is not set". Every
 * other non-zero exit is a real failure -- an unreadable config file, an
 * unparseable key -- and is allowed to throw, because a broken configuration
 * read as "no remote" would turn a fault into an absence.
 */
export function readRemoteUrl(root, remote = 'origin') {
  const argv = ['config', '--get', `remote.${remote}.url`];
  const { code, stdout, stderr } = runGit(root, argv, { allowFailure: true });
  if (code === 1) return null;
  if (code !== 0) throw new GitCommandError(argv, code, stderr);

  const url = stdout.trim();
  return url === '' ? null : url;
}

export class ConflictedIndexError extends Error {
  constructor(paths) {
    super(`the index holds ${paths.length} unmerged path(s): ${paths.join(', ')}`);
    this.name = 'ConflictedIndexError';
    this.paths = paths;
  }
}

/**
 * Every entry of the index, as `{ mode, blobSha, stage, path }`.
 *
 * Read with `git ls-files --stage -z`, which reports the object each entry
 * already points at. Those objects exist because `git add` wrote them; nothing
 * here creates one.
 *
 * Modes and paths are kept: the same bytes staged executable, or staged under
 * a different name, are different candidates, and folding either away would
 * make two distinguishable states hash alike.
 *
 * @throws {ConflictedIndexError} on any entry whose stage is not 0. An index
 *         mid-merge holds several versions of the same path and describes no
 *         single candidate.
 */
export function readIndexEntries(root) {
  const argv = ['ls-files', '--stage', '-z'];
  const { stdout } = runGit(root, argv);

  const entries = [];
  const unmerged = new Set();

  for (const record of splitNul(stdout)) {
    if (record === '') continue;

    const tab = record.indexOf('\t');
    if (tab === -1) throw new GitUnexpectedOutputError(argv, `entry without a path: "${record}"`);

    const [mode, blobSha, stageText] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);

    if (!/^[0-7]{6}$/.test(mode ?? '')) throw new GitUnexpectedOutputError(argv, `unparseable mode "${mode}"`);
    if (!/^[0-9a-f]{40,64}$/.test(blobSha ?? '')) throw new GitUnexpectedOutputError(argv, `unparseable object id "${blobSha}"`);
    if (!/^[0-3]$/.test(stageText ?? '')) throw new GitUnexpectedOutputError(argv, `unparseable stage "${stageText}"`);

    const stage = Number(stageText);
    if (stage !== 0) { unmerged.add(path); continue; }

    entries.push({ mode, blobSha, stage, path });
  }

  if (unmerged.size > 0) throw new ConflictedIndexError([...unmerged].sort());

  // Canonical order: by path, then by stage. Git's own order is already
  // deterministic, but depending on it would make the identity a property of
  // Git's implementation rather than of the entries.
  return entries.sort((left, right) =>
    (left.path < right.path ? -1 : left.path > right.path ? 1 : left.stage - right.stage));
}

/**
 * Ask Git which of the given object ids exist, and of what type.
 *
 * `cat-file --batch-check` is a read: it reports on objects, and creates none.
 */
export function verifyObjects(root, objectIds) {
  if (objectIds.length === 0) return new Map();

  const argv = ['cat-file', '--batch-check'];
  const { stdout } = runGit(root, argv, { input: `${objectIds.join('\n')}\n`, allowFailure: true });

  const seen = new Map();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const parts = trimmed.split(' ');
    if (parts[1] === 'missing' || parts[1] === undefined) { seen.set(parts[0], { present: false, type: null }); continue; }
    seen.set(parts[0], { present: true, type: parts[1], size: Number(parts[2]) });
  }
  return seen;
}

/**
 * Repository layout facts that decide whether a single-tree snapshot can
 * describe this repository at all.
 *
 * Submodules mean "there is more state than this reading covers". Reporting a
 * snapshot that silently omits a submodule's working tree would be a partial
 * observation presented as complete, so the caller treats that layout as
 * unsupported rather than as clean.
 *
 * Linked worktrees used to be refused for the same reason, and the reason was
 * the same only as long as their state went unread. It no longer does: each
 * registration is resolved to its working tree and read, so a sibling worktree
 * is now an observation rather than an omission. What is still refused is a
 * registration whose state could NOT be read -- the omission, not the layout.
 *
 * Detection is read-only and uses no `git submodule` / `git worktree`
 * subcommand: gitlinks come from the index, and worktree registration from
 * paths under the common git dir.
 */
export function readLayout(root) {
  // Gitlinks: index entries with mode 160000 are submodule pointers.
  const { stdout } = runGit(root, ['ls-files', '--stage', '-z']);
  const submodulePaths = [];
  for (const record of splitNul(stdout)) {
    if (record === '') continue;
    if (!record.startsWith('160000 ')) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) throw new GitUnexpectedOutputError(['ls-files', '--stage'], `entry without a path: "${record}"`);
    submodulePaths.push(record.slice(tab + 1));
  }

  const hasGitmodules = runGit(root, ['ls-files', '--error-unmatch', '-z', '.gitmodules'], { allowFailure: true }).code === 0;

  const gitDir = resolveGitDir(root);
  const commonRaw = runGit(root, ['rev-parse', '--git-common-dir']).stdout.trim();
  const commonDir = isAbsolute(commonRaw) ? commonRaw : join(root, commonRaw);

  const normalise = (path) => path.replaceAll('\\', '/').replace(/\/+$/, '');
  const insideLinkedWorktree = normalise(gitDir) !== normalise(commonDir);

  // Every linked worktree registers a directory under <common>/worktrees.
  const registrations = join(commonDir, 'worktrees');
  const names = existsSync(registrations) ? readdirSync(registrations).sort() : [];
  const linkedWorktrees = names.map((name) => readLinkedWorktree(registrations, name));

  // Reading the registrations covers every LINKED worktree and none of the
  // main one, which is not registered under <common>/worktrees. From inside a
  // linked worktree that omission is exactly the state we are trying not to
  // leave unread, so the main working tree is read too.
  const mainWorktree = insideLinkedWorktree ? readMainWorktree(commonDir) : null;

  return {
    submodulePaths: submodulePaths.sort(),
    hasGitmodules,
    insideLinkedWorktree,
    linkedWorktrees,
    mainWorktree,
  };
}

/** The primary checkout, derived from the common git dir rather than from a registration. */
function readMainWorktree(commonDir) {
  const trimmed = commonDir.replace(/[\\/]+$/, '');
  // A bare repository has no working tree to read, and nothing can be
  // uncommitted in one.
  if (!/[\\/]\.git$/.test(trimmed)) return { name: '(main)', path: null, present: false, bare: true, head: null, branch: null, detached: null, clean: null, unreadable: null };
  return { ...readWorktreeAt('(main)', dirname(trimmed)), bare: false };
}

/**
 * Resolve one worktree registration to the state of its working tree.
 *
 * A registration is a directory under `<common>/worktrees/<name>` holding a
 * `gitdir` file that points back at the working tree's `.git`. Three outcomes,
 * and the difference between the last two is the whole point:
 *
 *   - present: the working tree exists and was read.
 *   - absent: the registration points at a path that is gone. That is a
 *     complete observation, not a gap -- `git worktree prune` has simply not
 *     run. A prunable registration cannot hold uncommitted work.
 *   - unreadable: the pointer or the tree could not be read at all. THIS is an
 *     omission, and the caller refuses on it.
 */
function readLinkedWorktree(registrations, name) {
  const pointer = join(registrations, name, 'gitdir');
  const record = { name, path: null, present: false, head: null, branch: null, detached: null, clean: null, unreadable: null };

  let target;
  try {
    target = readFileSync(pointer, 'utf8').trim();
  } catch (error) {
    return { ...record, unreadable: `the registration's gitdir pointer could not be read: ${error.message}` };
  }
  if (target === '') return { ...record, unreadable: 'the registration\'s gitdir pointer is empty' };

  // The pointer names the worktree's `.git`; the working tree is its parent.
  const worktreeRoot = target.endsWith('.git') || target.endsWith('.git/') || target.endsWith('.git\\')
    ? dirname(target.replace(/[\\/]+$/, ''))
    : target;
  record.path = worktreeRoot;

  return readWorktreeAt(name, worktreeRoot);
}

/** Read one working tree's identity and cleanliness, or say why it could not be read. */
function readWorktreeAt(name, worktreeRoot) {
  const record = { name, path: worktreeRoot, present: false, head: null, branch: null, detached: null, clean: null, unreadable: null };

  if (!existsSync(worktreeRoot)) return record;
  record.present = true;

  // Read-only, and each failure is reported as an omission rather than guessed at.
  const head = runGit(worktreeRoot, ['rev-parse', 'HEAD'], { allowFailure: true });
  if (head.code !== 0) return { ...record, unreadable: `HEAD could not be resolved: ${head.stderr.trim() || `git exited ${head.code}`}` };
  record.head = head.stdout.trim();

  const symbolic = runGit(worktreeRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true });
  if (symbolic.code !== 0) return { ...record, unreadable: `the branch could not be resolved: ${symbolic.stderr.trim() || `git exited ${symbolic.code}`}` };
  const branch = symbolic.stdout.trim();
  record.detached = branch === 'HEAD';
  record.branch = record.detached ? null : branch;

  const porcelain = runGit(worktreeRoot, ['status', '--porcelain', '-z'], { allowFailure: true });
  if (porcelain.code !== 0) return { ...record, unreadable: `the working tree state could not be read: ${porcelain.stderr.trim() || `git exited ${porcelain.code}`}` };
  record.clean = splitNul(porcelain.stdout).every((entry) => entry === '');

  return record;
}

/**
 * In-progress Git operation, detected from control files in the git dir.
 * An unfinished merge or rebase means the working tree is mid-transaction and
 * nothing should be published from it.
 */
export function readOperation(gitDir) {
  const markers = [
    ['merge', 'MERGE_HEAD'],
    ['rebase', 'rebase-merge'],
    ['rebase', 'rebase-apply'],
    ['cherry-pick', 'CHERRY_PICK_HEAD'],
    ['revert', 'REVERT_HEAD'],
    ['bisect', 'BISECT_LOG'],
  ];
  for (const [operation, marker] of markers) {
    if (existsSync(join(gitDir, marker))) return operation;
  }
  return 'none';
}
