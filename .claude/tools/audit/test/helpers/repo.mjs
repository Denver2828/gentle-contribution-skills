// Real, disposable Git repositories for the snapshot fixtures.
//
// These are not mocks. Every fixture below is produced by running Git, so the
// parser is tested against what Git actually emits on this platform rather
// than against what the author remembers it emitting.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { loadPolicy, policyPath } from '../../lib/policy.mjs';
import { parseSourceRef } from '../../lib/parity.mjs';

/** Config pinned so fixtures behave identically wherever the suite runs. */
const FIXTURE_CONFIG = [
  '-c', 'user.name=Audit Fixture',
  '-c', 'user.email=fixture@example.invalid',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false',
  '-c', 'init.defaultBranch=main',
  '-c', 'protocol.file.allow=always',
  '-c', 'advice.detachedHead=false',
];

export function git(cwd, ...args) {
  const outcome = spawnSync('git', [...FIXTURE_CONFIG, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    windowsHide: true,
  });
  if (outcome.status !== 0) {
    throw new Error(`fixture setup failed: git ${args.join(' ')}\n${outcome.stderr}`);
  }
  return outcome.stdout;
}

/**
 * The identity every fixture repository declares, and the policy fragment that
 * matches it.
 *
 * A policy now names the one repository it may run against, and the preflight
 * gate refuses to run anywhere else. A fixture repository therefore has to say
 * which repository it stands in for -- and it says so the only way the engine
 * will read it, through the url of its `origin` remote. Nothing is fetched
 * from it: the identity is configuration, not a network operation.
 */
export const FIXTURE_REMOTE_URL = 'https://github.com/Gentleman-Programming/gentle-ai.git';
export const FIXTURE_REPOSITORY = Object.freeze({
  remote: 'origin',
  expected: Object.freeze({ host: 'github.com', owner: 'Gentleman-Programming', name: 'gentle-ai' }),
});

const created = new Set();

/** Create an empty temporary directory that the suite will clean up. */
export function makeDirectory(label = 'repo') {
  const directory = mkdtempSync(join(tmpdir(), `audit-${label}-`));
  created.add(directory);
  return directory;
}

/**
 * Initialise a repository with no commits.
 *
 * `origin` is declared by default so the repository has an identity the gate
 * can read. Pass `{ origin: null }` for the fixtures that exist precisely to
 * exercise a repository that declares none.
 */
export function initRepo(label = 'repo', { origin = FIXTURE_REMOTE_URL } = {}) {
  const directory = makeDirectory(label);
  git(directory, 'init', '-q', '-b', 'main', '.');
  if (origin !== null) git(directory, 'remote', 'add', 'origin', origin);
  return directory;
}

/**
 * Make a clone declare a repository identity while still fetching from the
 * local path it was cloned from.
 *
 * `url.<local>.insteadOf` is a real Git feature and the honest way to do this:
 * `remote.origin.url` holds the declared identity -- which is what the gate
 * reads -- and Git rewrites it to the local path at transport time, so fetch
 * and upstream tracking keep working against a directory instead of the
 * network. Rewriting the url without it would break every fixture that
 * fetches; leaving the local path in place would make the identity
 * unparseable and mask what these fixtures are meant to exercise.
 */
export function declareOrigin(root, localPath, url = FIXTURE_REMOTE_URL) {
  git(root, 'config', `url.${localPath}.insteadOf`, url);
  git(root, 'remote', 'set-url', 'origin', url);
  return url;
}

export function write(root, relativePath, content) {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
}

export function remove(root, relativePath) {
  unlinkSync(join(root, relativePath));
}

export function commit(root, message) {
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD').trim();
}

/**
 * A repository with one commit containing the given files.
 * Returns { root, head }.
 */
export function repoWithCommit(files = { 'a.txt': 'alpha\n' }, label = 'repo') {
  const root = initRepo(label);
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  git(root, 'add', '-A');
  const head = commit(root, 'initial commit');
  return { root, head };
}

/**
 * A clone with an upstream, so ahead/behind is real rather than simulated.
 * Returns { origin, clone }.
 */
export function repoWithUpstream(label = 'upstream') {
  const { root: origin } = repoWithCommit({ 'a.txt': 'alpha\n' }, `${label}-origin`);
  const parent = makeDirectory(`${label}-clone`);
  const clone = join(parent, 'work');
  const source = origin.replaceAll('\\', '/');
  git(parent, 'clone', '-q', source, 'work');
  git(clone, 'config', 'user.name', 'Audit Fixture');
  git(clone, 'config', 'user.email', 'fixture@example.invalid');
  declareOrigin(clone, source);
  return { origin, clone };
}

/** Clone an existing repository into a fresh temporary directory. */
export function cloneInto(origin, label = 'clone') {
  const parent = makeDirectory(label);
  const target = join(parent, 'work');
  const source = origin.replaceAll('\\', '/');
  git(parent, 'clone', '-q', source, 'work');
  declareOrigin(target, source);
  return target;
}

/**
 * Add a submodule pointing at another temporary repository. Entirely local:
 * `protocol.file.allow=always` is already pinned in FIXTURE_CONFIG, so no
 * network is involved.
 */
export function addSubmodule(root, path = 'sub', label = 'submodule-origin') {
  const { root: origin } = repoWithCommit({ 'inner.txt': 'inner\n' }, label);
  git(root, 'submodule', 'add', '--quiet', origin.replaceAll('\\', '/'), path);
  return origin;
}

/** Register a second worktree of an existing repository. */
export function addWorktree(root, branch = 'side', label = 'linked-worktree') {
  const parent = makeDirectory(label);
  const target = join(parent, 'tree');
  git(root, 'worktree', 'add', '-q', '-b', branch, target);
  return target;
}

/**
 * Files that reproduce, at the exact lines the bundled gentle-ai policy cites,
 * the rules and commands that policy declares.
 *
 * The padding is the honest cost of a policy that cites line numbers: a
 * fixture cannot claim a citation is verifiable unless the citation resolves
 * in the fixture too.
 *
 * Those lines are READ FROM THE POLICY, never repeated here. Upstream moves the
 * rules it writes, so our citations have to be re-pinned; a fixture that
 * hardcoded its own copy would keep passing against the old numbers and prove
 * nothing about the policy we actually ship.
 */
function bundledCitations() {
  const policy = loadPolicy(policyPath('gentle-ai'));
  const branch = policy.gates.preflight.checks.find((check) => check.id === 'git.branch-allowed');
  const lineOf = (reference) => parseSourceRef(reference).from;

  return {
    branchRule: { line: lineOf(branch.with.source), source: branch.with.source, pattern: branch.with.pattern },
    commands: policy.tooling.commands.map((command) => ({ id: command.id, line: lineOf(command.source), run: command.run })),
  };
}

export const BUNDLED_CITATIONS = bundledCitations();
export const BUNDLED_BRANCH_RULE = BUNDLED_CITATIONS.branchRule.pattern;
export const BUNDLED_BRANCH_RULE_SOURCE = BUNDLED_CITATIONS.branchRule.source;
export const BUNDLED_BUILD_COMMAND = BUNDLED_CITATIONS.commands.find((command) => command.id === 'build').run;

/** A document whose given 1-based lines hold the given content. */
function documentWithLines(entries, totalLines) {
  const lines = Array.from({ length: totalLines }, (_, index) => `# filler line ${index + 1}`);
  for (const [lineNumber, content] of Object.entries(entries)) lines[Number(lineNumber) - 1] = content;
  return `${lines.join('\n')}\n`;
}

/** Enough lines that every cited line resolves, with room to spare after it. */
const paddedTo = (lines, slack) => Math.max(...lines) + slack;

export function gentleAiFixtureFiles(extra = {}) {
  const { line: ruleLine, pattern } = BUNDLED_CITATIONS.branchRule;
  const commandLines = Object.fromEntries(
    BUNDLED_CITATIONS.commands.map(({ line, run }) => [line, `        run: ${run}`])
  );

  return {
    'CONTRIBUTING.md': documentWithLines(
      { [ruleLine - 5]: '## Branch Naming', [ruleLine]: pattern },
      paddedTo([ruleLine], 5)
    ),
    '.github/workflows/ci.yml': documentWithLines(
      commandLines,
      paddedTo(BUNDLED_CITATIONS.commands.map((command) => command.line), 9)
    ),
    '.github/workflows/pr-check.yml': 'name: PR Validation\n',
    'go.mod': 'module example\n\ngo 1.25\n\nrequire example.com/a v1.0.0\n',
    'go.sum': 'example.com/a v1.0.0 h1:abc=\n',
    'bench/go.mod': 'module example/bench\n\ngo 1.25\n',
    ...extra,
  };
}

export function cleanupAll() {
  for (const directory of created) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  }
  created.clear();
}
