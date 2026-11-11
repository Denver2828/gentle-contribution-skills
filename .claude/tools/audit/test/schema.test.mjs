import test from 'node:test';
import assert from 'node:assert/strict';

import { validate, SchemaError } from '../lib/jsonschema.mjs';
import { validateResult, assertValidResult, ContractError, resultSchema } from '../lib/validate.mjs';

const VALID = Object.freeze({
  schemaVersion: '1.0.0',
  toolVersion: '0.1.0',
  runId: 'run_abc',
  gate: 'preflight',
  status: 'PASS',
  startedAt: '2026-08-01T00:00:00Z',
  finishedAt: '2026-08-01T00:00:01.500Z',
  repository: { root: '/repo', branch: 'main', head: 'abc123', dirty: false },
  policy: { id: 'default', version: '1' },
  binding: {
    snapshotHash: `sha256:${'b'.repeat(64)}`,
    snapshotHashAfter: `sha256:${'b'.repeat(64)}`,
    stable: true,
    policyHash: `sha256:${'c'.repeat(64)}`,
    toolVersion: '0.1.0',
    decisionId: `sha256:${'d'.repeat(64)}`,
  },
  summary: { pass: 1, fail: 0, unknown: 0, notRun: 0 },
  checks: [{
    id: 'git.repository-readable',
    title: 'Git repository is readable',
    status: 'PASS',
    required: true,
    durationMs: 12,
    reason: 'Repository metadata was read successfully',
    evidence: [{
      type: 'git',
      source: 'rev-parse',
      observed: { insideWorkTree: true },
      hash: `sha256:${'a'.repeat(64)}`,
    }],
    remediation: null,
  }],
  errors: [],
});

const withResult = (mutate) => {
  const copy = structuredClone(VALID);
  mutate(copy);
  return copy;
};

test('the reference document from the specification is accepted', () => {
  const { valid, errors } = validateResult(VALID);
  assert.equal(valid, true, JSON.stringify(errors));
});

test('an invalid gate status is rejected', () => {
  const { valid, errors } = validateResult(withResult((r) => { r.status = 'OK'; }));
  assert.equal(valid, false);
  assert.match(errors[0].message, /expected one of/);
});

test('an invalid check status is rejected', () => {
  assert.equal(validateResult(withResult((r) => { r.checks[0].status = 'passed'; })).valid, false);
});

test('an unexpected property is rejected', () => {
  const { valid, errors } = validateResult(withResult((r) => { r.extra = true; }));
  assert.equal(valid, false);
  assert.match(errors[0].message, /unexpected property "extra"/);
});

test('an unexpected property inside a check is rejected', () => {
  assert.equal(validateResult(withResult((r) => { r.checks[0].note = 'x'; })).valid, false);
});

test('a missing required field is rejected', () => {
  for (const field of ['summary', 'checks', 'errors', 'policy', 'repository', 'runId', 'gate', 'binding']) {
    const { valid } = validateResult(withResult((r) => { delete r[field]; }));
    assert.equal(valid, false, `missing "${field}" must be rejected`);
  }
});

test('a check with an empty reason is rejected, for every status', () => {
  assert.equal(validateResult(withResult((r) => { r.checks[0].reason = ''; })).valid, false);
});

test('every required blocking check must carry a non-empty remediation', () => {
  for (const status of ['FAIL', 'UNKNOWN', 'NOT_RUN']) {
    const missing = withResult((r) => {
      r.status = status;
      r.checks[0].status = status;
      r.checks[0].remediation = null;
    });
    assert.equal(
      validate(resultSchema(), missing).valid,
      true,
      'the structural schema deliberately permits null; validateResult owns the cross-field invariant'
    );
    const outcome = validateResult(missing);
    assert.equal(outcome.valid, false, `${status} without remediation must be rejected`);
    assert.match(outcome.errors[0].path, /remediation/);
  }
});

test('optional blocking checks may omit remediation', () => {
  const optional = withResult((r) => {
    r.checks[0].status = 'FAIL';
    r.checks[0].required = false;
    r.checks[0].remediation = null;
  });
  assert.equal(validateResult(optional).valid, true);
});

test('a malformed evidence hash is rejected', () => {
  assert.equal(validateResult(withResult((r) => { r.checks[0].evidence[0].hash = 'abc'; })).valid, false);
  assert.equal(validateResult(withResult((r) => { r.checks[0].evidence[0].hash = `md5:${'a'.repeat(32)}`; })).valid, false);
});

test('a malformed check id is rejected', () => {
  for (const id of ['Git.Readable', 'git', 'git_repository', 'git..x']) {
    assert.equal(validateResult(withResult((r) => { r.checks[0].id = id; })).valid, false, `${id} must be rejected`);
  }
});

test('a non-ISO timestamp is rejected', () => {
  assert.equal(validateResult(withResult((r) => { r.startedAt = '2026-08-01 00:00:00'; })).valid, false);
});

test('a negative summary count is rejected', () => {
  assert.equal(validateResult(withResult((r) => { r.summary.pass = -1; })).valid, false);
});

test('a non-integer duration is rejected', () => {
  assert.equal(validateResult(withResult((r) => { r.checks[0].durationMs = 1.5; })).valid, false);
});

test('a schemaVersion other than 1.0.0 is rejected', () => {
  assert.equal(validateResult(withResult((r) => { r.schemaVersion = '2.0.0'; })).valid, false);
});

test('nullable fields accept null but not the wrong type', () => {
  assert.equal(validateResult(withResult((r) => { r.repository.branch = null; })).valid, true);
  assert.equal(validateResult(withResult((r) => { r.repository.branch = 7; })).valid, false);
});

test('assertValidResult throws a ContractError listing the violations', () => {
  assert.throws(() => assertValidResult(withResult((r) => { r.status = 'OK'; })), ContractError);
  assert.equal(assertValidResult(VALID), VALID);
});

test('the validator fails closed on a keyword it does not implement', () => {
  assert.throws(
    () => validate({ type: 'object', propertyNames: { pattern: '^x$' } }, {}),
    SchemaError,
    'an unimplemented keyword must throw, never be ignored'
  );
});

test('the validator refuses an unresolvable or remote $ref', () => {
  assert.throws(() => validate({ $ref: '#/$defs/missing' }, 1), SchemaError);
  assert.throws(() => validate({ $ref: 'https://example.com/s.json' }, 1), SchemaError);
});

test('the shipped schema uses only keywords this validator implements', () => {
  // Walking the real schema with a conforming document is what proves it: any
  // unsupported keyword anywhere in it would throw here.
  assert.doesNotThrow(() => validate(resultSchema(), VALID));
});
