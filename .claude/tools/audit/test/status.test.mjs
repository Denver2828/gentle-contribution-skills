import test from 'node:test';
import assert from 'node:assert/strict';

import { STATUS, EXIT, aggregate, summarise, exitCodeFor, authorises, assertStatus } from '../lib/status.mjs';

const check = (id, status, required = true) => ({ id, status, required });

test('every status maps to a documented exit code', () => {
  assert.equal(exitCodeFor(STATUS.PASS), EXIT.PASS);
  assert.equal(exitCodeFor(STATUS.FAIL), EXIT.FAIL);
  assert.equal(exitCodeFor(STATUS.UNKNOWN), EXIT.INCONCLUSIVE);
  assert.equal(exitCodeFor(STATUS.NOT_RUN), EXIT.INCONCLUSIVE);
});

test('only PASS authorises', () => {
  assert.equal(authorises(STATUS.PASS), true);
  for (const status of [STATUS.FAIL, STATUS.UNKNOWN, STATUS.NOT_RUN]) {
    assert.equal(authorises(status), false, `${status} must not authorise`);
  }
});

test('an unrecognised status is rejected rather than defaulted', () => {
  assert.throws(() => assertStatus('OK', 'test'), TypeError);
  assert.throws(() => exitCodeFor(undefined), TypeError);
});

test('all required checks passing yields PASS', () => {
  const verdict = aggregate([check('a.one', STATUS.PASS), check('a.two', STATUS.PASS)]);
  assert.equal(verdict.status, STATUS.PASS);
  assert.match(verdict.reason, /2 required check/);
});

test('the worst required state wins: FAIL over UNKNOWN over NOT_RUN over PASS', () => {
  assert.equal(aggregate([check('a.one', STATUS.PASS), check('a.two', STATUS.NOT_RUN)]).status, STATUS.NOT_RUN);
  assert.equal(aggregate([check('a.one', STATUS.NOT_RUN), check('a.two', STATUS.UNKNOWN)]).status, STATUS.UNKNOWN);
  assert.equal(aggregate([check('a.one', STATUS.UNKNOWN), check('a.two', STATUS.FAIL)]).status, STATUS.FAIL);
});

test('the verdict names the offending checks', () => {
  const verdict = aggregate([check('a.one', STATUS.FAIL), check('a.two', STATUS.FAIL), check('a.three', STATUS.PASS)]);
  assert.match(verdict.reason, /a\.one, a\.two/);
});

test('an optional check never blocks, whatever it reports', () => {
  const verdict = aggregate([check('a.one', STATUS.PASS), check('a.two', STATUS.FAIL, false)]);
  assert.equal(verdict.status, STATUS.PASS);
});

test('a gate with no required checks is UNKNOWN, never PASS', () => {
  assert.equal(aggregate([]).status, STATUS.UNKNOWN);
  assert.equal(aggregate([check('a.one', STATUS.PASS, false)]).status, STATUS.UNKNOWN);
});

test('the summary counts every check, required or not', () => {
  const summary = summarise([
    check('a.one', STATUS.PASS), check('a.two', STATUS.FAIL, false),
    check('a.three', STATUS.UNKNOWN), check('a.four', STATUS.NOT_RUN),
  ]);
  assert.deepEqual(summary, { pass: 1, fail: 1, unknown: 1, notRun: 1 });
});
