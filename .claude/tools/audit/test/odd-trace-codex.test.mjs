// odd-trace-codex: Codex CLI rollout analog of odd-trace.test.mjs. Fixtures
// are small synthetic rollouts built line-by-line, matching the real shapes
// verified against ~/.codex/sessions (see the header comment in
// bin/odd-trace-codex.mjs and docs/odd-codex-trace.md for the evidence).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
  buildCodexReport,
  extractPatchedFiles,
  isSubagentMeta,
  isReviewerSubprocess,
  isStateReadCodexPayload,
  parseArgs,
  USAGE,
} from '../bin/odd-trace-codex.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'odd-trace-codex.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'odd-trace-codex-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;
const fresh = (name) => {
  const root = join(scratch, `${name}-${(sequence += 1)}`);
  mkdirSync(root, { recursive: true });
  return root;
};

// -- line builders, matching the real payload shapes verified on disk -------

const sessionMeta = ({
  id, sessionId = id, forkedFromId, threadSource, source = 'vscode', cwd = 'C:\\ExampleWorkspace\\projects', ts,
}) => JSON.stringify({
  timestamp: ts,
  type: 'session_meta',
  payload: {
    id,
    session_id: sessionId,
    ...(forkedFromId ? { forked_from_id: forkedFromId } : {}),
    ...(threadSource ? { thread_source: threadSource } : {}),
    source,
    cwd,
    originator: 'codex_work_desktop',
    cli_version: '0.155.0-alpha.9.2',
  },
});

const execCall = (ts, input) => JSON.stringify({
  timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input },
});

const functionCall = (ts, name, args = {}) => JSON.stringify({
  timestamp: ts,
  type: 'response_item',
  payload: { type: 'function_call', name, namespace: 'collaboration', arguments: JSON.stringify(args) },
});

const userMessage = (ts, text) => JSON.stringify({
  timestamp: ts,
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});

// A patch touching one file, encoded the way a double-quoted JS string
// literal carries it (line breaks are the literal two characters "\" "n").
const patchInput = (action, filePath) => `const patch = "*** Begin Patch\\n*** ${action} File: ${filePath}\\n@@\\n+line\\n*** End Patch";`;

const writeRollout = (dir, filename, lines) => writeFileSync(join(dir, filename), `${lines.join('\n')}\n`, 'utf8');

// -- extractPatchedFiles -------------------------------------------------------

test('extractPatchedFiles reads a single-file apply_patch diff (escaped-newline form)', () => {
  const input = patchInput('Update', '/repo/src/a.js');
  assert.deepEqual([...extractPatchedFiles(input)], ['/repo/src/a.js']);
});

test('extractPatchedFiles reads a multi-file diff and collapses doubled Windows backslashes', () => {
  // Built from raw characters (not hand-escaped literals) to avoid off-by-one
  // backslash-counting mistakes: `oneBackslash` is exactly one raw "\" char,
  // matching the single-backslash "\n" newline marker and the doubled "\\"
  // path separator verified byte-for-byte against real rollout files.
  const oneBackslash = '\\';
  const twoBackslashes = oneBackslash + oneBackslash;
  const preEvalPath1 = ['C:', 'ExampleWorkspace', 'file1.md'].join(twoBackslashes);
  const preEvalPath2 = ['C:', 'ExampleWorkspace', 'file2.md'].join(twoBackslashes);
  const nl = `${oneBackslash}n`; // the pre-eval "newline" marker: one backslash + 'n'
  const input = `const patch = "*** Begin Patch${nl}`
    + `*** Update File: ${preEvalPath1}${nl}@@${nl}+x${nl}`
    + `*** Add File: ${preEvalPath2}${nl}+y${nl}*** End Patch";`;

  const files = [...extractPatchedFiles(input)];
  const expectedPath1 = ['C:', 'ExampleWorkspace', 'file1.md'].join(oneBackslash);
  const expectedPath2 = ['C:', 'ExampleWorkspace', 'file2.md'].join(oneBackslash);
  assert.deepEqual(files, [expectedPath1, expectedPath2]);
});

test('extractPatchedFiles reads a template-literal diff carrying real newlines', () => {
  const input = 'const patch = `*** Begin Patch\n*** Update File: /repo/b.py\n@@\n+z\n*** End Patch`;';
  assert.deepEqual([...extractPatchedFiles(input)], ['/repo/b.py']);
});

test('extractPatchedFiles returns an empty set for exec input with no patch', () => {
  const input = 'const r = await tools.exec_command({cmd:"git status"});';
  assert.equal(extractPatchedFiles(input).size, 0);
});

// -- isSubagentMeta / isReviewerSubprocess ------------------------------------

test('isSubagentMeta is true for thread_source "subagent"', () => {
  assert.equal(isSubagentMeta({ thread_source: 'subagent', source: { subagent: {} } }), true);
});

test('isSubagentMeta is true for the pre-thread_source object-shaped source (older format)', () => {
  assert.equal(isSubagentMeta({ source: { subagent: { thread_spawn: {} } } }), true);
});

test('isSubagentMeta is false for a main-thread session forked across compaction', () => {
  // Verified against real data: forked_from_id alone does not mean sub-agent.
  assert.equal(isSubagentMeta({ thread_source: 'agent_forked_thread', source: 'vscode', forked_from_id: 'x' }), false);
});

test('isSubagentMeta is false for an ordinary user session with no thread_source', () => {
  assert.equal(isSubagentMeta({ source: 'vscode' }), false);
});

// -- OCM-5: isSubagentMeta matches only the documented sub-agent shape ------

test('isSubagentMeta is false for an array-shaped source (not the documented object shape)', () => {
  assert.equal(isSubagentMeta({ source: ['subagent'] }), false);
});

test('isSubagentMeta is false for an object-shaped source with no subagent key', () => {
  assert.equal(isSubagentMeta({ source: { other: {} } }), false);
});

test('isSubagentMeta is true for an object-shaped source carrying the subagent key', () => {
  assert.equal(isSubagentMeta({ source: { subagent: {} } }), true);
});

test('isReviewerSubprocess requires both the Temp cwd and an early GENTLE_AI_REVIEW_BINDING message', () => {
  const cwd = 'C:\\Users\\x\\AppData\\Local\\Temp\\gentle-ai-codex-reviewer-12345';
  assert.equal(isReviewerSubprocess(cwd, ['<recommended_plugins>...', 'GENTLE_AI_REVIEW_BINDING {"lineage":"r1"}']), true);
});

test('isReviewerSubprocess is false when the cwd matches but no early message carries the marker', () => {
  const cwd = 'C:\\Users\\x\\AppData\\Local\\Temp\\gentle-ai-codex-reviewer-12345';
  assert.equal(isReviewerSubprocess(cwd, ['just a normal task, nothing about review bindings']), false);
});

test('isReviewerSubprocess is false when the marker is present but the cwd does not match', () => {
  assert.equal(isReviewerSubprocess('C:\\ExampleWorkspace\\projects', ['GENTLE_AI_REVIEW_BINDING {}']), false);
});

// -- buildCodexReport: basic counting and delegation definition ---------------

test('spawn_agent counts as delegation and splits the streak; followup_task/send_message do not', () => {
  const dir = fresh('delegation-definition');
  writeRollout(dir, 'main.jsonl', [
    sessionMeta({ id: 'main', ts: '2026-09-20T00:00:00.000Z' }),
    execCall('2026-09-20T00:00:01.000Z', 'const r = await tools.exec_command({cmd:"git status"});'),
    functionCall('2026-09-20T00:00:02.000Z', 'spawn_agent', { task_name: 'child', message: 'go' }),
    functionCall('2026-09-20T00:00:03.000Z', 'wait_agent', { timeout_ms: 1000 }),
    functionCall('2026-09-20T00:00:04.000Z', 'followup_task', { target: '/root/child', message: 'more' }),
    functionCall('2026-09-20T00:00:05.000Z', 'send_message', { target: '/root/child', message: 'ping' }),
  ]);

  const report = buildCodexReport(dir, {});

  assert.equal(report.totals.sessions, 1);
  const s = report.sessions[0];
  assert.equal(s.delegations, 1, 'only spawn_agent counts as a delegation');
  assert.equal(s.toolCalls, 5, 'every custom_tool_call/function_call counts toward the backstop');
  assert.equal(s.streaks, 2, 'the delegation splits the streak into two non-empty streaks');
});

// -- sub-agent and reviewer-subprocess exclusion ------------------------------

test('a sub-agent rollout is excluded with a reason naming thread_source', () => {
  const dir = fresh('exclude-subagent');
  writeRollout(dir, 'sub.jsonl', [
    sessionMeta({ id: 'sub', threadSource: 'subagent', source: { subagent: { thread_spawn: {} } }, ts: '2026-09-20T00:00:00.000Z' }),
    execCall('2026-09-20T00:00:01.000Z', 'const r = 1;'),
  ]);
  writeRollout(dir, 'main.jsonl', [
    sessionMeta({ id: 'main', ts: '2026-09-20T00:00:00.000Z' }),
    execCall('2026-09-20T00:00:01.000Z', 'const r = 1;'),
  ]);

  const report = buildCodexReport(dir, {});

  assert.equal(report.totals.sessions, 1);
  assert.equal(report.sessions[0].sessionId, 'main');
  const excludedSub = report.excluded.find((e) => e.sessionId === 'sub');
  assert.match(excludedSub.reason, /sub-agent\/forked rollout/);
  assert.match(excludedSub.reason, /subagent/);
});

test('a main-thread session forked across compaction (agent_forked_thread) is NOT excluded as a sub-agent', () => {
  const dir = fresh('forked-not-subagent');
  writeRollout(dir, 'forked.jsonl', [
    sessionMeta({
      id: 'forked', forkedFromId: 'parent-thread', threadSource: 'agent_forked_thread', source: 'vscode',
      ts: '2026-09-20T00:00:00.000Z',
    }),
    execCall('2026-09-20T00:00:01.000Z', 'const r = 1;'),
  ]);

  const report = buildCodexReport(dir, {});

  assert.equal(report.totals.sessions, 1);
  assert.deepEqual(report.excluded, []);
});

test('a gentle-ai reviewer subprocess is excluded with its own reason', () => {
  const dir = fresh('exclude-reviewer');
  const reviewerCwd = 'C:\\Users\\x\\AppData\\Local\\Temp\\gentle-ai-codex-reviewer-999';
  writeRollout(dir, 'reviewer.jsonl', [
    sessionMeta({ id: 'reviewer', threadSource: 'user', cwd: reviewerCwd, ts: '2026-09-20T00:00:00.000Z' }),
    userMessage('2026-09-20T00:00:01.000Z', '<recommended_plugins>...'),
    userMessage('2026-09-20T00:00:02.000Z', 'GENTLE_AI_REVIEW_BINDING {"lineage":"r1"}'),
    execCall('2026-09-20T00:00:03.000Z', 'const r = 1;'),
  ]);

  const report = buildCodexReport(dir, {});

  assert.equal(report.totals.sessions, 0);
  assert.equal(report.excluded.length, 1);
  assert.match(report.excluded[0].reason, /gentle-ai reviewer subprocess/);
});

// -- valid-from and unknown start time, matching odd-trace.mjs semantics -----

test('--valid-from excludes an earlier rollout with its reason', () => {
  const dir = fresh('valid-from');
  writeRollout(dir, 'early.jsonl', [
    sessionMeta({ id: 'early', ts: '2026-09-01T00:00:00.000Z' }),
    execCall('2026-09-01T00:00:00.000Z', 'const r = 1;'),
  ]);
  writeRollout(dir, 'late.jsonl', [
    sessionMeta({ id: 'late', ts: '2026-09-20T00:00:00.000Z' }),
    execCall('2026-09-20T00:00:00.000Z', 'const r = 1;'),
  ]);

  const report = buildCodexReport(dir, { validFromIso: '2026-09-15T00:00:00.000Z' });

  assert.equal(report.totals.sessions, 1);
  assert.equal(report.sessions[0].sessionId, 'late');
  const excludedEarly = report.excluded.find((e) => e.sessionId === 'early');
  assert.match(excludedEarly.reason, /started before valid-from/);
});

test('a rollout with a tool call but no timestamped event is excluded as unknown, never as early', () => {
  const dir = fresh('unknown-start');
  writeRollout(dir, 'no-ts.jsonl', [
    JSON.stringify({ type: 'session_meta', payload: { id: 'no-ts', source: 'vscode' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'const r=1;' } }),
  ]);

  const report = buildCodexReport(dir, { validFromIso: '2026-09-15T00:00:00.000Z' });

  assert.equal(report.totals.sessions, 0);
  assert.equal(report.excluded.length, 1);
  assert.match(report.excluded[0].reason, /start time unknown/);
});

// -- OCM-5: an unparseable timestamp is ignored, never fails open -----------

test('a rollout whose only timestamp is unparseable is excluded as unknown, not counted as valid', () => {
  const dir = fresh('unparseable-timestamp');
  writeRollout(dir, 'bad-ts.jsonl', [
    sessionMeta({ id: 'bad-ts', ts: 'not-a-real-timestamp' }),
    execCall('not-a-real-timestamp', 'const r=1;'),
  ]);

  // Give the cutoff a value that a naive `Date.parse(NaN-ish) < validFromAt`
  // comparison would fail open on (any comparison against NaN is false, so
  // the old code let this rollout through as valid instead of excluding it).
  const report = buildCodexReport(dir, { validFromIso: '2026-09-15T00:00:00.000Z' });

  assert.equal(report.totals.sessions, 0);
  assert.equal(report.excluded.length, 1);
  assert.equal(report.excluded[0].sessionId, 'bad-ts');
  assert.match(report.excluded[0].reason, /start time unknown/);
});

test('firstTs and lastTs are chosen by actual time, not by line order or lexicographic string order', () => {
  const dir = fresh('timestamp-by-value');
  // Line 1 is 2026-09-20T09:00:00+02:00 == 07:00:00Z (the true earliest).
  // Line 2 is 2026-09-20T08:00:00Z, which sorts LEXICOGRAPHICALLY before
  // line 1's raw string ("...T08..." < "...T09...") despite being an hour
  // LATER in real time. Naive string min/max, or picking by line order,
  // would misreport line 2's string as firstTs; parsing to epoch ms picks
  // line 1 correctly.
  writeRollout(dir, 's.jsonl', [
    sessionMeta({ id: 's', ts: '2026-09-20T09:00:00.000+02:00' }),
    execCall('2026-09-20T09:00:00.000+02:00', 'const r=1;'),
    execCall('2026-09-20T08:00:00.000Z', 'const r=2;'),
  ]);

  const report = buildCodexReport(dir, {});

  assert.equal(report.totals.sessions, 1);
  assert.equal(report.sessions[0].firstTs, '2026-09-20T09:00:00.000+02:00');
  assert.equal(report.sessions[0].lastTs, '2026-09-20T08:00:00.000Z');
});

test('a rollout with no observable tool call is excluded, not silently dropped', () => {
  const dir = fresh('no-calls');
  writeRollout(dir, 'empty.jsonl', [
    sessionMeta({ id: 'empty', ts: '2026-09-20T00:00:00.000Z' }),
    userMessage('2026-09-20T00:00:01.000Z', 'hello'),
  ]);

  const report = buildCodexReport(dir, {});

  assert.equal(report.totals.sessions, 0);
  assert.equal(report.excluded.length, 1);
  assert.match(report.excluded[0].reason, /no observable tool call/);
  const corpusEntry = report.corpus.find((c) => c.sha256);
  assert.equal(corpusEntry.status, 'excluded');
});

test('a zero-call gentle-ai reviewer subprocess is excluded as a reviewer subprocess, not as generic "no observable tool call"', () => {
  const dir = fresh('zero-call-reviewer');
  const reviewerCwd = 'C:\\Users\\x\\AppData\\Local\\Temp\\gentle-ai-codex-reviewer-42';
  writeRollout(dir, 'reviewer.jsonl', [
    sessionMeta({ id: 'reviewer', threadSource: 'user', cwd: reviewerCwd, ts: '2026-09-20T00:00:00.000Z' }),
    userMessage('2026-09-20T00:00:01.000Z', '<recommended_plugins>...'),
    userMessage('2026-09-20T00:00:02.000Z', 'GENTLE_AI_REVIEW_BINDING {"lineage":"r1"}'),
    // No exec/function_call at all: this lens replies with a verdict directly.
  ]);

  const report = buildCodexReport(dir, {});

  assert.equal(report.excluded.length, 1);
  assert.match(report.excluded[0].reason, /gentle-ai reviewer subprocess/);
});

test('buildCodexReport throws on an invalid validFromIso instead of running uncut', () => {
  const dir = fresh('invalid-validfrom');
  writeRollout(dir, 'a.jsonl', [
    sessionMeta({ id: 'a', ts: '2026-09-20T00:00:00.000Z' }),
    execCall('2026-09-20T00:00:00.000Z', 'const r=1;'),
  ]);

  assert.throws(
    () => buildCodexReport(dir, { validFromIso: 'not-a-timestamp' }),
    /--valid-from value "not-a-timestamp" is not a valid ISO 8601 timestamp/,
  );
});

// -- --cwd-prefix selection -----------------------------------------------------

test('--cwd-prefix keeps only rollouts whose cwd matches, excluding the rest with their actual cwd', () => {
  const dir = fresh('cwd-prefix');
  writeRollout(dir, 'inside.jsonl', [
    sessionMeta({ id: 'inside', cwd: 'C:\\ExampleWorkspace\\projects\\sample-app', ts: '2026-09-20T00:00:00.000Z' }),
    execCall('2026-09-20T00:00:00.000Z', 'const r=1;'),
  ]);
  writeRollout(dir, 'outside.jsonl', [
    sessionMeta({ id: 'outside', cwd: 'C:\\Users\\x\\Documents\\Other', ts: '2026-09-20T00:00:00.000Z' }),
    execCall('2026-09-20T00:00:00.000Z', 'const r=1;'),
  ]);

  const report = buildCodexReport(dir, { cwdPrefix: 'C:\\ExampleWorkspace\\projects' });

  assert.equal(report.totals.sessions, 1);
  assert.equal(report.sessions[0].sessionId, 'inside');
  const excludedOutside = report.excluded.find((e) => e.sessionId === 'outside');
  assert.match(excludedOutside.reason, /does not match --cwd-prefix/);
  assert.match(excludedOutside.reason, /Documents\\Other/);
});

test('--cwd-prefix matching is case-insensitive and tolerant of forward slashes', () => {
  const dir = fresh('cwd-prefix-normalize');
  writeRollout(dir, 'a.jsonl', [
    sessionMeta({ id: 'a', cwd: 'c:/ExampleWorkspace/projects/sample-app', ts: '2026-09-20T00:00:00.000Z' }),
    execCall('2026-09-20T00:00:00.000Z', 'const r=1;'),
  ]);

  const report = buildCodexReport(dir, { cwdPrefix: 'C:\\ExampleWorkspace\\projects' });

  assert.equal(report.totals.sessions, 1);
});

// -- OCM-5: --cwd-prefix matches on a path-separator boundary ---------------

test('--cwd-prefix matches a cwd that is exactly equal to the prefix', () => {
  const dir = fresh('cwd-prefix-equal');
  writeRollout(dir, 'a.jsonl', [
    sessionMeta({ id: 'a', cwd: 'C:\\ExampleWorkspace\\projects', ts: '2026-09-20T00:00:00.000Z' }),
    execCall('2026-09-20T00:00:00.000Z', 'const r=1;'),
  ]);

  const report = buildCodexReport(dir, { cwdPrefix: 'C:\\ExampleWorkspace\\projects' });

  assert.equal(report.totals.sessions, 1);
});

test('--cwd-prefix rejects a sibling directory that merely shares the same leading characters', () => {
  const dir = fresh('cwd-prefix-sibling');
  writeRollout(dir, 'a.jsonl', [
    // "C:\A\projects" is a plain-startsWith substring of "C:\A\projectsX"
    // but is not that directory or an ancestor of it.
    sessionMeta({ id: 'a', cwd: 'C:\\ExampleWorkspace\\projectsX', ts: '2026-09-20T00:00:00.000Z' }),
    execCall('2026-09-20T00:00:00.000Z', 'const r=1;'),
  ]);

  const report = buildCodexReport(dir, { cwdPrefix: 'C:\\ExampleWorkspace\\projects' });

  assert.equal(report.totals.sessions, 0);
  const excluded = report.excluded.find((e) => e.sessionId === 'a');
  assert.match(excluded.reason, /does not match --cwd-prefix/);
});

// -- edits (apply_patch) and the writer/backstop thresholds --------------------

test('apply_patch edits are counted and distinct files cross the writer2Files threshold', () => {
  const dir = fresh('writer-threshold');
  writeRollout(dir, 's.jsonl', [
    sessionMeta({ id: 's', ts: '2026-09-20T00:00:00.000Z' }),
    execCall('2026-09-20T00:00:01.000Z', patchInput('Update', '/repo/a.js')),
    execCall('2026-09-20T00:00:02.000Z', patchInput('Update', '/repo/b.js')),
  ]);

  const report = buildCodexReport(dir, {});

  const s = report.sessions[0];
  assert.equal(s.editCallsObserved, 2);
  assert.equal(s.crossings.writer2Files, 1);
  assert.equal(s.crossings.edits2, 1);
});

test('a patch touching odd/tasks sets touchedOddTasks', () => {
  const dir = fresh('odd-tasks-touch');
  writeRollout(dir, 's.jsonl', [
    sessionMeta({ id: 's', ts: '2026-09-20T00:00:00.000Z' }),
    execCall('2026-09-20T00:00:01.000Z', patchInput('Update', '/repo/odd/tasks/feature.md')),
  ]);

  const report = buildCodexReport(dir, {});

  assert.equal(report.sessions[0].touchedOddTasks, true);
});

test('20 non-delegation calls cross the backstop and backstopFollowThrough counts extra calls before the delegation', () => {
  const dir = fresh('backstop');
  const lines = [sessionMeta({ id: 's', ts: '2026-09-20T00:00:00.000Z' })];
  for (let i = 0; i < 21; i += 1) {
    lines.push(execCall(`2026-09-20T00:00:${String(i).padStart(2, '0')}.000Z`, 'const r=1;'));
  }
  lines.push(functionCall('2026-09-20T00:00:21.000Z', 'spawn_agent', { task_name: 'x', message: 'go' }));
  writeRollout(dir, 's.jsonl', lines);

  const report = buildCodexReport(dir, {});

  assert.equal(report.sessions[0].crossings.calls20, 1);
  assert.equal(report.backstopFollowThrough.crossed, 1);
  assert.equal(report.backstopFollowThrough.followed, 1);
  assert.deepEqual(report.backstopFollowThrough.extraCallsPastThreshold, [1]);
});

test('a zero-call streak (back-to-back delegations) is reported as emptyStreaks, not in the streaks denominator', () => {
  const dir = fresh('empty-streak');
  writeRollout(dir, 's.jsonl', [
    sessionMeta({ id: 's', ts: '2026-09-20T00:00:00.000Z' }),
    execCall('2026-09-20T00:00:00.000Z', 'const r=1;'),
    functionCall('2026-09-20T00:00:01.000Z', 'spawn_agent', { task_name: 'x', message: 'go' }),
    functionCall('2026-09-20T00:00:02.000Z', 'spawn_agent', { task_name: 'y', message: 'go' }),
  ]);

  const report = buildCodexReport(dir, {});

  assert.equal(report.sessions[0].streaks, 1);
  assert.equal(report.sessions[0].emptyStreaks, 1);
  assert.equal(report.totals.emptyStreaksTotal, 1);
});

// -- corpus: single read, byte size and SHA-256 -------------------------------

test('corpus records bytes and SHA-256 for both valid and excluded rollouts, from one read', () => {
  const dir = fresh('corpus');
  writeRollout(dir, 'late.jsonl', [
    sessionMeta({ id: 'late', ts: '2026-09-20T00:00:00.000Z' }),
    execCall('2026-09-20T00:00:00.000Z', 'const r=1;'),
  ]);
  writeRollout(dir, 'early.jsonl', [
    sessionMeta({ id: 'early', ts: '2026-09-01T00:00:00.000Z' }),
    execCall('2026-09-01T00:00:00.000Z', 'const r=1;'),
  ]);

  const report = buildCodexReport(dir, { validFromIso: '2026-09-15T00:00:00.000Z' });

  assert.equal(report.corpus.length, 2);
  const byFile = Object.fromEntries(report.corpus.map((c) => [c.file, c]));
  const lateFile = Object.keys(byFile).find((f) => f.includes('late.jsonl'));
  const earlyFile = Object.keys(byFile).find((f) => f.includes('early.jsonl'));
  assert.equal(byFile[lateFile].status, 'valid');
  assert.equal(byFile[earlyFile].status, 'excluded');
  const expectedHash = createHash('sha256').update(readFileSync(join(dir, 'late.jsonl'))).digest('hex');
  assert.equal(byFile[lateFile].sha256, expectedHash);
  assert.ok(byFile[lateFile].bytes > 0);
});

// -- argument parsing and CLI ---------------------------------------------------

test('parseArgs recognizes --valid-from and --cwd-prefix in any order', () => {
  assert.deepEqual(parseArgs(['/dir', '--valid-from', '2026-09-18T11:32:56Z']), {
    dir: '/dir', validFrom: '2026-09-18T11:32:56Z', cwdPrefix: undefined,
  });
  assert.deepEqual(
    parseArgs(['--cwd-prefix', 'C:\\ExampleWorkspace\\projects', '/dir', '--valid-from', '2026-09-18T11:32:56Z']),
    { dir: '/dir', validFrom: '2026-09-18T11:32:56Z', cwdPrefix: 'C:\\ExampleWorkspace\\projects' },
  );
});

test('CLI: an invalid --valid-from ISO exits non-zero with the usage message', () => {
  const dir = fresh('cli-invalid-valid-from');
  const outcome = spawnSync(process.execPath, [CLI, dir, '--valid-from', 'not-a-timestamp'], { encoding: 'utf8' });

  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, new RegExp(USAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('CLI: no sessions-dir exits non-zero with the usage message', () => {
  const outcome = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, new RegExp(USAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('CLI: the full real command shape (dir, --valid-from, --cwd-prefix) succeeds and reports the cutoff', () => {
  const dir = fresh('cli-full-shape');
  writeRollout(dir, 'late.jsonl', [
    sessionMeta({ id: 'late', cwd: 'C:\\ExampleWorkspace\\projects', ts: '2026-09-20T00:00:00.000Z' }),
    execCall('2026-09-20T00:00:00.000Z', 'const r=1;'),
  ]);

  const outcome = spawnSync(process.execPath, [
    CLI, dir, '--valid-from', '2026-09-15T00:00:00Z', '--cwd-prefix', 'C:\\ExampleWorkspace\\projects',
  ], { encoding: 'utf8' });

  assert.equal(outcome.status, 0, outcome.stderr);
  const report = JSON.parse(outcome.stdout);
  assert.equal(report.validFrom, '2026-09-15T00:00:00.000Z');
  assert.equal(report.cwdPrefix, 'C:\\ExampleWorkspace\\projects');
  assert.equal(report.totals.sessions, 1);
});

// -- OTS-1: state reads left out of a second view of the backstop -----------

const shellCall = (ts, name, args) => JSON.stringify({
  timestamp: ts, type: 'response_item', payload: { type: 'function_call', name, arguments: JSON.stringify(args) },
});

const tsAt = (i) => `2026-09-20T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;

test('isStateReadCodexPayload reads exec_command calls embedded in an exec input', () => {
  const exec = (input) => ({ type: 'custom_tool_call', name: 'exec', input });
  assert.equal(isStateReadCodexPayload(exec('const r = await tools.exec_command({cmd:"git status"});')), true);
  assert.equal(isStateReadCodexPayload(exec(
    'const a = await tools.exec_command({ cmd: "git log -1", workdir: "C:\\\\repo", yield_time_ms: 1000 });\n'
    + "const b = await tools.exec_command({cmd:'gh pr view 1'});\nreturn b;",
  )), true);
  assert.equal(isStateReadCodexPayload(exec('const r = await tools.exec_command({cmd:"git commit -m x"});')), false);
  assert.equal(isStateReadCodexPayload(exec(
    'await tools.exec_command({cmd:"git status"}); await tools.exec_command({cmd:"gh issue comment 1 -b x"});',
  )), false, 'every embedded command must be a state read');
  assert.equal(isStateReadCodexPayload(exec(
    'const r = await tools.exec_command({cmd:"git status"}); await fs.writeFile("x", r);',
  )), false, 'any other statement makes the call unreadable');
  assert.equal(isStateReadCodexPayload(exec('const c = "git status"; await tools.exec_command({cmd:c});')), false);
  assert.equal(isStateReadCodexPayload(exec('await tools.exec_command({cmd:`git log ${x}`});')), false);
  assert.equal(isStateReadCodexPayload(exec(patchInput('Update', '/repo/a.js'))), false);
  assert.equal(isStateReadCodexPayload(exec('const r=1;')), false);
});

// OTS-3: the exec input shapes below are synthesized from the structure of
// real rollouts (a read-only census of ~/.codex/sessions, strings stripped);
// every command, path and key value here is invented.
test('OTS-3: real exec shapes with text(...) output statements are read', () => {
  const exec = (input) => ({ type: 'custom_tool_call', name: 'exec', input });
  const state = [
    // const r = await tools.exec_command({...}); text(r.output);
    'const r = await tools.exec_command({cmd:"git status","workdir":"C:\\\\repo","yield_time_ms":10000,"max_output_tokens":8000}); text(r.output);',
    'const r=await tools.exec_command({cmd:"git log -1",yield_time_ms:1000,max_output_tokens:2000});text(r.output);',
    'const r = await tools.exec_command({ cmd: "gh pr list", workdir: "/repo", yield_time_ms: 5000, max_output_tokens: 4000 }); text(r.output);',
    // every key quoted, including cmd, plus a boolean
    'const r = await tools.exec_command({"cmd":"git diff --stat","workdir":"/repo","login":false,"yield_time_ms":1000,"max_output_tokens":1000}); text(r.output);',
    // text(JSON.stringify(r))
    'const r = await tools.exec_command({cmd:"git status",workdir:"/repo"}); text(JSON.stringify(r));',
    'const r = await tools.exec_command({cmd:"git status"}); text(JSON.stringify(r, null, 2));',
    // text(await tools.exec_command({...}))
    'text(await tools.exec_command({cmd:"git log --oneline | head -5",max_output_tokens:500}));',
    'text(await tools.exec_command({cmd:"git status",shell:"bash",login:false,workdir:"/repo",max_output_tokens:500}));',
    // a trailing literal label and a concatenation
    'const r = await tools.exec_command({cmd:"git status"}); text(r.output); text(`done`);',
    'const a = await tools.exec_command({cmd:"git status"}); const b = await tools.exec_command({cmd:"gh pr view 1 --json title | jq .title"}); text(a.output + "\\n" + b.output);',
    'text(await tools.exec_command({cmd:"git status"})); text(await tools.exec_command({cmd:"git log -1"}));',
    'console.log(await tools.exec_command({cmd:"git status"}));',
  ];
  for (const input of state) assert.equal(isStateReadCodexPayload(exec(input)), true, input);

  const notState = [
    // two exec_command calls, one mutating
    'text(await tools.exec_command({cmd:"git status"})); text(await tools.exec_command({cmd:"git commit -m x"}));',
    'const r = await tools.exec_command({cmd:"git status"}); text(r.output); const w = await tools.exec_command({cmd:"git push"}); text(w.output);',
    // another tool in the same exec
    'text(await tools.apply_patch("*** Begin Patch\\n*** End Patch")); text(await tools.exec_command({cmd:"git status"}));',
    'text(await tools.write_stdin({session_id:1,chars:"q",yield_time_ms:100})); text(await tools.exec_command({cmd:"git status"}));',
    'text(await tools.exec_command({cmd:"git status"})); text(await tools.mcp__x__save({title:"t"}));',
    // variable or interpolated command
    'const cmd = `git status`; const r = await tools.exec_command({cmd,workdir:"/repo"}); text(r.output);',
    'const s = "x"; const r = await tools.exec_command({cmd:`git log ${s}`}); text(r.output);',
    'const s = "git status"; const r = await tools.exec_command({cmd:s}); text(r.output);',
    // a non-literal or computed text argument
    'const r = await tools.exec_command({cmd:"git status"}); text(r.output.replace(/a/g, "b"));',
    'const r = await tools.exec_command({cmd:"git status"}); text(fn(r));',
    'const r = await tools.exec_command({cmd:"git status"}); text(`${r.output}`);',
    // loops and other JS
    'for (const c of ["git status"]) text(await tools.exec_command({cmd:c}));',
    'text("hello");',
    // a filter command that is not a state read on its own
    'const r = await tools.exec_command({cmd:"rg foo file"}); text(r.output);',
  ];
  for (const input of notState) assert.equal(isStateReadCodexPayload(exec(input)), false, input);
});

test('isStateReadCodexPayload unwraps shell/exec_command function_call payloads', () => {
  const fc = (name, args) => ({ type: 'function_call', name, arguments: JSON.stringify(args) });
  assert.equal(isStateReadCodexPayload(fc('exec_command', { cmd: 'git status' })), true);
  assert.equal(isStateReadCodexPayload(fc('shell', { command: ['bash', '-lc', 'git log -1 && git status'] })), true);
  assert.equal(isStateReadCodexPayload(fc('shell', { command: ['powershell.exe', '-Command', 'gh pr list'] })), true);
  assert.equal(isStateReadCodexPayload(fc('shell', { command: ['git', 'status'] })), true);
  assert.equal(isStateReadCodexPayload(fc('shell', { command: ['bash', '-lc', 'git fetch'] })), false);
  assert.equal(isStateReadCodexPayload(fc('exec_command', { cmd: 'gh api -X POST repos/o/r/issues' })), false);
  assert.equal(isStateReadCodexPayload({ type: 'function_call', name: 'shell', arguments: '{not json' }), false);
  assert.equal(isStateReadCodexPayload(fc('wait_agent', { timeout_ms: 1 })), false);
  assert.equal(isStateReadCodexPayload(fc('spawn_agent', { task_name: 'x', message: 'git status' })), false);
});

test('a Codex streak of 25 calls with 10 state reads crosses the original backstop but not the excluding-state view', () => {
  const dir = fresh('state-reads-streak');
  const lines = [sessionMeta({ id: 's', ts: tsAt(0) })];
  for (let i = 0; i < 25; i += 1) {
    if (i % 5 === 0) lines.push(execCall(tsAt(i), 'const r = await tools.exec_command({cmd:"git status"});'));
    else if (i % 5 === 1) lines.push(shellCall(tsAt(i), 'shell', { command: ['bash', '-lc', 'gh pr view 1'] }));
    else lines.push(execCall(tsAt(i), 'const r=1;'));
  }
  lines.push(functionCall(tsAt(25), 'spawn_agent', { task_name: 'x', message: 'go' }));
  writeRollout(dir, 's.jsonl', lines);

  const report = buildCodexReport(dir, {});
  const s = report.sessions[0];

  assert.equal(s.crossings.calls20, 1, 'the original view is unchanged');
  assert.equal(report.backstopFollowThrough.crossed, 1);
  assert.equal(s.stateReads, 10);
  assert.equal(s.excludingStateReads.crossingsCalls20, 0);
  assert.equal(s.excludingStateReads.maxStreakCalls, 15);
  assert.equal(report.stateReadTotals.stateReads, 10);
  assert.equal(report.stateReadTotals.streaksCrossingCalls20ExcludingStateReads, 0);
  assert.equal(report.stateReadTotals.sessionsCrossingCalls20ExcludingStateReads, 0);
  assert.deepEqual(report.backstopFollowThroughExcludingStateReads, {
    crossed: 0, followed: 0, ranToEnd: 0, extraCallsPastThreshold: [],
  });
  assert.ok(Array.isArray(report.stateReadClassifier.git.allowedSubcommands));
  assert.match(report.stateReadClassifier.codexPayloads, /exec_command/);
  assert.equal(report.stateReadClassifier.version, 2, 'the report names the rule set that produced it');
});

test('existing Codex fields keep their exact values on a mixed fixture', () => {
  const dir = fresh('state-reads-existing-fields');
  writeRollout(dir, 's.jsonl', [
    sessionMeta({ id: 's', ts: tsAt(0) }),
    execCall(tsAt(1), 'const r = await tools.exec_command({cmd:"git status"});'),
    execCall(tsAt(2), patchInput('Update', '/repo/a.js')),
    execCall(tsAt(3), patchInput('Add', '/repo/b.js')),
    functionCall(tsAt(4), 'spawn_agent', { task_name: 'x', message: 'go' }),
    execCall(tsAt(5), 'const r=1;'),
  ]);

  const report = buildCodexReport(dir, {});

  assert.deepEqual(report.totals, {
    sessions: 1,
    toolCalls: 5,
    delegations: 1,
    sessionsWithZeroDelegation: 0,
    sessionsCrossingCalls20: 0,
    sessionsCrossingEdits2: 1,
    sessionsCrossingWriter2: 1,
    streaksTotal: 2,
    emptyStreaksTotal: 0,
    streaksCrossingCalls20: 0,
    streaksCrossingEdits2: 1,
    sessionsTouchingOddTasks: 0,
    editCallsObservedTotal: 2,
  });
  assert.deepEqual(report.backstopFollowThrough, { crossed: 0, followed: 0, ranToEnd: 0, extraCallsPastThreshold: [] });
  const [detail] = Object.values(report.streakDetail);
  assert.deepEqual(detail, [
    {
      startIndex: 0, calls: 3, edits: 2, distinctEditFiles: 2,
      crossedAt: { edits: 2, writerFiles: 2 }, closedBy: { index: 3, name: 'spawn_agent' },
    },
    { startIndex: 4, calls: 1, edits: 0, distinctEditFiles: 0, crossedAt: {}, closedBy: null },
  ]);
  assert.equal(report.sessions[0].stateReads, 1);
});
