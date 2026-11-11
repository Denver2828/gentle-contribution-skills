import test from 'node:test';
import assert from 'node:assert/strict';

import { runGate, exitCodeForResult, SCHEMA_VERSION } from '../lib/gate.mjs';
import { defineCheck, notRun } from '../lib/check.mjs';
import { STATUS, EXIT } from '../lib/status.mjs';
import { makeEvidence, EVIDENCE_TYPE } from '../lib/evidence.mjs';
import { validateResult } from '../lib/validate.mjs';
import { equivalent } from '../lib/canonical.mjs';
import { renderHuman } from '../lib/report.mjs';

const REPOSITORY = { root: '/repo', branch: 'main', head: 'abc123', dirty: false };
const POLICY = { id: 'test', version: '1' };

const evidence = (observed = { ok: true }) => [
  makeEvidence({ type: EVIDENCE_TYPE.COMPUTED, source: 'test', observed }),
];

const passing = (id, required = true) => defineCheck({
  id, title: `Check ${id}`, required,
  run: async () => ({ status: STATUS.PASS, reason: 'observed as expected', evidence: evidence() }),
});

const failing = (id, required = true) => defineCheck({
  id, title: `Check ${id}`, required,
  run: async () => ({ status: STATUS.FAIL, reason: 'observed a violation', evidence: evidence(), remediation: 'do the thing' }),
});

const throwing = (id) => defineCheck({
  id, title: `Check ${id}`, required: true,
  run: async () => { throw new Error('simulated internal failure'); },
});

const gate = (checks, extra = {}) => runGate({ gate: 'preflight', policy: POLICY, repository: REPOSITORY, checks, ...extra });

test('a passing gate produces a contract-valid PASS result', async () => {
  const result = await gate([passing('a.one'), passing('a.two')]);
  assert.equal(result.status, STATUS.PASS);
  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(result.summary, { pass: 2, fail: 0, unknown: 0, notRun: 0 });
  assert.equal(exitCodeForResult(result), EXIT.PASS);

  const { valid, errors } = validateResult(result);
  assert.equal(valid, true, JSON.stringify(errors));
});

test('one failing required check blocks the whole gate', async () => {
  const result = await gate([passing('a.one'), failing('a.two')]);
  assert.equal(result.status, STATUS.FAIL);
  assert.equal(exitCodeForResult(result), EXIT.FAIL);
  assert.equal(validateResult(result).valid, true);
});

test('a failing optional check is recorded but does not block', async () => {
  const result = await gate([passing('a.one'), failing('a.two', false)]);
  assert.equal(result.status, STATUS.PASS);
  assert.deepEqual(result.summary, { pass: 1, fail: 1, unknown: 0, notRun: 0 });
});

test('a check that throws blocks the gate and is surfaced as a structured error', async () => {
  const result = await gate([passing('a.one'), throwing('a.two')]);
  assert.equal(result.status, STATUS.UNKNOWN);
  assert.equal(exitCodeForResult(result), EXIT.INCONCLUSIVE);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'check.contract-violation');
  assert.equal(result.errors[0].checkId, 'a.two');
  assert.equal(validateResult(result).valid, true);
});

test('an internal failure never yields PASS, whatever else passed', async () => {
  const result = await gate([passing('a.one'), passing('a.two'), throwing('a.three')]);
  assert.notEqual(result.status, STATUS.PASS);
});

test('a gate with zero checks is UNKNOWN and blocks', async () => {
  const result = await gate([]);
  assert.equal(result.status, STATUS.UNKNOWN);
  assert.equal(exitCodeForResult(result), EXIT.INCONCLUSIVE);
  assert.equal(validateResult(result).valid, true);
});

test('a required check that was selected but not run blocks, carrying its motive', async () => {
  const check = passing('a.one');
  const skipped = notRun(
    check,
    'the configured runner is absent on this machine',
    'Install the configured runner, then run the gate again.'
  );
  const result = await gate([check], { preRun: new Map([[check.id, skipped]]) });

  assert.equal(result.status, STATUS.NOT_RUN);
  assert.equal(exitCodeForResult(result), EXIT.INCONCLUSIVE);
  assert.equal(result.checks[0].reason, 'the configured runner is absent on this machine');
  assert.equal(validateResult(result).valid, true);
});

test('a pre-decided blocking result cannot bypass remediation enforcement', async () => {
  const check = passing('a.one');
  const result = await gate([check], {
    preRun: new Map([[check.id, { status: STATUS.FAIL, reason: 'pre-decided failure', evidence: evidence() }]]),
  });

  assert.equal(result.status, STATUS.UNKNOWN);
  assert.match(result.checks[0].reason, /required FAIL.*remediation/);
  assert.equal(result.errors[0].code, 'check.contract-violation');
});

test('two runs over identical state are equivalent and share a runId', async () => {
  let tick = 0;
  const options = { now: () => (tick += 7), clock: () => '2026-08-01T00:00:00Z' };

  const first = await gate([passing('a.one'), failing('a.two', false)], options);
  tick = 5000;
  const second = await gate([passing('a.one'), failing('a.two', false)], options);

  assert.equal(first.runId, second.runId, 'the run id is derived from what was audited');
  assert.equal(equivalent(first, second), true);
});

test('a different repository state changes the runId', async () => {
  const first = await gate([passing('a.one')]);
  const second = await runGate({
    gate: 'preflight', policy: POLICY, checks: [passing('a.one')],
    repository: { ...REPOSITORY, head: 'def456' },
  });
  assert.notEqual(first.runId, second.runId);
});

test('runGate refuses a malformed invocation instead of guessing', async () => {
  await assert.rejects(() => runGate({ gate: '', policy: POLICY, repository: REPOSITORY, checks: [] }), TypeError);
  await assert.rejects(() => runGate({ gate: 'g', policy: POLICY, repository: REPOSITORY, checks: null }), TypeError);
});

test('the human summary is derived from the result and states the verdict', async () => {
  const result = await gate([passing('a.one'), failing('a.two')]);
  const text = renderHuman(result);
  assert.match(text, /gate preflight: FAIL/);
  assert.match(text, /a\.one \(required\)/);
  assert.match(text, /remediation: do the thing/);
  assert.match(text, /FAIL blocks\./);
});
