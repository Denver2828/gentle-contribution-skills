// Publication-specific receipts: the binding lives in the receipt, the ticket
// derives from it, re-authorization supersedes, and 1.0.0 receipts remain
// readable history that authorizes nothing further.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore, StoreError } from '../lib/store/store.mjs';
import { writeAtomic } from '../lib/store/atomic.mjs';
import { authorize, receiptIntact, publicationBindingProblems, PUBLICATION_OPERATIONS, AUTHORIZATION_VERSION } from '../lib/authorization.mjs';
import { TICKET_OPERATIONS, ticketOf, bodyDigest } from '../lib/ticket.mjs';
import { validateAuthorization, validateTicket } from '../lib/validate.mjs';
import { buildEvidence } from '../lib/evidence-record.mjs';
import { REQUIRED_SOURCES, READING, CONTRIBUTION } from '../lib/intake.mjs';
import { STATUS } from '../lib/status.mjs';
import { digest } from '../lib/canonical.mjs';
import { completeCoverage, auditorResult, TASK_CONTRACT } from './helpers/documents.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'audit-binding-'));
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

const BODY = 'el cuerpo exacto\n';
const BINDING = { operation: 'issue-comment', targetRepo: REPO, targetNumber: 3297, bodySha256: bodyDigest(BODY), titleSha256: null };

/** Frozen, audited PASS, evidence recorded: ready to authorize. */
function ready(api, lineage = `b-${sequence += 1}`) {
  const frozen = api.freeze({ lineage, candidateId: CANDIDATE, ...FREEZE, draftBodySha256: BINDING.bodySha256 });
  api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'PASS') });
  api.recordEvidence({ lineage, evidence: evidenceFor() });
  return lineage;
}

/** A handcrafted 1.0.0 receipt -- what the store minted before the binding existed. */
function legacyReceiptFor(evidence) {
  const bound = {
    authorizationVersion: '1.0.0',
    kind: 'content-addressed-receipt',
    notASignature: 'This is a content-addressed receipt, not a cryptographic signature.',
    gate: evidence.gate,
    evidenceId: evidence.evidenceId,
    candidateId: evidence.candidate.candidateId,
    decisionId: evidence.binding.decisionId,
    snapshotHash: evidence.binding.snapshotHash,
    policyHash: evidence.binding.policyHash,
    toolVersion: evidence.binding.toolVersion,
    artifacts: [],
  };
  return { ...bound, receiptId: digest(bound) };
}

/**
 * Rewrite a lineage's current receipt to a 1.0.0 one, the way a store written
 * before this contract holds them: the artifact exists, the index points at
 * it, and no publication binding exists anywhere.
 */
function downgradeToLegacy(api, lineage) {
  const legacy = legacyReceiptFor(evidenceFor());
  writeFileSync(join(api.layout.authorizations, `${legacy.receiptId.slice(7)}.json`), `${JSON.stringify(legacy, null, 2)}\n`);
  const index = JSON.parse(readFileSync(api.layout.index, 'utf8'));
  index.lineages[lineage].receiptId = legacy.receiptId;
  writeFileSync(api.layout.index, `${JSON.stringify(index, null, 2)}\n`);
  return legacy;
}

// -- the receipt carries the binding ---------------------------------------------------

test('the receipt records the publication binding inside the identity, and validates as 1.1.0', () => {
  const { api } = store();
  const lineage = ready(api);
  const { receipt } = api.authorize({ lineage, publication: BINDING });

  assert.equal(receipt.authorizationVersion, AUTHORIZATION_VERSION);
  assert.deepEqual(receipt.publication, { ...BINDING, dependsOn: [] });
  assert.equal(validateAuthorization(receipt).valid, true);
  assert.equal(receiptIntact(receipt), true);
  // The binding sits BEFORE the id: editing it breaks the receipt's own id,
  // which is what makes one signature over receiptId cover the target.
  assert.equal(receiptIntact({ ...receipt, publication: { ...receipt.publication, targetNumber: 9999 } }), false);
});

test('authorize refuses an absent or incomplete binding at the lib level, listing every problem', () => {
  const evidence = evidenceFor();
  const missing = authorize({ evidence });
  assert.equal(missing.authorized, false);
  assert.match(missing.refusals.join(' '), /names no publication binding/);

  assert.deepEqual(publicationBindingProblems(BINDING), []);
  assert.ok(publicationBindingProblems({ ...BINDING, operation: 'gist-create' }).length > 0);
  assert.deepEqual(TICKET_OPERATIONS, PUBLICATION_OPERATIONS, 'ticket and receipt agree on what can be published');

  // The title rule, per operation: issue-create REQUIRES the hash -- a title
  // outside the binding lets a signed receipt publish under a changed title
  // -- and a comment still binds none.
  const create = { ...BINDING, targetNumber: null, titleSha256: bodyDigest('el titulo\n') };
  assert.deepEqual(publicationBindingProblems({ ...create, operation: 'issue-create' }), []);
  assert.match(publicationBindingProblems({ ...create, operation: 'issue-create', titleSha256: null }).join(' '), /issue-create publishes a title/);
  assert.match(publicationBindingProblems({ ...BINDING, titleSha256: bodyDigest('x') }).join(' '), /binds no title/, 'issue-comment still refuses a title hash');
});

test('REGRESSION: pr-create is retired at every layer, with the reason, never as a generic enum miss', () => {
  // Lib level: a distinct, complete reason naming what full binding requires.
  const attempted = { ...BINDING, operation: 'pr-create', targetNumber: null, titleSha256: bodyDigest('el titulo\n') };
  const problems = publicationBindingProblems(attempted);
  assert.match(problems.join(' '), /pr-create is not supported/);
  assert.match(problems.join(' '), /commits and target branch would sit outside the signature/);
  assert.match(problems.join(' '), /baseRef/, 'the refusal names what full binding will require');
  assert.match(problems.join(' '), /immutable commit identity/);

  // Store level: a DISTINCT failure code, before any receipt exists.
  const { api } = store();
  const lineage = ready(api);
  assert.throws(() => api.authorize({ lineage, publication: attempted }), (error) =>
    error instanceof StoreError && error.detail.failure === 'operation-unsupported'
    && /cannot be fully bound/.test(error.message));
  assert.equal(api.status(lineage).receiptId, null, 'no receipt was minted');

  // Schema level: both documents reject the enum value outright.
  const ticket = ticketOf({
    lineage: 'x', candidateId: CANDIDATE, receiptId: id('a'), evidenceId: id('b'), attemptNumber: 1,
    operation: 'pr-create', targetRepo: REPO, targetNumber: null,
    bodySha256: id('d'), titleSha256: id('e'), sessionId: null, issuedAt: new Date().toISOString(),
  });
  assert.equal(validateTicket(ticket).valid, false, 'ticket.v1.json rejects pr-create');

  const granted = authorize({ evidence: evidenceFor(), publication: BINDING });
  const { receiptId, ...bound } = granted.receipt;
  const forged = { ...bound, publication: { ...bound.publication, operation: 'pr-create' } };
  const document = { ...forged, receiptId: digest(forged) };
  assert.equal(validateAuthorization(document).valid, false, 'authorization.v1.1.json rejects pr-create');
});

test('the two-phase authorize writes a pending-signature request naming the receiptId', () => {
  const { api } = store();
  const lineage = ready(api);
  const { receipt, pendingSignature, signatureAttached } = api.authorize({ lineage, publication: BINDING });

  assert.equal(signatureAttached, false, 'the receipt exists and is unsigned');
  assert.equal(pendingSignature.receiptId, receipt.receiptId);
  const onDisk = JSON.parse(readFileSync(join(api.layout.pendingSignature, `${lineage}.json`), 'utf8'));
  assert.equal(onDisk.receiptId, receipt.receiptId);
  assert.equal(onDisk.lineage, lineage);
});

// -- the ticket derives from the receipt ------------------------------------------------

test('the ticket copies the receipt binding field for field; the reserver has no say', () => {
  const { api } = store();
  const lineage = ready(api);
  const { receipt } = api.authorize({ lineage, publication: BINDING });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  const { ticket } = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });

  assert.deepEqual(
    {
      operation: ticket.operation, targetRepo: ticket.targetRepo,
      targetNumber: ticket.targetNumber, bodySha256: ticket.bodySha256, titleSha256: ticket.titleSha256,
      dependsOn: ticket.dependsOn,
    },
    receipt.publication
  );
  assert.equal(ticket.receiptId, receipt.receiptId);
});

// -- re-authorization supersedes ---------------------------------------------------------

test('re-authorizing to a different target replaces the receipt, archives the old one and supersedes the ticket', () => {
  const { api } = store();
  const lineage = ready(api);
  const first = api.authorize({ lineage, publication: BINDING });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });

  const firstReceiptFile = join(api.layout.authorizations, `${first.receipt.receiptId.slice(7)}.json`);
  const firstBytes = readFileSync(firstReceiptFile, 'utf8');

  // The same candidate, aimed at a different issue: a NEW authorization.
  const second = api.authorize({ lineage, publication: { ...BINDING, targetNumber: 3300 } });

  assert.notEqual(second.receipt.receiptId, first.receipt.receiptId, 'a different target is a different receiptId');
  assert.equal(second.state, 'AUTHORIZED', 'the lineage resets to AUTHORIZED');
  assert.equal(second.signatureAttached, false, 'a new receipt needs a new signature');

  // The old receipt is archived byte-identical, never edited, never deleted.
  assert.equal(existsSync(firstReceiptFile), false);
  const archived = join(api.layout.authorizationsSuperseded, `${first.receipt.receiptId.slice(7)}.json`);
  assert.equal(readFileSync(archived, 'utf8'), firstBytes, 'archived untouched');

  // The live ticket derived from the old receipt is superseded, not left live.
  assert.equal(existsSync(join(api.layout.tickets, `${lineage}.json`)), false);
  const superseded = JSON.parse(readFileSync(join(api.layout.ticketsSuperseded, `${lineage}-1.json`), 'utf8'));
  assert.equal(superseded.receiptId, first.receipt.receiptId);

  // The pending request now names the new receipt.
  const pending = JSON.parse(readFileSync(join(api.layout.pendingSignature, `${lineage}.json`), 'utf8'));
  assert.equal(pending.receiptId, second.receipt.receiptId);

  // And the forward path works against the new receipt.
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  const { ticket } = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
  assert.equal(ticket.targetNumber, 3300);
  assert.equal(ticket.receiptId, second.receipt.receiptId);
});

test('attempts recorded under the old receipt keep referring to it; history is never rewritten', () => {
  const { api } = store();
  const lineage = ready(api);
  const first = api.authorize({ lineage, publication: BINDING });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  const { ticket } = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
  api.consumeTicket({ lineage, ticketId: ticket.ticketId });

  const evidenceId = api.status(lineage).evidenceId;
  const record = {
    attemptVersion: '1.0.0', attemptNumber: 1, receiptId: first.receipt.receiptId, evidenceId,
    candidateId: CANDIDATE, outcome: 'failed', reason: 'gh exited 1', detail: {}, publisher: { module: 'fake' },
  };
  const attempt = { ...record, attemptId: digest(record) };
  api.recordAttempt({ lineage, attempt });
  const attemptPath = join(api.layout.attempts, first.receipt.receiptId.slice(7), '001.json');
  const attemptBytes = readFileSync(attemptPath, 'utf8');

  api.authorize({ lineage, publication: { ...BINDING, targetNumber: 3300 } });

  assert.equal(readFileSync(attemptPath, 'utf8'), attemptBytes, 'the attempt file is byte-identical');
  assert.equal(JSON.parse(attemptBytes).receiptId, first.receipt.receiptId, 'and still names the old receipt');
});

// -- 1.0.0 receipts: readable history, no forward permission -----------------------------

test('a 1.0.0 receipt still validates against its own schema', () => {
  const legacy = legacyReceiptFor(evidenceFor());
  assert.equal(validateAuthorization(legacy).valid, true);
  assert.equal(receiptIntact(legacy), true);
  const unknownVersion = { ...legacy, authorizationVersion: '9.9.9' };
  assert.equal(validateAuthorization(unknownVersion).valid, false, 'an unknown version satisfies neither schema');
});

test('REGRESSION: gate-publish refuses a bindingless receipt, naming re-authorization as the way through', () => {
  const { api } = store();
  const lineage = ready(api);
  api.authorize({ lineage, publication: BINDING });
  downgradeToLegacy(api, lineage);

  assert.throws(() => api.gatePublish({ lineage, currentCandidateId: CANDIDATE }), (error) =>
    error instanceof StoreError
    && error.detail.failure === 'bindingless-receipt'
    && /re-authorize with the publication binding/.test(error.message));
});

test('REGRESSION: reserve-attempt refuses a bindingless receipt and burns no attempt number', () => {
  const { api } = store();
  const lineage = ready(api);
  api.authorize({ lineage, publication: BINDING });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  downgradeToLegacy(api, lineage);

  assert.throws(() => api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE }), (error) =>
    error instanceof StoreError && error.detail.failure === 'bindingless-receipt');
  assert.equal(api.status(lineage).attempts, 0);
});

test('attempts recorded under a 1.0.0 receipt remain listable', () => {
  const { api } = store();
  const lineage = ready(api);
  api.authorize({ lineage, publication: BINDING });
  const legacy = downgradeToLegacy(api, lineage);

  // History the old machine wrote: one attempt under the legacy receipt.
  const record = {
    attemptVersion: '1.0.0', attemptNumber: 1, receiptId: legacy.receiptId, evidenceId: api.status(lineage).evidenceId,
    candidateId: CANDIDATE, outcome: 'published', reason: 'published under the old contract', detail: {}, publisher: { module: 'fake' },
  };
  writeAtomic(
    join(api.layout.attempts, legacy.receiptId.slice(7), '001.json'),
    `${JSON.stringify({ ...record, attemptId: digest(record) }, null, 2)}\n`
  );

  const attempts = api.listAttempts(lineage);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].receiptId, legacy.receiptId);
});

test('a bindingless lineage can re-authorize with a binding, which is the named way through', () => {
  const { api } = store();
  const lineage = ready(api);
  api.authorize({ lineage, publication: BINDING });
  downgradeToLegacy(api, lineage);

  const again = api.authorize({ lineage, publication: BINDING });
  assert.deepEqual(again.receipt.publication, { ...BINDING, dependsOn: [] });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  const { ticket } = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
  assert.equal(ticket.receiptId, again.receipt.receiptId);
});
