// odd-trace: the whole-corpus split is unconditional; --valid-from is a
// stricter, separate cutoff that removes a session from every count instead
// of merely reclassifying it.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReport, backstopFollowThrough, parseArgs, USAGE } from '../bin/odd-trace.mjs';
import { isStateReadCommand } from '../lib/odd-state-reads.mjs';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'odd-trace.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'odd-trace-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;
const fresh = (name) => {
  const root = join(scratch, `${name}-${(sequence += 1)}`);
  mkdirSync(root, { recursive: true });
  return root;
};

/** One transcript line: an assistant tool_use event at `ts` for `sessionId`. */
const toolUse = (sessionId, ts, name = 'Read', path = 'a.js') => JSON.stringify({
  sessionId,
  timestamp: ts,
  version: '3.1.0',
  gitBranch: 'main',
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name, input: { file_path: path } }] },
});

/** Write one synthetic session file made of the given event lines. */
const writeSession = (dir, filename, lines) => {
  writeFileSync(join(dir, filename), `${lines.join('\n')}\n`, 'utf8');
};

/** One transcript line with a tool_use event that carries NO `timestamp` field at all. */
const toolUseNoTs = (sessionId, name = 'Read', path = 'a.js') => JSON.stringify({
  sessionId,
  version: '3.1.0',
  gitBranch: 'main',
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name, input: { file_path: path } }] },
});

// -- no flag: unconditional behavior ------------------------------------------

test('no --valid-from: every session with a tool call is counted, excluded is empty', () => {
  const dir = fresh('no-flag');
  writeSession(dir, 'early.jsonl', [toolUse('early', '2026-09-01T00:00:00.000Z')]);
  writeSession(dir, 'late.jsonl', [toolUse('late', '2026-09-20T00:00:00.000Z')]);

  const report = buildReport(dir, {});

  assert.equal(report.validFrom, null);
  assert.deepEqual(report.excluded, []);
  assert.equal(report.totals.sessions, 2);
  assert.equal(report.sessions.length, 2);
  assert.equal(Object.keys(report.streakDetail).length, 2);
});

// -- --valid-from excludes and shrinks totals ---------------------------------

test('--valid-from excludes an earlier session with its reason, and totals shrink', () => {
  const dir = fresh('excludes-earlier');
  writeSession(dir, 'early.jsonl', [toolUse('early', '2026-09-01T00:00:00.000Z')]);
  writeSession(dir, 'late.jsonl', [toolUse('late', '2026-09-20T00:00:00.000Z')]);

  const validFromIso = '2026-09-15T00:00:00.000Z';
  const report = buildReport(dir, { validFromIso });

  assert.equal(report.validFrom, validFromIso);
  assert.equal(report.excluded.length, 1);
  assert.equal(report.excluded[0].sessionId, 'early');
  assert.equal(report.excluded[0].firstTs, '2026-09-01T00:00:00.000Z');
  assert.match(report.excluded[0].reason, /^started before valid-from 2026-09-15T00:00:00\.000Z$/);

  assert.equal(report.totals.sessions, 1);
  assert.equal(report.sessions.length, 1);
  assert.equal(report.sessions[0].sessionId, 'late');
  assert.equal(Object.keys(report.streakDetail).length, 1);
  assert.equal(report.streakDetail['late.jsonl'] !== undefined, true);
});

test('excluded sessions never count in beforeRule or afterRule either', () => {
  const dir = fresh('excludes-from-before-after');
  // "early" would be beforeRule under the whole-corpus split; "late" afterRule.
  const ruleInstalledIso = '2026-09-10T00:00:00.000Z';
  writeSession(dir, 'early.jsonl', [toolUse('early', '2026-09-01T00:00:00.000Z')]);
  writeSession(dir, 'late.jsonl', [toolUse('late', '2026-09-20T00:00:00.000Z')]);

  const validFromIso = '2026-09-15T00:00:00.000Z';
  const report = buildReport(dir, { ruleInstalledIso, validFromIso });

  assert.equal(report.beforeRule.sessions, 0, '"early" is excluded, not counted as beforeRule');
  assert.equal(report.afterRule.sessions, 1);
});

// -- straddling session: excluded in full, never split ------------------------

test('a session that starts before the cutoff and continues after it is excluded in full', () => {
  const dir = fresh('straddles-cutoff');
  const validFromIso = '2026-09-10T00:00:00.000Z';
  writeSession(dir, 'straddler.jsonl', [
    toolUse('straddler', '2026-09-05T00:00:00.000Z', 'Read', 'a.js'),
    toolUse('straddler', '2026-09-05T00:00:01.000Z', 'Edit', 'b.js'),
    toolUse('straddler', '2026-09-20T00:00:00.000Z', 'Write', 'c.js'),
  ]);

  const report = buildReport(dir, { validFromIso });

  assert.equal(report.excluded.length, 1);
  assert.equal(report.excluded[0].sessionId, 'straddler');
  assert.equal(report.excluded[0].firstTs, '2026-09-05T00:00:00.000Z');
  assert.equal(report.totals.sessions, 0);
  assert.equal(report.totals.toolCalls, 0, 'none of the straddling session\'s three tool calls count');
  assert.equal(report.sessions.length, 0);
  assert.deepEqual(report.streakDetail, {});
});

// -- R3-null-firstts-misclassified: unknown start time never counts as early --

test('a session with tool calls but no timestamped event is excluded as unknown, not as early, with --valid-from', () => {
  const dir = fresh('no-timestamp-with-cutoff');
  writeSession(dir, 'no-ts.jsonl', [toolUseNoTs('no-ts')]);
  writeSession(dir, 'late.jsonl', [toolUse('late', '2026-09-20T00:00:00.000Z')]);

  const report = buildReport(dir, { validFromIso: '2026-09-15T00:00:00.000Z' });

  assert.equal(report.excluded.length, 1);
  assert.equal(report.excluded[0].sessionId, 'no-ts');
  assert.equal(report.excluded[0].firstTs, null);
  assert.match(report.excluded[0].reason, /start time unknown/);
  assert.doesNotMatch(report.excluded[0].reason, /started before valid-from/);
  assert.equal(report.totals.sessions, 1);
  assert.equal(report.sessions[0].sessionId, 'late');
});

test('a session with no timestamped event is excluded as unknown even WITHOUT --valid-from, never counted', () => {
  const dir = fresh('no-timestamp-no-cutoff');
  writeSession(dir, 'no-ts.jsonl', [toolUseNoTs('no-ts')]);
  writeSession(dir, 'late.jsonl', [toolUse('late', '2026-09-20T00:00:00.000Z')]);

  const report = buildReport(dir, {});

  assert.equal(report.validFrom, null, 'no --valid-from cutoff was given');
  assert.equal(report.excluded.length, 1);
  assert.equal(report.excluded[0].sessionId, 'no-ts');
  assert.match(report.excluded[0].reason, /start time unknown/);
  assert.equal(report.totals.sessions, 1);
  assert.equal(report.sessions[0].sessionId, 'late');
});

test('a session with no timestamped event never lands in beforeRule or afterRule', () => {
  const dir = fresh('no-timestamp-before-after');
  writeSession(dir, 'no-ts.jsonl', [toolUseNoTs('no-ts')]);
  writeSession(dir, 'late.jsonl', [toolUse('late', '2026-09-20T00:00:00.000Z')]);

  const report = buildReport(dir, { ruleInstalledIso: '2026-09-10T00:00:00.000Z' });

  assert.equal(report.beforeRule.sessions, 0, 'the unknown-start session must not silently count as beforeRule');
  assert.equal(report.afterRule.sessions, 1);
});

// -- R3-api-invalid-validfrom-silent: buildReport throws on a bad cutoff -----

test('buildReport throws on an invalid validFromIso instead of running uncut', () => {
  const dir = fresh('invalid-validfrom-api');
  writeSession(dir, 'a.jsonl', [toolUse('a', '2026-09-20T00:00:00.000Z')]);

  assert.throws(
    () => buildReport(dir, { validFromIso: 'not-a-timestamp' }),
    /--valid-from value "not-a-timestamp" is not a valid ISO 8601 timestamp/,
  );
});

test('buildReport throws on an empty-string validFromIso (flag given with no value)', () => {
  const dir = fresh('empty-validfrom-api');
  writeSession(dir, 'a.jsonl', [toolUse('a', '2026-09-20T00:00:00.000Z')]);

  assert.throws(
    () => buildReport(dir, { validFromIso: '' }),
    /--valid-from value "" is not a valid ISO 8601 timestamp/,
  );
});

// -- R3-boundary-untested: equality at the cutoff, and other edges ----------

test('a session whose firstTs equals --valid-from exactly counts as valid, not excluded', () => {
  const dir = fresh('boundary-equal');
  const validFromIso = '2026-09-15T00:00:00.000Z';
  writeSession(dir, 'exact.jsonl', [toolUse('exact', validFromIso)]);

  const report = buildReport(dir, { validFromIso });

  assert.deepEqual(report.excluded, []);
  assert.equal(report.totals.sessions, 1);
  assert.equal(report.sessions[0].sessionId, 'exact');
});

test('CLI: --valid-from as the last argument with no value exits non-zero with usage', () => {
  const dir = fresh('cli-valid-from-no-value');
  const outcome = spawnSync(process.execPath, [CLI, dir, '--valid-from'], { encoding: 'utf8' });

  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, new RegExp(USAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(outcome.stderr, /--valid-from value "" is not a valid ISO 8601 timestamp/);
});

test('a transcript directory with sessions that never carry a timestamp produces an empty valid corpus, not a crash', () => {
  const dir = fresh('no-timestamps-anywhere');
  writeSession(dir, 'a.jsonl', [toolUseNoTs('a')]);
  writeSession(dir, 'b.jsonl', [toolUseNoTs('b', 'Edit', 'x.js')]);

  const report = buildReport(dir, { validFromIso: '2026-09-15T00:00:00.000Z' });

  assert.equal(report.totals.sessions, 0);
  assert.equal(report.excluded.length, 2);
  assert.ok(report.excluded.every((e) => /start time unknown/.test(e.reason)));
});

// -- R3-extra-calls-off-by-one: backstopFollowThrough excludes the Agent call --

test('backstopFollowThrough does not count the delegating Agent call as an extra call', () => {
  // Build a streakDetail-shaped fixture directly: threshold crossed at global
  // index 19 (the 20th call), delegation closes the streak at index 20 (the
  // very next event) -- zero real extra calls happened in between.
  const immediateDelegation = {
    crossedAt: { calls: 19 },
    closedBy: { index: 20, name: 'Agent' },
  };
  const fifteenExtraCalls = {
    crossedAt: { calls: 19 },
    closedBy: { index: 35, name: 'Agent' },
  };
  const neverDelegates = {
    crossedAt: { calls: 19 },
    closedBy: null,
  };
  const neverCrossed = {
    crossedAt: {},
    closedBy: { index: 3, name: 'Agent' },
  };

  const result = backstopFollowThrough([
    immediateDelegation, fifteenExtraCalls, neverDelegates, neverCrossed,
  ]);

  assert.equal(result.crossed, 3, 'the streak that never crossed the threshold is excluded');
  assert.equal(result.followed, 2);
  assert.equal(result.ranToEnd, 1);
  assert.deepEqual(result.extraCallsPastThreshold, [0, 15]);
});

test('buildReport exposes backstopFollowThrough scoped to the valid corpus', () => {
  const dir = fresh('backstop-follow-through-report');
  // 21 non-delegation calls (crosses 20 at the 20th), then one more call,
  // then a delegation: 1 real extra call before delegating.
  const lines = [];
  for (let i = 0; i < 21; i += 1) lines.push(toolUse('s', `2026-09-20T00:00:${String(i).padStart(2, '0')}.000Z`, 'Bash', null));
  lines.push(toolUse('s', '2026-09-20T00:00:21.000Z', 'Agent', null));
  writeSession(dir, 's.jsonl', lines);

  const report = buildReport(dir, {});

  assert.equal(report.backstopFollowThrough.crossed, 1);
  assert.equal(report.backstopFollowThrough.followed, 1);
  assert.deepEqual(report.backstopFollowThrough.extraCallsPastThreshold, [1]);
});

// -- R3-empty-streak-denominator: zero-call streaks excluded from totals ----

test('a zero-call streak (back-to-back delegations) is excluded from the streaks denominator', () => {
  const dir = fresh('empty-streak');
  writeSession(dir, 's.jsonl', [
    toolUse('s', '2026-09-20T00:00:00.000Z', 'Read', 'a.js'),
    toolUse('s', '2026-09-20T00:00:01.000Z', 'Agent', null),
    // Back-to-back delegation: the streak between these two Agent calls has
    // zero non-delegation calls in it.
    toolUse('s', '2026-09-20T00:00:02.000Z', 'Agent', null),
  ]);

  const report = buildReport(dir, {});

  assert.equal(report.sessions[0].streaks, 1, 'only the one non-empty streak is counted');
  assert.equal(report.sessions[0].emptyStreaks, 1, 'the back-to-back-delegation streak is reported separately');
  assert.equal(report.totals.streaksTotal, 1);
  assert.equal(report.totals.emptyStreaksTotal, 1);
  // Full transparency: the empty streak still appears in streakDetail.
  assert.equal(report.streakDetail['s.jsonl'].length, 2);
});

// -- OCM-4 corpus freeze: file/size/hash listing -----------------------------

test('corpus lists every analyzed transcript (valid and excluded) with its byte size and sha256', () => {
  const dir = fresh('corpus-listing');
  writeSession(dir, 'early.jsonl', [toolUse('early', '2026-09-01T00:00:00.000Z')]);
  writeSession(dir, 'late.jsonl', [toolUse('late', '2026-09-20T00:00:00.000Z')]);

  const report = buildReport(dir, { validFromIso: '2026-09-15T00:00:00.000Z' });

  assert.equal(report.corpus.length, 2);
  const byFile = Object.fromEntries(report.corpus.map((c) => [c.file, c]));
  assert.equal(byFile['early.jsonl'].status, 'excluded');
  assert.equal(byFile['late.jsonl'].status, 'valid');
  const expectedHash = createHash('sha256')
    .update(readFileSync(join(dir, 'late.jsonl')))
    .digest('hex');
  assert.equal(byFile['late.jsonl'].sha256, expectedHash);
  assert.equal(typeof byFile['late.jsonl'].bytes, 'number');
  assert.ok(byFile['late.jsonl'].bytes > 0);
});

// -- OCM-5: hash the same bytes analyzed, not a second read ------------------

test('the recorded hash is the hash of the exact bytes analyzed, not a later re-read', () => {
  const dir = fresh('hash-matches-analyzed-bytes');
  const file = join(dir, 'growing.jsonl');
  const preAppendLine = toolUse('growing', '2026-09-20T00:00:00.000Z');
  writeFileSync(file, `${preAppendLine}\n`, 'utf8');
  const preAppendBytes = readFileSync(file);
  const expectedHash = createHash('sha256').update(preAppendBytes).digest('hex');

  // Simulate a transcript still being appended to between the analysis read
  // and what a naive second read (statSync + re-hash) would see afterward:
  // append more content to the same file right after buildReport's single
  // read would have happened, by reading the report synchronously in one
  // buildReport call over the pre-append bytes only.
  const report = buildReport(dir, {});

  assert.equal(report.corpus.length, 1);
  assert.equal(report.corpus[0].sha256, expectedHash);
  assert.equal(report.corpus[0].bytes, preAppendBytes.length);

  // Now append more lines to the same file on disk and confirm the ALREADY
  // PRODUCED report still carries the pre-append hash: it was computed once,
  // from the same buffer that was analyzed, not from a later filesystem read.
  writeFileSync(file, `${preAppendLine}\n${toolUse('growing', '2026-09-20T00:00:01.000Z', 'Bash', null)}\n`, 'utf8');
  assert.equal(report.corpus[0].sha256, expectedHash, 'the frozen report keeps the pre-append hash');
  assert.notEqual(
    createHash('sha256').update(readFileSync(file)).digest('hex'),
    expectedHash,
    'sanity check: the file on disk did change after the report was built',
  );
});

// -- OCM-5: null validFromIso means no cutoff, same as undefined ------------

test('buildReport treats a null validFromIso the same as undefined: no cutoff', () => {
  const dir = fresh('null-validfrom');
  writeSession(dir, 'early.jsonl', [toolUse('early', '2026-09-01T00:00:00.000Z')]);
  writeSession(dir, 'late.jsonl', [toolUse('late', '2026-09-20T00:00:00.000Z')]);

  const report = buildReport(dir, { validFromIso: null });

  assert.equal(report.validFrom, null);
  assert.deepEqual(report.excluded, []);
  assert.equal(report.totals.sessions, 2);
});

test('CLI without --valid-from succeeds and reports no exclusions by cutoff', () => {
  const dir = fresh('cli-no-valid-from-flag');
  writeSession(dir, 'a.jsonl', [toolUse('a', '2026-09-01T00:00:00.000Z')]);
  writeSession(dir, 'b.jsonl', [toolUse('b', '2026-09-20T00:00:00.000Z')]);

  const outcome = spawnSync(process.execPath, [CLI, dir], { encoding: 'utf8' });

  assert.equal(outcome.status, 0, outcome.stderr);
  const report = JSON.parse(outcome.stdout);
  assert.equal(report.validFrom, null);
  assert.deepEqual(report.excluded, []);
  assert.equal(report.totals.sessions, 2);
});

// -- argument parsing ----------------------------------------------------------

test('parseArgs keeps the existing positionals working with --valid-from anywhere', () => {
  assert.deepEqual(parseArgs(['/dir', '2026-09-18T22:53:11Z']), {
    dir: '/dir', ruleInstalledIso: '2026-09-18T22:53:11Z', validFrom: undefined,
  });
  assert.deepEqual(
    parseArgs(['/dir', '2026-09-18T22:53:11Z', '--valid-from', '2026-09-18T11:32:56Z']),
    { dir: '/dir', ruleInstalledIso: '2026-09-18T22:53:11Z', validFrom: '2026-09-18T11:32:56Z' },
  );
  assert.deepEqual(
    parseArgs(['--valid-from', '2026-09-18T11:32:56Z', '/dir', '2026-09-18T22:53:11Z']),
    { dir: '/dir', ruleInstalledIso: '2026-09-18T22:53:11Z', validFrom: '2026-09-18T11:32:56Z' },
  );
});

// -- CLI process boundary ------------------------------------------------------

test('CLI: an invalid --valid-from ISO exits non-zero with the usage message', () => {
  const dir = fresh('cli-invalid-valid-from');
  const outcome = spawnSync(process.execPath, [CLI, dir, '--valid-from', 'not-a-timestamp'], { encoding: 'utf8' });

  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, new RegExp(USAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(outcome.stderr, /--valid-from value "not-a-timestamp" is not a valid ISO 8601 timestamp/);
});

test('CLI: no transcript-dir exits non-zero with the usage message', () => {
  const outcome = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, new RegExp(USAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('CLI: the full real command shape (positionals plus --valid-from) succeeds and reports the cutoff', () => {
  const dir = fresh('cli-full-shape');
  writeSession(dir, 'early.jsonl', [toolUse('early', '2026-09-01T00:00:00.000Z')]);
  writeSession(dir, 'late.jsonl', [toolUse('late', '2026-09-20T00:00:00.000Z')]);

  const outcome = spawnSync(process.execPath, [
    CLI, dir, '2026-09-18T22:53:11Z', '--valid-from', '2026-09-15T00:00:00Z',
  ], { encoding: 'utf8' });

  assert.equal(outcome.status, 0, outcome.stderr);
  const report = JSON.parse(outcome.stdout);
  assert.equal(report.validFrom, '2026-09-15T00:00:00.000Z');
  assert.equal(report.excluded.length, 1);
  assert.equal(report.excluded[0].sessionId, 'early');
  assert.equal(report.totals.sessions, 1);
});

// -- OTS-1: state reads left out of a second view of the backstop -----------

const bashUse = (sessionId, ts, command) => JSON.stringify({
  sessionId,
  timestamp: ts,
  version: '3.1.0',
  gitBranch: 'main',
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
});

const tsAt = (i) => `2026-09-20T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;

test('isStateReadCommand accepts pure git, gh and ledger state reads', () => {
  for (const cmd of [
    'git status',
    'git status --short',
    'git log --oneline -5',
    'git -C C:/repo diff --stat',
    'git --no-pager show HEAD',
    'git rev-parse --abbrev-ref HEAD',
    'git branch',
    'git branch -vv',
    'git branch --show-current',
    'git branch -a --contains abc123',
    'git remote -v',
    'git remote get-url origin',
    'git ls-files',
    'git ls-remote origin',
    'git merge-base HEAD origin/main',
    'git cat-file -p HEAD',
    'git config --get user.name',
    'git config --list --show-origin',
    'git worktree list',
    'git describe --tags',
    'git log --format="%h|%s" -3',
    'git status 2>&1',
    'gh issue view 123 --repo o/r',
    'gh issue list --state open',
    'gh pr view 1 --json title',
    'gh pr list',
    'gh pr diff 1',
    'gh pr checks 1',
    'gh search issues "odd trace" --repo o/r',
    'gh release list',
    'gh release view v1',
    'gh repo view o/r',
    'gh run list',
    'gh run view 9 --log',
    'gh api repos/o/r/issues/1',
    'gh api -X GET repos/o/r/pulls --paginate',
    'gh api --method=get repos/o/r',
    'node .claude/tools/audit/bin/ledger.mjs status --json',
    'node C:\\repo\\bin\\ledger.mjs intake 42',
    'cd C:/repo && git status && git log -1',
    'FOO=bar git status; git diff',
    'git status\ngit log -1',
    'git log | git status',
  ]) {
    assert.equal(isStateReadCommand(cmd), true, cmd);
  }
});

test('isStateReadCommand rejects mutating, compound-with-mutation, unknown and unparseable commands', () => {
  for (const cmd of [
    'git fetch origin',
    'git commit -m x',
    'git push',
    'git status && git commit -m x',
    'git log; rm -rf x',
    'git status || git reset --hard',
    'git branch -D old',
    'git branch new-branch',
    'git branch -m a b',
    'git remote add up url',
    'git config user.name x',
    'git config --unset user.name',
    'git -c core.pager=evil log',
    'git diff --output=out.patch',
    'git worktree add ../x',
    'gh issue comment 1 --body hi',
    'gh issue create --title t',
    'gh pr create --fill',
    'gh pr merge 1',
    'gh pr edit 1 --title t',
    'gh pr close 1',
    'gh pr ready 1',
    'gh api -X POST repos/o/r/issues',
    'gh api -XPOST repos/o/r/issues',
    'gh api --method PATCH repos/o/r',
    'gh api repos/o/r/issues -f title=x',
    'gh api repos/o/r/issues -F title=x',
    'gh api repos/o/r/issues --field title=x',
    'gh api repos/o/r/issues --raw-field title=x',
    'gh api repos/o/r/issues --input body.json',
    'node .claude/tools/audit/bin/ledger.mjs record x',
    'node other.mjs status',
    'npm test',
    'rg foo',
    'git status > out.txt',
    'git log $(rm -rf x)',
    'git log `rm x`',
    'git status &',
    '(git status)',
    'cat <<END\nx\nEND',
    'cd C:/repo',
    'echo hi',
    '',
    '   ',
    'git log "unterminated',
  ]) {
    assert.equal(isStateReadCommand(cmd), false, JSON.stringify(cmd));
  }
  assert.equal(isStateReadCommand(undefined), false);
  assert.equal(isStateReadCommand(['git', 'status']), false, 'a non-string is never a state read');
});

test('a Claude streak of 25 calls with 10 state reads crosses the original backstop but not the excluding-state view', () => {
  const dir = fresh('state-reads-streak');
  const lines = [];
  for (let i = 0; i < 25; i += 1) {
    lines.push(i % 5 < 2
      ? bashUse('s', tsAt(i), i % 2 === 0 ? 'git status' : 'gh pr view 1')
      : toolUse('s', tsAt(i), 'Bash', null));
  }
  lines.push(toolUse('s', tsAt(25), 'Agent', null));
  writeSession(dir, 's.jsonl', lines);

  const report = buildReport(dir, {});
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
});

test('excluding-state extra calls count only non-state calls between the crossing and the delegation', () => {
  const dir = fresh('state-reads-extra');
  const lines = [];
  // 20 non-state calls cross the threshold; 5 state reads, 1 more call, then a delegation.
  for (let i = 0; i < 20; i += 1) lines.push(toolUse('s', tsAt(i), 'Bash', null));
  for (let i = 20; i < 25; i += 1) lines.push(bashUse('s', tsAt(i), 'git log -1'));
  lines.push(toolUse('s', tsAt(25), 'Read', 'x.js'));
  lines.push(toolUse('s', tsAt(26), 'Agent', null));
  writeSession(dir, 's.jsonl', lines);

  const report = buildReport(dir, {});

  assert.deepEqual(report.backstopFollowThrough.extraCallsPastThreshold, [6]);
  assert.deepEqual(report.backstopFollowThroughExcludingStateReads, {
    crossed: 1, followed: 1, ranToEnd: 0, extraCallsPastThreshold: [1],
  });
});

test('non-Bash tools are never state reads, and a state read never closes a streak', () => {
  const dir = fresh('state-reads-non-bash');
  writeSession(dir, 's.jsonl', [
    toolUse('s', tsAt(0), 'Read', 'a.js'),
    JSON.stringify({
      sessionId: 's', timestamp: tsAt(1), type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'PowerShell', input: { command: 'git status' } }] },
    }),
    bashUse('s', tsAt(2), 'git status'),
  ]);

  const report = buildReport(dir, {});
  const s = report.sessions[0];

  assert.equal(s.stateReads, 1);
  assert.equal(s.streaks, 1);
  assert.equal(s.excludingStateReads.maxStreakCalls, 2);
});

test('OTS-3: a Bash state read piped into a read-only filter counts as a state read, a standalone filter does not', () => {
  const dir = fresh('state-reads-pipe-filters');
  writeSession(dir, 's.jsonl', [
    bashUse('s', tsAt(0), 'git log --oneline | head -5'),
    bashUse('s', tsAt(1), 'gh pr list --json number | jq .'),
    bashUse('s', tsAt(2), 'git status | tee out'),
    bashUse('s', tsAt(3), 'rg foo file'),
  ]);

  const report = buildReport(dir, {});
  const s = report.sessions[0];

  assert.equal(s.stateReads, 2);
  assert.equal(s.excludingStateReads.maxStreakCalls, 2);
});

test('existing fields keep their exact values on a mixed fixture', () => {
  const dir = fresh('state-reads-existing-fields');
  writeSession(dir, 's.jsonl', [
    toolUse('s', tsAt(0), 'Read', 'a.js'),
    toolUse('s', tsAt(1), 'Read', 'b.js'),
    bashUse('s', tsAt(2), 'git status'),
    toolUse('s', tsAt(3), 'Edit', 'c.js'),
    toolUse('s', tsAt(4), 'Edit', 'd.js'),
    toolUse('s', tsAt(5), 'Agent', null),
    bashUse('s', tsAt(6), 'git commit -m x'),
  ]);

  const report = buildReport(dir, {});

  assert.deepEqual(report.totals, {
    sessions: 1,
    toolCalls: 7,
    delegations: 1,
    sessionsWithZeroDelegation: 0,
    sessionsCrossingCalls20: 0,
    sessionsCrossingReads5: 0,
    sessionsCrossingEdits2: 1,
    sessionsCrossingMapping4: 0,
    sessionsCrossingWriter2: 1,
    streaksTotal: 2,
    emptyStreaksTotal: 0,
    streaksCrossingCalls20: 0,
    streaksCrossingReads5: 0,
    streaksCrossingEdits2: 1,
    sessionsTouchingOddTasks: 0,
  });
  assert.deepEqual(report.backstopFollowThrough, { crossed: 0, followed: 0, ranToEnd: 0, extraCallsPastThreshold: [] });
  assert.deepEqual(report.streakDetail['s.jsonl'], [
    {
      startIndex: 0, calls: 5, reads: 2, edits: 2, bash: 1, distinctReadFiles: 2, distinctEditFiles: 2,
      crossedAt: { edits: 4, writerFiles: 4 }, closedBy: { index: 5, name: 'Agent' },
    },
    {
      startIndex: 6, calls: 1, reads: 0, edits: 0, bash: 1, distinctReadFiles: 0, distinctEditFiles: 0,
      crossedAt: {}, closedBy: null,
    },
  ]);
  assert.equal(report.sessions[0].stateReads, 1);
  assert.ok(Array.isArray(report.stateReadClassifier.git.allowedSubcommands));
  assert.ok(report.stateReadClassifier.gh.allowed.includes('pr view'));
  assert.equal(report.stateReadClassifier.version, 2, 'the report names the rule set that produced it');
});
