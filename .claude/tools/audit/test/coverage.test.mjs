import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCoverage } from '../lib/coverage.mjs';
import { completeCoverage } from './helpers/documents.mjs';

test('finite total and full review prove coverage', () => {
  assert.equal(evaluateCoverage(completeCoverage({ count: 3 })).complete, true);
});

test('a limit-shaped first page without termination cannot claim completeness', () => {
  const receipt = { ...completeCoverage({ count: 20 }), authoritativeTotal: null, termination: 'unknown' };
  assert.equal(evaluateCoverage(receipt).complete, false);
});

test('page arithmetic, exclusions and consumer requirements fail closed', () => {
  assert.equal(evaluateCoverage({ ...completeCoverage({ count: 2 }), reviewedCount: 1 }).complete, false);
  assert.equal(evaluateCoverage({ ...completeCoverage(), exclusions: ['page unavailable'] }).complete, false);
  assert.equal(evaluateCoverage(completeCoverage(), { requireInterval: true }).complete, false);
  assert.equal(evaluateCoverage(completeCoverage(), { requireStableRetrieval: true }).complete, false);
  assert.equal(evaluateCoverage(completeCoverage({ interval: { since: '2026-08-01T00:00:00Z', until: '2026-08-28T00:00:00Z' }, retrieval: 'stable-id' }), { requireInterval: true, requireStableRetrieval: true }).complete, true);
});

test('multi-page receipts bind each next cursor to the following page', () => {
  const receipt = completeCoverage({ count: 2 });
  receipt.pages = [{ cursor: null, nextCursor: 'page-2', count: 1 }, { cursor: 'wrong', nextCursor: null, count: 1 }];
  receipt.termination = 'cursor-exhausted';
  receipt.authoritativeTotal = null;
  assert.equal(evaluateCoverage(receipt).complete, false);
  receipt.pages[1].cursor = 'page-2';
  assert.equal(evaluateCoverage(receipt).complete, true);
});

test('a terminal page without proof of the retrieval origin is incomplete', () => {
  const receipt = completeCoverage();
  receipt.pages = [{ cursor: 'page-99', nextCursor: null, count: 0 }];
  receipt.termination = 'cursor-exhausted';
  receipt.authoritativeTotal = null;
  assert.equal(evaluateCoverage(receipt).complete, false);
});

test('REGRESSION (ASTRA-05): an authoritative total that contradicts returnedCount defeats every termination, cursor exhaustion included', () => {
  const contradictory = { ...completeCoverage({ count: 0 }), termination: 'cursor-exhausted', authoritativeTotal: 100 };
  const result = evaluateCoverage(contradictory);
  assert.equal(result.complete, false);
  assert.match(result.reason, /authoritativeTotal 100 contradicts returnedCount 0/);
  // the triage flags do not rescue it
  const strict = { ...contradictory, interval: { since: '2026-08-01T00:00:00Z', until: '2026-08-28T00:00:00Z' }, retrieval: 'stable-id' };
  assert.equal(evaluateCoverage(strict, { requireInterval: true, requireStableRetrieval: true }).complete, false);
  // the other terminations were already refused; they still are, now for the contradiction itself
  for (const termination of ['authoritative-total', 'finite-listing']) {
    assert.match(evaluateCoverage({ ...contradictory, termination }).reason, /contradicts/);
  }
});

test('CONTROL (ASTRA-05): cursor exhaustion with no total, or with a matching total, still proves termination', () => {
  const exhausted = { ...completeCoverage({ count: 5 }), termination: 'cursor-exhausted' };
  assert.equal(evaluateCoverage({ ...exhausted, authoritativeTotal: null }).complete, true);
  assert.equal(evaluateCoverage({ ...exhausted, authoritativeTotal: 5 }).complete, true);
  assert.equal(evaluateCoverage({ ...completeCoverage({ count: 0 }), termination: 'cursor-exhausted', authoritativeTotal: 0 }).complete, true);
});
