// Retirement: the store learns to close.
//
// Before this transition existed no command could end a lineage. AUTHORIZED
// kept a live unsigned receipt forever, PUBLISHABLE was not terminal (a
// second reserve-attempt minted attempt 2), and STALE was reachable only
// through a candidate mismatch. These tests pin the closure: RETIRED is
// terminal, the receipt is archived and no longer spendable, and every forward
// path -- store, ledger, publisher -- refuses with one typed reason naming the
// retirement.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { openStore, StoreError, RETIRABLE_STATES } from '../lib/store/store.mjs';
import { ticketOf, bodyDigest, TICKET_TTL_MS } from '../lib/ticket.mjs';
import { retirementOf, retirementIntact, RETIREMENT_VERSION } from '../lib/retirement.mjs';
import { validateRetirement } from '../lib/validate.mjs';
import { publishWithTicket } from '../bin/publish.mjs';
import { buildEvidence } from '../lib/evidence-record.mjs';
import { REQUIRED_SOURCES, READING, CONTRIBUTION } from '../lib/intake.mjs';
import { STATUS } from '../lib/status.mjs';
import { digest } from '../lib/canonical.mjs';
import { completeCoverage, auditorResult, TASK_CONTRACT } from './helpers/documents.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER = resolve(HERE, '..', '..', '..', 'skills', 'gentle-ai-aporte', 'scripts', 'ledger.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'audit-retire-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;
const store = () => {
  const root = mkdtempSync(join(scratch, 'store-'));
  return { root, api: openStore({ override: root, allowOutsideWorkspace: true, lockOptions: { waitMs: 4000 } }) };
};

const id = (character) => `sha256:${character.repeat(64)}`;
const CANDIDATE = id('c');
const REPO = 'Gentleman-Programming/gentle-ai';

const INTAKE = {
  repository: REPO,
  contributionType: CONTRIBUTION.ISSUE,
  readings: REQUIRED_SOURCES.map((source) => ({
    source, command: `${source} --repo ${REPO}`, result: READING.COMPLETE, matches: 0, reviewed: false, coverage: completeCoverage({ source }),
  })),
  competing: [],
};

const FREEZE = {
  baseTree: 'ab933c1c', candidateTree: '4daf0098',
  pathsDigest: id('1'), draftDigest: id('2'), policyDigest: id('3'), testManifestDigest: id('4'),
  taskContract: TASK_CONTRACT,
  intake: INTAKE,
};

const evidenceFor = () => buildEvidence({
  result: {
    gate: 'preflight',
    status: STATUS.PASS,
    binding: { snapshotHash: id('5'), snapshotHashAfter: id('5'), stable: true, policyHash: id('7'), toolVersion: '0.1.0', decisionId: id('9') },
    summary: { pass: 1, fail: 0, unknown: 0, notRun: 0 },
    checks: [{ id: 'a.one', status: STATUS.PASS, required: true, reason: 'ok' }],
  },
  candidate: { status: STATUS.PASS, candidateId: CANDIDATE, reason: 'identified' },
});

const BODY = 'cuerpo que quedo superado\n';
const BINDING = { operation: 'issue-comment', targetRepo: REPO, targetNumber: 3900, bodySha256: bodyDigest(BODY), titleSha256: null };
const REASON = 'Superseded body: the comment was rewritten under another lineage and this one must never be published.';

const attemptFor = ({ attemptNumber, receiptId, evidenceId, outcome = 'published' }) => {
  const record = {
    attemptVersion: '1.0.0', attemptNumber, receiptId, evidenceId, candidateId: CANDIDATE,
    outcome, reason: `attempt ${attemptNumber}`, detail: {}, publisher: { module: 'fake' },
  };
  return { ...record, attemptId: digest(record) };
};

const failure = (code) => (error) => error instanceof StoreError && error.detail.failure === code;

/** Frozen, audited PASS, evidence recorded. */
function audited(api, lineage = `r-${sequence += 1}`) {
  const frozen = api.freeze({ lineage, candidateId: CANDIDATE, ...FREEZE, draftBodySha256: BINDING.bodySha256 });
  api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'PASS') });
  api.recordEvidence({ lineage, evidence: evidenceFor() });
  return { lineage, frozen };
}

/** ...and authorized, the shape of the three real lineages that motivated this. */
function authorized(api, lineage) {
  const ready = audited(api, lineage);
  const { receipt } = api.authorize({ lineage: ready.lineage, publication: BINDING });
  return { ...ready, receipt };
}

/** ...and PUBLISHABLE with attempt 1 reserved, consumed and recorded. */
function publishedOnce(api, lineage) {
  const ready = authorized(api, lineage);
  api.gatePublish({ lineage: ready.lineage, currentCandidateId: CANDIDATE });
  const { ticket } = api.reserveAttempt({ lineage: ready.lineage, currentCandidateId: CANDIDATE });
  api.consumeTicket({ lineage: ready.lineage, ticketId: ticket.ticketId });
  api.recordAttempt({ lineage: ready.lineage, attempt: attemptFor({ attemptNumber: 1, receiptId: ready.receipt.receiptId, evidenceId: api.status(ready.lineage).evidenceId }) });
  return ready;
}

const receiptFile = (api, receiptId) => `${receiptId.slice('sha256:'.length)}.json`;

// -- the artifact ---------------------------------------------------------------------

test('a retirement record is content-addressed and validates against its schema', () => {
  const retirement = retirementOf({
    lineage: 'comment-3900-full', retiredAt: '2026-09-03T10:00:00.000Z', reason: REASON, supersededBy: 'comment-3900-b',
    priorState: 'AUTHORIZED', receiptId: id('a'), ticketId: null, attempts: 0,
  });
  assert.equal(retirement.retirementVersion, RETIREMENT_VERSION);
  assert.equal(validateRetirement(retirement).valid, true, JSON.stringify(validateRetirement(retirement).errors));
  assert.equal(retirementIntact(retirement), true);
  const { retirementId, ...rest } = retirement;
  assert.equal(retirementId, digest(rest), 'the id is the digest of everything else, in the idiom every other artifact uses');
  assert.equal(retirementIntact({ ...retirement, reason: 'edited' }), false);

  for (const [label, broken] of Object.entries({
    'empty reason': { ...retirement, reason: '' },
    'terminal prior state': { ...retirement, priorState: 'STALE' },
    'already retired prior state': { ...retirement, priorState: 'RETIRED' },
    'negative attempts': { ...retirement, attempts: -1 },
    'extra property': { ...retirement, note: 'x' },
    'other version': { ...retirement, retirementVersion: '2.0.0' },
  })) {
    assert.equal(validateRetirement(broken).valid, false, label);
  }
});

// -- retire from AUTHORIZED: the motivating case ----------------------------------------

test('retire from AUTHORIZED archives the receipt, keeps it for history, and blocks every forward path', () => {
  const { api } = store();
  const { lineage, receipt } = authorized(api, 'comment-3900-full');
  const livePath = join(api.layout.authorizations, receiptFile(api, receipt.receiptId));
  const receiptBytes = readFileSync(livePath, 'utf8');
  assert.equal(existsSync(join(api.layout.pendingSignature, `${lineage}.json`)), true, 'an unsigned receipt has a live signer request');

  const outcome = api.retire({ lineage, reason: REASON });
  assert.equal(outcome.state, 'RETIRED');
  assert.match(outcome.retirementId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(outcome.retirement.priorState, 'AUTHORIZED');
  assert.equal(outcome.retirement.receiptId, receipt.receiptId);
  assert.equal(outcome.retirement.supersededBy, null);
  assert.equal(outcome.receiptId, receipt.receiptId, 'the receiptId stays on the entry for history');

  // Archived the way re-authorization archives: moved byte-identical, never deleted.
  assert.equal(existsSync(livePath), false, 'the receipt is no longer at its live path');
  const archived = join(api.layout.authorizationsSuperseded, receiptFile(api, receipt.receiptId));
  assert.equal(readFileSync(archived, 'utf8'), receiptBytes, 'archived byte-identical');
  assert.equal(existsSync(join(api.layout.pendingSignature, `${lineage}.json`)), false, 'nothing is left to sign for');

  // The artifact on disk validates, recomputes, and is what the index names.
  const artifactPath = join(api.layout.retirements, `${outcome.retirementId.slice('sha256:'.length)}.json`);
  const stored = JSON.parse(readFileSync(artifactPath, 'utf8'));
  assert.equal(validateRetirement(stored).valid, true);
  assert.equal(retirementIntact(stored), true);
  assert.deepEqual(stored, { ...outcome.retirement });

  // status shows the closure.
  const status = api.status(lineage);
  assert.equal(status.state, 'RETIRED');
  assert.equal(status.retirementId, outcome.retirementId);
  assert.equal(status.retiredAt, outcome.retirement.retiredAt);
  assert.equal(status.supersededBy, null);
  assert.equal(status.retirement.reason, REASON);

  // The forward path is closed, with one typed reason that names the retirement.
  const retired = (error) => error instanceof StoreError
    && error.detail.failure === 'lineage-retired'
    && error.detail.retirementId === outcome.retirementId
    && error.message.includes(outcome.retirementId);
  assert.throws(() => api.gatePublish({ lineage, currentCandidateId: CANDIDATE }), retired, 'gate-publish');
  assert.throws(() => api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE }), retired, 'reserve-attempt');
  assert.throws(() => api.loadTicket({ lineage }), retired, 'load-ticket');
  assert.throws(() => api.consumeTicket({ lineage, ticketId: id('f') }), retired, 'consume-ticket');
  assert.equal(api.status(lineage).state, 'RETIRED', 'and nothing above moved it');
});

test('the publisher refuses a retired lineage before consulting any ticket, even one that somehow exists', () => {
  const { api } = store();
  const { lineage, receipt } = authorized(api, 'comment-4048-win32');
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  // Reserve, then expire the reservation so retire is allowed; then plant a
  // fresh-looking ticket on disk after the retirement, the way a leftover or
  // a hand-written file would appear. It must decide nothing.
  const { ticket } = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
  const { ticketId, issuedAt, expiresAt, ...rest } = ticket;
  const expired = ticketOf({ ...rest, issuedAt: new Date(Date.now() - TICKET_TTL_MS - 60_000).toISOString() });
  const artifact = join(api.layout.ticketArtifacts, `${expired.ticketId.slice('sha256:'.length)}.json`);
  writeFileSync(artifact, `${JSON.stringify(expired, null, 2)}\n`);
  writeFileSync(join(api.layout.tickets, `${lineage}.json`), `${JSON.stringify(expired, null, 2)}\n`);
  const index = JSON.parse(readFileSync(api.layout.index, 'utf8'));
  index.lineages[lineage].ticketId = expired.ticketId;
  writeFileSync(api.layout.index, `${JSON.stringify(index, null, 2)}\n`);

  const outcome = api.retire({ lineage, reason: REASON });
  assert.equal(outcome.retirement.ticketId, expired.ticketId, 'the expired ticket is recorded, not hidden');
  assert.equal(existsSync(join(api.layout.ticketsExpired, `${lineage}-1.json`)), true, 'and swept to expired/, never deleted');
  assert.equal(api.status(lineage).ticketId, null);

  const planted = ticketOf({ ...rest, issuedAt: new Date().toISOString() });
  const plantedText = `${JSON.stringify(planted, null, 2)}\n`;
  writeFileSync(join(api.layout.ticketArtifacts, `${planted.ticketId.slice('sha256:'.length)}.json`), plantedText);
  writeFileSync(join(api.layout.tickets, `${lineage}.json`), plantedText);
  const bodyFile = join(scratch, `body-${lineage}.md`);
  writeFileSync(bodyFile, BODY);

  const result = publishWithTicket({ store: api, lineage, bodyFile, runGh: () => { throw new Error('gh must not be reached'); } });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.refusal.failure, 'lineage-retired');
  assert.equal(result.refusal.retirementId, outcome.retirementId);
  assert.match(result.refusal.message, /nothing was consumed/);
  assert.notEqual(result.code, 0);
  assert.equal(existsSync(join(api.layout.tickets, `${lineage}.json`)), true, 'the planted file was not consumed either');
  assert.deepEqual(api.listAttempts(lineage), [], 'no attempt was recorded');
  assert.equal(receipt.receiptId, api.status(lineage).receiptId);
});

// -- retire from PUBLISHABLE: closing after a real attempt ---------------------------------

test('retire from PUBLISHABLE with attempts=1 leaves the attempt record untouched and refuses a second reserve-attempt', () => {
  const { api } = store();
  const { lineage, receipt } = publishedOnce(api, 'comment-4048-win32-b');
  assert.equal(api.status(lineage).state, 'PUBLISHABLE');
  assert.equal(api.status(lineage).attempts, 1);
  const attemptsDirectory = join(api.layout.attempts, receipt.receiptId.slice('sha256:'.length));
  const attemptBytes = readFileSync(join(attemptsDirectory, '001.json'), 'utf8');

  const outcome = api.retire({ lineage, reason: 'Published once; the thread moved on. Closing so no second attempt can be minted.' });
  assert.equal(outcome.state, 'RETIRED');
  assert.equal(outcome.retirement.priorState, 'PUBLISHABLE');
  assert.equal(outcome.retirement.attempts, 1);
  assert.equal(outcome.attempts, 1);

  assert.throws(() => api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE }), failure('lineage-retired'));
  assert.equal(api.status(lineage).attempts, 1, 'no attempt 2 was minted');
  assert.equal(readFileSync(join(attemptsDirectory, '001.json'), 'utf8'), attemptBytes, 'the attempt record is byte-identical');
  assert.equal(api.listAttempts(lineage).length, 1, 'attempts stay listable after retirement');
});

// -- every other transition refuses on RETIRED ---------------------------------------------

test('every ledger transition refuses a retired lineage with the typed reason naming the retirement id', () => {
  const { api } = store();
  const { lineage, frozen, receipt } = publishedOnce(api);
  const evidenceId = api.status(lineage).evidenceId;
  const { retirementId } = api.retire({ lineage, reason: REASON });

  const transitions = {
    freeze: () => api.freeze({ lineage, candidateId: CANDIDATE, ...FREEZE, draftBodySha256: BINDING.bodySha256 }),
    refreeze: () => api.refreeze({ lineage, candidateId: id('d'), ...FREEZE, draftBodySha256: BINDING.bodySha256 }),
    'record-audit': () => api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'PASS') }),
    'record-evidence': () => api.recordEvidence({ lineage, evidence: evidenceFor() }),
    authorize: () => api.authorize({ lineage, publication: { ...BINDING, targetNumber: 3901 } }),
    'attach-signature': () => api.attachSignature({ lineage }),
    'gate-publish': () => api.gatePublish({ lineage, currentCandidateId: CANDIDATE }),
    'reserve-attempt': () => api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE }),
    'record-attempt': () => api.recordAttempt({ lineage, attempt: attemptFor({ attemptNumber: 1, receiptId: receipt.receiptId, evidenceId, outcome: 'failed' }) }),
    'reserve-correction': () => api.reserveCorrection({ lineage }),
    retire: () => api.retire({ lineage, reason: 'again' }),
  };

  const before = readFileSync(api.layout.index, 'utf8');
  for (const [operation, attempt] of Object.entries(transitions)) {
    assert.throws(attempt, (error) => error instanceof StoreError
      && error.detail.failure === 'lineage-retired'
      && error.detail.retirementId === retirementId
      && error.message.includes(retirementId), operation);
  }
  assert.equal(readFileSync(api.layout.index, 'utf8'), before, 'a refusal on RETIRED writes nothing');
  assert.equal(api.status(lineage).state, 'RETIRED');
});

// -- refusals of the retirement itself -----------------------------------------------------

test('retire refuses while a live ticket exists, and the ticket stays live', () => {
  const { api } = store();
  const { lineage } = authorized(api);
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  const { ticket } = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });

  assert.throws(() => api.retire({ lineage, reason: REASON }), (error) =>
    error instanceof StoreError && error.detail.failure === 'ticket-pending' && error.detail.ticketId === ticket.ticketId);
  assert.equal(api.status(lineage).state, 'PUBLISHABLE');
  assert.equal(api.loadTicket({ lineage }).ticket.ticketId, ticket.ticketId, 'the ticket was not voided');
  assert.equal(existsSync(api.layout.retirements) && readdirSync(api.layout.retirements).length > 0, false, 'no retirement artifact was written');

  // Spent, the lineage closes.
  api.consumeTicket({ lineage, ticketId: ticket.ticketId });
  assert.equal(api.retire({ lineage, reason: REASON }).state, 'RETIRED');
});

test('retire refuses from STALE and from RETIRED, each with its own typed reason', () => {
  const { api } = store();
  const stale = authorized(api, 'went-stale');
  assert.throws(() => api.gatePublish({ lineage: stale.lineage, currentCandidateId: id('b') }), failure('stale-candidate'));
  assert.equal(api.status(stale.lineage).state, 'STALE');
  assert.throws(() => api.retire({ lineage: stale.lineage, reason: REASON }), (error) =>
    error instanceof StoreError && error.detail.failure === 'illegal-transition' && error.detail.state === 'STALE' && error.detail.operation === 'retire');
  assert.equal(api.status(stale.lineage).state, 'STALE');

  const closed = audited(api, 'closed-once');
  const first = api.retire({ lineage: closed.lineage, reason: REASON });
  assert.throws(() => api.retire({ lineage: closed.lineage, reason: 'once more' }), (error) =>
    error instanceof StoreError && error.detail.failure === 'lineage-retired' && error.detail.retirementId === first.retirementId);
  assert.equal(api.status(closed.lineage).retirementId, first.retirementId, 'the first retirement stands');
  assert.equal(readdirSync(api.layout.retirements).length, 1, 'and no second record exists');
});

test('retire refuses an unknown or self-referencing --superseded-by, and records a real successor', () => {
  const { api } = store();
  const { lineage } = authorized(api, 'comment-3900-full');

  assert.throws(() => api.retire({ lineage, reason: REASON, supersededBy: 'comment-3900-b' }), (error) =>
    error instanceof StoreError && error.detail.failure === 'superseded-by-unknown' && error.detail.supersededBy === 'comment-3900-b');
  assert.throws(() => api.retire({ lineage, reason: REASON, supersededBy: lineage }), failure('superseded-by-self'));
  assert.equal(api.status(lineage).state, 'AUTHORIZED', 'neither refusal moved the lineage');

  api.freeze({ lineage: 'comment-3900-b', candidateId: id('e'), ...FREEZE, draftBodySha256: BINDING.bodySha256 });
  const outcome = api.retire({ lineage, reason: REASON, supersededBy: 'comment-3900-b' });
  assert.equal(outcome.retirement.supersededBy, 'comment-3900-b');
  assert.equal(api.status(lineage).supersededBy, 'comment-3900-b');
  assert.equal(api.status('comment-3900-b').state, 'FROZEN', 'the successor is untouched');
});

test('a missing or empty reason refuses before anything is written', () => {
  const { api } = store();
  const { lineage } = audited(api);
  const before = readFileSync(api.layout.index, 'utf8');
  for (const reason of [undefined, null, '', '   \n\n', '\uFEFF\r\n', 7]) {
    assert.throws(() => api.retire({ lineage, reason }), failure('retire-reason-missing'), JSON.stringify(reason));
  }
  assert.equal(readFileSync(api.layout.index, 'utf8'), before);
  assert.equal(existsSync(api.layout.retirements), false, 'no retirements directory was even created');
});

test('the reason is canonicalized like a body: BOM stripped, CRLF folded, trailing newlines dropped', () => {
  const { api } = store();
  const { lineage } = audited(api);
  const { retirement } = api.retire({ lineage, reason: '\uFEFFsuperseded\r\nby another lineage\r\n\r\n' });
  assert.equal(retirement.reason, 'superseded\nby another lineage');
});

test('retire is reachable from every non-terminal state the machine names', () => {
  assert.deepEqual([...RETIRABLE_STATES].sort(), [
    'AUDITED_PASS', 'AUTHORIZED', 'BLOCKED_INCOMPLETE', 'CORRECTION_RESERVED', 'FROZEN',
    'NEEDS_CHANGES', 'NEEDS_MAINTAINER', 'PUBLISHABLE', 'REAUDITED', 'REFROZEN',
  ]);

  const { api } = store();
  // FROZEN
  const frozen = api.freeze({ lineage: 'from-frozen', candidateId: CANDIDATE, ...FREEZE, draftBodySha256: BINDING.bodySha256 });
  assert.equal(api.retire({ lineage: 'from-frozen', reason: REASON }).retirement.priorState, 'FROZEN');
  // NEEDS_CHANGES -> CORRECTION_RESERVED -> REFROZEN -> NEEDS_MAINTAINER, retiring the last
  const escalated = api.freeze({ lineage: 'from-maintainer', candidateId: CANDIDATE, ...FREEZE, draftBodySha256: BINDING.bodySha256 });
  api.recordAudit({ lineage: 'from-maintainer', result: auditorResult(escalated.subject_id, 'NEEDS_CHANGES') });
  api.reserveCorrection({ lineage: 'from-maintainer' });
  api.refreeze({ lineage: 'from-maintainer', candidateId: id('d'), ...FREEZE, draftBodySha256: BINDING.bodySha256 });
  api.recordAudit({ lineage: 'from-maintainer', result: auditorResult(api.status('from-maintainer').subject_id, 'NEEDS_CHANGES') });
  assert.equal(api.status('from-maintainer').state, 'NEEDS_MAINTAINER');
  const closed = api.retire({ lineage: 'from-maintainer', reason: REASON });
  assert.equal(closed.retirement.priorState, 'NEEDS_MAINTAINER');
  assert.equal(closed.retirement.receiptId, null, 'no receipt was ever issued, and the record says so');
  assert.equal(existsSync(api.layout.authorizationsSuperseded), false, 'nothing to archive, nothing archived');
  assert.notEqual(frozen.subject_id, undefined);
});

test('a tampered retirement record blocks status rather than reading as a clean close', () => {
  const { api } = store();
  const { lineage } = audited(api);
  const { retirementId } = api.retire({ lineage, reason: REASON });
  const path = join(api.layout.retirements, `${retirementId.slice('sha256:'.length)}.json`);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...record, reason: 'rewritten after the fact' }));
  assert.throws(() => api.status(lineage), failure('tampered-artifact'));
});

// -- the CLI boundary ------------------------------------------------------------------------
//
// Only refusals that provably never touch a store are exercised through the
// ledger binary: it opens the workspace store on every operation, and these
// tests must never run against it. Both refusals below happen at argument
// parsing, before any store call.

test('the ledger refuses retire without --reason-file or with an empty one, before any store call', () => {
  const missing = spawnSync(process.execPath, [LEDGER, 'retire', '--lineage', 'never-touched'], { encoding: 'utf8' });
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /^REFUSED: missing --reason-file/m);
  assert.equal(missing.stdout, '');

  const empty = join(scratch, 'empty-reason.txt');
  writeFileSync(empty, '\uFEFF \r\n\n');
  const blank = spawnSync(process.execPath, [LEDGER, 'retire', '--lineage', 'never-touched', '--reason-file', empty], { encoding: 'utf8' });
  assert.equal(blank.status, 1, blank.stdout + blank.stderr);
  assert.match(blank.stderr, /^REFUSED: --reason-file is empty/m);
  assert.equal(blank.stdout, '');

  const argvOnly = spawnSync(process.execPath, [LEDGER, 'retire', '--lineage', 'never-touched', '--reason', 'text in argv is not a file'], { encoding: 'utf8' });
  assert.equal(argvOnly.status, 1);
  assert.match(argvOnly.stderr, /^REFUSED: missing --reason-file/m, 'argv text is never accepted as the reason');
});
