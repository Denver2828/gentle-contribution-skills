// A receipt issued before auditor-result/v3 keeps working, byte for byte.
//
// test/fixtures/pre-v3-store was produced by the pre-v3 code (commit ea7a8af,
// generator: test/fixtures/make-pre-v3-store.mjs): one AUTHORIZED lineage
// whose receipt binds a v2 auditor result. This test opens a copy of that
// store with the current code and walks the forward path short of the network
// (gate-publish, reserve-attempt, load and consume the ticket), then checks
// that no historical artifact moved.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore } from '../lib/store/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'pre-v3-store');
const CANDIDATE = `sha256:${'c'.repeat(64)}`;
const LINEAGE = 'pre-v3';

const scratch = mkdtempSync(join(tmpdir(), 'audit-pre-v3-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const filesUnder = (root, dir) => readdirSync(join(root, dir)).map((name) => join(root, dir, name));

test('a pre-v3 receipt over a v2 result gate-publishes, reserves and consumes with every historical byte intact', () => {
  const root = join(scratch, 'store');
  cpSync(FIXTURE, root, { recursive: true });
  const api = openStore({ override: root, allowOutsideWorkspace: true, lockOptions: { waitMs: 4000 } });

  const before = api.status(LINEAGE);
  assert.equal(before.state, 'AUTHORIZED');
  const [auditPath] = filesUnder(root, 'audit-results');
  const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  assert.equal(audit.schemaVersion, 'auditor-result/v2', 'the fixture holds a v2 result');
  assert.equal(audit.designCoverage, undefined);

  const historical = ['audit-results', 'authorizations', 'evidence', 'task-contracts']
    .flatMap((dir) => filesUnder(root, dir))
    .map((path) => [path, sha(path)]);

  api.gatePublish({ lineage: LINEAGE, currentCandidateId: CANDIDATE });
  assert.equal(api.status(LINEAGE).state, 'PUBLISHABLE');

  const { ticket } = api.reserveAttempt({ lineage: LINEAGE, currentCandidateId: CANDIDATE });
  assert.equal(ticket.receiptId, before.receiptId, 'the ticket derives from the pre-v3 receipt');
  assert.equal(api.loadTicket({ lineage: LINEAGE }).ticket.ticketId, ticket.ticketId);

  const consumed = api.consumeTicket({ lineage: LINEAGE, ticketId: ticket.ticketId });
  assert.equal(consumed.ticket.ticketId, ticket.ticketId);

  const after = api.status(LINEAGE);
  assert.equal(after.receiptId, before.receiptId);
  assert.equal(after.auditResultId, before.auditResultId);
  assert.equal(after.auditResultSha256, before.auditResultSha256);
  assert.equal(after.evidenceId, before.evidenceId);
  for (const [path, digest] of historical) {
    assert.equal(sha(path), digest, `${path} must not change`);
  }
});
