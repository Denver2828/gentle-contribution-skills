import test from 'node:test';
import assert from 'node:assert/strict';

import { redact, redactString } from '../lib/redact.mjs';
import { makeEvidence, EVIDENCE_TYPE, evidenceIntact } from '../lib/evidence.mjs';

test('github tokens are redacted in every shape', () => {
  assert.equal(redactString('token gho_abcdefghijklmnopqrstuvwxyz012345'), 'token <redacted:github-token>');
  assert.equal(redactString('ghp_abcdefghijklmnopqrstuvwxyz012345'), '<redacted:github-token>');
  assert.match(redactString('github_pat_11ABCDEFG0abcdefghijklmno'), /<redacted:github-pat>/);
});

test('bearer headers and url credentials are redacted', () => {
  assert.match(redactString('Authorization: Bearer abcdefghijklmnop'), /<redacted:bearer-token>/);
  assert.equal(
    redactString('https://user:s3cr3tvalue@github.com/x.git'),
    'https://<redacted:url-credentials>@github.com/x.git'
  );
});

test('private key blocks are redacted including the body', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nAAAABBBBCCCC\n-----END RSA PRIVATE KEY-----';
  assert.equal(redactString(pem), '<redacted:private-key>');
});

test('credential-bearing keys are replaced whatever their value type', () => {
  const out = redact({ Authorization: 'anything', api_key: { nested: 'x' }, password: 42 });
  assert.equal(out.Authorization, '<redacted:credential-key>');
  assert.equal(out.api_key, '<redacted:credential-key>');
  assert.equal(out.password, '<redacted:credential-key>');
});

test('a whole process environment is never recorded', () => {
  const out = redact({ env: { PATH: '/usr/bin', GH_TOKEN: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaa' } });
  assert.equal(out.env, '<redacted:environment>');
});

test('redaction reaches nested objects and arrays', () => {
  const out = redact({ commands: [{ argv: ['gh', 'auth', 'ghp_abcdefghijklmnopqrstuvwxyz012345'] }] });
  assert.equal(out.commands[0].argv[2], '<redacted:github-token>');
});

test('ordinary values pass through untouched', () => {
  const input = { branch: 'fix/810-monorepo', additions: 220, dirty: false, upstream: null };
  assert.deepEqual(redact(input), input);
});

test('the input object is never mutated', () => {
  const input = { token: 'ghp_abcdefghijklmnopqrstuvwxyz012345' };
  redact(input);
  assert.equal(input.token, 'ghp_abcdefghijklmnopqrstuvwxyz012345');
});

test('evidence hashes the redacted observation, so the digest matches what is stored', () => {
  const item = makeEvidence({
    type: EVIDENCE_TYPE.PROCESS,
    source: 'gh auth status',
    observed: { line: 'Token: ghp_abcdefghijklmnopqrstuvwxyz012345' },
  });
  assert.equal(item.observed.line.includes('ghp_'), false);
  assert.equal(evidenceIntact(item), true);
});

test('evidence refuses a missing source or an unknown type', () => {
  assert.throws(() => makeEvidence({ type: 'telepathy', source: 'x', observed: {} }), TypeError);
  assert.throws(() => makeEvidence({ type: EVIDENCE_TYPE.GIT, source: '  ', observed: {} }), TypeError);
  assert.throws(() => makeEvidence({ type: EVIDENCE_TYPE.GIT, source: 'git status', observed: 'text' }), TypeError);
});
