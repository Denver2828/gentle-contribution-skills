// Evidence -> authorization -> publication, as three separate acts.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildEvidence, evidenceIntact, unsatisfiedRequirements } from '../lib/evidence-record.mjs';
import { authorize, receiptIntact, receiptGoverns, NOT_A_SIGNATURE } from '../lib/authorization.mjs';
import { publish, OUTCOME } from '../lib/publication.mjs';
import { validateEvidence, validateAuthorization, validatePublication } from '../lib/validate.mjs';
import { STATUS } from '../lib/status.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'audit-authz-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;

/** A publisher module. Fake, always: nothing here reaches a network. */
function publisherModule(body) {
  const path = join(scratch, `publisher-${sequence += 1}.mjs`);
  writeFileSync(path, body);
  return path;
}

const RECORDING_PUBLISHER = publisherModule(`
  export default { publish: async ({ receipt }) => ({ published: true, reference: 'fake://' + receipt.candidateId.slice(7, 19) }) };
`);

const CANDIDATE_ID = `sha256:${'c'.repeat(64)}`;

/** A complete publication binding: since 1.1.0 no receipt exists without one. */
const PUBLICATION = {
  operation: 'issue-comment',
  targetRepo: 'Gentleman-Programming/gentle-ai',
  targetNumber: 3297,
  bodySha256: `sha256:${'b'.repeat(64)}`,
  titleSha256: null,
};

/** authorize with the standard binding supplied; overrides may replace it. */
const grant = (options = {}) => authorize({ publication: PUBLICATION, ...options });

function makeResult(overrides = {}) {
  return {
    gate: 'preflight',
    status: STATUS.PASS,
    binding: {
      snapshotHash: `sha256:${'5'.repeat(64)}`,
      snapshotHashAfter: `sha256:${'5'.repeat(64)}`,
      stable: true,
      policyHash: `sha256:${'7'.repeat(64)}`,
      toolVersion: '0.1.0',
      decisionId: `sha256:${'9'.repeat(64)}`,
    },
    summary: { pass: 2, fail: 0, unknown: 0, notRun: 1 },
    checks: [
      { id: 'git.repository-readable', status: STATUS.PASS, required: true, reason: 'read' },
      { id: 'git.no-conflicts', status: STATUS.PASS, required: true, reason: 'clean' },
      { id: 'git.branch-allowed', status: STATUS.NOT_RUN, required: false, reason: 'not selected by policy' },
    ],
    ...overrides,
  };
}

const passingCandidate = (candidateId = CANDIDATE_ID) => ({
  status: STATUS.PASS, candidateId, reason: 'identified', evidence: [],
});

const evidenceFor = (result = makeResult(), candidate = passingCandidate()) => buildEvidence({ result, candidate });

// -- act one: evidence ----------------------------------------------------------

test('evidence exists for a failing state, and still authorises nothing', () => {
  const failing = makeResult({
    status: STATUS.FAIL,
    checks: [{ id: 'git.no-conflicts', status: STATUS.FAIL, required: true, reason: 'conflicted' }],
    summary: { pass: 0, fail: 1, unknown: 0, notRun: 0 },
  });
  const evidence = buildEvidence({ result: failing, candidate: passingCandidate() });

  assert.equal(validateEvidence(evidence).valid, true);
  assert.equal(evidence.gateStatus, STATUS.FAIL);
  assert.equal(evidence.authorises, false);
  assert.deepEqual(evidence.verifications.failed.map((entry) => entry.id), ['git.no-conflicts']);
});

test('evidence records executed, failed, inconclusive and skipped, each exactly once', () => {
  const mixed = makeResult({
    status: STATUS.FAIL,
    checks: [
      { id: 'a.passed', status: STATUS.PASS, required: true, reason: 'p' },
      { id: 'b.failed', status: STATUS.FAIL, required: true, reason: 'f' },
      { id: 'c.inconclusive', status: STATUS.UNKNOWN, required: true, reason: 'u' },
      { id: 'd.skipped', status: STATUS.NOT_RUN, required: false, reason: 'n' },
    ],
    summary: { pass: 1, fail: 1, unknown: 1, notRun: 1 },
  });
  const evidence = buildEvidence({ result: mixed, candidate: passingCandidate() });
  const { passed, failed, inconclusive, skipped } = evidence.verifications;

  assert.deepEqual([passed, failed, inconclusive, skipped].map((bucket) => bucket.length), [1, 1, 1, 1]);
  assert.equal(passed.length + failed.length + inconclusive.length + skipped.length, mixed.checks.length,
    'every check lands in exactly one bucket');
});

test('a PASS evidence record on its own is not permission', () => {
  const evidence = evidenceFor();

  assert.equal(evidence.gateStatus, STATUS.PASS);
  assert.equal(evidence.authorises, false, 'even a fully passing record says it does not authorise');
  assert.equal(Object.hasOwn(evidence, 'receiptId'), false, 'and carries no receipt');
});

test('REGRESSION: passing evidence yields no authorization until one is asked for and granted', () => {
  const evidence = evidenceFor();
  // The record exists and is complete. Nothing has been authorised yet.
  assert.equal(evidence.authorises, false);

  const { authorized, receipt } = grant({ evidence });
  assert.equal(authorized, true, 'and asking, on a clean record, does grant it');
  assert.notEqual(receipt, null);
});

test('an altered evidence record is detected by its own id', () => {
  const evidence = evidenceFor();
  assert.equal(evidenceIntact(evidence), true);
  assert.equal(evidenceIntact({ ...evidence, gateStatus: STATUS.PASS, summary: { ...evidence.summary, fail: 9 } }), false);
});

// -- act two: authorization -------------------------------------------------------

test('an authorization binds the candidate, decision, policy, tool, snapshot and artifacts', () => {
  const artifacts = [{ path: 'dist/app.bin', sha256: `sha256:${'e'.repeat(64)}` }];
  const { authorized, receipt } = grant({ evidence: evidenceFor(), artifacts });

  assert.equal(authorized, true);
  assert.equal(validateAuthorization(receipt).valid, true);
  assert.equal(receipt.candidateId, CANDIDATE_ID);
  assert.equal(receipt.decisionId, makeResult().binding.decisionId);
  assert.equal(receipt.policyHash, makeResult().binding.policyHash);
  assert.equal(receipt.snapshotHash, makeResult().binding.snapshotHash);
  assert.equal(receipt.toolVersion, '0.1.0');
  assert.deepEqual(receipt.artifacts, artifacts);
  assert.match(receipt.receiptId, /^sha256:[0-9a-f]{64}$/);
});

test('the receipt says in its own text that it is not a signature', () => {
  const { receipt } = grant({ evidence: evidenceFor() });

  assert.equal(receipt.kind, 'content-addressed-receipt');
  assert.equal(receipt.notASignature, NOT_A_SIGNATURE);
  assert.match(receipt.notASignature, /not a cryptographic signature/);
  assert.match(receipt.notASignature, /resists no forgery/);
});

test('REGRESSION: a FAIL, an UNKNOWN or a required NOT_RUN each refuse authorization', () => {
  const cases = {
    'gate FAIL': makeResult({ status: STATUS.FAIL }),
    'gate UNKNOWN': makeResult({ status: STATUS.UNKNOWN }),
    'gate NOT_RUN': makeResult({ status: STATUS.NOT_RUN }),
    'required check FAIL': makeResult({
      checks: [{ id: 'a.one', status: STATUS.FAIL, required: true, reason: 'violated' }],
    }),
    'required check UNKNOWN': makeResult({
      checks: [{ id: 'a.one', status: STATUS.UNKNOWN, required: true, reason: 'inconclusive' }],
    }),
    'required check NOT_RUN': makeResult({
      checks: [{ id: 'a.one', status: STATUS.NOT_RUN, required: true, reason: 'skipped by policy' }],
    }),
  };

  for (const [label, result] of Object.entries(cases)) {
    const outcome = grant({ evidence: buildEvidence({ result, candidate: passingCandidate() }) });
    assert.equal(outcome.authorized, false, `${label} must refuse`);
    assert.equal(outcome.receipt, null, `${label} must produce no receipt`);
    assert.ok(outcome.refusals.length > 0, `${label} must say why`);
  }
});

test('an optional check that failed does not block authorization', () => {
  const result = makeResult({
    checks: [
      { id: 'a.required', status: STATUS.PASS, required: true, reason: 'p' },
      { id: 'b.optional', status: STATUS.FAIL, required: false, reason: 'recorded, not blocking' },
    ],
  });
  assert.equal(grant({ evidence: buildEvidence({ result, candidate: passingCandidate() }) }).authorized, true);
});

test('an unidentified candidate refuses authorization', () => {
  const evidence = buildEvidence({
    result: makeResult(),
    candidate: { status: STATUS.UNKNOWN, candidateId: null, reason: 'the index holds no entry', evidence: [] },
  });
  const outcome = grant({ evidence });

  assert.equal(outcome.authorized, false);
  assert.match(outcome.refusals.join(' '), /could not be identified/);
});

test('a repository that moved during the gate refuses authorization', () => {
  const result = makeResult();
  result.binding = { ...result.binding, stable: false, snapshotHashAfter: `sha256:${'6'.repeat(64)}` };

  const outcome = grant({ evidence: buildEvidence({ result, candidate: passingCandidate() }) });
  assert.equal(outcome.authorized, false);
  assert.match(outcome.refusals.join(' '), /changed while the gate ran/);
});

test('tampered evidence refuses authorization outright', () => {
  const evidence = evidenceFor(makeResult({ status: STATUS.FAIL }));
  const forged = { ...evidence, gateStatus: STATUS.PASS };

  const outcome = grant({ evidence: forged });
  assert.equal(outcome.authorized, false);
  assert.match(outcome.refusals[0], /does not match its own id/);
});

test('REGRESSION: an altered receipt fails its own integrity check', () => {
  const { receipt } = grant({ evidence: evidenceFor() });
  assert.equal(receiptIntact(receipt), true);

  for (const [field, value] of Object.entries({
    candidateId: `sha256:${'d'.repeat(64)}`,
    decisionId: `sha256:${'0'.repeat(64)}`,
    toolVersion: '9.9.9',
    notASignature: 'this is a signature',
    publication: { ...PUBLICATION, targetNumber: 9999 },
  })) {
    assert.equal(receiptIntact({ ...receipt, [field]: value }), false, `editing ${field} must be detected`);
  }
});

test('a correction produces another receipt, never an amended one', () => {
  const first = grant({ evidence: evidenceFor() }).receipt;
  const second = grant({ evidence: evidenceFor(makeResult(), passingCandidate(`sha256:${'f'.repeat(64)}`)) }).receipt;

  assert.notEqual(first.receiptId, second.receiptId);
  assert.throws(() => { first.candidateId = 'x'; }, TypeError, 'the receipt is frozen');
});

// -- act three: publication ---------------------------------------------------------

async function publishWith(options = {}) {
  const evidence = options.evidence ?? evidenceFor();
  const receipt = options.receipt ?? grant({ evidence, artifacts: options.artifacts }).receipt;
  return publish({
    evidence,
    receipt,
    currentCandidate: options.currentCandidate ?? passingCandidate(receipt?.candidateId ?? CANDIDATE_ID),
    publisherModule: options.publisherModule ?? RECORDING_PUBLISHER,
    attemptNumber: options.attemptNumber ?? 1,
    timeoutMs: options.timeoutMs ?? 5000,
  });
}

test('a publication attempt is a separate artifact that refers to the other two', async () => {
  const { attempt, evidence, receipt } = await publishWith();

  assert.equal(validatePublication(attempt).valid, true);
  assert.equal(attempt.outcome, OUTCOME.PUBLISHED);
  assert.equal(attempt.receiptId, receipt.receiptId);
  assert.equal(attempt.evidenceId, evidence.evidenceId);
  assert.equal(attempt.candidateId, receipt.candidateId);
  assert.match(attempt.detail.reference, /^fake:\/\//);
});

test('publication without an authorization is refused, and never reaches the publisher', async () => {
  const evidence = evidenceFor();
  const { attempt } = await publish({
    evidence, receipt: null, currentCandidate: passingCandidate(),
    publisherModule: publisherModule('export default { publish: async () => { throw new Error("must never run"); } };'),
  });

  assert.equal(attempt.outcome, OUTCOME.REFUSED);
  assert.equal(attempt.detail.failure, 'no-authorization');
});

test('publication with no publisher named is refused; there is no default', async () => {
  const { attempt } = await publishWith({ publisherModule: '' });
  assert.equal(attempt.outcome, OUTCOME.REFUSED);
  assert.equal(attempt.detail.failure, 'no-publisher');
});

test('REGRESSION: a receipt for another candidate is refused before the publisher runs', async () => {
  const mustNotRun = publisherModule('export default { publish: async () => { throw new Error("must never run"); } };');
  const { attempt } = await publishWith({
    currentCandidate: passingCandidate(`sha256:${'b'.repeat(64)}`),
    publisherModule: mustNotRun,
  });

  assert.equal(attempt.outcome, OUTCOME.REFUSED);
  assert.equal(attempt.detail.failure, 'candidate-mismatch');
  assert.equal(attempt.detail.authorised, CANDIDATE_ID);
});

test('REGRESSION: a candidate modified after authorization is refused', async () => {
  const evidence = evidenceFor();
  const { receipt } = grant({ evidence });

  // The receipt was issued for CANDIDATE_ID; the repository now reproduces
  // something else, exactly as a staged edit would cause.
  const { attempt } = await publish({
    evidence, receipt,
    currentCandidate: passingCandidate(`sha256:${'a'.repeat(64)}`),
    publisherModule: RECORDING_PUBLISHER,
  });

  assert.equal(attempt.outcome, OUTCOME.REFUSED);
  assert.match(attempt.reason, /the repository now holds/);
});

test('REGRESSION: a candidate that can no longer be identified is refused', async () => {
  const { attempt } = await publishWith({
    currentCandidate: { status: STATUS.UNKNOWN, candidateId: null, reason: 'the index holds unmerged paths', evidence: [] },
  });

  assert.equal(attempt.outcome, OUTCOME.REFUSED);
  assert.match(attempt.reason, /cannot be identified now/);
});

test('REGRESSION: a tampered receipt is refused at publication time', async () => {
  const evidence = evidenceFor();
  const { receipt } = grant({ evidence });
  const forged = { ...receipt, candidateId: `sha256:${'1'.repeat(64)}` };

  const { attempt } = await publish({
    evidence, receipt: forged,
    currentCandidate: passingCandidate(forged.candidateId),
    publisherModule: RECORDING_PUBLISHER,
  });

  assert.equal(attempt.outcome, OUTCOME.REFUSED);
  assert.match(attempt.reason, /was altered/);
});

test('REGRESSION: an altered artifact changes the candidate, so the receipt stops governing', async () => {
  // The artifact hash is part of the candidate identity, so a rebuilt binary
  // produces a different candidateId and the receipt no longer applies.
  const evidence = evidenceFor();
  const { receipt } = grant({ evidence, artifacts: [{ path: 'dist/app.bin', sha256: `sha256:${'e'.repeat(64)}` }] });

  const rebuilt = passingCandidate(`sha256:${'2'.repeat(64)}`);
  assert.equal(receiptGoverns(receipt, rebuilt).governs, false);

  const { attempt } = await publish({ evidence, receipt, currentCandidate: rebuilt, publisherModule: RECORDING_PUBLISHER });
  assert.equal(attempt.outcome, OUTCOME.REFUSED);
});

test('a receipt issued for other evidence is refused', async () => {
  const evidence = evidenceFor();
  const other = evidenceFor(makeResult({ summary: { pass: 2, fail: 0, unknown: 0, notRun: 0 } }));
  const { receipt } = grant({ evidence: other });

  const { attempt } = await publish({
    evidence, receipt, currentCandidate: passingCandidate(), publisherModule: RECORDING_PUBLISHER,
  });

  assert.equal(attempt.outcome, OUTCOME.REFUSED);
  assert.equal(attempt.detail.failure, 'evidence-mismatch');
});

// -- publishers that misbehave -----------------------------------------------------------

test('REGRESSION: a publisher that throws produces a failed attempt, not a published one', async () => {
  const { attempt } = await publishWith({
    publisherModule: publisherModule('export default { publish: async () => { throw new RangeError("network is down"); } };'),
  });

  assert.equal(attempt.outcome, OUTCOME.FAILED);
  assert.equal(attempt.detail.failure, 'exception');
  assert.match(attempt.reason, /network is down/);
});

test('REGRESSION: a publisher that terminates produces a failed attempt with its exit code', async () => {
  const { attempt } = await publishWith({
    publisherModule: publisherModule('export default { publish: async () => { process.exit(5); } };'),
  });

  assert.equal(attempt.outcome, OUTCOME.FAILED);
  assert.equal(attempt.detail.failure, 'terminated');
  assert.equal(attempt.detail.exitCode, 5);
});

test('REGRESSION: a publisher that hangs is terminated at its budget', async () => {
  const startedAt = Date.now();
  const { attempt } = await publishWith({
    publisherModule: publisherModule('export default { publish: () => { for(;;){} } };'),
    timeoutMs: 400,
  });

  assert.equal(attempt.outcome, OUTCOME.FAILED);
  assert.equal(attempt.detail.failure, 'timeout');
  assert.ok(Date.now() - startedAt < 8000, 'the publisher must not outlive its budget');
});

test('REGRESSION: a publisher returning a malformed outcome produces a failed attempt', async () => {
  for (const body of [
    'export default { publish: async () => "done" };',
    'export default { publish: async () => ({}) };',
    'export default { publish: async () => ({ published: "yes" }) };',
    'export default { published: true };',
  ]) {
    const { attempt } = await publishWith({ publisherModule: publisherModule(body) });
    assert.equal(attempt.outcome, OUTCOME.FAILED, body);
    assert.ok(['malformed-result', 'exception'].includes(attempt.detail.failure), `${body} -> ${attempt.detail.failure}`);
  }
});

test('a publisher that declines produces a failed attempt carrying its reason', async () => {
  const { attempt } = await publishWith({
    publisherModule: publisherModule('export default { publish: async () => ({ published: false, reason: "the remote refused" }) };'),
  });

  assert.equal(attempt.outcome, OUTCOME.FAILED);
  assert.equal(attempt.detail.failure, 'publisher-declined');
  assert.match(attempt.reason, /the remote refused/);
});

// -- a failure changes nothing ----------------------------------------------------------

test('REGRESSION: after a failed publication the evidence and receipt are byte-identical', async () => {
  const evidence = evidenceFor();
  const { receipt } = grant({ evidence });

  const evidenceBefore = JSON.stringify(evidence);
  const receiptBefore = JSON.stringify(receipt);

  const failing = publisherModule('export default { publish: async () => { throw new Error("it broke"); } };');
  const { attempt, evidence: afterEvidence, receipt: afterReceipt } = await publish({
    evidence, receipt, currentCandidate: passingCandidate(), publisherModule: failing, attemptNumber: 1,
  });

  assert.equal(attempt.outcome, OUTCOME.FAILED);
  assert.equal(JSON.stringify(afterEvidence), evidenceBefore, 'the evidence must not change');
  assert.equal(JSON.stringify(afterReceipt), receiptBefore, 'nor the receipt');
  assert.equal(evidenceIntact(afterEvidence), true);
  assert.equal(receiptIntact(afterReceipt), true);
  assert.equal(afterEvidence.gateStatus, STATUS.PASS, 'a publishing failure does not turn the gate into a FAIL');
});

test('REGRESSION: a second attempt is a separate artifact beside the first', async () => {
  const evidence = evidenceFor();
  const { receipt } = grant({ evidence });
  const failing = publisherModule('export default { publish: async () => { throw new Error("first time"); } };');

  const first = await publish({ evidence, receipt, currentCandidate: passingCandidate(), publisherModule: failing, attemptNumber: 1 });
  const second = await publish({ evidence, receipt, currentCandidate: passingCandidate(), publisherModule: RECORDING_PUBLISHER, attemptNumber: 2 });

  assert.equal(first.attempt.outcome, OUTCOME.FAILED);
  assert.equal(second.attempt.outcome, OUTCOME.PUBLISHED);
  assert.notEqual(first.attempt.attemptId, second.attempt.attemptId, 'the attempts are distinct artifacts');
  assert.equal(first.attempt.attemptNumber, 1);
  assert.equal(second.attempt.attemptNumber, 2);
  assert.equal(first.attempt.receiptId, second.attempt.receiptId, 'both refer to the same authorization');
  assert.equal(validatePublication(first.attempt).valid, true);
  assert.equal(validatePublication(second.attempt).valid, true);
});

test('two attempts with the same number and the same outcome are the same artifact', async () => {
  const evidence = evidenceFor();
  const { receipt } = grant({ evidence });

  const first = await publish({ evidence, receipt, currentCandidate: passingCandidate(), publisherModule: RECORDING_PUBLISHER, attemptNumber: 1 });
  const again = await publish({ evidence, receipt, currentCandidate: passingCandidate(), publisherModule: RECORDING_PUBLISHER, attemptNumber: 1 });

  assert.equal(first.attempt.attemptId, again.attempt.attemptId, 'the attempt id follows what happened, not when');
});

test('publication completes no missing evidence', async () => {
  // The evidence is inconclusive; publishing cannot fill that in, and the
  // authorization it would need was never issued.
  const inconclusive = evidenceFor(makeResult({
    status: STATUS.UNKNOWN,
    checks: [{ id: 'a.one', status: STATUS.UNKNOWN, required: true, reason: 'could not conclude' }],
  }));

  const { authorized, receipt } = grant({ evidence: inconclusive });
  assert.equal(authorized, false);

  const { attempt, evidence: after } = await publish({
    evidence: inconclusive, receipt, currentCandidate: passingCandidate(), publisherModule: RECORDING_PUBLISHER,
  });

  assert.equal(attempt.outcome, OUTCOME.REFUSED);
  assert.deepEqual(after.verifications.inconclusive.map((entry) => entry.id), ['a.one'], 'still inconclusive afterwards');
  assert.equal(unsatisfiedRequirements(after).length, 1);
});
