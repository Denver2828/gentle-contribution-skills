// Artifacts issued before auditor-result/v4 keep working, byte for byte.
//
// test/fixtures/pre-v4-store was produced by the pre-v4 code (generator:
// test/fixtures/make-pre-v4-store.mjs). `pre-v4` is AUTHORIZED over a v3 PASS
// result; `pre-v4-fail` stopped at NEEDS_CHANGES over a v3 result with a
// decisive FAIL row. This test opens a copy of that store with the current
// code, walks both lineages forward as far as their own contract allows short
// of the network, and checks that no historical artifact moved.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore } from '../lib/store/store.mjs';
import { validateAuditorResult } from '../lib/validate.mjs';
import { auditorResultIntact } from '../lib/auditor-result.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'pre-v4-store');
const CANDIDATE = `sha256:${'c'.repeat(64)}`;

const scratch = mkdtempSync(join(tmpdir(), 'audit-pre-v4-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const filesUnder = (root, dir) => readdirSync(join(root, dir)).map((name) => join(root, dir, name));
const historicalFiles = (root) => ['audit-results', 'authorizations', 'evidence', 'task-contracts']
  .flatMap((dir) => filesUnder(root, dir))
  .map((path) => [path, sha(path)]);

function open(name) {
  const root = join(scratch, name);
  cpSync(FIXTURE, root, { recursive: true });
  return { root, api: openStore({ override: root, allowOutsideWorkspace: true, lockOptions: { waitMs: 4000 } }) };
}

test('the fixture holds v3 results that carry no verification and no limit, and they still validate as v3', () => {
  for (const path of filesUnder(FIXTURE, 'audit-results')) {
    const audit = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(audit.schemaVersion, 'auditor-result/v3');
    for (const row of audit.acceptanceCoverage) {
      assert.equal(Object.hasOwn(row, 'verification'), false);
      assert.equal(Object.hasOwn(row, 'limit'), false);
    }
    assert.equal(validateAuditorResult(audit).valid, true);
    assert.equal(auditorResultIntact(audit), true, 'the historical identity still reproduces');
  }
});

test('a pre-v4 receipt over a v3 result gate-publishes, reserves and consumes with every historical byte intact', () => {
  const { root, api } = open('authorized');
  const before = api.status('pre-v4');
  assert.equal(before.state, 'AUTHORIZED');
  const historical = historicalFiles(root);

  api.gatePublish({ lineage: 'pre-v4', currentCandidateId: CANDIDATE });
  assert.equal(api.status('pre-v4').state, 'PUBLISHABLE');
  const { ticket } = api.reserveAttempt({ lineage: 'pre-v4', currentCandidateId: CANDIDATE });
  assert.equal(ticket.receiptId, before.receiptId, 'the ticket derives from the pre-v4 receipt');
  assert.equal(api.loadTicket({ lineage: 'pre-v4' }).ticket.ticketId, ticket.ticketId);
  assert.equal(api.consumeTicket({ lineage: 'pre-v4', ticketId: ticket.ticketId }).ticket.ticketId, ticket.ticketId);

  const after = api.status('pre-v4');
  assert.equal(after.receiptId, before.receiptId);
  assert.equal(after.auditResultId, before.auditResultId);
  assert.equal(after.auditResultSha256, before.auditResultSha256);
  assert.equal(after.evidenceId, before.evidenceId);
  for (const [path, digest] of historical) assert.equal(sha(path), digest, `${path} must not change`);
});

test('a pre-v4 NEEDS_CHANGES lineage over a v3 FAIL keeps its single correction, with its result untouched', () => {
  const { root, api } = open('needs-changes');
  const before = api.status('pre-v4-fail');
  assert.equal(before.state, 'NEEDS_CHANGES');
  assert.equal(before.corrections_used, 0);
  const historical = historicalFiles(root);

  const reserved = api.reserveCorrection({ lineage: 'pre-v4-fail' });
  assert.equal(reserved.corrections_used, 1);
  assert.equal(reserved.auditResultId, before.auditResultId);
  for (const [path, digest] of historical) assert.equal(sha(path), digest, `${path} must not change`);
});
