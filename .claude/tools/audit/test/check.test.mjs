import test from 'node:test';
import assert from 'node:assert/strict';

import { defineCheck, runCheck, notRun } from '../lib/check.mjs';
import { STATUS } from '../lib/status.mjs';
import { makeEvidence, EVIDENCE_TYPE } from '../lib/evidence.mjs';

const evidence = () => [makeEvidence({ type: EVIDENCE_TYPE.COMPUTED, source: 'test', observed: { ok: true } })];

const build = (run, required = true) => defineCheck({ id: 'test.subject', title: 'Subject', required, run });

test('a malformed definition is rejected at definition time', () => {
  assert.throws(() => defineCheck({ id: 'BadID', title: 't', required: true, run: async () => {} }), TypeError);
  assert.throws(() => defineCheck({ id: 'test.ok', title: '', required: true, run: async () => {} }), TypeError);
  assert.throws(() => defineCheck({ id: 'test.ok', title: 't', required: 'yes', run: async () => {} }), TypeError);
  assert.throws(() => defineCheck({ id: 'test.ok', title: 't', required: true, run: null }), TypeError);
});

test('a well formed PASS survives unchanged', async () => {
  const result = await runCheck(build(async () => ({ status: STATUS.PASS, reason: 'observed', evidence: evidence() })));
  assert.equal(result.status, STATUS.PASS);
  assert.equal(result.reason, 'observed');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.remediation, null);
});

test('a check that throws becomes UNKNOWN, never PASS', async () => {
  const result = await runCheck(build(async () => { throw new Error('boom'); }));
  assert.equal(result.status, STATUS.UNKNOWN);
  assert.match(result.reason, /threw and cannot conclude: boom/);
  assert.equal(result.evidence.length, 1, 'the failure itself is recorded as evidence');
});

test('a non-object return becomes UNKNOWN', async () => {
  for (const bad of [undefined, null, 'PASS', 42, [1]]) {
    const result = await runCheck(build(async () => bad));
    assert.equal(result.status, STATUS.UNKNOWN, `returning ${JSON.stringify(bad)} must not conclude`);
  }
});

test('an unrecognised status becomes UNKNOWN', async () => {
  const result = await runCheck(build(async () => ({ status: 'OK', reason: 'x', evidence: evidence() })));
  assert.equal(result.status, STATUS.UNKNOWN);
  assert.match(result.reason, /unrecognised status/);
});

test('a conclusion with no reason becomes UNKNOWN', async () => {
  const result = await runCheck(build(async () => ({ status: STATUS.PASS, reason: '   ', evidence: evidence() })));
  assert.equal(result.status, STATUS.UNKNOWN);
  assert.match(result.reason, /no reason/);
});

test('a PASS that cites no evidence is refused', async () => {
  const result = await runCheck(build(async () => ({ status: STATUS.PASS, reason: 'trust me', evidence: [] })));
  assert.equal(result.status, STATUS.UNKNOWN);
  assert.match(result.reason, /must cite at least one evidence item/);
});

test('a FAIL that cites no evidence is refused too', async () => {
  const result = await runCheck(build(async () => ({ status: STATUS.FAIL, reason: 'looks wrong', evidence: [] })));
  assert.equal(result.status, STATUS.UNKNOWN);
});

test('required UNKNOWN and NOT_RUN may carry no evidence but must carry remediation', async () => {
  const unknown = await runCheck(build(async () => ({
    status: STATUS.UNKNOWN,
    reason: 'network unreachable',
    remediation: 'Restore connectivity, then run the check again.',
  })));
  assert.equal(unknown.status, STATUS.UNKNOWN);
  assert.equal(unknown.reason, 'network unreachable');
  assert.match(unknown.remediation, /Restore connectivity/);

  const skipped = notRun(
    build(async () => {}),
    'the required check is unavailable on this host',
    'Run it on a supported host, or make it optional in the policy.'
  );
  assert.equal(skipped.status, STATUS.NOT_RUN);
  assert.equal(skipped.evidence.length, 0);
});

test('a required blocking result without remediation becomes a tool-contract UNKNOWN', async () => {
  for (const status of [STATUS.FAIL, STATUS.UNKNOWN, STATUS.NOT_RUN]) {
    const result = await runCheck(build(async () => ({ status, reason: 'blocked', evidence: evidence() })));
    assert.equal(result.status, STATUS.UNKNOWN, `${status} without remediation must be downgraded`);
    assert.match(result.reason, new RegExp(`required ${status}.*remediation`));
    assert.match(result.remediation, /Fix the check implementation/);
    assert.equal(result.evidence.some((item) => item.source === 'test'), true, 'the original evidence is preserved');
  }
});

test('optional blocking results may omit remediation because they do not block the gate', async () => {
  const result = await runCheck(build(async () => ({ status: STATUS.FAIL, reason: 'advisory', evidence: evidence() }), false));
  assert.equal(result.status, STATUS.FAIL);
  assert.equal(result.remediation, null);

  const skipped = notRun(build(async () => {}, false), 'not applicable to this operation');
  assert.equal(skipped.status, STATUS.NOT_RUN);
  assert.equal(skipped.remediation, null);
});

test('required NOT_RUN construction without remediation fails closed immediately', () => {
  const skipped = notRun(build(async () => {}), 'unavailable');
  assert.equal(skipped.status, STATUS.UNKNOWN);
  assert.match(skipped.reason, /required NOT_RUN.*remediation/);
});

test('NOT_RUN without a motive is refused', () => {
  assert.throws(() => notRun(build(async () => {}), ''), TypeError);
});

test('duration is measured from the injected clock', async () => {
  let tick = 1000;
  const result = await runCheck(
    build(async () => ({ status: STATUS.PASS, reason: 'ok', evidence: evidence() })),
    {},
    { now: () => { tick += 25; return tick; } }
  );
  assert.equal(result.durationMs, 25);
});

test('the required flag is carried from the definition, not from the outcome', async () => {
  const result = await runCheck(build(async () => ({ status: STATUS.PASS, reason: 'ok', evidence: evidence() }), false));
  assert.equal(result.required, false);
});
