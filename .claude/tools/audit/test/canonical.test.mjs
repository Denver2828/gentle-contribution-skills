import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJson, digest, stripVolatile, equivalent, CanonicalError } from '../lib/canonical.mjs';

test('object keys are sorted, so key order cannot change a hash', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(digest({ b: 1, a: 2 }), digest({ a: 2, b: 1 }));
});

test('nested structures serialize deterministically', () => {
  const left = { checks: [{ id: 'x', status: 'PASS' }], gate: 'preflight' };
  const right = { gate: 'preflight', checks: [{ status: 'PASS', id: 'x' }] };
  assert.equal(canonicalJson(left), canonicalJson(right));
});

test('array order is preserved, because order is meaningful', () => {
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test('undefined is refused instead of being silently dropped', () => {
  assert.throws(() => canonicalJson({ a: undefined }), CanonicalError);
});

test('non-finite numbers are refused', () => {
  assert.throws(() => canonicalJson({ a: NaN }), CanonicalError);
  assert.throws(() => canonicalJson({ a: Infinity }), CanonicalError);
});

test('negative zero cannot hash differently from zero', () => {
  assert.equal(digest({ a: -0 }), digest({ a: 0 }));
});

test('non-plain objects are refused rather than half-serialized', () => {
  assert.throws(() => canonicalJson({ when: new Date(0) }), CanonicalError);
});

test('digest is prefixed with its algorithm and is 64 hex chars', () => {
  assert.match(digest({ a: 1 }), /^sha256:[0-9a-f]{64}$/);
});

test('stripVolatile removes exactly the documented volatile fields', () => {
  const result = {
    runId: 'run_a', startedAt: 'x', finishedAt: 'y', gate: 'preflight',
    checks: [{ id: 'a.b', durationMs: 12, status: 'PASS' }],
  };
  const stripped = stripVolatile(result);
  assert.deepEqual(Object.keys(stripped).sort(), ['checks', 'gate']);
  assert.deepEqual(Object.keys(stripped.checks[0]).sort(), ['id', 'status']);
  assert.equal(result.runId, 'run_a', 'the input must not be mutated');
});

test('two runs differing only in volatile fields are equivalent', () => {
  const base = { runId: 'r1', startedAt: 'a', finishedAt: 'b', gate: 'g', checks: [{ id: 'a.b', durationMs: 1, status: 'PASS' }] };
  const later = { runId: 'r2', startedAt: 'c', finishedAt: 'd', gate: 'g', checks: [{ id: 'a.b', durationMs: 999, status: 'PASS' }] };
  assert.equal(equivalent(base, later), true);
});

test('a real difference is not hidden by the volatile filter', () => {
  const base = { runId: 'r1', startedAt: 'a', finishedAt: 'b', gate: 'g', checks: [{ id: 'a.b', durationMs: 1, status: 'PASS' }] };
  const changed = { runId: 'r1', startedAt: 'a', finishedAt: 'b', gate: 'g', checks: [{ id: 'a.b', durationMs: 1, status: 'FAIL' }] };
  assert.equal(equivalent(base, changed), false);
});
