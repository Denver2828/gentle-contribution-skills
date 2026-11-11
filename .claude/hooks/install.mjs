#!/usr/bin/env node
// Installer and doctor for the workspace Git hooks.
//
// The hooks are versioned under .claude/hooks. Installation may claim Git's
// hook path only when no other owner is configured; it never composes scripts,
// stores a fictional rollback value, or overwrites another hook manager. The
// doctor verifies the active bytes against the index using `git hash-object
// --path`, so clean filters and CRLF normalization have the same semantics Git
// uses when staging the file.
//
//   node .claude/hooks/install.mjs
//   node .claude/hooks/install.mjs --check

import { spawnSync } from 'node:child_process';
import { existsSync, chmodSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOOKS_DIR = '.claude/hooks';
const HOOKS = Object.freeze([
  Object.freeze({ name: 'pre-commit', shim: `${HOOKS_DIR}/pre-commit`, checker: `${HOOKS_DIR}/pre-commit-check.mjs` }),
  Object.freeze({ name: 'commit-msg', shim: `${HOOKS_DIR}/commit-msg`, checker: `${HOOKS_DIR}/commit-msg-check.mjs` }),
]);
const IS_POSIX = process.platform !== 'win32';

export function nextAction(reason, path = '') {
  switch (reason) {
    case 'doctor':
      return 'Next action: correct the reported ownership/file/mode mismatch, run `node .claude/hooks/install.mjs`, then re-run with `--check`.';
    case 'hooks-path-read':
      return 'Next action: run `git config --show-origin --get core.hooksPath`, resolve the reported Git configuration error, then retry this installer.';
    case 'hooks-path-collision':
      return 'Next action: inspect that hook owner and choose the integration explicitly; no configuration or hook file was changed.';
    case 'files':
      return 'Next action: restore missing files, then `git add` the tested hook files (or `git restore --` unintended edits) and re-run this installer.';
    case 'chmod':
      return `Next action: fix filesystem permissions or run \`chmod +x ${path}\`, then retry this installer.`;
    case 'git-mode':
      return 'Next action: stage the tested hook files, then re-run this installer.';
    case 'config-set':
      return `Next action: run \`git config --local core.hooksPath ${HOOKS_DIR}\`, then retry this installer.`;
    case 'verification':
      return 'Next action: correct the reported ownership/mode/byte mismatch, re-run this installer, then verify with `--check`.';
    default:
      throw new TypeError(`unknown continuation reason: ${reason}`);
  }
}

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

function effectiveHooksPath() {
  const value = git(['config', '--get', 'core.hooksPath']);
  if (value.status === 1) return { value: '', origin: '(none)', error: null };
  if (value.status !== 0) {
    return { value: '', origin: '(unknown)', error: (value.stderr || '').trim() || `git exit ${value.status}` };
  }

  const configured = value.stdout.trim();
  const withOrigin = git(['config', '--show-origin', '--get', 'core.hooksPath']);
  if (withOrigin.status !== 0) {
    return { value: configured, origin: '(unknown)', error: (withOrigin.stderr || '').trim() || `git exit ${withOrigin.status}` };
  }
  const line = withOrigin.stdout.trim().split(/\r?\n/).at(-1) ?? '';
  const tab = line.indexOf('\t');
  return { value: configured, origin: tab === -1 ? '(unknown)' : line.slice(0, tab), error: null };
}

function indexEntry(path) {
  const result = git(['ls-files', '-s', '--', path]);
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const match = result.stdout.trim().match(/^(\d{6}) ([0-9a-f]{40,64}) 0\t/);
  return match === null ? null : { mode: match[1], oid: match[2] };
}

function worktreeOid(path) {
  if (!existsSync(join(process.cwd(), path))) return null;
  const result = git(['hash-object', `--path=${path}`, path]);
  return result.status === 0 ? result.stdout.trim() : null;
}

function fsExecutable(path) {
  if (!IS_POSIX) return true;
  try { accessSync(join(process.cwd(), path), constants.X_OK); return true; } catch { return false; }
}

function fileState(path, executable) {
  const present = existsSync(join(process.cwd(), path));
  const entry = indexEntry(path);
  const worktree = worktreeOid(path);
  return {
    path,
    present,
    tracked: entry !== null,
    mode: entry?.mode ?? null,
    gitExec: !executable || entry?.mode === '100755',
    fsExec: !executable || fsExecutable(path),
    indexOid: entry?.oid ?? null,
    worktreeOid: worktree,
    bytesMatch: entry !== null && worktree !== null && entry.oid === worktree,
  };
}

function state() {
  const configured = effectiveHooksPath();
  const hooks = HOOKS.map((hook) => ({
    name: hook.name,
    shim: fileState(hook.shim, true),
    checker: fileState(hook.checker, false),
  }));
  const files = hooks.flatMap((hook) => [hook.shim, hook.checker]);
  return {
    configured,
    hooks,
    armed: configured.error === null
      && configured.value === HOOKS_DIR
      && files.every((file) => file.present && file.tracked && file.bytesMatch && file.gitExec && file.fsExec),
  };
}

function identityLabel(file) {
  if (!file.present) return 'MISSING';
  if (!file.tracked) return 'UNTRACKED';
  return file.bytesMatch ? 'matches index' : 'DIFFERS FROM INDEX';
}

function report(current) {
  const suffix = current.configured.error === null ? '' : ` (ERROR: ${current.configured.error})`;
  console.log(`core.hooksPath:        ${current.configured.value || '(unset)'}${suffix}`);
  console.log(`core.hooksPath origin: ${current.configured.origin}`);
  for (const hook of current.hooks) {
    const fs = IS_POSIX ? (hook.shim.fsExec ? 'yes' : 'NO') : 'n/a (Windows)';
    console.log(`${hook.name} shim:       ${identityLabel(hook.shim)}; mode ${hook.shim.mode || '(not in index)'}; fs executable ${fs}`);
    console.log(`${hook.name} checker:    ${identityLabel(hook.checker)}`);
  }
  console.log(`hooks armed:           ${current.armed ? 'YES' : 'NO'}`);
}

function stopForCollision(configured) {
  console.error(`install: BLOCKED — core.hooksPath is already owned by ${configured.value} (${configured.origin}).`);
  console.error(nextAction('hooks-path-collision'));
  process.exit(1);
}

function stopForFiles(current) {
  const files = current.hooks.flatMap((hook) => [hook.shim, hook.checker]);
  const missing = files.filter((file) => !file.present).map((file) => file.path);
  const untracked = files.filter((file) => file.present && !file.tracked).map((file) => file.path);
  const different = files.filter((file) => file.present && file.tracked && !file.bytesMatch).map((file) => file.path);

  if (missing.length > 0) console.error(`install: missing required hook file(s): ${missing.join(', ')}`);
  if (untracked.length > 0) console.error(`install: hook file(s) are not in the index: ${untracked.join(', ')}`);
  if (different.length > 0) console.error(`install: active hook bytes differ from the index: ${different.join(', ')}`);
  if (missing.length > 0 || untracked.length > 0 || different.length > 0) {
    console.error(nextAction('files'));
    process.exit(1);
  }
}

function main() {
  const checkOnly = process.argv.includes('--check');
  let current = state();
  if (checkOnly) {
    report(current);
    if (!current.armed) console.error(nextAction('doctor'));
    process.exit(current.armed ? 0 : 1);
  }

  if (current.configured.error !== null) {
    console.error(`install: could not resolve effective core.hooksPath (${current.configured.error}); failing closed.`);
    console.error(nextAction('hooks-path-read'));
    process.exit(1);
  }
  if (current.configured.value && current.configured.value !== HOOKS_DIR) stopForCollision(current.configured);
  stopForFiles(current);

  // Filesystem and index modes are changed only after ownership and byte
  // identity have passed. A collision therefore leaves every hook byte/mode
  // and the Git configuration untouched.
  if (IS_POSIX) {
    for (const hook of HOOKS) {
      try { chmodSync(join(process.cwd(), hook.shim), 0o755); }
      catch (error) {
        console.error(`install: could not chmod +x ${hook.shim} (${error.message}).`);
        console.error(nextAction('chmod', hook.shim));
        process.exit(1);
      }
    }
  }

  for (const hook of current.hooks) {
    if (hook.shim.mode === '100755') continue;
    const chmod = git(['update-index', '--chmod=+x', '--', hook.shim.path]);
    if (chmod.status !== 0) {
      console.error(`install: could not set git mode +x on ${hook.shim.path} (${(chmod.stderr || '').trim() || 'git failed'}).`);
      console.error(nextAction('git-mode'));
      process.exit(1);
    }
  }

  if (!current.configured.value) {
    const set = git(['config', '--local', 'core.hooksPath', HOOKS_DIR]);
    if (set.status !== 0) {
      console.error(`install: failed to set core.hooksPath (${(set.stderr || '').trim()})`);
      console.error(nextAction('config-set'));
      process.exit(1);
    }
  }

  current = state();
  report(current);
  if (!current.armed) {
    console.error('install: verification FAILED — active hook ownership, modes, or bytes do not match the index.');
    console.error(nextAction('verification'));
    process.exit(1);
  }
  console.log('install: hooks armed.');
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (invokedDirectly) main();
