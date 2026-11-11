// Publication dependencies: the store holds the order a body assumes.
//
// Lineage comment-3262-withdraw carried a body saying, in past tense, "I left
// a note on #4078". It was true only once comment-4078-j97 had published, and
// the store had no way to say so: the controller enforced the order by hand
// with a live read before gate-publish, and the auditor could only flag an
// external WARNING. These tests pin the replacement: the receipt declares
// `publication.dependsOn`, the ticket carries it in its id, and gate-publish,
// reserve-attempt, the publisher and consumption all refuse until every
// dependency has a recorded attempt with outcome published and bodyIdentical
// true, and is not retired.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { openStore, StoreError } from '../lib/store/store.mjs';
import { ticketOf, ticketIntact, bodyDigest } from '../lib/ticket.mjs';
import { authorize as issueAuthorization, receiptIntact } from '../lib/authorization.mjs';
import { validateAuthorization, validateTicket } from '../lib/validate.mjs';
import { publishWithTicket } from '../bin/publish.mjs';
import { buildEvidence } from '../lib/evidence-record.mjs';
import { REQUIRED_SOURCES, READING, CONTRIBUTION } from '../lib/intake.mjs';
import { STATUS } from '../lib/status.mjs';
import { digest } from '../lib/canonical.mjs';
import { completeCoverage, auditorResult, TASK_CONTRACT } from './helpers/documents.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER = resolve(HERE, '..', '..', '..', 'skills', 'gentle-ai-aporte', 'scripts', 'ledger.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'audit-dependency-'));
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

const NOTE_BODY = 'Nota sobre el caso j97.\n';
const WITHDRAW_BODY = 'Retiro este aporte; deje una nota en #4078.\n';
const binding = (body, targetNumber) => ({ operation: 'issue-comment', targetRepo: REPO, targetNumber, bodySha256: bodyDigest(body), titleSha256: null });

const failure = (code) => (error) => error instanceof StoreError && error.detail.failure === code;

/** Frozen on `body` (the draft authorize will bind), audited PASS, evidence recorded. */
function audited(api, lineage = `d-${sequence += 1}`, body = 'x\n') {
  const frozen = api.freeze({ lineage, candidateId: CANDIDATE, ...FREEZE, draftBodySha256: bodyDigest(body) });
  api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'PASS') });
  api.recordEvidence({ lineage, evidence: evidenceFor() });
  return lineage;
}

/** An attempt built the way publish.mjs builds one; `bodyIdentical` lives in `detail`. */
function attemptFor({ attemptNumber, receiptId, evidenceId, outcome = 'published', bodyIdentical = true }) {
  const record = {
    attemptVersion: '1.0.0', attemptNumber, receiptId, evidenceId, candidateId: CANDIDATE,
    outcome, reason: `attempt ${attemptNumber}`, detail: { bodyIdentical }, publisher: { module: 'fake' },
  };
  return { ...record, attemptId: digest(record) };
}

/** Reserve, consume and record one attempt for a PUBLISHABLE lineage with the given outcome. */
function recordAttempt(api, lineage, receipt, { outcome = 'published', bodyIdentical = true } = {}) {
  const { ticket, attemptNumber } = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
  api.consumeTicket({ lineage, ticketId: ticket.ticketId });
  api.recordAttempt({ lineage, attempt: attemptFor({ attemptNumber, receiptId: receipt.receiptId, evidenceId: api.status(lineage).evidenceId, outcome, bodyIdentical }) });
}

/** The motivating pair: the note lineage, and the withdrawal that depends on it. */
function pair(api) {
  const note = audited(api, 'comment-4078-j97', NOTE_BODY);
  const noteReceipt = api.authorize({ lineage: note, publication: binding(NOTE_BODY, 4078) }).receipt;
  const withdraw = audited(api, 'comment-3262-withdraw', WITHDRAW_BODY);
  const withdrawReceipt = api.authorize({ lineage: withdraw, publication: { ...binding(WITHDRAW_BODY, 3262), dependsOn: [note] } }).receipt;
  return { note, noteReceipt, withdraw, withdrawReceipt };
}

const ghNeverReached = () => { throw new Error('gh must not be reached'); };

// -- the receipt carries the declaration ----------------------------------------------------

test('authorize stores dependsOn inside the publication binding, under the receipt id, still as 1.1.0', () => {
  const { api } = store();
  const { note, withdrawReceipt } = pair(api);

  assert.deepEqual(withdrawReceipt.publication.dependsOn, [note]);
  assert.equal(withdrawReceipt.authorizationVersion, '1.1.0');
  assert.equal(validateAuthorization(withdrawReceipt).valid, true, JSON.stringify(validateAuthorization(withdrawReceipt).errors));
  assert.equal(receiptIntact(withdrawReceipt), true);
  assert.equal(receiptIntact({ ...withdrawReceipt, publication: { ...withdrawReceipt.publication, dependsOn: [] } }), false, 'the list sits inside the identity');

  const stored = JSON.parse(readFileSync(join(api.layout.authorizations, `${withdrawReceipt.receiptId.slice(7)}.json`), 'utf8'));
  assert.deepEqual(stored.publication.dependsOn, [note]);

  // Absent means empty, explicitly recorded.
  const plain = audited(api);
  assert.deepEqual(api.authorize({ lineage: plain, publication: binding('x\n', 1) }).receipt.publication.dependsOn, []);
});

test('an existing 1.1.0 receipt without the field still validates, reads as no dependencies, and gates normally', () => {
  const { api } = store();
  const lineage = audited(api);
  const { receipt } = api.authorize({ lineage, publication: binding('x\n', 1) });

  // Rewrite the stored receipt the way the store minted them before the field
  // existed: same fields minus dependsOn, self-consistent id.
  const { receiptId, ...bound } = receipt;
  const { dependsOn, ...publication } = bound.publication;
  const legacy = { ...bound, publication };
  const legacyReceipt = { ...legacy, receiptId: digest(legacy) };
  assert.equal(validateAuthorization(legacyReceipt).valid, true, JSON.stringify(validateAuthorization(legacyReceipt).errors));
  assert.equal(receiptIntact(legacyReceipt), true);
  assert.equal('dependsOn' in legacyReceipt.publication, false);

  writeFileSync(join(api.layout.authorizations, `${legacyReceipt.receiptId.slice(7)}.json`), `${JSON.stringify(legacyReceipt, null, 2)}\n`);
  const index = JSON.parse(readFileSync(api.layout.index, 'utf8'));
  index.lineages[lineage].receiptId = legacyReceipt.receiptId;
  writeFileSync(api.layout.index, `${JSON.stringify(index, null, 2)}\n`);

  assert.equal(api.gatePublish({ lineage, currentCandidateId: CANDIDATE }).state, 'PUBLISHABLE');
  const { ticket } = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
  assert.deepEqual(ticket.dependsOn, [], 'a receipt without the field derives an empty list into the ticket');
  assert.equal(validateTicket(ticket).valid, true);
});

test('the lib-level binding check refuses a malformed dependsOn and accepts a well-formed one', () => {
  const evidence = evidenceFor();
  const ok = issueAuthorization({ evidence, publication: { ...binding('x\n', 1), dependsOn: ['other-lineage'] } });
  assert.equal(ok.authorized, true);
  assert.deepEqual(ok.receipt.publication.dependsOn, ['other-lineage']);
  for (const bad of ['not-a-list', ['../escape'], [7], ['a/b']]) {
    const refused = issueAuthorization({ evidence, publication: { ...binding('x\n', 1), dependsOn: bad } });
    assert.equal(refused.authorized, false, JSON.stringify(bad));
    assert.match(refused.refusals.join(' '), /dependsOn must be a list of lineage names/);
  }
});

// -- refusals at authorize, before anything is written ---------------------------------------

test('authorize refuses an unknown, self, duplicate, or closed dependency, typed and before any receipt exists', () => {
  const { api } = store();
  const lineage = audited(api, 'comment-3262-withdraw', WITHDRAW_BODY);
  const open = audited(api, 'comment-4078-j97', NOTE_BODY);
  const stale = audited(api, 'went-stale', 's\n');
  api.authorize({ lineage: stale, publication: binding('s\n', 9) });
  assert.throws(() => api.gatePublish({ lineage: stale, currentCandidateId: id('b') }), failure('stale-candidate'));
  const retired = audited(api, 'closed');
  api.retire({ lineage: retired, reason: 'closed for the test' });

  const cases = {
    'dependency-unknown': ['nobody-froze-this'],
    'dependency-self': [lineage],
    'dependency-duplicate': [open, open],
    'dependency-closed': [stale],
  };
  const receiptsBefore = existsSync(api.layout.authorizations) ? 1 : 0;
  for (const [code, dependsOn] of Object.entries(cases)) {
    assert.throws(() => api.authorize({ lineage, publication: { ...binding(WITHDRAW_BODY, 3262), dependsOn } }), failure(code), code);
  }
  assert.throws(() => api.authorize({ lineage, publication: { ...binding(WITHDRAW_BODY, 3262), dependsOn: [retired] } }), (error) =>
    error instanceof StoreError && error.detail.failure === 'dependency-closed' && error.detail.dependencyState === 'RETIRED');

  assert.equal(api.status(lineage).receiptId, null, 'no receipt was minted');
  assert.equal(api.status(lineage).state, 'AUDITED_PASS');
  assert.equal(readFileSync(api.layout.index, 'utf8').includes(lineage), true);
  assert.equal(existsSync(api.layout.authorizations) ? 1 : 0, receiptsBefore, 'nothing was prepared');
});

test('authorize refuses a dependency cycle through the current receipts, direct and transitive', () => {
  const { api } = store();
  const a = audited(api, 'cycle-a', 'a\n');
  const b = audited(api, 'cycle-b', 'b\n');
  const c = audited(api, 'cycle-c', 'c\n');

  // a depends on nothing yet; b depends on a; then a wants to depend on b.
  api.authorize({ lineage: a, publication: binding('a\n', 1) });
  api.authorize({ lineage: b, publication: { ...binding('b\n', 2), dependsOn: [a] } });
  assert.throws(() => api.authorize({ lineage: a, publication: { ...binding('a\n', 11), dependsOn: [b] } }), (error) =>
    error instanceof StoreError && error.detail.failure === 'dependency-cycle' && error.detail.chain.join('>') === [a, b, a].join('>'));

  // Transitive: c depends on b (which depends on a); a wanting c closes a -> c -> b -> a.
  api.authorize({ lineage: c, publication: { ...binding('c\n', 3), dependsOn: [b] } });
  assert.throws(() => api.authorize({ lineage: a, publication: { ...binding('a\n', 12), dependsOn: [c] } }), (error) =>
    error instanceof StoreError && error.detail.failure === 'dependency-cycle' && error.detail.chain.join('>') === [a, c, b, a].join('>'));

  // The chain is built from CURRENT receipts: once b re-authorizes without a, a may depend on b.
  api.authorize({ lineage: b, publication: binding('b\n', 22) });
  assert.equal(api.authorize({ lineage: a, publication: { ...binding('a\n', 13), dependsOn: [b] } }).state, 'AUTHORIZED');
});

// -- enforcement at every forward step ---------------------------------------------------------

test('gate-publish and reserve-attempt refuse until the dependency has a published, body-identical attempt', () => {
  const { api } = store();
  const { note, noteReceipt, withdraw } = pair(api);

  const unpublished = (error) => error instanceof StoreError
    && error.detail.failure === 'dependency-unpublished'
    && error.detail.dependency === note
    && error.message.includes(note);
  assert.throws(() => api.gatePublish({ lineage: withdraw, currentCandidateId: CANDIDATE }), unpublished, 'gate-publish, dependency authorized but unpublished');
  assert.equal(api.status(withdraw).state, 'AUTHORIZED', 'the refusal is not a transition');

  // A failed attempt is not a publication.
  api.gatePublish({ lineage: note, currentCandidateId: CANDIDATE });
  recordAttempt(api, note, noteReceipt, { outcome: 'failed', bodyIdentical: null });
  assert.throws(() => api.gatePublish({ lineage: withdraw, currentCandidateId: CANDIDATE }), (error) =>
    unpublished(error) && /include none with outcome published/.test(error.detail.missing));

  // Published but the read-back did not confirm the bytes: still not satisfied.
  recordAttempt(api, note, noteReceipt, { outcome: 'published', bodyIdentical: false });
  assert.throws(() => api.gatePublish({ lineage: withdraw, currentCandidateId: CANDIDATE }), unpublished);

  // Published and verified: the order is satisfied.
  recordAttempt(api, note, noteReceipt, { outcome: 'published', bodyIdentical: true });
  assert.equal(api.gatePublish({ lineage: withdraw, currentCandidateId: CANDIDATE }).state, 'PUBLISHABLE');
  const { ticket } = api.reserveAttempt({ lineage: withdraw, currentCandidateId: CANDIDATE });
  assert.deepEqual(ticket.dependsOn, [note]);
});

test('reserve-attempt re-evaluates on its own: PUBLISHABLE granted earlier does not carry the dependency', () => {
  const { api } = store();
  const { note, noteReceipt, withdraw } = pair(api);
  api.gatePublish({ lineage: note, currentCandidateId: CANDIDATE });
  recordAttempt(api, note, noteReceipt);
  assert.equal(api.gatePublish({ lineage: withdraw, currentCandidateId: CANDIDATE }).state, 'PUBLISHABLE');

  // The dependency's published attempt is removed from disk after the gate,
  // the way a rewritten store or a moved directory would leave it. The index
  // still reads PUBLISHABLE; the reservation looks again.
  rmSync(join(api.layout.attempts, noteReceipt.receiptId.slice(7)), { recursive: true, force: true });
  assert.throws(() => api.reserveAttempt({ lineage: withdraw, currentCandidateId: CANDIDATE }), failure('dependency-unpublished'));
  assert.equal(api.status(withdraw).attempts, 0, 'no attempt number was burned');
});

test('a retired dependency refuses at gate, reservation, publisher and consumption, even after it had published', () => {
  const { api } = store();
  const { note, noteReceipt, withdraw } = pair(api);
  api.gatePublish({ lineage: note, currentCandidateId: CANDIDATE });
  recordAttempt(api, note, noteReceipt);
  api.gatePublish({ lineage: withdraw, currentCandidateId: CANDIDATE });
  const { ticket } = api.reserveAttempt({ lineage: withdraw, currentCandidateId: CANDIDATE });
  const bodyFile = join(scratch, 'withdraw-body.md');
  writeFileSync(bodyFile, WITHDRAW_BODY);

  api.retire({ lineage: note, reason: 'the note was withdrawn after all' });

  const closed = (error) => error instanceof StoreError && error.detail.failure === 'dependency-closed' && error.detail.dependency === note;
  assert.throws(() => api.consumeTicket({ lineage: withdraw, ticketId: ticket.ticketId }), closed, 'consumption');
  assert.throws(() => api.dependenciesSatisfied({ lineage: withdraw, dependsOn: ticket.dependsOn }), closed, 'the publisher check');
  const result = publishWithTicket({ store: api, lineage: withdraw, bodyFile, runGh: ghNeverReached });
  assert.equal(result.refusal.failure, 'dependency-closed');
  assert.match(result.refusal.message, /nothing was consumed/);
  assert.equal(existsSync(join(api.layout.tickets, `${withdraw}.json`)), true, 'the ticket is still live; nothing was spent');

  // With the ticket expired out of the way, gate and reservation refuse too.
  const lineageEntry = JSON.parse(readFileSync(api.layout.index, 'utf8')).lineages[withdraw];
  const livePath = join(api.layout.ticketArtifacts, `${lineageEntry.ticketId.slice(7)}.json`);
  const { ticketId, issuedAt, expiresAt, ...rest } = JSON.parse(readFileSync(livePath, 'utf8'));
  const expired = ticketOf({ ...rest, issuedAt: new Date(Date.now() - 31 * 60_000).toISOString() });
  writeFileSync(join(api.layout.ticketArtifacts, `${expired.ticketId.slice(7)}.json`), `${JSON.stringify(expired, null, 2)}\n`);
  writeFileSync(join(api.layout.tickets, `${withdraw}.json`), `${JSON.stringify(expired, null, 2)}\n`);
  const index = JSON.parse(readFileSync(api.layout.index, 'utf8'));
  index.lineages[withdraw].ticketId = expired.ticketId;
  writeFileSync(api.layout.index, `${JSON.stringify(index, null, 2)}\n`);
  assert.throws(() => api.reserveAttempt({ lineage: withdraw, currentCandidateId: CANDIDATE }), closed, 'reservation');
  assert.throws(() => api.gatePublish({ lineage: withdraw, currentCandidateId: CANDIDATE }), (error) =>
    ['dependency-closed', 'illegal-transition'].includes(error.detail.failure), 'gate: refused by the dependency or by the machine, never granted');
});

test('the publisher refuses an unpublished dependency BEFORE consuming, then publishes once it is satisfied', () => {
  const { api } = store();
  const { note, noteReceipt, withdraw } = pair(api);
  api.gatePublish({ lineage: note, currentCandidateId: CANDIDATE });
  recordAttempt(api, note, noteReceipt);
  api.gatePublish({ lineage: withdraw, currentCandidateId: CANDIDATE });
  const { ticket } = api.reserveAttempt({ lineage: withdraw, currentCandidateId: CANDIDATE });
  const bodyFile = join(scratch, 'withdraw-body-2.md');
  writeFileSync(bodyFile, WITHDRAW_BODY);

  // Between reservation and publication the dependency's published record
  // disappears. The ticket carries the list, so the publisher refuses from
  // the ticket alone, and spends nothing.
  const attemptsDirectory = join(api.layout.attempts, noteReceipt.receiptId.slice(7));
  const kept = readFileSync(join(attemptsDirectory, '001.json'), 'utf8');
  rmSync(attemptsDirectory, { recursive: true, force: true });

  const refused = publishWithTicket({ store: api, lineage: withdraw, bodyFile, runGh: ghNeverReached });
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.refusal.failure, 'dependency-unpublished');
  assert.equal(refused.refusal.dependency, note);
  assert.match(refused.refusal.message, /nothing was consumed/);
  assert.equal(existsSync(join(api.layout.tickets, `${withdraw}.json`)), true, 'the ticket is still live');
  assert.deepEqual(api.listAttempts(withdraw), []);

  // Restored, the same ticket publishes.
  mkdirSync(attemptsDirectory, { recursive: true });
  writeFileSync(join(attemptsDirectory, '001.json'), kept);
  const calls = [];
  const runGh = (argv, { stdin = null } = {}) => {
    calls.push({ argv, stdin });
    return calls.length === 1
      ? { status: 0, stdout: `https://github.com/${REPO}/issues/3262#issuecomment-1\n`, stderr: '' }
      : { status: 0, stdout: WITHDRAW_BODY, stderr: '' };
  };
  const published = publishWithTicket({ store: api, lineage: withdraw, bodyFile, runGh });
  assert.equal(published.code, 0, JSON.stringify(published));
  assert.equal(published.attempt.detail.ticketId, ticket.ticketId);
});

// -- the ticket ---------------------------------------------------------------------------------

test('the ticket copies dependsOn from the receipt and binds it in its id', () => {
  const { api } = store();
  const { note, noteReceipt, withdraw, withdrawReceipt } = pair(api);
  api.gatePublish({ lineage: note, currentCandidateId: CANDIDATE });
  recordAttempt(api, note, noteReceipt);
  api.gatePublish({ lineage: withdraw, currentCandidateId: CANDIDATE });
  const { ticket } = api.reserveAttempt({ lineage: withdraw, currentCandidateId: CANDIDATE });

  assert.deepEqual(ticket.dependsOn, withdrawReceipt.publication.dependsOn);
  assert.equal(validateTicket(ticket).valid, true, JSON.stringify(validateTicket(ticket).errors));
  assert.equal(ticketIntact(ticket), true);
  assert.equal(ticketIntact({ ...ticket, dependsOn: [] }), false, 'dropping the list breaks the ticket id');
  const { ticketId, ...rest } = ticket;
  assert.notEqual(ticketOf({ ...rest, dependsOn: [] }).ticketId, ticketId, 'a different list is a different ticket');
  assert.equal(validateTicket({ ...ticket, dependsOn: undefined }).valid, false, 'a ticket minted today always carries the field');
});

// -- the CLI boundary --------------------------------------------------------------------------
//
// Only a refusal that happens before any store call is exercised through the
// ledger binary, which always opens the workspace store.

test('the ledger refuses a bare --depends-on before any store call', () => {
  const body = join(scratch, 'cli-body.md');
  writeFileSync(body, WITHDRAW_BODY);
  const run = spawnSync(process.execPath, [
    LEDGER, 'authorize', '--lineage', 'never-touched', '--operation', 'issue-comment',
    '--target-repo', REPO, '--target-number', '3262', '--body-file', body, '--depends-on',
  ], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /^REFUSED: --depends-on needs at least one lineage name/m);
  assert.equal(run.stdout, '');
});
