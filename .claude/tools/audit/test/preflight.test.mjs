// The preflight gate: one snapshot, terminable isolation, a second reading.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { runPreflight, FAILURE_CODE, VOLATILE_DECISION_FIELDS } from '../lib/preflight.mjs';
import { runIsolated, ISOLATION } from '../lib/isolate.mjs';
import { discoverChecks } from '../lib/registry.mjs';
import { policyPath } from '../lib/policy.mjs';
import { validateResult } from '../lib/validate.mjs';
import { STATUS } from '../lib/status.mjs';
import { git, write, remove, commit, repoWithCommit, gentleAiFixtureFiles, FIXTURE_REPOSITORY, cleanupAll } from './helpers/repo.mjs';

after(cleanupAll);

const scratch = mkdtempSync(join(tmpdir(), 'audit-preflight-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;

function policyFile(document) {
  const path = join(scratch, `policy-${sequence += 1}.json`);
  writeFileSync(path, JSON.stringify(document));
  return path;
}

/** A directory of purpose-built check files, used as a catalogue. */
function checkDirectory(files) {
  const directory = mkdtempSync(join(scratch, 'checks-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(directory, name), body);
  return directory;
}

const gatePolicy = (checks, extra = {}) => policyFile({
  policyVersion: '1.0.0',
  id: 'preflight-test',
  version: '1',
  repository: FIXTURE_REPOSITORY,
  gates: { preflight: { checks, ...extra } },
});

const CHECK_ECHO_SNAPSHOT = (id) => `
  export default {
    id: '${id}',
    title: 'Reports the snapshot hash it was handed',
    needsSnapshot: true,
    params: {},
    evaluate: ({ snapshot }) => ({
      status: 'PASS',
      reason: 'read the snapshot handed to me',
      evidence: [{
        type: 'computed', source: 'echo',
        observed: { hash: snapshot.hash },
        hash: 'sha256:' + '0'.repeat(64),
      }],
    }),
  };
`;

// -- isolation, at the layer that enforces it ---------------------------------

test('a check that finishes normally comes back as completed', async () => {
  const directory = checkDirectory({
    'ok.mjs': "export default { id:'probe.ok', title:'t', needsSnapshot:false, params:{}, evaluate: () => ({status:'PASS', reason:'fine', evidence:[]}) };",
  });
  const isolation = await runIsolated({ checkFile: join(directory, 'ok.mjs'), payload: {}, timeoutMs: 5000 });

  assert.equal(isolation.kind, ISOLATION.COMPLETED);
  assert.equal(isolation.outcome.status, 'PASS');
});

test('REGRESSION: a synchronous infinite loop is really terminated, not merely awaited', async () => {
  // The property Promise.race cannot provide. If the worker were not killed,
  // this test would never return.
  const directory = checkDirectory({
    'spin.mjs': "export default { id:'probe.spin', title:'t', needsSnapshot:false, params:{}, evaluate: () => { for(;;){} } };",
  });

  const startedAt = Date.now();
  const isolation = await runIsolated({ checkFile: join(directory, 'spin.mjs'), payload: {}, timeoutMs: 300 });
  const elapsed = Date.now() - startedAt;

  assert.equal(isolation.kind, ISOLATION.TIMEOUT);
  assert.equal(isolation.detail.terminated, true);
  assert.equal(isolation.detail.timeoutMs, 300);
  assert.ok(elapsed < 5000, `the timeout must actually end the run, took ${elapsed}ms`);
});

test('REGRESSION: a catastrophic regular expression is terminated like any other loop', async () => {
  const directory = checkDirectory({
    'redos.mjs': `
      export default { id:'probe.redos', title:'t', needsSnapshot:false, params:{},
        evaluate: () => ({ status: /^(a+)+$/.test('a'.repeat(40) + 'b') ? 'PASS' : 'FAIL', reason:'r', evidence:[] }) };
    `,
  });

  const startedAt = Date.now();
  const isolation = await runIsolated({ checkFile: join(directory, 'redos.mjs'), payload: {}, timeoutMs: 400 });

  assert.equal(isolation.kind, ISOLATION.TIMEOUT);
  assert.ok(Date.now() - startedAt < 5000, 'the ReDoS must not outlive its budget');
});

test('a check that throws comes back as an exception, with its message', async () => {
  const directory = checkDirectory({
    'throw.mjs': "export default { id:'probe.throw', title:'t', needsSnapshot:false, params:{}, evaluate: () => { throw new RangeError('deliberate'); } };",
  });
  const isolation = await runIsolated({ checkFile: join(directory, 'throw.mjs'), payload: {}, timeoutMs: 5000 });

  assert.equal(isolation.kind, ISOLATION.EXCEPTION);
  assert.equal(isolation.detail.name, 'RangeError');
  assert.match(isolation.detail.message, /deliberate/);
});

test('a worker that kills itself comes back as terminated, not as a pass', async () => {
  const directory = checkDirectory({
    'exit.mjs': "process.exit(7); export default { id:'probe.exit', title:'t', needsSnapshot:false, params:{}, evaluate: () => ({}) };",
  });
  const isolation = await runIsolated({ checkFile: join(directory, 'exit.mjs'), payload: {}, timeoutMs: 5000 });

  assert.equal(isolation.kind, ISOLATION.TERMINATED);
  assert.equal(isolation.detail.exitCode, 7);
});

test('a check module that cannot be loaded comes back as an exception', async () => {
  const isolation = await runIsolated({ checkFile: join(scratch, 'absent-check.mjs'), payload: {}, timeoutMs: 5000 });
  assert.equal(isolation.kind, ISOLATION.EXCEPTION);
});

// -- the four failure modes, end to end ---------------------------------------

async function runWith(files, checks, options = {}) {
  const directory = checkDirectory(files);
  const catalogue = await discoverChecks({ directory });
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, `preflight-${sequence += 1}`);

  const outcome = await runPreflight({
    cwd: options.cwd ?? root,
    policy: gatePolicy(checks, options.gate),
    gate: 'preflight',
    checkTimeoutMs: options.timeoutMs,
    catalogue,
    afterChecks: options.afterChecks?.(root),
  });

  return { ...outcome, root };
}

test('REGRESSION: a timeout blocks the gate and is distinguishable from every other failure', async () => {
  const { result } = await runWith(
    { 'spin.mjs': "export default { id:'probe.spin', title:'Spins forever', needsSnapshot:false, params:{}, evaluate: () => { for(;;){} } };" },
    [{ id: 'probe.spin', required: true }],
    { timeoutMs: 300 }
  );

  assert.equal(result.status, STATUS.UNKNOWN);
  assert.equal(result.checks[0].status, STATUS.UNKNOWN);
  assert.equal(result.checks[0].evidence[0].observed.failure, 'timeout');
  assert.equal(result.errors[0].code, FAILURE_CODE.TIMEOUT);
  assert.match(result.checks[0].remediation, /not retried automatically/);
  assert.equal(validateResult(result).valid, true);
});

test('REGRESSION: an exception is recorded as an exception, not as a timeout', async () => {
  const { result } = await runWith(
    { 'boom.mjs': "export default { id:'probe.boom', title:'Throws', needsSnapshot:false, params:{}, evaluate: () => { throw new Error('kaboom'); } };" },
    [{ id: 'probe.boom', required: true }]
  );

  assert.equal(result.status, STATUS.UNKNOWN);
  assert.equal(result.checks[0].evidence[0].observed.failure, 'exception');
  assert.equal(result.errors[0].code, FAILURE_CODE.EXCEPTION);
});

test('REGRESSION: a worker that dies is recorded as terminated, with its exit code', async () => {
  const { result } = await runWith(
    { 'die.mjs': "export default { id:'probe.die', title:'Dies', needsSnapshot:false, params:{}, evaluate: () => { process.exit(3); } };" },
    [{ id: 'probe.die', required: true }]
  );

  assert.equal(result.status, STATUS.UNKNOWN);
  assert.equal(result.checks[0].evidence[0].observed.failure, 'terminated');
  assert.equal(result.checks[0].evidence[0].observed.exitCode, 3);
  assert.equal(result.errors[0].code, FAILURE_CODE.TERMINATED);
});

test('REGRESSION: a malformed result is recorded as malformed, never as a pass', async () => {
  const malformed = {
    'garbage.mjs': "export default { id:'probe.garbage', title:'Returns nonsense', needsSnapshot:false, params:{}, evaluate: () => 'PASS' };",
    'nostatus.mjs': "export default { id:'probe.nostatus', title:'No status', needsSnapshot:false, params:{}, evaluate: () => ({ reason:'r' }) };",
    'noevidence.mjs': "export default { id:'probe.noevidence', title:'Pass without evidence', needsSnapshot:false, params:{}, evaluate: () => ({ status:'PASS', reason:'trust me', evidence: [] }) };",
  };

  for (const [file, body] of Object.entries(malformed)) {
    const id = /id:'([^']+)'/.exec(body)[1];
    const { result } = await runWith({ [file]: body }, [{ id, required: true }]);

    assert.equal(result.status, STATUS.UNKNOWN, `${id} must not conclude`);
    assert.equal(result.errors[0].code, FAILURE_CODE.MALFORMED, `${id} must be classified as malformed`);
    assert.equal(result.errors.length, 1, 'and classified exactly once');
  }
});

test('every failure mode blocks: none of them exits with a pass', async () => {
  const cases = [
    ['probe.spin', "export default { id:'probe.spin', title:'t', needsSnapshot:false, params:{}, evaluate: () => { for(;;){} } };"],
    ['probe.boom', "export default { id:'probe.boom', title:'t', needsSnapshot:false, params:{}, evaluate: () => { throw new Error('x'); } };"],
    ['probe.die', "export default { id:'probe.die', title:'t', needsSnapshot:false, params:{}, evaluate: () => { process.exit(1); } };"],
    ['probe.garbage', "export default { id:'probe.garbage', title:'t', needsSnapshot:false, params:{}, evaluate: () => 42 };"],
  ];

  for (const [id, body] of cases) {
    const { result } = await runWith({ 'c.mjs': body }, [{ id, required: true }], { timeoutMs: 300 });
    assert.notEqual(result.status, STATUS.PASS, `${id} must never authorise`);
  }
});

// -- the ReDoS path, through the real check ------------------------------------

test('REGRESSION: a catastrophic policy regex cannot freeze the preflight', async () => {
  const catastrophic = '^(a+)+$';
  const { root } = repoWithCommit({ 'RULES.md': `${catastrophic}\n` }, 'preflight-redos');
  git(root, 'checkout', '-q', '-b', `${'a'.repeat(40)}b`);

  const startedAt = Date.now();
  const outcome = await runPreflight({
    cwd: root,
    policy: gatePolicy([{
      id: 'git.branch-allowed',
      required: true,
      with: { pattern: catastrophic, source: 'RULES.md#L1', authority: 'repository' },
    }]),
    gate: 'preflight',
    checkTimeoutMs: 500,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(outcome.result.status, STATUS.UNKNOWN);
  assert.equal(outcome.result.checks.find((c) => c.id === 'git.branch-allowed').evidence[0].observed.failure, 'timeout');
  assert.ok(elapsed < 20_000, `the gate must not hang on a configured regex, took ${elapsed}ms`);
});

// -- one snapshot for everyone --------------------------------------------------

test('every check receives the same snapshot, not one reading each', async () => {
  const { result, snapshot } = await runWith(
    { 'one.mjs': CHECK_ECHO_SNAPSHOT('probe.one'), 'two.mjs': CHECK_ECHO_SNAPSHOT('probe.two') },
    [{ id: 'probe.one', required: true }, { id: 'probe.two', required: true }]
  );

  const hashes = result.checks
    .filter((check) => check.status === STATUS.PASS && check.evidence[0]?.source === 'echo')
    .map((check) => check.evidence[0].observed.hash);

  assert.equal(hashes.length, 2);
  assert.equal(hashes[0], hashes[1], 'both checks must have read the same snapshot');
  assert.equal(hashes[0], snapshot.hash);
  assert.equal(hashes[0], result.binding.snapshotHash);
});

// -- the second reading ----------------------------------------------------------

const stabilityCase = (mutate) => ({
  afterChecks: (root) => () => mutate(root),
});

test('REGRESSION: a HEAD that moves during the gate makes the result UNKNOWN despite every pass', async () => {
  const { result } = await runWith(
    { 'ok.mjs': "export default { id:'probe.ok', title:'t', needsSnapshot:false, params:{}, evaluate: () => ({status:'PASS', reason:'fine', evidence:[{type:'computed',source:'s',observed:{},hash:'sha256:'+'0'.repeat(64)}]}) };" },
    [{ id: 'probe.ok', required: true }],
    stabilityCase((root) => { write(root, 'new.txt', 'x\n'); git(root, 'add', '-A'); commit(root, 'landed mid-gate'); })
  );

  assert.equal(result.checks.find((c) => c.id === 'probe.ok').status, STATUS.PASS, 'the check itself passed');
  assert.equal(result.status, STATUS.UNKNOWN, 'and the gate still refuses');
  assert.equal(result.binding.stable, false);
  assert.notEqual(result.binding.snapshotHash, result.binding.snapshotHashAfter);
  assert.ok(result.errors.some((error) => error.code === FAILURE_CODE.UNSTABLE));

  const marker = result.checks.find((check) => check.id === 'gate.repository-stable');
  assert.equal(marker.status, STATUS.UNKNOWN);
  assert.equal(marker.required, true);
  assert.equal(validateResult(result).valid, true);
});

test('REGRESSION: a staged change during the gate makes the result UNKNOWN', async () => {
  const { result } = await runWith(
    { 'ok.mjs': "export default { id:'probe.ok', title:'t', needsSnapshot:false, params:{}, evaluate: () => ({status:'PASS', reason:'fine', evidence:[{type:'computed',source:'s',observed:{},hash:'sha256:'+'0'.repeat(64)}]}) };" },
    [{ id: 'probe.ok', required: true }],
    stabilityCase((root) => { write(root, 'staged.txt', 'x\n'); git(root, 'add', 'staged.txt'); })
  );

  assert.equal(result.status, STATUS.UNKNOWN);
  assert.equal(result.binding.stable, false);
});

test('REGRESSION: an unstaged change during the gate makes the result UNKNOWN', async () => {
  const { result } = await runWith(
    { 'ok.mjs': "export default { id:'probe.ok', title:'t', needsSnapshot:false, params:{}, evaluate: () => ({status:'PASS', reason:'fine', evidence:[{type:'computed',source:'s',observed:{},hash:'sha256:'+'0'.repeat(64)}]}) };" },
    [{ id: 'probe.ok', required: true }],
    stabilityCase((root) => write(root, 'a.txt', 'alpha changed in the worktree\n'))
  );

  assert.equal(result.status, STATUS.UNKNOWN);
  assert.equal(result.binding.stable, false);
});

test('REGRESSION: an untracked file appearing during the gate makes the result UNKNOWN', async () => {
  const { result } = await runWith(
    { 'ok.mjs': "export default { id:'probe.ok', title:'t', needsSnapshot:false, params:{}, evaluate: () => ({status:'PASS', reason:'fine', evidence:[{type:'computed',source:'s',observed:{},hash:'sha256:'+'0'.repeat(64)}]}) };" },
    [{ id: 'probe.ok', required: true }],
    stabilityCase((root) => write(root, 'appeared.txt', 'x\n'))
  );

  assert.equal(result.status, STATUS.UNKNOWN);
  assert.equal(result.binding.stable, false);
});

test('a repository that stays put is recorded as stable', async () => {
  const { result } = await runWith(
    { 'ok.mjs': "export default { id:'probe.ok', title:'t', needsSnapshot:false, params:{}, evaluate: () => ({status:'PASS', reason:'fine', evidence:[{type:'computed',source:'s',observed:{},hash:'sha256:'+'0'.repeat(64)}]}) };" },
    [{ id: 'probe.ok', required: true }]
  );

  assert.equal(result.binding.stable, true);
  assert.equal(result.binding.snapshotHash, result.binding.snapshotHashAfter);
  assert.equal(result.status, STATUS.PASS);
  assert.equal(result.checks.some((check) => check.id === 'gate.repository-stable'), false, 'no marker when nothing moved');
});

// -- binding and idempotence ---------------------------------------------------

test('the decision is bound to the snapshot, the policy and the tool version', async () => {
  const { root } = repoWithCommit(gentleAiFixtureFiles(), 'preflight-binding');
  git(root, 'checkout', '-q', '-b', 'fix/999-binding');

  const { result, snapshot } = await runPreflight({ cwd: root, policy: policyPath('gentle-ai'), gate: 'preflight' });

  assert.equal(result.binding.snapshotHash, snapshot.hash);
  assert.match(result.binding.policyHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.binding.toolVersion, result.toolVersion);
  assert.match(result.binding.decisionId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(validateResult(result).valid, true);
});

test('a different policy over the same state yields a different decisionId', async () => {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, 'preflight-decision');
  const catalogue = await discoverChecks();

  const first = await runPreflight({ cwd: root, gate: 'preflight', catalogue, policy: gatePolicy([{ id: 'git.repository-readable', required: true }]) });
  const second = await runPreflight({ cwd: root, gate: 'preflight', catalogue, policy: gatePolicy([{ id: 'git.no-conflicts', required: true }]) });

  assert.notEqual(first.result.binding.policyHash, second.result.binding.policyHash);
  assert.notEqual(first.result.binding.decisionId, second.result.binding.decisionId);
  assert.equal(first.result.binding.snapshotHash, second.result.binding.snapshotHash, 'the state was the same');
});

test('two runs over the same state decide identically, differing only in the documented volatile fields', async () => {
  const { root } = repoWithCommit(gentleAiFixtureFiles(), 'preflight-idempotent');
  git(root, 'checkout', '-q', '-b', 'fix/999-idempotent');

  const first = await runPreflight({ cwd: root, policy: policyPath('gentle-ai'), gate: 'preflight' });
  const second = await runPreflight({ cwd: root, policy: policyPath('gentle-ai'), gate: 'preflight' });

  assert.equal(first.result.status, second.result.status);
  assert.equal(first.result.runId, second.result.runId);
  assert.deepEqual(first.result.binding, second.result.binding);
  assert.deepEqual(first.result.summary, second.result.summary);
  assert.deepEqual(
    first.result.checks.map((check) => [check.id, check.status, check.reason]),
    second.result.checks.map((check) => [check.id, check.status, check.reason])
  );

  // And the documented volatile list is exactly what differs.
  assert.deepEqual([...VOLATILE_DECISION_FIELDS], ['startedAt', 'finishedAt', 'checks[].durationMs']);
  const strip = (result) => {
    const copy = structuredClone(result);
    delete copy.startedAt;
    delete copy.finishedAt;
    for (const check of copy.checks) delete check.durationMs;
    return JSON.stringify(copy);
  };
  assert.equal(strip(first.result), strip(second.result));
});

// -- read-only ------------------------------------------------------------------

function fingerprint(root) {
  const hash = createHash('sha256');
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) { hash.update(`D ${relative(root, absolute)}\n`); walk(absolute); continue; }
      if (!entry.isFile()) continue;
      hash.update(`F ${relative(root, absolute)} ${statSync(absolute).size}\n`);
      hash.update(readFileSync(absolute));
    }
  };
  walk(root);
  return hash.digest('hex');
}

test('the preflight gate changes nothing, including when checks time out', async () => {
  const { root } = repoWithCommit(gentleAiFixtureFiles(), 'preflight-readonly');
  git(root, 'checkout', '-q', '-b', 'fix/999-readonly');
  write(root, 'untracked.txt', 'x\n');

  const before = fingerprint(root);
  await runPreflight({ cwd: root, policy: policyPath('gentle-ai'), gate: 'preflight' });
  assert.equal(fingerprint(root), before, 'a normal run must leave the repository byte-identical');

  const directory = checkDirectory({ 'spin.mjs': "export default { id:'probe.spin', title:'t', needsSnapshot:false, params:{}, evaluate: () => { for(;;){} } };" });
  await runPreflight({
    cwd: root,
    policy: gatePolicy([{ id: 'probe.spin', required: true }]),
    gate: 'preflight',
    checkTimeoutMs: 300,
    catalogue: await discoverChecks({ directory }),
  });
  assert.equal(fingerprint(root), before, 'and a terminated worker must not leave anything behind either');
});

test('the gate never synchronises the branch on its own', async () => {
  const { root } = repoWithCommit(gentleAiFixtureFiles(), 'preflight-no-sync');
  git(root, 'checkout', '-q', '-b', 'fix/999-no-sync');

  const head = git(root, 'rev-parse', 'HEAD').trim();
  const { result } = await runPreflight({ cwd: root, policy: policyPath('gentle-ai'), gate: 'preflight' });

  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), head, 'HEAD must not move');
  assert.equal(result.checks.find((c) => c.id === 'git.upstream-configured').status, STATUS.FAIL, 'it reports the problem instead of fixing it');
});

// -- the timeout is configurable and declared ---------------------------------------

test('the policy declares the per-check budget, and an override may only harden it', async () => {
  const directory = checkDirectory({ 'spin.mjs': "export default { id:'probe.spin', title:'t', needsSnapshot:false, params:{}, evaluate: () => { for(;;){} } };" });
  const catalogue = await discoverChecks({ directory });
  const { root } = repoWithCommit({ 'a.txt': 'x\n' }, 'preflight-budget');

  const fromPolicy = await runPreflight({
    cwd: root, gate: 'preflight', catalogue,
    policy: gatePolicy([{ id: 'probe.spin', required: true }], { checkTimeoutMs: 250 }),
  });
  assert.equal(fromPolicy.result.checks[0].evidence[0].observed.timeoutMs, 250);

  const raised = await runPreflight({
    cwd: root, gate: 'preflight', catalogue, checkTimeoutMs: 400,
    policy: gatePolicy([{ id: 'probe.spin', required: true }], { checkTimeoutMs: 250 }),
  });
  assert.equal(raised.result.checks[0].evidence[0].observed.timeoutMs, 250, 'a command line must not widen a policy budget');

  const lowered = await runPreflight({
    cwd: root, gate: 'preflight', catalogue, checkTimeoutMs: 150,
    policy: gatePolicy([{ id: 'probe.spin', required: true }], { checkTimeoutMs: 250 }),
  });
  assert.equal(lowered.result.checks[0].evidence[0].observed.timeoutMs, 150, 'but it may harden it');
});

test('a timed-out check is not retried', async () => {
  const directory = checkDirectory({
    'counting.mjs': `
      import { appendFileSync } from 'node:fs';
      export default { id:'probe.counting', title:'t', needsSnapshot:false, params:{},
        evaluate: () => { appendFileSync(process.env.AUDIT_PROBE_LOG, 'run\\n'); for(;;){} } };
    `,
  });
  const log = join(scratch, `attempts-${sequence += 1}.log`);
  writeFileSync(log, '');
  process.env.AUDIT_PROBE_LOG = log;

  try {
    const { root } = repoWithCommit({ 'a.txt': 'x\n' }, 'preflight-noretry');
    await runPreflight({
      cwd: root, gate: 'preflight', checkTimeoutMs: 300,
      catalogue: await discoverChecks({ directory }),
      policy: gatePolicy([{ id: 'probe.counting', required: true }]),
    });

    assert.equal(readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length, 1, 'the check must run exactly once');
  } finally {
    delete process.env.AUDIT_PROBE_LOG;
  }
});
