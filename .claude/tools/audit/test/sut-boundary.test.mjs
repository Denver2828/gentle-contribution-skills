import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { attestSut, assertExternalSandboxPath, compareSutAttestations, decideSutCommand } from '../lib/sut-boundary.mjs';
import { canonicalProspectivePath } from './helpers/paths.mjs';
import { git } from './helpers/repo.mjs';

// Platform-native absolute roots: `resolve()` only treats 'C:/...' as absolute
// on win32, so a hard-coded Windows drive path is not absolute on POSIX and
// silently resolves against process.cwd() there instead of failing the way
// it should.
const outer = resolve(tmpdir(), 'gentle-work', 'gentle');
const sut = join(outer, 'src');
const sandboxSibling = resolve(tmpdir(), 'gentle-work', 'gentle-sandboxes', 'case');

test('sandbox paths must be outside both harness and nested SUT', () => {
  assert.throws(() => assertExternalSandboxPath({ outerRoot: outer, sutRoot: sut, candidate: `${outer}/worktree` }), /outside/);
  assert.throws(() => assertExternalSandboxPath({ outerRoot: outer, sutRoot: sut, candidate: `${sut}/tmp` }), /outside/);
  assert.equal(
    assertExternalSandboxPath({ outerRoot: outer, sutRoot: sut, candidate: sandboxSibling }),
    canonicalProspectivePath(sandboxSibling),
  );
});

test('SUT command guard allows known reads and denies writes or unknown execution', () => {
  const context = { outerRoot: outer, sutRoot: sut };
  for (const command of ['git -C src status --short', 'git -C C:/work/gentle/src diff', 'Get-Content src/README.md', 'rg TODO src']) {
    assert.equal(decideSutCommand(command, context).decision, 'allow', command);
  }
  for (const command of [
    'git -C src reset --hard', 'git -C src add .', 'Set-Content src/x y', 'go test ./src/...',
    'cat src/a | tee src/b', 'cat src/a >src/b', 'git -C src status >src/x', 'Get-Content src/a | tee src/b',
  ]) {
    const verdict = decideSutCommand(command, context);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /Next action:/);
  }
});

test('SUT command guard ignores src inside longer paths but still guards every SUT path form', () => {
  const context = { outerRoot: outer, sutRoot: sut };
  // Regression, lineage comment-3411-odd-gate-evidence: remote reads whose path
  // merely contains a `src` segment were denied as if they targeted the SUT.
  for (const command of [
    'gh api repos/openai/codex/contents/codex-rs/hooks/src/lib.rs?ref=36650394',
    'curl -sL https://raw.githubusercontent.com/o/r/abc/packages/app/src/index.ts',
    'node fetch.mjs codex-rs/core/src/hook_runtime.rs',
    'rg srcset docs',
  ]) {
    assert.equal(decideSutCommand(command, context).decision, 'allow', command);
  }
  for (const command of [
    'cat ./src/a >x', 'Set-Content "src/x" y', "Remove-Item 'src/x'", 'node tool.mjs --out=src/x',
    `Remove-Item ${sut}/x`, `node tool.mjs ${sut}`,
  ]) {
    const verdict = decideSutCommand(command, context);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /Next action:/);
  }
});

// W-3 (2026-10-01) deny table, kept through the W-3b revert: these denied
// before W-3, under it, and after it.
test('W-3: a harmless redirect does not excuse a write or a real redirect', () => {
  const context = { outerRoot: outer, sutRoot: sut };
  for (const command of [
    'git -C src status 2>&1 >src/x',
    'cat src/a >/dev/nullx',
    'cat src/a >/dev/null/x',
    'rm src/a 2>/dev/null',
    'cat src/a 2>/dev/null | tee src/b',
    'cat src/a 2>/dev/null >src/b',
    'git -C src status >& out.txt',
    'cat src/a 2>&1x',
    'git -C src status 2>&1 | tee log',
  ]) {
    const verdict = decideSutCommand(command, context);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /Next action:/);
  }
});

// W-3b (2026-10-01): adversarial MAJOR on W-3. Stripping the harmless
// redirects left the command looking simple, so a write beside them -- cp,
// sed -i, perl -pi, python, dd, install -- reached allow. W-3 is reverted:
// redirects are composition again, and the reads W-3 allowed (its former
// allow table) are accepted false positives.
test('W-3b: a write into src beside a discarded or duplicated stream denies', () => {
  const context = { outerRoot: outer, sutRoot: sut };
  for (const command of [
    'cat src/a 2>/dev/null\ncp x src/a',
    'git -C src log 2>&1 && sed -i s/a/b/ src/a',
    'git -C src log 2>&1 && perl -pi -e s/a/b/ src/a',
    'git -C src log >/dev/null && python -c "open(\'src/a\',\'w\')"',
    'git -C src log >/dev/null; dd of=src/a if=x',
    'rg x src >/dev/null 2>&1; install x src/a',
  ]) {
    const verdict = decideSutCommand(command, context);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /Next action:/);
  }
});

test('W-3b: SUT reads with fd redirects deny (accepted false positive)', () => {
  const context = { outerRoot: outer, sutRoot: sut };
  for (const command of [
    'git -C src rev-parse HEAD 2>&1',
    'git -C src status --short 2>/dev/null',
    'rg TODO src 2> /dev/null',
    'git -C src log -1 --oneline &>/dev/null',
    'git -C src diff >/dev/null 2>&1',
    'git -C src show HEAD:README.md >&2',
  ]) {
    assert.equal(decideSutCommand(command, context).decision, 'deny', command);
  }
});

test('external sandbox paths reject symlink or junction aliases into the outer repository', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sut-boundary-path-'));
  const realOuter = join(root, 'outer');
  const realSut = join(realOuter, 'src');
  const alias = join(root, 'outer-alias');
  mkdirSync(realSut, { recursive: true });
  try {
    try {
      symlinkSync(realOuter, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
      t.skip(`host refuses symlink/junction creation (${error.code}); alias-boundary behavior was NOT verified`);
      return;
    }
    assert.throws(
      () => assertExternalSandboxPath({ outerRoot: realOuter, sutRoot: realSut, candidate: join(alias, 'new-sandbox') }),
      /outside/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('read-only attestation detects a changed candidate and remains stable otherwise', () => {
  const root = mkdtempSync(join(tmpdir(), 'sut-attest-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://example.invalid/upstream.git']);
  writeFileSync(join(root, 'a.txt'), 'one\n');
  execFileSync('git', ['-C', root, 'add', 'a.txt']);
  git(root, 'commit', '-qm', 'test: seed');
  writeFileSync(join(root, 'staged.txt'), 'staged\n');
  execFileSync('git', ['-C', root, 'add', 'staged.txt']);
  const before = attestSut(root);
  assert.equal(compareSutAttestations(before, attestSut(root)).equal, true);
  writeFileSync(join(root, 'a.txt'), 'two\n');
  assert.equal(compareSutAttestations(before, attestSut(root)).equal, false);
});

test('PreToolUse adapter returns deny JSON for an SUT mutation', () => {
  const guard = fileURLToPath(new URL('../bin/sut-boundary-guard.mjs', import.meta.url));
  const out = spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git -C src clean -fd' } }), encoding: 'utf8',
  });
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
