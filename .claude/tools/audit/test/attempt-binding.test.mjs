// ASTRA-03: an attempt record is bound to the lineage's candidate, evidence
// and a CONFIRMED ticket consumption.
//
// Before this binding, `recordAttempt` checked only that the attempt named the
// current receiptId and an issued attempt number. A schema-valid, self-
// consistent report naming a foreign candidateId and evidenceId was accepted;
// so was one whose ticket was still live, or whose consumption had only been
// PREPARED (the consumed/ artifact written, the index never committed). Any
// of those, with outcome `published` and `bodyIdentical: true`, satisfied
// another lineage's publication dependency and let it reach the publisher.
//
// Consumption is confirmed by the INDEX, never by a file: the store prepares
// tickets/consumed/<lineage>-<n>.json before the manifest write, so a failure
// between the two leaves the artifact on disk without a consumption having
// happened. `consumedAttempts` on the lineage entry is written in the same
// transaction as the consumption, and it is the only thing recordAttempt
// believes.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore, StoreError } from '../lib/store/store.mjs';
import { writeAtomic } from '../lib/store/atomic.mjs';
import { bodyDigest } from '../lib/ticket.mjs';
import { buildEvidence } from '../lib/evidence-record.mjs';
import { digest } from '../lib/canonical.mjs';
import { REQUIRED_SOURCES, READING, CONTRIBUTION } from '../lib/intake.mjs';
import { STATUS } from '../lib/status.mjs';
import { completeCoverage, auditorResult, TASK_CONTRACT } from './helpers/documents.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'audit-attempt-binding-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const id = (character) => `sha256:${character.repeat(64)}`;
const CANDIDATE = id('c');
const REPO = 'Gentleman-Programming/gentle-ai';
const NOTE_BODY = 'Nota sobre el caso j97.\n';
const WITHDRAW_BODY = 'Retiro este aporte; deje una nota en #4078.\n';

const INTAKE = {
  repository: REPO,
  contributionType: CONTRIBUTION.ISSUE,
  readings: REQUIRED_SOURCES.map((source) => ({
    source, command: `${source} --repo ${REPO}`, result: READING.COMPLETE, matches: 0, reviewed: false, coverage: completeCoverage({ source }),
  })),
  competing: [],
};

function faultableStore() {
  const fault = { armed: false };
  const api = openStore({
    override: mkdtempSync(join(scratch, 'store-')), allowOutsideWorkspace: true, lockOptions: { waitMs: 4000 },
    writer: (path, text) => { if (fault.armed) throw new Error('the write boundary was faulted'); return writeAtomic(path, text); },
  });
  return { api, fault };
}
const store = () => faultableStore().api;

const evidenceFor = () => buildEvidence({
  result: {
    gate: 'preflight', status: STATUS.PASS,
    binding: { snapshotHash: id('5'), snapshotHashAfter: id('5'), stable: true, policyHash: id('7'), toolVersion: '0.1.0', decisionId: id('9') },
    summary: { pass: 1, fail: 0, unknown: 0, notRun: 0 },
    checks: [{ id: 'a.one', status: STATUS.PASS, required: true, reason: 'ok' }],
  },
  candidate: { status: STATUS.PASS, candidateId: CANDIDATE, reason: 'identified' },
});

const binding = (body, targetNumber, dependsOn = []) => ({ operation: 'issue-comment', targetRepo: REPO, targetNumber, bodySha256: bodyDigest(body), titleSha256: null, dependsOn });

function audited(api, lineage, body) {
  const frozen = api.freeze({
    lineage, candidateId: CANDIDATE, intake: INTAKE, taskContract: TASK_CONTRACT,
    baseTree: 'ab933c1c', candidateTree: '4daf0098',
    pathsDigest: id('1'), draftDigest: id('2'), policyDigest: id('3'), testManifestDigest: id('4'),
    draftBodySha256: bodyDigest(body),
  });
  api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'PASS') });
  api.recordEvidence({ lineage, evidence: evidenceFor() });
  return lineage;
}

/** An attempt built the way the publishers build one: the id is the digest of the rest. */
function attemptFor({ attemptNumber, receiptId, evidenceId, candidateId = CANDIDATE, outcome = 'published', bodyIdentical = true, module = 'manual-report' }) {
  const record = {
    attemptVersion: '1.0.0', attemptNumber, receiptId, evidenceId, candidateId,
    outcome, reason: `attempt ${attemptNumber}`, detail: { bodyIdentical }, publisher: { module },
  };
  return { ...record, attemptId: digest(record) };
}

/**
 * The motivating pair, reserved: `note` is PUBLISHABLE with a live ticket for
 * attempt 1, and `withdraw` depends on it. `before` is the dependent's refusal.
 */
function reservedPair(api) {
  const note = audited(api, 'comment-4078-j97', NOTE_BODY);
  const receipt = api.authorize({ lineage: note, publication: binding(NOTE_BODY, 4078) }).receipt;
  const withdraw = audited(api, 'comment-3262-withdraw', WITHDRAW_BODY);
  api.authorize({ lineage: withdraw, publication: binding(WITHDRAW_BODY, 3262, [note]) });
  api.gatePublish({ lineage: note, currentCandidateId: CANDIDATE });
  const before = gateOutcome(api, withdraw);
  const reserved = api.reserveAttempt({ lineage: note, currentCandidateId: CANDIDATE });
  return { note, withdraw, receipt, ticket: reserved.ticket, attemptNumber: reserved.attemptNumber, before };
}

function gateOutcome(api, lineage) {
  try { return api.gatePublish({ lineage, currentCandidateId: CANDIDATE }).state; } catch (error) {
    if (error instanceof StoreError) return error.detail.failure;
    throw error;
  }
}

const refusal = (failure) => (error) => error instanceof StoreError && error.detail?.failure === failure;
const attemptsOnDisk = (api, receiptId) => {
  const directory = join(api.layout.attempts, receiptId.slice('sha256:'.length));
  return existsSync(directory) ? readdirSync(directory) : [];
};
const consistent = (ticket, overrides = {}) => attemptFor({ attemptNumber: ticket.attemptNumber, receiptId: ticket.receiptId, evidenceId: ticket.evidenceId, candidateId: ticket.candidateId, ...overrides });
const numbers = (api, lineage) => (api.status(lineage).consumedAttempts ?? []).map((consumption) => consumption.attemptNumber);
/** Evidence for the same candidate, decision and snapshot, but a different record (a re-run). */
const rerunEvidence = () => buildEvidence({
  result: {
    gate: 'preflight', status: STATUS.PASS,
    binding: { snapshotHash: id('5'), snapshotHashAfter: id('5'), stable: true, policyHash: id('7'), toolVersion: '0.1.0', decisionId: id('9') },
    summary: { pass: 1, fail: 0, unknown: 0, notRun: 0 },
    checks: [{ id: 'a.one', status: STATUS.PASS, required: true, reason: 're-run after consumption' }],
  },
  candidate: { status: STATUS.PASS, candidateId: CANDIDATE, reason: 'identified' },
});

// -- control: the legitimate manual path ---------------------------------------------------

test('CONTROL: an attempt with the ticket ids, recorded after a confirmed consumption, is accepted and satisfies the dependency', () => {
  const api = store();
  const { note, withdraw, ticket, before } = reservedPair(api);
  assert.equal(before, 'dependency-unpublished');

  api.consumeTicket({ lineage: note, ticketId: ticket.ticketId });
  // The confirmation carries the ticket's immutable identity, not just the number.
  assert.deepEqual(api.status(note).consumedAttempts, [{
    attemptNumber: 1, ticketId: ticket.ticketId, receiptId: ticket.receiptId, candidateId: ticket.candidateId, evidenceId: ticket.evidenceId,
  }], 'the index records the confirmed consumption bound to the ticket and its authorization');

  api.recordAttempt({ lineage: note, attempt: consistent(ticket) });
  assert.equal(api.listAttempts(note).length, 1);
  assert.equal(gateOutcome(api, withdraw), 'PUBLISHABLE');
});

test('CONTROL: a failed attempt under a consumed ticket is recorded too; only published+bodyIdentical satisfies', () => {
  const api = store();
  const { note, withdraw, ticket } = reservedPair(api);
  api.consumeTicket({ lineage: note, ticketId: ticket.ticketId });
  api.recordAttempt({ lineage: note, attempt: consistent(ticket, { outcome: 'failed', bodyIdentical: null }) });
  assert.equal(api.listAttempts(note)[0].outcome, 'failed');
  assert.equal(gateOutcome(api, withdraw), 'dependency-unpublished');
});

// -- regression: foreign identities, ticket properly consumed -----------------------------------

test('REGRESSION (ASTRA-03): foreign candidateId and evidenceId are refused even after a confirmed consumption', () => {
  const api = store();
  const { note, withdraw, receipt, ticket } = reservedPair(api);
  api.consumeTicket({ lineage: note, ticketId: ticket.ticketId });

  // Judge A's exact shape: a self-consistent report for a different candidate and evidence.
  const foreign = attemptFor({ attemptNumber: 1, receiptId: receipt.receiptId, evidenceId: id('a'), candidateId: id('b'), module: 'different-publisher' });
  assert.throws(() => api.recordAttempt({ lineage: note, attempt: foreign }), (error) => {
    assert.equal(error.detail.failure, 'attempt-binding-mismatch');
    assert.equal(error.detail.field, 'candidateId');
    assert.equal(error.detail.expected, CANDIDATE);
    assert.equal(error.detail.found, id('b'));
    return true;
  });
  const wrongEvidence = consistent(ticket, { evidenceId: id('a') });
  assert.throws(() => api.recordAttempt({ lineage: note, attempt: wrongEvidence }), (error) => {
    assert.equal(error.detail.failure, 'attempt-binding-mismatch');
    assert.equal(error.detail.field, 'evidenceId');
    return true;
  });

  assert.deepEqual(attemptsOnDisk(api, receipt.receiptId), [], 'nothing was written');
  assert.equal(gateOutcome(api, withdraw), 'dependency-unpublished', 'the dependency is not satisfied by a foreign record');
  // ...and the number is still free for the honest record.
  api.recordAttempt({ lineage: note, attempt: consistent(ticket) });
  assert.equal(gateOutcome(api, withdraw), 'PUBLISHABLE');
});

// -- regression: correct identities, consumption not confirmed --------------------------------

test('REGRESSION (ASTRA-03): correct ids with a LIVE ticket are refused; the ticket stays live and the dependency unsatisfied', () => {
  const api = store();
  const { note, withdraw, receipt, ticket } = reservedPair(api);

  assert.throws(() => api.recordAttempt({ lineage: note, attempt: consistent(ticket) }), (error) => {
    assert.equal(error.detail.failure, 'attempt-unconsumed');
    assert.equal(error.detail.attemptNumber, 1);
    assert.match(error.detail.remediation, /publish\.mjs/);
    return true;
  });
  assert.equal(api.loadTicket({ lineage: note }).ticket.ticketId, ticket.ticketId, 'the ticket is still live');
  assert.deepEqual(attemptsOnDisk(api, receipt.receiptId), []);
  assert.equal(gateOutcome(api, withdraw), 'dependency-unpublished');
});

test('REGRESSION (ASTRA-03): a consumption that was only PREPARED (artifact on disk, index never committed) does not admit the attempt', () => {
  const { api, fault } = faultableStore();
  const { note, withdraw, receipt, ticket } = reservedPair(api);

  // Fault the index write: the consumed/ artifact is prepared, the manifest is not.
  fault.armed = true;
  assert.throws(() => api.consumeTicket({ lineage: note, ticketId: ticket.ticketId }));
  fault.armed = false;
  const consumedPath = join(api.layout.ticketsConsumed, `${note}-1.json`);
  assert.equal(existsSync(consumedPath), true, 'the prepared artifact really is on disk');
  assert.equal(api.status(note).ticketId, ticket.ticketId, 'the index still names the live ticket');
  assert.deepEqual(api.status(note).consumedAttempts ?? [], [], 'nothing was confirmed');

  assert.throws(() => api.recordAttempt({ lineage: note, attempt: consistent(ticket) }), refusal('attempt-unconsumed'));
  assert.deepEqual(attemptsOnDisk(api, receipt.receiptId), []);
  assert.equal(gateOutcome(api, withdraw), 'dependency-unpublished');

  // Recovery: the real consumption reuses the prepared record and confirms it in the index.
  api.consumeTicket({ lineage: note, ticketId: ticket.ticketId });
  assert.deepEqual(numbers(api, note), [1]);
  api.recordAttempt({ lineage: note, attempt: consistent(ticket) });
  assert.equal(gateOutcome(api, withdraw), 'PUBLISHABLE');
});

// -- history ------------------------------------------------------------------------------

test('HISTORY: attempts already recorded keep counting, and a lineage without consumedAttempts admits no new attempt', () => {
  const api = store();
  const { note, withdraw, ticket } = reservedPair(api);
  api.consumeTicket({ lineage: note, ticketId: ticket.ticketId });
  api.recordAttempt({ lineage: note, attempt: consistent(ticket) });

  // Simulate a store written before the field existed.
  const indexPath = join(api.layout.root, 'store.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  delete index.lineages[note].consumedAttempts;
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  assert.equal(api.listAttempts(note).length, 1, 'history still reads');
  assert.equal(gateOutcome(api, withdraw), 'PUBLISHABLE', 'a dependency satisfied by history stays satisfied');

  // A second reservation and consumption confirm normally from here on.
  api.reserveAttempt({ lineage: withdraw, currentCandidateId: CANDIDATE });
  const second = api.reserveAttempt({ lineage: note, currentCandidateId: CANDIDATE });
  assert.throws(() => api.recordAttempt({ lineage: note, attempt: consistent(second.ticket) }), refusal('attempt-unconsumed'));
  api.consumeTicket({ lineage: note, ticketId: second.ticket.ticketId });
  assert.deepEqual(numbers(api, note), [2]);
  api.recordAttempt({ lineage: note, attempt: consistent(second.ticket) });
  assert.equal(api.listAttempts(note).length, 2);
});

// -- the bindings that were already enforced stay enforced ------------------------------------

test('receipt, issued number and integrity are still checked, and before the new bindings', () => {
  const api = store();
  const { note, receipt, ticket } = reservedPair(api);
  api.consumeTicket({ lineage: note, ticketId: ticket.ticketId });
  assert.throws(() => api.recordAttempt({ lineage: note, attempt: consistent(ticket, { receiptId: id('f') }) }), refusal('receipt-mismatch'));
  assert.throws(() => api.recordAttempt({ lineage: note, attempt: consistent(ticket, { attemptNumber: 2 }) }), refusal('unissued-attempt'));
  assert.throws(() => api.recordAttempt({ lineage: note, attempt: { ...consistent(ticket), outcome: 'failed' } }), refusal('tampered-attempt'));
  assert.deepEqual(attemptsOnDisk(api, receipt.receiptId), []);
});

// -- the consumption is bound to the ticket and its authorization, not to the number ----------
// (Astra escalation of the first candidate, 2026-09-06: a number-only confirmation let a
// consumption under receipt A be reported under receipt B, and compared identities against
// the lineage's CURRENT evidence instead of the ticket's.)

test('REGRESSION (ASTRA-03 v2): a consumption under receipt A cannot be reported under receipt B after re-authorization', () => {
  const api = store();
  const { note, withdraw, receipt: A, ticket } = reservedPair(api);
  api.consumeTicket({ lineage: note, ticketId: ticket.ticketId });

  // Re-authorize to another target: receipt B, lineage back to AUTHORIZED, then PUBLISHABLE.
  const B = api.authorize({ lineage: note, publication: binding(NOTE_BODY, 4079) }).receipt;
  assert.notEqual(B.receiptId, A.receiptId);
  api.gatePublish({ lineage: note, currentCandidateId: CANDIDATE });
  assert.equal(api.status(note).ticketId, null, 'no ticket of B was ever reserved, let alone consumed');

  const underB = consistent(ticket, { receiptId: B.receiptId });
  assert.throws(() => api.recordAttempt({ lineage: note, attempt: underB }), (error) => {
    assert.equal(error.detail.failure, 'attempt-binding-mismatch');
    assert.equal(error.detail.field, 'receiptId');
    assert.equal(error.detail.expected, A.receiptId, 'the consumption belongs to A');
    assert.equal(error.detail.found, B.receiptId);
    return true;
  });
  assert.deepEqual(attemptsOnDisk(api, B.receiptId), []);
  assert.equal(gateOutcome(api, withdraw), 'dependency-unpublished', 'nothing published under the current receipt');
  // The honest record under A is refused too, by the pre-existing rule: attempts refer to the current receipt.
  assert.throws(() => api.recordAttempt({ lineage: note, attempt: consistent(ticket) }), refusal('receipt-mismatch'));
});

test('REGRESSION (ASTRA-03 v2): evidence re-recorded after consumption neither breaks the ticket report nor admits the new evidence', () => {
  const api = store();
  const { note, withdraw, receipt, ticket } = reservedPair(api);
  api.consumeTicket({ lineage: note, ticketId: ticket.ticketId });

  api.recordEvidence({ lineage: note, evidence: rerunEvidence() });
  const current = api.status(note).evidenceId;
  assert.notEqual(current, ticket.evidenceId, 'the lineage now carries evidence the ticket never had');

  // A report carrying the new evidence was never what the ticket reserved: refused.
  assert.throws(() => api.recordAttempt({ lineage: note, attempt: consistent(ticket, { evidenceId: current }) }), (error) => {
    assert.equal(error.detail.failure, 'attempt-binding-mismatch');
    assert.equal(error.detail.field, 'evidenceId');
    assert.equal(error.detail.expected, ticket.evidenceId);
    return true;
  });
  assert.equal(gateOutcome(api, withdraw), 'dependency-unpublished');
  // The legitimate report -- the ticket's own evidence -- is still accepted.
  api.recordAttempt({ lineage: note, attempt: consistent(ticket) });
  assert.equal(api.listAttempts(note)[0].evidenceId, ticket.evidenceId);
  assert.equal(gateOutcome(api, withdraw), 'PUBLISHABLE');
  assert.deepEqual(attemptsOnDisk(api, receipt.receiptId), ['001.json']);
});

test('a consumption record without the ticket binding admits nothing and cannot be persisted', () => {
  const api = store();
  const { note, receipt, ticket } = reservedPair(api);
  api.consumeTicket({ lineage: note, ticketId: ticket.ticketId });
  const indexPath = join(api.layout.root, 'store.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.lineages[note].consumedAttempts = [1];   // the first candidate's number-only shape
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  // Reads do not validate shape (persisted drafts are validated on write), so
  // the number-only entry simply is not a confirmed consumption: fail closed.
  assert.throws(() => api.recordAttempt({ lineage: note, attempt: consistent(ticket) }), refusal('attempt-unconsumed'));
  assert.deepEqual(attemptsOnDisk(api, receipt.receiptId), []);
  // ...and the next transaction that would persist the index refuses it as an invalid draft.
  assert.throws(() => api.reserveAttempt({ lineage: note, currentCandidateId: CANDIDATE }), (error) =>
    error instanceof StoreError && error.detail.failure === 'invalid-draft' && error.detail.field === 'consumedAttempts');
});
