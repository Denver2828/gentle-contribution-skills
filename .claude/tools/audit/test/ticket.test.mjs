// Publication tickets: the binding, the one-live-ticket rule, expiry, and the
// recordAttempt hardening that arrived with them.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore, StoreError } from '../lib/store/store.mjs';
import { ticketOf, ticketIntact, ticketExpired, normalizeBody, bodyDigest, TICKET_TTL_MS } from '../lib/ticket.mjs';
import { validateTicket } from '../lib/validate.mjs';
import { attemptIntact } from '../lib/publication.mjs';
import { buildEvidence } from '../lib/evidence-record.mjs';
import { REQUIRED_SOURCES, READING, CONTRIBUTION } from '../lib/intake.mjs';
import { STATUS } from '../lib/status.mjs';
import { digest } from '../lib/canonical.mjs';
import { completeCoverage, auditorResult, TASK_CONTRACT } from './helpers/documents.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'audit-ticket-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;
const store = () => {
  const root = mkdtempSync(join(scratch, 'store-'));
  return { root, api: openStore({ override: root, allowOutsideWorkspace: true, lockOptions: { waitMs: 4000 } }) };
};

const id = (character) => `sha256:${character.repeat(64)}`;
const CANDIDATE = id('c');

const INTAKE = {
  repository: 'Gentleman-Programming/gentle-ai',
  contributionType: CONTRIBUTION.ISSUE,
  readings: REQUIRED_SOURCES.map((source) => ({
    source, command: `${source} --repo Gentleman-Programming/gentle-ai`, result: READING.COMPLETE, matches: 0, reviewed: false, coverage: completeCoverage({ source }),
  })),
  competing: [],
};

const BODY = 'hola mundo\ncon dos lineas\n';

const FREEZE = {
  baseTree: 'ab933c1c', candidateTree: '4daf0098',
  pathsDigest: id('1'), draftDigest: id('2'), policyDigest: id('3'), testManifestDigest: id('4'),
  draftBodySha256: bodyDigest(BODY),
  taskContract: TASK_CONTRACT,
  intake: INTAKE,
};

function evidenceFor() {
  return buildEvidence({
    result: {
      gate: 'preflight',
      status: STATUS.PASS,
      binding: { snapshotHash: id('5'), snapshotHashAfter: id('5'), stable: true, policyHash: id('7'), toolVersion: '0.1.0', decisionId: id('9') },
      summary: { pass: 1, fail: 0, unknown: 0, notRun: 0 },
      checks: [{ id: 'a.one', status: STATUS.PASS, required: true, reason: 'ok' }],
    },
    candidate: { status: STATUS.PASS, candidateId: CANDIDATE, reason: 'identified' },
  });
}

const BINDING = { operation: 'issue-comment', targetRepo: 'Gentleman-Programming/gentle-ai', targetNumber: 3297, bodySha256: bodyDigest(BODY), titleSha256: null };

/** A lineage taken all the way to PUBLISHABLE, ready to reserve. */
function publishable(api, lineage = `t-${sequence += 1}`, publication = BINDING) {
  const frozen = api.freeze({ lineage, candidateId: CANDIDATE, ...FREEZE });
  api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'PASS') });
  api.recordEvidence({ lineage, evidence: evidenceFor() });
  const { receipt } = api.authorize({ lineage, publication });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  return { lineage, receipt };
}

/** No binding arguments: the reservation derives it from the receipt. */
const reserve = (api, lineage) => api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });

function attemptFor({ attemptNumber, receiptId, evidenceId, outcome = 'published' }) {
  const record = {
    attemptVersion: '1.0.0', attemptNumber, receiptId, evidenceId, candidateId: CANDIDATE,
    outcome, reason: `attempt ${attemptNumber}`, detail: {}, publisher: { module: 'fake' },
  };
  return { ...record, attemptId: digest(record) };
}

function replaceCommittedTicket(api, lineage, ticket) {
  const artifact = join(api.layout.ticketArtifacts, `${ticket.ticketId.slice('sha256:'.length)}.json`);
  const text = `${JSON.stringify(ticket, null, 2)}\n`;
  writeFileSync(artifact, text);
  writeFileSync(join(api.layout.tickets, `${lineage}.json`), text);
  const index = JSON.parse(readFileSync(api.layout.index, 'utf8'));
  index.lineages[lineage].ticketId = ticket.ticketId;
  index.lineages[lineage].attempts = ticket.attemptNumber;
  writeFileSync(api.layout.index, `${JSON.stringify(index, null, 2)}\n`);
}

/** The lineage's live ticket, rewritten with a validity window already closed. */
function expireLiveTicket(api, lineage) {
  const current = api.status(lineage);
  const path = join(api.layout.ticketArtifacts, `${current.ticketId.slice('sha256:'.length)}.json`);
  const live = JSON.parse(readFileSync(path, 'utf8'));
  const { ticketId, expiresAt, issuedAt, ...rest } = live;
  const expired = ticketOf({ ...rest, issuedAt: new Date(Date.now() - TICKET_TTL_MS - 60_000).toISOString() });
  replaceCommittedTicket(api, lineage, expired);
  return expired;
}

// -- normalization ------------------------------------------------------------------

test('body normalization strips the BOM, folds line endings and drops trailing newlines', () => {
  assert.equal(normalizeBody('﻿hola\r\nmundo\r\n'), 'hola\nmundo');
  assert.equal(normalizeBody('hola\rmundo\n\n\n'), 'hola\nmundo');
  assert.equal(bodyDigest('﻿hola\r\nmundo\r\n'), bodyDigest('hola\nmundo'),
    'a Windows-saved draft and the body GitHub echoes back must hash identically');
});

test('REGRESSION: normalizeBody is idempotent -- canonical in, canonical out, over a hostile set', () => {
  // The publisher canonicalizes once and then hashes with bodyDigest, which
  // normalizes AGAIN internally. Those two digests are equal only because
  // normalizing a canonical value changes nothing; if this test ever fails,
  // the ledger-side hash of the raw file and the publisher-side hash of the
  // canonical form would silently diverge.
  const hostile = [
    '\uFEFFhola\r\nmundo\r\n\n\n',
    '\uFEFF\uFEFFdoble',
    '\uFEFF\r\n\r\n',
    'linea\rvieja\r\r',
    'bom en el medio \uFEFF se queda',
    'sin cambios',
    '\n\n\n',
    '',
  ];
  for (const raw of hostile) {
    const canonical = normalizeBody(raw);
    assert.equal(normalizeBody(canonical), canonical, `idempotence over ${JSON.stringify(raw)}`);
    assert.equal(bodyDigest(canonical), bodyDigest(raw),
      `hashing the canonical form equals hashing the raw form for ${JSON.stringify(raw)}`);
  }
});

// -- the binding is mandatory, at authorization ----------------------------------------

test('authorizing without the publication binding is refused before a receipt exists', () => {
  const { api } = store();
  const lineage = `t-${sequence += 1}`;
  const frozen = api.freeze({ lineage, candidateId: CANDIDATE, ...FREEZE });
  api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'PASS') });
  api.recordEvidence({ lineage, evidence: evidenceFor() });

  assert.throws(() => api.authorize({ lineage }), (error) =>
    error instanceof StoreError && error.detail.failure === 'refused'
    && /names no publication binding/.test(error.detail.refusals.join(' ')));
  assert.equal(api.status(lineage).receiptId, null, 'no receipt was minted');
});

test('every cross-field rule of the binding refuses at authorization, and no receipt exists', () => {
  const { api } = store();
  const lineage = `t-${sequence += 1}`;
  const frozen = api.freeze({ lineage, candidateId: CANDIDATE, ...FREEZE });
  api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'PASS') });
  api.recordEvidence({ lineage, evidence: evidenceFor() });

  const cases = {
    'unknown operation': { operation: 'gist-create' },
    'malformed repo': { targetRepo: 'not-a-repo' },
    'comment without a target number': { targetNumber: null },
    'create with a target number': { operation: 'issue-create', titleSha256: id('a'), targetNumber: 7 },
    'issue-create without a title hash': { operation: 'issue-create', targetNumber: null },
    'comment with a title hash': { titleSha256: id('a') },
    'missing body hash': { bodySha256: undefined },
  };

  for (const [label, overrides] of Object.entries(cases)) {
    assert.throws(() => api.authorize({ lineage, publication: { ...BINDING, ...overrides } }), (error) =>
      error instanceof StoreError && error.detail.failure === 'refused', label);
  }
  assert.equal(api.status(lineage).receiptId, null);
});

// -- the ticket -----------------------------------------------------------------------

test('a reservation emits a schema-valid, self-describing one-shot ticket', () => {
  const { api } = store();
  const { lineage, receipt } = publishable(api);

  process.env.CLAUDE_SESSION_ID = 'session-under-test';
  let outcome;
  try {
    outcome = reserve(api, lineage);
  } finally {
    delete process.env.CLAUDE_SESSION_ID;
  }

  const { ticket } = outcome;
  assert.equal(validateTicket(ticket).valid, true);
  assert.equal(ticketIntact(ticket), true);
  assert.equal(ticket.lineage, lineage);
  assert.equal(ticket.attemptNumber, 1);
  assert.equal(ticket.receiptId, receipt.receiptId);
  assert.equal(ticket.candidateId, CANDIDATE);
  assert.equal(ticket.operation, 'issue-comment');
  assert.equal(ticket.targetNumber, 3297);
  assert.equal(ticket.bodySha256, bodyDigest(BODY));
  assert.equal(ticket.titleSha256, null);
  // The ticket is DERIVED from the receipt's binding, field for field: the
  // reservation had no say in what gets published, or where.
  assert.deepEqual(
    { operation: ticket.operation, targetRepo: ticket.targetRepo, targetNumber: ticket.targetNumber, bodySha256: ticket.bodySha256, titleSha256: ticket.titleSha256, dependsOn: ticket.dependsOn },
    receipt.publication
  );
  assert.equal(ticket.sessionId, 'session-under-test', 'recorded, never enforced');
  assert.equal(Date.parse(ticket.expiresAt) - Date.parse(ticket.issuedAt), TICKET_TTL_MS);

  const stored = JSON.parse(readFileSync(join(api.layout.tickets, `${lineage}.json`), 'utf8'));
  assert.deepEqual(stored, { ...ticket });
});

test('REGRESSION: a second reservation while a ticket is pending is refused, not double-booked', () => {
  const { api } = store();
  const { lineage } = publishable(api);
  const first = reserve(api, lineage);

  assert.throws(() => reserve(api, lineage), (error) =>
    error instanceof StoreError && error.detail.failure === 'ticket-pending' && error.detail.ticketId === first.ticket.ticketId);
  assert.equal(api.status(lineage).attempts, 1, 'the refused reservation burned nothing');
});

test('an expired ticket is swept to expired/, never deleted, and reservation proceeds', () => {
  const { api } = store();
  const { lineage } = publishable(api);
  reserve(api, lineage);
  const expired = expireLiveTicket(api, lineage);
  assert.equal(ticketExpired(expired), true);

  const second = reserve(api, lineage);
  assert.equal(second.attemptNumber, 2);
  assert.equal(second.ticket.attemptNumber, 2);

  const sweptPath = join(api.layout.ticketsExpired, `${lineage}-1.json`);
  assert.equal(existsSync(sweptPath), true, 'the expired ticket is the record that attempt 1 was reserved');
  assert.equal(JSON.parse(readFileSync(sweptPath, 'utf8')).ticketId, expired.ticketId);
});

test('a tampered live ticket blocks the lineage instead of being repaired', () => {
  const { api } = store();
  const { lineage } = publishable(api);
  const { ticket } = reserve(api, lineage);

  const path = join(api.layout.ticketArtifacts, `${ticket.ticketId.slice('sha256:'.length)}.json`);
  writeFileSync(path, JSON.stringify({ ...ticket, targetNumber: 9999 }));

  assert.throws(() => reserve(api, lineage), (error) =>
    error instanceof StoreError && error.detail.failure === 'tampered-artifact');
  assert.throws(() => api.loadTicket({ lineage }), (error) =>
    error instanceof StoreError && error.detail.failure === 'tampered-artifact');
});

// -- consumption ----------------------------------------------------------------------

test('consuming moves the ticket to consumed/ with a stamp, and a second consumption refuses', () => {
  const { api } = store();
  const { lineage } = publishable(api);
  const { ticket } = reserve(api, lineage);

  const consumed = api.consumeTicket({ lineage, ticketId: ticket.ticketId });
  assert.equal(consumed.ticket.ticketId, ticket.ticketId);
  assert.match(consumed.consumedAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.equal(existsSync(join(api.layout.tickets, `${lineage}.json`)), false, 'the live ticket is spent');
  const record = JSON.parse(readFileSync(join(api.layout.ticketsConsumed, `${lineage}-1.json`), 'utf8'));
  assert.equal(record.ticketId, ticket.ticketId);
  assert.equal(record.consumedAt, consumed.consumedAt);
  assert.equal(ticketIntact(record), true, 'the consumption stamp does not break the issued identity');

  assert.throws(() => api.consumeTicket({ lineage, ticketId: ticket.ticketId }), (error) =>
    error instanceof StoreError && error.detail.failure === 'no-ticket');
});

test('consuming a ticket other than the live one refuses', () => {
  const { api } = store();
  const { lineage } = publishable(api);
  reserve(api, lineage);

  assert.throws(() => api.consumeTicket({ lineage, ticketId: id('f') }), (error) =>
    error instanceof StoreError && error.detail.failure === 'ticket-mismatch');
});

// -- recordAttempt hardening ----------------------------------------------------------

test('REGRESSION: a duplicate attempt number is refused, never silently overwritten', () => {
  const { api } = store();
  const { lineage, receipt } = publishable(api);
  const { ticket } = reserve(api, lineage);
  api.consumeTicket({ lineage, ticketId: ticket.ticketId });
  const evidenceId = api.status(lineage).evidenceId;

  const first = attemptFor({ attemptNumber: 1, receiptId: receipt.receiptId, evidenceId, outcome: 'failed' });
  api.recordAttempt({ lineage, attempt: first });

  const rewrite = attemptFor({ attemptNumber: 1, receiptId: receipt.receiptId, evidenceId, outcome: 'published' });
  assert.throws(() => api.recordAttempt({ lineage, attempt: rewrite }), (error) =>
    error instanceof StoreError && error.detail.failure === 'attempt-already-recorded');

  const [kept] = api.listAttempts(lineage);
  assert.equal(kept.outcome, 'failed', 'history stands; the rewrite never landed');
});

test('REGRESSION: an attempt that does not match its own attemptId is refused as tampered', () => {
  const { api } = store();
  const { lineage, receipt } = publishable(api);
  const { ticket } = reserve(api, lineage);
  api.consumeTicket({ lineage, ticketId: ticket.ticketId });

  const honest = attemptFor({ attemptNumber: 1, receiptId: receipt.receiptId, evidenceId: api.status(lineage).evidenceId });
  assert.equal(attemptIntact(honest), true);
  const tampered = { ...honest, outcome: 'failed' };
  assert.equal(attemptIntact(tampered), false);

  assert.throws(() => api.recordAttempt({ lineage, attempt: tampered }), (error) =>
    error instanceof StoreError && error.detail.failure === 'tampered-attempt');
  assert.deepEqual(api.listAttempts(lineage), [], 'nothing was written');
});
