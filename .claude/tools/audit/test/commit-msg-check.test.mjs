import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFinalTrailers, validateCommitMessage } from '../../../hooks/commit-msg-check.mjs';
import { commit, git, initRepo, makeDirectory, repoWithCommit, write } from './helpers/repo.mjs';
import { subjectGrammarHistory } from './helpers/subject-grammar-ref.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, '..', '..', '..', '..');
const CHECKER = join(WORKSPACE, '.claude', 'hooks', 'commit-msg-check.mjs');

const valid = (message) => assert.deepEqual(validateCommitMessage(message).errors, []);
const invalid = (message, pattern) => {
  const result = validateCommitMessage(message);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), pattern);
};

test('the real repository history satisfies the deterministic subject grammar', () => {
  const subjects = subjectGrammarHistory(WORKSPACE);
  assert.ok(subjects.length > 0, 'the repository must expose at least one real subject');
  for (const subject of subjects) {
    assert.equal(validateCommitMessage(subject).valid, true, `historical subject must stay valid: ${subject}`);
  }
});

test('subject-grammar ref selection: SUBJECT_GRAMMAR_REF unset reads HEAD, as before', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'subject-grammar-unset');
  assert.deepEqual(subjectGrammarHistory(root, {}), ['initial commit']);
});

test('subject-grammar ref selection: a valid existing ref reads that ref\'s own history', () => {
  const root = initRepo('subject-grammar-valid');
  write(root, 'a.txt', 'alpha\n');
  git(root, 'add', '-A');
  const first = commit(root, 'feat: first');
  write(root, 'b.txt', 'beta\n');
  git(root, 'add', '-A');
  commit(root, 'feat: second');

  assert.deepEqual(subjectGrammarHistory(root, { SUBJECT_GRAMMAR_REF: first }), ['feat: first']);
});

test('subject-grammar ref selection: a ref that does not resolve fails closed, never falls back to HEAD', () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'subject-grammar-missing');
  const missingSha = '0'.repeat(40);
  assert.throws(
    () => subjectGrammarHistory(root, { SUBJECT_GRAMMAR_REF: missingSha }),
    /does not resolve to a commit.*\(fail closed, no fallback to HEAD\)/,
  );
});

test('subject-grammar ref selection: a malformed value is rejected before it reaches git', () => {
  for (const bad of ['-x', '../escape', 'a b', 'a..b', 'HEAD~1', 'refs/heads/x:y', 'a//b', 'a.']) {
    assert.throws(
      () => subjectGrammarHistory('.', { SUBJECT_GRAMMAR_REF: bad }),
      /not a safe Git ref shape/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test('ordinary, scoped, and breaking conventional subjects pass without a type whitelist', () => {
  for (const subject of [
    'feat: add deterministic message policy',
    'fix(hooks): preserve the active owner',
    'governance(policy)!: tighten the publication boundary',
  ]) valid(subject);
});

test('fixup and squash pass only when their inner subject is conventional', () => {
  valid('fixup! fix(hooks): preserve the active owner');
  valid('squash! feat: add deterministic message policy');
  invalid('fixup! preserve the active owner', /subject must match/);
  invalid('squash! Merge branch main', /subject must match/);
});

test('arbitrary merge, revert, uppercase, and malformed subjects remain invalid', () => {
  for (const subject of [
    'Merge branch main',
    'Revert "feat: old change"',
    'Feat: uppercase type',
    'fix missing separator',
    'fix: ',
  ]) invalid(subject, /subject must match/);
});

test('normal body text and Git comment lines are ignored', () => {
  valid(`# Please enter the commit message\nfeat(docs): explain the gate\n\nA normal body may contain colons: freely.\n# Co-Authored-By: ChatGPT\n`);
});

test('only a real final trailer block is interpreted as trailers', () => {
  valid([
    'docs: explain attribution examples',
    '',
    'Reviewed-by: OpenAI Codex',
    'This is body prose, not a trailer block.',
    '',
    'The final paragraph is ordinary body text.',
  ].join('\n'));

  invalid([
    'docs: explain attribution examples',
    '',
    'Reviewed-by: OpenAI Codex appears in the body.',
    'This paragraph is free-form prose.',
    '',
    'Signed-off-by: Human Person <human@example.invalid>',
    'Reviewed-by: OpenAI Codex',
  ].join('\n'), /Reviewed-by names an AI tool/);
});

test('final trailer extraction accepts continuations and rejects mixed final prose', () => {
  assert.deepEqual(extractFinalTrailers([
    'fix: subject',
    '',
    'Reviewed-by: Human Person',
    ' details continued here',
  ]), [{ key: 'Reviewed-by', value: 'Human Person\ndetails continued here' }]);
  assert.deepEqual(extractFinalTrailers([
    'fix: subject',
    '',
    'Reviewed-by: OpenAI Codex',
    'This is body prose.',
  ]), []);
});

test('Co-Authored-By is always rejected, including a human value', () => {
  invalid('fix: one owner\n\nCo-Authored-By: Human Person <human@example.invalid>\n', /Co-Authored-By/);
});

test('bounded AI-attribution trailers are rejected', () => {
  for (const trailer of [
    'Assisted-by: Claude Code',
    'AI-Generated-By: ChatGPT',
    'Reviewed-by: OpenAI Codex',
    'Signed-off-by: OpenAI Codex <bot@example.invalid>',
  ]) invalid(`fix: one owner\n\n${trailer}\n`, /AI|AI tool|AI-attribution/);
});

test('legitimate human trailers remain valid, including human first names shared with models', () => {
  valid([
    'fix: preserve human trailers',
    '',
    'Signed-off-by: contributor Person <contributor@example.invalid>',
    'Reviewed-by: Claude Dupont <claude@example.invalid>',
    'Tested-by: Gemini Jones <gemini@example.invalid>',
    'Reviewed-by: Ai Nguyen <ai@example.invalid>',
  ].join('\n'));
});

test('unambiguous AI role phrases remain rejected without treating Ai as a model name', () => {
  for (const value of ['AI assistant', 'AI agent', 'AI model', 'AI tool', 'AI system']) {
    invalid(`fix: preserve human names\n\nReviewed-by: ${value}\n`, /AI tool or model/);
  }
});

test('CLI failure exits 1 and names the correction and retry action', () => {
  const root = makeDirectory('commit-message');
  const message = write(root, 'COMMIT_EDITMSG', 'not conventional\n');
  const outcome = spawnSync(process.execPath, [CHECKER, message], { cwd: root, encoding: 'utf8' });
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /commit-msg: BLOCKED/);
  assert.match(outcome.stderr, /Next action: edit/);
  assert.match(outcome.stderr, /retry git commit/);
});
