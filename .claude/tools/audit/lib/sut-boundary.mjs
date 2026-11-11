// Read-only boundary controls for the nested Gentle AI system under test.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { canonicalJson, sha256Hex } from './canonical.mjs';

export class SutBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SutBoundaryError';
  }
}

const platformPath = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
const normalized = (value) => platformPath(resolve(value).replaceAll('/', sep));
const within = (parent, candidate) => {
  const rel = relative(normalized(parent), normalized(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

function canonicalProspectivePath(value) {
  let current = resolve(value);
  const suffix = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(basename(current));
    current = parent;
  }
  const canonicalAncestor = existsSync(current) ? realpathSync.native(current) : current;
  return resolve(canonicalAncestor, ...suffix);
}

export function assertExternalSandboxPath({ outerRoot, sutRoot, candidate, label = 'sandbox' }) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new SutBoundaryError(`${label} path is required`);
  }
  const canonicalOuter = canonicalProspectivePath(outerRoot);
  const canonicalSut = canonicalProspectivePath(sutRoot);
  const canonicalCandidate = canonicalProspectivePath(candidate);
  if (within(canonicalOuter, canonicalCandidate) || within(canonicalSut, canonicalCandidate)) {
    throw new SutBoundaryError(
      `${label} must be outside both the outer harness and its nested SUT. `
      + `Next action: choose a disposable sibling directory outside ${resolve(outerRoot)}.`
    );
  }
  return canonicalCandidate;
}

const WRITE_TOKENS = /\b(add|apply|checkout|clean|clone|commit|fetch|gc|init|merge|mv|pull|push|rebase|reset|restore|rm|stash|switch|worktree)\b|\b(set-content|add-content|out-file|remove-item|move-item|copy-item|new-item|chmod|touch)\b|(?:^|\s)(?:>|>>)(?:\s|$)/i;
const SHELL_COMPOSITION = /[|<>]/;
const INDIRECT_WRITE = /\b(?:tee|tee-object)\b/i;
const SAFE_GIT = /^\s*git(?:\.exe)?\s+(?:-[Cc]\s+\S+\s+)?(?:status|diff|show|log|rev-parse|ls-files|cat-file|remote\s+get-url)\b/i;
const SAFE_READ = /^\s*(?:get-content|select-string|rg|grep|type|cat|more)\b/i;

/** Conservative string gate. The attestation is the proof; this is early feedback. */
export function decideSutCommand(command, { outerRoot, sutRoot }) {
  if (typeof command !== 'string') {
    return { decision: 'deny', reason: 'the SUT boundary hook received no command string; doubt denies' };
  }
  const flat = command.replace(/\\/g, '/');
  // A SUT name counts only as a whole path: the relative name must start an
  // argument (optionally `./`, quoted or after `=`), and both names must end at
  // a separator, quote, whitespace or the end. A plain substring match denied
  // remote reads such as `gh api .../codex-rs/hooks/src/...`.
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const end = '(?:/|[\\s"\')]|$)';
  const absolute = resolve(sutRoot).replace(/\\/g, '/');
  const relativeName = relative(outerRoot, sutRoot).replace(/\\/g, '/');
  const patterns = [new RegExp(`${escape(absolute)}${end}`, 'i')];
  for (const name of new Set([relativeName, 'src'].filter(Boolean))) {
    patterns.push(new RegExp(`(?:^|[\\s"'=(])(?:\\./)?${escape(name)}${end}`, 'i'));
  }
  const targetsSut = patterns.some((pattern) => pattern.test(flat));
  if (!targetsSut) return { decision: 'allow', reason: null };
  if (SHELL_COMPOSITION.test(flat) || INDIRECT_WRITE.test(flat) || WRITE_TOKENS.test(flat)) {
    return {
      decision: 'deny',
      reason: 'The nested src repository is a read-only SUT. Next action: run mutations in a disposable clone/worktree outside the outer repository.',
    };
  }
  if (SAFE_GIT.test(flat) || SAFE_READ.test(flat)) return { decision: 'allow', reason: null };
  return {
    decision: 'deny',
    reason: 'This command targets the nested SUT but is not a recognised read. Next action: use a read-only Git/content command, or move the experiment to an external disposable sandbox.',
  };
}

function git(cwd, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', cwd, ...args], { encoding, windowsHide: true });
}
const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function attestSut(sutRoot) {
  const root = resolve(sutRoot);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const remote = git(root, ['remote', 'get-url', 'origin']).trim();
  const index = git(root, ['ls-files', '--stage', '-z'], 'buffer');
  const status = git(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'], 'buffer');
  const diff = git(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], 'buffer');
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z'], 'buffer')
    .toString('utf8').split('\0').filter(Boolean).sort();
  const untrackedContent = untracked.map((path) => ({
    path,
    sha256: sha256Bytes(readFileSync(resolve(root, path))),
  }));
  const attestation = {
    schemaVersion: 'sut-attestation/v1',
    root,
    head,
    remote,
    indexSha256: sha256Bytes(index),
    statusSha256: sha256Bytes(status),
    worktreeSha256: sha256Bytes(diff),
    untracked: untrackedContent,
  };
  return { ...attestation, attestationId: `sha256:${sha256Hex(canonicalJson(attestation))}` };
}

export function compareSutAttestations(before, after) {
  return {
    equal: before?.attestationId === after?.attestationId,
    before: before?.attestationId ?? null,
    after: after?.attestationId ?? null,
  };
}
