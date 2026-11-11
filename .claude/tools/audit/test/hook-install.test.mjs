import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { git, initRepo, write } from './helpers/repo.mjs';
import { nextAction } from '../../../hooks/install.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, '..', '..', '..', '..');
const INSTALLER = join(WORKSPACE, '.claude', 'hooks', 'install.mjs');
const HOOK_FILES = [
  '.claude/hooks/pre-commit',
  '.claude/hooks/pre-commit-check.mjs',
  '.claude/hooks/commit-msg',
  '.claude/hooks/commit-msg-check.mjs',
];
const SHIMS = ['.claude/hooks/pre-commit', '.claude/hooks/commit-msg'];

function fixture(label) {
  const root = initRepo(label, { origin: null });
  write(root, '.gitattributes', '*.mjs text eol=lf\n');
  for (const path of HOOK_FILES) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(WORKSPACE, path), destination);
  }
  git(root, 'add', '-A');
  for (const shim of SHIMS) git(root, 'update-index', '--chmod=+x', '--', shim);
  git(root, 'commit', '-q', '-m', 'test: add hook fixture');
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function install(root) {
  const outcome = run(root);
  assert.equal(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
  return outcome;
}

test('foreign core.hooksPath blocks before config, bytes, or modes mutate', () => {
  const root = fixture('hook-owner');
  git(root, 'config', 'core.hooksPath', '.husky');
  const beforeStatus = git(root, 'status', '--porcelain');
  const beforeModes = SHIMS.map((path) => statSync(join(root, path)).mode);

  const outcome = run(root);

  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /already owned by \.husky/);
  assert.match(outcome.stderr, /no configuration or hook file was changed/);
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').trim(), '.husky');
  assert.equal(git(root, 'status', '--porcelain'), beforeStatus);
  assert.deepEqual(SHIMS.map((path) => statSync(join(root, path)).mode), beforeModes);
});

test('installation is idempotent when this workspace already owns the effective hook path', () => {
  const root = fixture('hook-idempotent');
  install(root);
  const beforeStatus = git(root, 'status', '--porcelain');
  const beforeModes = SHIMS.map((path) => statSync(join(root, path)).mode);

  const second = install(root);

  assert.match(second.stdout, /hooks armed:\s+YES/);
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').trim(), '.claude/hooks');
  assert.equal(git(root, 'status', '--porcelain'), beforeStatus);
  assert.deepEqual(SHIMS.map((path) => statSync(join(root, path)).mode), beforeModes);
});

test('--check fails when active checker bytes differ from the index', () => {
  const root = fixture('hook-mismatch');
  install(root);
  writeFileSync(join(root, '.claude/hooks/commit-msg-check.mjs'), '\n// unstaged mutation\n', { flag: 'a' });

  const outcome = run(root, '--check');

  assert.equal(outcome.status, 1);
  assert.match(outcome.stdout, /commit-msg checker:\s+DIFFERS FROM INDEX/);
  assert.match(outcome.stdout, /hooks armed:\s+NO/);
  assert.match(outcome.stderr, /Next action:.*run `node \.claude\/hooks\/install\.mjs`.*--check/);
});

test('every installer failure class has one concrete continuation', () => {
  for (const [reason, detail] of [
    ['doctor', 'ownership/file/mode'],
    ['hooks-path-read', 'git config --show-origin'],
    ['hooks-path-collision', 'choose the integration'],
    ['files', 'git add'],
    ['chmod', 'chmod +x .claude/hooks/commit-msg'],
    ['git-mode', 'stage the tested hook files'],
    ['config-set', 'git config --local core.hooksPath .claude/hooks'],
    ['verification', 'ownership/mode/byte'],
  ]) {
    const message = nextAction(reason, '.claude/hooks/commit-msg');
    assert.match(message, /^Next action:/);
    assert.ok(message.includes(detail), `${reason} continuation must include ${detail}`);
  }
});

test('--check distinguishes a missing file from an untracked file', () => {
  const missingRoot = fixture('hook-missing');
  install(missingRoot);
  unlinkSync(join(missingRoot, '.claude/hooks/pre-commit-check.mjs'));
  const missing = run(missingRoot, '--check');
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /pre-commit checker:\s+MISSING/);

  const untrackedRoot = fixture('hook-untracked');
  install(untrackedRoot);
  git(untrackedRoot, 'rm', '--cached', '-q', '--', '.claude/hooks/commit-msg-check.mjs');
  const untracked = run(untrackedRoot, '--check');
  assert.equal(untracked.status, 1);
  assert.match(untracked.stdout, /commit-msg checker:\s+UNTRACKED/);
});

test('--check compares filtered Git bytes, not raw CRLF worktree bytes', () => {
  const root = fixture('hook-crlf');
  install(root);
  const path = join(root, '.claude/hooks/commit-msg-check.mjs');
  const lf = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  writeFileSync(path, lf.replaceAll('\n', '\r\n'));

  const outcome = run(root, '--check');

  assert.equal(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
  assert.match(outcome.stdout, /commit-msg checker:\s+matches index/);
  assert.match(outcome.stdout, /hooks armed:\s+YES/);
});

test('--check passes only when ownership, files, modes, and filtered bytes match exactly', () => {
  const root = fixture('hook-pass');
  install(root);

  const outcome = run(root, '--check');

  assert.equal(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
  assert.match(outcome.stdout, /pre-commit shim:\s+matches index; mode 100755/);
  assert.match(outcome.stdout, /commit-msg shim:\s+matches index; mode 100755/);
  assert.match(outcome.stdout, /hooks armed:\s+YES/);
});
