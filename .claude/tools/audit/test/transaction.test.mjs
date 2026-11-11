// Transactional semantics of a store mutation.
//
// The distinction under test: a refusal that IS a transition must survive
// being refused, and everything else must leave the store exactly as it was.
// An earlier version wrote the index on every throw, which meant a partial
// mutation followed by an unexpected exception was persisted as if it had been
// decided.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, chmodSync, renameSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { writeAtomic } from '../lib/store/atomic.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openStore, runTransaction, assertIndexShape,
  StoreError, StoreDurabilityError, STORE_VERSION, NO_SIGNATURE_WARNING,
} from '../lib/store/store.mjs';
import { buildEvidence } from '../lib/evidence-record.mjs';
import { REQUIRED_SOURCES, READING, CONTRIBUTION } from '../lib/intake.mjs';
import { STATUS } from '../lib/status.mjs';
import { completeCoverage, auditorResult, TASK_CONTRACT } from './helpers/documents.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'audit-tx-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;
const newRoot = () => mkdtempSync(join(scratch, 'store-'));
const store = (root = newRoot()) => ({ root, api: openStore({ override: root, allowOutsideWorkspace: true, lockOptions: { waitMs: 4000 } }) });

const id = (character) => `sha256:${character.repeat(64)}`;
const CANDIDATE = id('c');

/** A satisfied intake: all three readings complete, nothing competing. */
const INTAKE = {
  repository: 'Gentleman-Programming/gentle-ai',
  contributionType: CONTRIBUTION.ISSUE,
  readings: REQUIRED_SOURCES.map((source) => ({
    source, command: `${source} --repo Gentleman-Programming/gentle-ai`, result: READING.COMPLETE, matches: 0, reviewed: false, coverage: completeCoverage({ source }),
  })),
  competing: [],
};

/** The publication binding authorize now requires. */
const BINDING = { operation: 'issue-comment', targetRepo: 'Gentleman-Programming/gentle-ai', targetNumber: 42, bodySha256: id('b'), titleSha256: null };

const FREEZE = {
  baseTree: 'aa', candidateTree: 'bb',
  pathsDigest: id('1'), draftDigest: id('2'), policyDigest: id('3'), testManifestDigest: id('4'),
  draftBodySha256: id('b'),
  taskContract: TASK_CONTRACT,
  intake: INTAKE,
};

const evidenceFor = (overrides = {}) => buildEvidence({
  result: {
    gate: 'preflight',
    status: STATUS.PASS,
    binding: { snapshotHash: id('5'), snapshotHashAfter: id('5'), stable: true, policyHash: id('7'), toolVersion: '0.1.0', decisionId: id('9') },
    summary: { pass: 1, fail: 0, unknown: 0, notRun: 0 },
    checks: [{ id: 'a.one', status: STATUS.PASS, required: true, reason: 'ok' }],
    ...overrides,
  },
  candidate: { status: STATUS.PASS, candidateId: CANDIDATE, reason: 'identified' },
});

function readyLineage(api, lineage = `pr-${sequence += 1}`) {
  const frozen = api.freeze({ lineage, candidateId: CANDIDATE, ...FREEZE });
  api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'PASS') });
  api.recordEvidence({ lineage, evidence: evidenceFor() });
  return lineage;
}

/** A minimal in-memory index, so the transaction can be tested exactly. */
function harness(initial = { storeVersion: STORE_VERSION, notASignature: NO_SIGNATURE_WARNING, lineages: {}, migratedFrom: [] }) {
  const state = { persisted: initial, writes: 0, handedToWork: null };
  return {
    state,
    read: () => state.persisted,
    write: (draft) => { state.writes += 1; state.persisted = draft; },
    failingWrite: () => { throw new Error('the disk said no'); },
  };
}

// -- rollback -----------------------------------------------------------------------

test('REGRESSION: a partial mutation followed by an unexpected exception rolls back', () => {
  const bench = harness({ storeVersion: STORE_VERSION, notASignature: NO_SIGNATURE_WARNING, migratedFrom: [], lineages: {
    'pr-1': { lineage: 'pr-1', state: 'FROZEN', correction_budget: 1, corrections_used: 0, attempts: 0 },
  } });
  const before = JSON.stringify(bench.state.persisted);

  assert.throws(() => runTransaction({
    read: bench.read,
    write: bench.write,
    work: (draft) => {
      draft.lineages['pr-1'].state = 'AUTHORIZED';
      draft.lineages['pr-2'] = { lineage: 'pr-2', state: 'FROZEN', correction_budget: 1, corrections_used: 0, attempts: 0 };
      throw new TypeError('something nobody planned for');
    },
  }), TypeError);

  assert.equal(bench.state.writes, 0, 'nothing may be written');
  assert.equal(JSON.stringify(bench.state.persisted), before, 'the store is byte-identical');
});

test('REGRESSION: the index handed to the work is a copy; the original is never mutated', () => {
  const original = { storeVersion: STORE_VERSION, notASignature: NO_SIGNATURE_WARNING, migratedFrom: [], lineages: {
    'pr-1': { lineage: 'pr-1', state: 'FROZEN', correction_budget: 1, corrections_used: 0, attempts: 0 },
  } };
  const bench = harness(original);
  let handed;

  assert.throws(() => runTransaction({
    read: bench.read,
    write: bench.write,
    work: (draft) => { handed = draft; draft.lineages['pr-1'].state = 'STALE'; throw new Error('boom'); },
  }), Error);

  assert.notEqual(handed, original, 'the work must not receive the persisted object');
  assert.equal(original.lineages['pr-1'].state, 'FROZEN', 'the original object is untouched in memory');
  assert.equal(handed.lineages['pr-1'].state, 'STALE', 'and the discarded draft really had been mutated');
});

test('REGRESSION: a typed refusal WITHOUT commitTransition rolls back', () => {
  const bench = harness();
  assert.throws(() => runTransaction({
    read: bench.read,
    write: bench.write,
    work: (draft) => {
      draft.lineages['pr-1'] = { lineage: 'pr-1', state: 'STALE', correction_budget: 1, corrections_used: 0, attempts: 0 };
      throw new StoreError('an ordinary refusal', { failure: 'illegal-transition' });
    },
  }), StoreError);

  assert.equal(bench.state.writes, 0);
  assert.deepEqual(Object.keys(bench.state.persisted.lineages), []);
});

// -- commit -------------------------------------------------------------------------------

test('REGRESSION: a typed refusal WITH commitTransition persists, and still refuses', () => {
  const bench = harness({ storeVersion: STORE_VERSION, notASignature: NO_SIGNATURE_WARNING, migratedFrom: [], lineages: {
    'pr-1': { lineage: 'pr-1', state: 'AUTHORIZED', correction_budget: 1, corrections_used: 0, attempts: 0 },
  } });

  assert.throws(() => runTransaction({
    read: bench.read,
    write: bench.write,
    work: (draft) => {
      draft.lineages['pr-1'].state = 'STALE';
      throw new StoreError('the candidate changed', { failure: 'stale-candidate', commitTransition: true });
    },
  }), (error) => error instanceof StoreError && error.detail.failure === 'stale-candidate');

  assert.equal(bench.state.writes, 1, 'the transition is persisted');
  assert.equal(bench.state.persisted.lineages['pr-1'].state, 'STALE');
});

test('a completed operation persists once', () => {
  const bench = harness();
  const outcome = runTransaction({
    read: bench.read,
    write: bench.write,
    work: (draft) => {
      draft.lineages['pr-1'] = { lineage: 'pr-1', state: 'FROZEN', correction_budget: 1, corrections_used: 0, attempts: 0 };
      return 'done';
    },
  });

  assert.equal(outcome, 'done');
  assert.equal(bench.state.writes, 1);
});

test('REGRESSION: cleanup failure after the index commit returns the committed result with warning evidence', () => {
  const bench = harness();
  const outcome = runTransaction({
    read: bench.read,
    write: bench.write,
    work: (draft, transaction) => {
      draft.lineages['pr-1'] = { lineage: 'pr-1', state: 'FROZEN', correction_budget: 1, corrections_used: 0, attempts: 0 };
      transaction.stage({ cleanup: () => { throw new Error('injected consume cleanup failure'); } });
      return { committed: true };
    },
  });

  assert.equal(bench.state.writes, 1, 'the authoritative index committed');
  assert.equal(outcome.committed, true, 'the operation result still reports its committed outcome');
  assert.deepEqual(outcome.cleanupWarnings, [{
    failure: 'artifact-cleanup',
    indexPersisted: true,
    message: 'injected consume cleanup failure',
  }]);
});

// -- durability ------------------------------------------------------------------------------

test('REGRESSION: a write that fails while persisting a refusal is a visible durability error', () => {
  const bench = harness({ storeVersion: STORE_VERSION, notASignature: NO_SIGNATURE_WARNING, migratedFrom: [], lineages: {
    'pr-1': { lineage: 'pr-1', state: 'AUTHORIZED', correction_budget: 1, corrections_used: 0, attempts: 0 },
  } });

  let raised;
  try {
    runTransaction({
      read: bench.read,
      write: bench.failingWrite,
      work: (draft) => {
        draft.lineages['pr-1'].state = 'STALE';
        throw new StoreError('the candidate changed', { failure: 'stale-candidate', commitTransition: true });
      },
    });
  } catch (error) {
    raised = error;
  }

  assert.ok(raised instanceof StoreDurabilityError, 'the durability failure must surface, not be swallowed');
  assert.equal(raised.detail.transitionPersisted, false);
  assert.equal(raised.refusal.detail.failure, 'stale-candidate', 'the original refusal is preserved as the cause');
  assert.match(raised.message, /did NOT reach the state the refusal implies/);
  assert.match(raised.message, /the disk said no/);
  assert.equal(bench.state.persisted.lineages['pr-1'].state, 'AUTHORIZED', 'and the store did not move');
});

// -- validation before writing ------------------------------------------------------------------

test('an invalid draft is never written, on either path', () => {
  for (const thrower of [null, (draft) => { draft.lineages['pr-1'].state = 'INVENTED'; }]) {
    const bench = harness({ storeVersion: STORE_VERSION, notASignature: NO_SIGNATURE_WARNING, migratedFrom: [], lineages: {
      'pr-1': { lineage: 'pr-1', state: 'FROZEN', correction_budget: 1, corrections_used: 0, attempts: 0 },
    } });

    assert.throws(() => runTransaction({
      read: bench.read,
      write: bench.write,
      work: (draft) => {
        (thrower ?? (() => {}))(draft);
        if (thrower === null) draft.lineages['pr-1'].corrections_used = 9;
      },
    }), (error) => error instanceof StoreError && error.detail.failure === 'invalid-draft');

    assert.equal(bench.state.writes, 0, 'an invalid draft never becomes the store');
  }
});

test('assertIndexShape refuses every malformed draft it is given', () => {
  const good = { storeVersion: STORE_VERSION, notASignature: NO_SIGNATURE_WARNING, migratedFrom: [], lineages: {} };
  assert.equal(assertIndexShape(good), good);

  const bad = [
    null, [], 'x',
    { ...good, storeVersion: '9.9.9' },
    { ...good, lineages: [] },
    { ...good, migratedFrom: 'no' },
    { ...good, lineages: { 'pr-1': null } },
    { ...good, lineages: { 'pr-1': { lineage: 'pr-1', state: 'FROZEN', correction_budget: 1, corrections_used: 0 } } },
    { ...good, lineages: { 'pr-1': { lineage: 'other', state: 'FROZEN', correction_budget: 1, corrections_used: 0, attempts: 0 } } },
    { ...good, lineages: { 'pr-1': { lineage: 'pr-1', state: 'INVENTED', correction_budget: 1, corrections_used: 0, attempts: 0 } } },
    { ...good, lineages: { 'pr-1': { lineage: 'pr-1', state: 'FROZEN', correction_budget: 1, corrections_used: 5, attempts: 0 } } },
  ];
  for (const draft of bad) assert.throws(() => assertIndexShape(draft), StoreError, JSON.stringify(draft)?.slice(0, 60));
});

// -- the same rules, through the real store ----------------------------------------------------------

test('REGRESSION: a stale candidate persists STALE through the real store', () => {
  const { api } = store();
  const lineage = readyLineage(api);
  api.authorize({ lineage, publication: BINDING });

  assert.throws(() => api.gatePublish({ lineage, currentCandidateId: id('b') }), (error) =>
    error instanceof StoreError && error.detail.failure === 'stale-candidate' && error.detail.commitTransition === true);

  assert.equal(api.status(lineage).state, 'STALE', 'the transition survived the refusal');
});

test('REGRESSION: an exhausted budget persists NEEDS_MAINTAINER through the real store', () => {
  const { api } = store();
  const lineage = `pr-${sequence += 1}`;
  const frozen = api.freeze({ lineage, candidateId: CANDIDATE, ...FREEZE });
  api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'NEEDS_CHANGES') });
  api.reserveCorrection({ lineage });
  api.refreeze({ lineage, candidateId: id('d'), ...FREEZE });
  api.recordAudit({ lineage, result: auditorResult(api.status(lineage).subject_id, 'NEEDS_CHANGES') });

  // REFROZEN + NEEDS_CHANGES escalates on its own; the budget is spent.
  assert.equal(api.status(lineage).state, 'NEEDS_MAINTAINER');
  assert.equal(api.status(lineage).corrections_used, 1);
});

test('REGRESSION: an ordinary refusal leaves store.json byte-identical', () => {
  const { api } = store();
  const lineage = readyLineage(api);
  const before = readFileSync(api.layout.index, 'utf8');

  assert.throws(() => api.recordEvidence({
    lineage,
    evidence: buildEvidence({
      result: {
        gate: 'preflight', status: STATUS.PASS,
        binding: { snapshotHash: id('5'), snapshotHashAfter: id('5'), stable: true, policyHash: id('7'), toolVersion: '0.1.0', decisionId: id('9') },
        summary: { pass: 1, fail: 0, unknown: 0, notRun: 0 },
        checks: [{ id: 'a.one', status: STATUS.PASS, required: true, reason: 'ok' }],
      },
      candidate: { status: STATUS.PASS, candidateId: id('e'), reason: 'another candidate entirely' },
    }),
  }), (error) => error instanceof StoreError && error.detail.failure === 'candidate-mismatch');

  assert.equal(readFileSync(api.layout.index, 'utf8'), before, 'a refusal that is not a transition writes nothing');
});

/**
 * A store whose write boundary can be faulted.
 *
 * This is how the durability path is exercised authoritatively: a permission
 * trick means different things on different systems -- on POSIX the right to
 * replace a file belongs to its DIRECTORY, not to the file's own mode -- so a
 * chmod-based test proves the semantics on exactly one platform and silently
 * stops proving them elsewhere.
 */
function faultableStore() {
  const root = newRoot();
  const fault = { armed: false, calls: 0 };
  const api = openStore({
    override: root,
    allowOutsideWorkspace: true,
    lockOptions: { waitMs: 4000 },
    writer: (path, text) => {
      fault.calls += 1;
      if (fault.armed) throw new Error('the write boundary was faulted');
      return writeAtomic(path, text);
    },
  });
  return { root, api, fault };
}

test('REGRESSION: a faulted write while persisting a refusal is a durability error, through the whole store', async () => {
  const { api, fault } = faultableStore();
  const lineage = readyLineage(api);
  api.authorize({ lineage, publication: BINDING });

  const before = readFileSync(api.layout.index, 'utf8');
  const stateBefore = api.status(lineage).state;
  assert.equal(stateBefore, 'AUTHORIZED');

  // The refusal below carries a STALE transition. Persisting it will fail.
  fault.armed = true;
  let raised;
  try {
    api.gatePublish({ lineage, currentCandidateId: id('b') });
  } catch (error) {
    raised = error;
  } finally {
    fault.armed = false;
  }

  assert.ok(raised instanceof StoreDurabilityError, `expected a durability error, got ${raised?.name}: ${raised?.message}`);
  assert.equal(raised.detail.transitionPersisted, false);
  assert.equal(raised.refusal.detail.failure, 'stale-candidate', 'the original refusal is preserved as the cause');
  assert.match(raised.message, /the write boundary was faulted/);

  // The previous state survives, byte for byte.
  assert.equal(readFileSync(api.layout.index, 'utf8'), before, 'store.json must be byte-identical');
  assert.equal(api.status(lineage).state, stateBefore, 'the lineage did NOT reach STALE');

  // And the error does not claim the transition it could not make.
  assert.match(raised.message, /did NOT reach the state the refusal implies/);
  assert.equal(
    /is now STALE|reached STALE|lineage is STALE|marked STALE/i.test(raised.message),
    false,
    'the error must not assert a state the lineage never reached'
  );
});

test('REGRESSION: a faulted write on a normal operation rolls back the whole store', async () => {
  const { api, fault } = faultableStore();
  const lineage = readyLineage(api);

  const before = readFileSync(api.layout.index, 'utf8');
  fault.armed = true;
  assert.throws(() => api.authorize({ lineage, publication: BINDING }), /the write boundary was faulted/);
  fault.armed = false;

  assert.equal(readFileSync(api.layout.index, 'utf8'), before, 'store.json must be byte-identical');
  assert.equal(api.status(lineage).state, 'AUDITED_PASS', 'the lineage did not become AUTHORIZED');
});

test('REGRESSION: a faulted authorization exposes no live signer alias or committed right', () => {
  const { api, fault } = faultableStore();
  const lineage = readyLineage(api);
  const beforeState = readFileSync(api.layout.index, 'utf8');

  fault.armed = true;
  assert.throws(() => api.authorize({ lineage, publication: BINDING }), /the write boundary was faulted/);
  fault.armed = false;

  assert.equal(readFileSync(api.layout.index, 'utf8'), beforeState);
  assert.equal(api.status(lineage).state, 'AUDITED_PASS');
  assert.equal(existsSync(join(api.layout.pendingSignature, `${lineage}.json`)), false, 'no signer request exists for an authorization the index never issued');
  const receipts = existsSync(api.layout.authorizations)
    ? readdirSync(api.layout.authorizations).filter((name) => name.endsWith('.json'))
    : [];
  assert.equal(receipts.length, 1, 'the immutable receipt may remain, but the committed index does not reference it');
});

test('REGRESSION: index failure after artifact preparation leaves only inert artifacts and the committed state usable', () => {
  const { api, fault } = faultableStore();
  const lineage = readyLineage(api);
  const before = readFileSync(api.layout.index, 'utf8');

  fault.armed = true;
  assert.throws(() => api.authorize({ lineage, publication: BINDING }), /the write boundary was faulted/);
  fault.armed = false;

  assert.equal(readFileSync(api.layout.index, 'utf8'), before, 'the manifest remains the previous committed index');
  assert.equal(api.status(lineage).state, 'AUDITED_PASS', 'the orphan artifacts grant no authorization');
  assert.equal(
    readdirSync(api.layout.authorizations).filter((name) => name.endsWith('.json')).length,
    1,
    'the immutable receipt was prepared before the failed manifest commit'
  );
  assert.equal(
    readdirSync(api.layout.pendingSignature).filter((name) => name.endsWith('.json')).length,
    1,
    'the receipt-specific signer request is prepared but inert without a manifest reference'
  );
});

test('REGRESSION: the index writer never observes a manifest that references missing authorization or ticket artifacts', () => {
  const root = newRoot();
  let api;
  const writer = (path, text) => {
    const draft = JSON.parse(text);
    for (const entry of Object.values(draft.lineages)) {
      if (entry.receiptId !== null && entry.receiptId !== undefined) {
        assert.equal(
          existsSync(join(api.layout.authorizations, `${entry.receiptId.slice('sha256:'.length)}.json`)),
          true,
          'a receipt exists before its manifest reference is written'
        );
      }
      if (entry.ticketId !== null && entry.ticketId !== undefined) {
        assert.equal(
          existsSync(join(api.layout.ticketArtifacts, `${entry.ticketId.slice('sha256:'.length)}.json`)),
          true,
          'a ticket exists before its manifest reference is written'
        );
      }
    }
    return writeAtomic(path, text);
  };
  api = openStore({ override: root, allowOutsideWorkspace: true, lockOptions: { waitMs: 4000 }, writer });
  const lineage = readyLineage(api);
  api.authorize({ lineage, publication: BINDING });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
});

test('REGRESSION: a prewritten ticket is refused unless the committed index issued that exact ticket and attempt', () => {
  const { api } = store();
  const lineage = readyLineage(api);
  api.authorize({ lineage, publication: BINDING });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  const { ticket } = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });

  const index = JSON.parse(readFileSync(api.layout.index, 'utf8'));
  index.lineages[lineage].attempts = 0;
  index.lineages[lineage].ticketId = null;
  writeFileSync(api.layout.index, `${JSON.stringify(index, null, 2)}\n`);

  assert.throws(() => api.consumeTicket({ lineage, ticketId: ticket.ticketId }), (error) =>
    error instanceof StoreError
      && ['no-ticket', 'unissued-ticket'].includes(error.detail.failure));
  assert.equal(
    existsSync(join(api.layout.ticketArtifacts, `${ticket.ticketId.slice('sha256:'.length)}.json`)),
    true,
    'the prewritten immutable ticket remains present but inert'
  );
});

test('REGRESSION: a legacy manifest without an exact ticketId cannot admit a prewritten ticket', () => {
  const { api } = store();
  const lineage = readyLineage(api);
  api.authorize({ lineage, publication: BINDING });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  const { ticket } = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });

  const index = JSON.parse(readFileSync(api.layout.index, 'utf8'));
  delete index.lineages[lineage].ticketId;
  writeFileSync(api.layout.index, `${JSON.stringify(index, null, 2)}\n`);

  assert.throws(() => api.consumeTicket({ lineage, ticketId: ticket.ticketId }), (error) =>
    error instanceof StoreError && error.detail.failure === 'unissued-ticket');
});

test('REGRESSION: post-index supersession cleanup failure leaves the new authorization and reservation usable', () => {
  const { api } = store();
  const lineage = readyLineage(api);
  const first = api.authorize({ lineage, publication: BINDING });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });

  const blockingDestination = join(
    api.layout.authorizationsSuperseded,
    `${first.receipt.receiptId.slice('sha256:'.length)}.json`
  );
  mkdirSync(blockingDestination, { recursive: true });

  const authorized = api.authorize({
    lineage,
    publication: { ...BINDING, targetNumber: 43 },
  });
  assert.equal(authorized.cleanupWarnings.length, 1);
  assert.equal(authorized.cleanupWarnings[0].failure, 'artifact-cleanup');
  assert.equal(authorized.cleanupWarnings[0].indexPersisted, true);

  const current = api.status(lineage);
  assert.notEqual(current.receiptId, first.receipt.receiptId, 'the committed manifest selects the new receipt');
  assert.equal(
    existsSync(join(api.layout.authorizations, `${current.receiptId.slice('sha256:'.length)}.json`)),
    true,
    'the selected receipt was durable before the manifest commit'
  );
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  const reserved = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
  assert.equal(reserved.lineage.ticketId, reserved.ticket.ticketId, 'stale cleanup debris cannot block the current authorization');
});

test('REGRESSION: a faulted re-authorization keeps the committed receipt, ticket, and signer request usable', () => {
  const { api, fault } = faultableStore();
  const lineage = readyLineage(api);
  const first = api.authorize({ lineage, publication: BINDING });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  const reserved = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });

  const oldReceiptPath = join(api.layout.authorizations, `${first.receipt.receiptId.slice('sha256:'.length)}.json`);
  const liveTicketPath = join(api.layout.tickets, `${lineage}.json`);
  const pendingPath = join(api.layout.pendingSignature, `${lineage}.json`);
  const beforeState = {
    index: readFileSync(api.layout.index, 'utf8'),
    receipt: readFileSync(oldReceiptPath, 'utf8'),
    ticket: readFileSync(liveTicketPath, 'utf8'),
    pending: readFileSync(pendingPath, 'utf8'),
  };

  fault.armed = true;
  assert.throws(() => api.authorize({
    lineage,
    publication: { ...BINDING, targetNumber: 43 },
  }), /the write boundary was faulted/);
  fault.armed = false;

  assert.equal(readFileSync(api.layout.index, 'utf8'), beforeState.index);
  assert.equal(readFileSync(oldReceiptPath, 'utf8'), beforeState.receipt, 'the committed receipt stays at its live path');
  assert.equal(readFileSync(liveTicketPath, 'utf8'), beforeState.ticket, 'the previously issued ticket stays live and byte-identical');
  assert.equal(readFileSync(pendingPath, 'utf8'), beforeState.pending, 'the committed signer request is not replaced');
  assert.equal(api.loadTicket({ lineage }).ticket.ticketId, reserved.ticket.ticketId, 'the previous ticket remains usable');
});

test('REGRESSION: a faulted reservation exposes no ticket the committed index never issued', () => {
  const { api, fault } = faultableStore();
  const lineage = readyLineage(api);
  api.authorize({ lineage, publication: BINDING });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  const beforeState = readFileSync(api.layout.index, 'utf8');
  const liveTicketPath = join(api.layout.tickets, `${lineage}.json`);

  fault.armed = true;
  assert.throws(() => api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE }), /the write boundary was faulted/);
  fault.armed = false;

  assert.equal(readFileSync(api.layout.index, 'utf8'), beforeState);
  assert.equal(api.status(lineage).attempts, 0);
  assert.equal(existsSync(liveTicketPath), false, 'no live ticket survives without its committed attempt number');
});

test('REGRESSION: index failure after consumed-record preparation leaves the committed ticket retryable', () => {
  const { api, fault } = faultableStore();
  const lineage = readyLineage(api);
  api.authorize({ lineage, publication: BINDING });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  const { ticket } = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });

  fault.armed = true;
  assert.throws(() => api.consumeTicket({ lineage, ticketId: ticket.ticketId }), /the write boundary was faulted/);
  fault.armed = false;

  assert.equal(api.loadTicket({ lineage }).ticket.ticketId, ticket.ticketId, 'the committed ticket remains usable');
  assert.equal(api.consumeTicket({ lineage, ticketId: ticket.ticketId }).ticket.ticketId, ticket.ticketId, 'retry completes from inert prepared evidence');
});

test('the faultable store behaves exactly like the real one when nothing is faulted', () => {
  const { api, fault } = faultableStore();
  const lineage = readyLineage(api);
  const { receipt } = api.authorize({ lineage, publication: BINDING });

  assert.equal(api.status(lineage).state, 'AUTHORIZED');
  assert.equal(receipt.candidateId, CANDIDATE);
  assert.ok(fault.calls > 0, 'the injected writer really is the one being used');
});

/**
 * Diagnostic only, and capability-detected.
 *
 * It records what THIS platform does when the index file is made read-only.
 * It is not the authoritative test of the transactional semantics -- the
 * faulted-writer tests above are -- because the answer legitimately differs
 * per system, and a test that only holds on one platform proves nothing on
 * the others.
 */
const readOnlyBlocksReplace = (() => {
  const directory = newRoot();
  const target = join(directory, 'probe.json');
  const source = join(directory, 'probe.json.new');
  writeFileSync(target, 'old');
  writeFileSync(source, 'new');
  try {
    chmodSync(target, 0o444);
    renameSync(source, target);
    return { blocks: false, reason: `this platform replaced a 0444 file: the right to replace belongs to the directory, not to the file` };
  } catch (error) {
    return { blocks: true, reason: `this platform refused to replace a 0444 file (${error.code})` };
  } finally {
    try { chmodSync(target, 0o644); } catch { /* already gone */ }
  }
})();

test('DIAGNOSTIC: what a read-only index does on this platform', { skip: readOnlyBlocksReplace.blocks ? false : readOnlyBlocksReplace.reason }, () => {
  const { api } = store();
  const lineage = readyLineage(api);
  api.authorize({ lineage, publication: BINDING });

  chmodSync(api.layout.index, 0o444);
  let raised;
  try {
    api.gatePublish({ lineage, currentCandidateId: id('b') });
  } catch (error) {
    raised = error;
  } finally {
    chmodSync(api.layout.index, 0o644);
  }

  assert.ok(raised instanceof StoreDurabilityError, `expected a durability error, got ${raised?.name}`);
  assert.equal(api.status(lineage).state, 'AUTHORIZED', 'the lineage did NOT reach STALE');
});
