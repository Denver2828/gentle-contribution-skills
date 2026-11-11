// Repository snapshot.
//
// One reproducible reading of what the repository currently is. It states
// facts and computes nothing about whether they are acceptable -- that is the
// policy layer's job.
//
// Two properties matter more than the field list:
//
//   Determinism. The hash covers repository state and the Git configuration
//   that decides how that state is read. It excludes where the checkout lives,
//   which Git binary read it, and when. Two clones of the same state on two
//   machines hash identically; the same bytes under a different core.autocrlf
//   do not, because Git itself would treat them differently.
//
//   No false cleanliness. Every failure path here ends in UNKNOWN. There is no
//   branch that turns an unreadable repository, an unparseable Git output or a
//   concurrent modification into an empty change list.

import {
  resolveRoot, resolveGitDir, readStatus, readNumstat, readTrackedPaths,
  readRelevantConfig, readOperation, readLayout, resolveMergeBase, gitVersion,
  GitUnavailableError, GitCommandError, GitUnexpectedOutputError, GitUndecodableOutputError,
} from './adapters/git.mjs';
import { canonicalJson, digest } from './canonical.mjs';
import { makeEvidence, EVIDENCE_TYPE } from './evidence.mjs';
import { STATUS } from './status.mjs';

export const SNAPSHOT_VERSION = '1.0.0';

/**
 * Fields excluded from the snapshot hash, and why.
 *
 *   root    absolute path of the checkout. Machine-specific; the same state in
 *           two directories is the same state.
 *   reader  the Git binary that performed the reading. Environment, not state.
 *   hash    cannot contain itself.
 */
export const HASH_EXCLUDED_FIELDS = Object.freeze(['root', 'reader', 'hash']);

/**
 * Raised when the repository holds more state than a single-tree snapshot can
 * describe. Delivery 2 reads one working tree; a submodule or a second
 * worktree means there is state this reading does not cover, and reporting the
 * part it did read would be a partial observation presented as complete.
 */
export class UnsupportedLayoutError extends Error {
  constructor(reasons, layout) {
    super(`this repository layout is not supported yet: ${reasons.join('; ')}`);
    this.name = 'UnsupportedLayoutError';
    this.reasons = reasons;
    this.layout = layout;
  }
}

export class ConcurrentChangeError extends Error {
  constructor(first, second) {
    super('the repository changed while it was being read; no snapshot describes it');
    this.name = 'ConcurrentChangeError';
    this.first = first;
    this.second = second;
  }
}

// -- inventory --------------------------------------------------------------
//
// Pure path facts, matched against a declared table. Nothing here reads file
// contents or infers what a project does: "which test command should run" is
// an interpretation and belongs to the policy layer, not to a snapshot.

const MANIFEST_NAMES = Object.freeze(new Set([
  'go.mod', 'go.work', 'package.json', 'Cargo.toml', 'pyproject.toml', 'requirements.txt',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'deno.json',
]));

const LOCKFILE_NAMES = Object.freeze(new Set([
  'go.sum', 'go.work.sum', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'Cargo.lock', 'poetry.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'deno.lock',
]));

const CI_SINGLE_FILES = Object.freeze(new Set([
  '.gitlab-ci.yml', 'azure-pipelines.yml', '.travis.yml', 'Jenkinsfile',
]));

function basenameOf(path) {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

function buildInventory(trackedPaths) {
  const manifests = [];
  const lockfiles = [];
  const ciWorkflows = [];

  for (const path of trackedPaths) {
    const name = basenameOf(path);
    if (MANIFEST_NAMES.has(name)) manifests.push(path);
    if (LOCKFILE_NAMES.has(name)) lockfiles.push(path);
    if (CI_SINGLE_FILES.has(path)) ciWorkflows.push(path);
    else if (path.startsWith('.github/workflows/') && /\.ya?ml$/.test(path)) ciWorkflows.push(path);
  }

  return {
    manifests: manifests.sort(),
    lockfiles: lockfiles.sort(),
    ciWorkflows: ciWorkflows.sort(),
  };
}

// -- state collection -------------------------------------------------------

/**
 * Refuse layouts whose full state this snapshot does not read.
 *
 * Fail-closed on purpose, including the case of a tracked .gitmodules with no
 * live gitlinks: a repository that declares submodules is a repository whose
 * publication decisions depend on them, and "the declaration is stale" is a
 * judgement, not an observation.
 */
function assertSupportedLayout(root) {
  const layout = readLayout(root);
  const reasons = [];

  if (layout.submodulePaths.length > 0) {
    reasons.push(`${layout.submodulePaths.length} submodule gitlink(s) present (${layout.submodulePaths.join(', ')}), whose working trees this snapshot does not read`);
  } else if (layout.hasGitmodules) {
    reasons.push('a tracked .gitmodules declares submodules, and whether that declaration is stale is a judgement rather than an observation');
  }

  // A sibling worktree is no longer refused for existing. It is read, and what
  // is refused is a registration whose state could not be read -- the omission
  // the original refusal was actually about. A registration pointing at a path
  // that is gone reads as absent, which is a complete observation: a prunable
  // registration holds no uncommitted work.
  const unreadable = [...layout.linkedWorktrees, ...(layout.mainWorktree ? [layout.mainWorktree] : [])]
    .filter((worktree) => worktree.unreadable !== null);

  if (unreadable.length > 0) {
    reasons.push(
      `${unreadable.length} worktree(s) could not be read (${unreadable.map((worktree) => `${worktree.name}: ${worktree.unreadable}`).join('; ')})`
    );
  }

  if (reasons.length > 0) throw new UnsupportedLayoutError(reasons, layout);
  return layout;
}

/** Everything the hash covers. Read twice and compared, to catch concurrent change. */
function collectState(root, gitDir) {
  const status = readStatus(root);
  const trackedPaths = readTrackedPaths(root);

  const staged = readNumstat(root, { cached: true });
  const unstaged = readNumstat(root, { cached: false });

  // The publishable candidate: everything that would leave this repository if
  // the branch were published. That is own commits PLUS staged changes,
  // measured from the point the branch left the upstream -- not the index
  // against HEAD, which on a clean tree measures zero however large the
  // contribution is.
  const mergeBase = resolveMergeBase(root, status.branch.upstream);
  let candidate = null;
  let candidateUnavailable = null;

  if (status.branch.upstream === null) {
    candidateUnavailable = 'the branch tracks no upstream, so there is no base to measure the candidate against';
  } else if (mergeBase === null) {
    candidateUnavailable = `no merge base could be resolved between HEAD and ${status.branch.upstream}`;
  } else {
    try {
      candidate = { base: 'merge-base', baseOid: mergeBase, ...readNumstat(root, { cached: true, base: mergeBase }) };
    } catch (error) {
      candidateUnavailable = `the candidate diff against ${mergeBase} could not be read: ${error.message}`;
    }
  }

  const detached = status.branch.head === null;
  const unborn = status.branch.oid === null;

  const conflicted = status.unmerged.length > 0;
  const clean =
    status.staged.length === 0 &&
    status.unstaged.length === 0 &&
    status.untracked.length === 0 &&
    !conflicted;

  return {
    snapshotVersion: SNAPSHOT_VERSION,
    identity: {
      head: status.branch.oid,
      headKind: unborn ? 'unborn' : 'commit',
      branch: status.branch.head,
      detached,
      upstream: status.branch.upstream ?? null,
      mergeBase,
      ahead: status.branch.ahead,
      behind: status.branch.behind,
      operation: readOperation(gitDir),
    },
    config: readRelevantConfig(root),
    // The absence of submodules is an affirmative finding, not something the
    // reader is left to assume. Worktrees are carried in full rather than
    // counted: a count would say a sibling exists, and the whole reason the
    // layout is now supported is that its state was read, so the reading is
    // what the snapshot has to carry.
    layout: (() => {
      const layout = readLayout(root);
      return {
        submodules: layout.submodulePaths.length,
        hasGitmodules: layout.hasGitmodules,
        insideLinkedWorktree: layout.insideLinkedWorktree,
        linkedWorktrees: layout.linkedWorktrees,
        mainWorktree: layout.mainWorktree,
      };
    })(),
    worktree: { clean, conflicted },
    changes: {
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked,
      unmerged: status.unmerged,
    },
    diffstat: {
      // `diff --cached` compares the index against HEAD, or against the empty
      // tree when HEAD is unborn -- which is why baseOid is null there.
      staged: { base: 'HEAD', baseOid: status.branch.oid, ...staged },
      // `diff` compares the working tree against the index, which has no oid.
      unstaged: { base: 'index', baseOid: null, ...unstaged },
      // What would actually be published, or the reason it cannot be measured.
      candidate,
      candidateUnavailable,
    },
    inventory: buildInventory(trackedPaths),
    counts: { tracked: trackedPaths.length },
  };
}

/**
 * Take a snapshot of the repository containing `cwd`.
 *
 * The state is read twice and the two readings compared. A difference means
 * the repository moved under the reader, and no single snapshot describes it.
 *
 * @param {object}   [input]
 * @param {string}   [input.cwd]
 * @param {Function} [input.betweenReadings]  test seam, invoked between the two
 *                   readings so the concurrent-change path can be exercised
 *                   deterministically instead of being asserted by hand.
 * @returns {{status: string, snapshot: object|null, reason: string, evidence: Array}}
 */
export function takeSnapshot({ cwd = process.cwd(), betweenReadings } = {}) {
  const inconclusive = (reason, observed, source) => ({
    status: STATUS.UNKNOWN,
    snapshot: null,
    reason,
    evidence: [makeEvidence({ type: EVIDENCE_TYPE.GIT, source, observed })],
  });

  let root;
  try {
    root = resolveRoot(cwd);
  } catch (error) {
    if (error instanceof GitUnavailableError) {
      return inconclusive(`git is not usable from this environment: ${error.message}`, { error: error.message }, 'git version');
    }
    throw error;
  }

  if (root === null) {
    return inconclusive(
      'the working directory is not inside a Git work tree, so there is no repository state to describe',
      { cwd, insideWorkTree: false },
      'git rev-parse --is-inside-work-tree'
    );
  }

  try {
    const gitDir = resolveGitDir(root);
    assertSupportedLayout(root);

    const first = collectState(root, gitDir);
    betweenReadings?.();
    const second = collectState(root, gitDir);
    if (canonicalJson(first) !== canonicalJson(second)) {
      throw new ConcurrentChangeError(digest(first), digest(second));
    }

    const snapshot = {
      ...first,
      root,
      reader: { gitVersion: gitVersion(root) },
      hash: null,
    };
    snapshot.hash = snapshotHash(snapshot);

    return {
      status: STATUS.PASS,
      snapshot,
      reason: `repository state read and stable across two consecutive readings (${snapshot.counts.tracked} tracked files)`,
      evidence: [
        makeEvidence({
          type: EVIDENCE_TYPE.GIT,
          source: 'git status --porcelain=v2 --branch --untracked-files=all -z',
          observed: {
            head: snapshot.identity.head,
            branch: snapshot.identity.branch,
            upstream: snapshot.identity.upstream,
            clean: snapshot.worktree.clean,
            staged: snapshot.changes.staged.length,
            unstaged: snapshot.changes.unstaged.length,
            untracked: snapshot.changes.untracked.length,
          },
        }),
        makeEvidence({
          type: EVIDENCE_TYPE.COMPUTED,
          source: 'snapshot.hash',
          observed: { hash: snapshot.hash, excludedFields: [...HASH_EXCLUDED_FIELDS] },
        }),
      ],
    };
  } catch (error) {
    if (error instanceof UnsupportedLayoutError) {
      return inconclusive(
        error.message,
        {
          submodules: error.layout.submodulePaths.length,
          submodulePaths: error.layout.submodulePaths,
          hasGitmodules: error.layout.hasGitmodules,
          insideLinkedWorktree: error.layout.insideLinkedWorktree,
          linkedWorktrees: error.layout.linkedWorktrees,
        },
        'git ls-files --stage / git rev-parse --git-common-dir'
      );
    }
    if (error instanceof ConcurrentChangeError) {
      return inconclusive(error.message, { firstReading: error.first, secondReading: error.second }, 'snapshot.double-read');
    }
    if (error instanceof GitUndecodableOutputError) {
      return inconclusive(
        `a path could not be decoded without loss, so no snapshot describes this repository: ${error.message}`,
        { argv: error.argv },
        `git ${error.argv.join(' ')}`
      );
    }
    if (error instanceof GitUnexpectedOutputError) {
      return inconclusive(`git output could not be parsed, so the reading is incomplete: ${error.message}`, { argv: error.argv }, `git ${error.argv.join(' ')}`);
    }
    if (error instanceof GitCommandError) {
      return inconclusive(`a required git command failed: ${error.message}`, { argv: error.argv, code: error.code }, `git ${error.argv.join(' ')}`);
    }
    if (error instanceof GitUnavailableError) {
      return inconclusive(`git is not usable from this environment: ${error.message}`, { error: error.message }, 'git');
    }
    return inconclusive(`the repository could not be read: ${error.message}`, { error: error.message, errorName: error.name ?? 'Error' }, 'snapshot');
  }
}

/**
 * Canonical hash of a snapshot.
 *
 * Computed over the snapshot with HASH_EXCLUDED_FIELDS removed, serialized by
 * canonicalJson. Documented, reproducible, and independent of where the
 * checkout lives or when it was read.
 */
export function snapshotHash(snapshot) {
  const hashed = { ...snapshot };
  for (const field of HASH_EXCLUDED_FIELDS) delete hashed[field];
  return digest(hashed);
}

/** Re-derive the hash and compare it to the recorded one. */
export function snapshotIntact(snapshot) {
  return snapshot.hash === snapshotHash(snapshot);
}
