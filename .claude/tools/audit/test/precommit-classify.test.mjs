import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyStagedPaths, operativeUncleanPaths } from '../../../hooks/pre-commit-check.mjs';

test('docs-only staged set is passive (suite skipped)', () => {
  const c = classifyStagedPaths(['docs/control-plane.md', 'docs/burn-in-censo-modelo.md', 'docs/control-plane.png']);
  assert.equal(c.allPassive, true);
  assert.deepEqual(c.operative, []);
});

test('fail-closed: every non-docs path is operative, including new surfaces', () => {
  const operativePaths = [
    '.claude/tools/audit/lib/census.mjs',
    '.claude/tools/audit/test/census.test.mjs',   // a test can teach the regression as correct
    '.claude/tools/audit/schema/policy.v1.json',
    '.claude/tools/audit/policies/anything.json',
    '.claude/tools/audit/enforcement.json',
    '.claude/settings.json',                       // the guard wiring
    '.claude/skills/gentle-ai-aporte/SKILL.md',    // a .md that IS operative
    '.claude/agents/gentle-ai-auditor.md',
    '.claude/hooks/pre-commit-check.mjs',          // the gate protects itself
    'REGLAS-APORTE.md',                            // a root .md, not under docs/
    'src/whatever.js',
  ];
  for (const p of operativePaths) {
    const c = classifyStagedPaths([p]);
    assert.equal(c.allPassive, false, `${p} must be operative`);
    assert.deepEqual(c.operative, [p]);
  }
});

test('mixed docs + operative runs the suite and names only the operative paths', () => {
  const c = classifyStagedPaths(['docs/x.md', '.claude/tools/audit/lib/y.mjs', 'docs/z.md']);
  assert.equal(c.allPassive, false);
  assert.deepEqual(c.operative, ['.claude/tools/audit/lib/y.mjs']);
});

test('an empty staged set is not passive — there is nothing to clear', () => {
  const c = classifyStagedPaths([]);
  assert.equal(c.allPassive, false);
  assert.equal(c.count, 0);
});

test('docs/ prefix must be exact — a lookalike outside docs/ is operative', () => {
  const c = classifyStagedPaths(['notdocs/x.md', 'src/docs/y.md']);
  assert.equal(c.allPassive, false);
  assert.deepEqual(c.operative, ['notdocs/x.md', 'src/docs/y.md']);
});

// --- subject guard: the suite runs on the worktree, the commit captures the index ---

test('operativeUncleanPaths flags operative index↔worktree divergence and untracked', () => {
  const lines = [
    'MM .claude/tools/audit/lib/x.mjs',       // staged then modified — unclean
    ' M .claude/settings.json',               // modified, not staged — unclean
    '?? .claude/tools/audit/lib/new.mjs',     // untracked operative — unclean
    'A  .claude/tools/audit/lib/staged.mjs',  // staged, worktree matches (Y=' ') — clean
    'M  .claude/tools/audit/lib/clean.mjs',   // staged modify, worktree matches — clean
    ' M docs/control-plane.md',               // doc modified — allowed to differ
    '?? docs/new.md',                         // doc untracked — allowed
  ];
  assert.deepEqual(operativeUncleanPaths(lines).sort(), [
    '.claude/settings.json',
    '.claude/tools/audit/lib/new.mjs',
    '.claude/tools/audit/lib/x.mjs',
  ].sort());
});

test('operativeUncleanPaths flags an operative side of a modified rename', () => {
  assert.deepEqual(operativeUncleanPaths(['RM docs/a.md -> .claude/tools/audit/lib/b.mjs']), ['.claude/tools/audit/lib/b.mjs']);
});

test('operativeUncleanPaths passes a fully-staged clean operative surface', () => {
  assert.deepEqual(operativeUncleanPaths(['M  .claude/tools/audit/lib/x.mjs', 'A  .claude/hooks/y.mjs', ' M docs/z.md']), []);
});
