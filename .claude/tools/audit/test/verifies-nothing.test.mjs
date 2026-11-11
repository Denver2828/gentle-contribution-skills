// ASTRA-04: evidence that verifies nothing must not authorise anything.
//
// The engine already knows the rule: `aggregate([])` is UNKNOWN, and README
// says "A gate with no required checks is UNKNOWN, not PASS. A gate that
// verifies nothing must not authorise anything." But the rule lived only in
// the engine. A gate result whose `status` had been set to PASS by hand, with
// `checks: []`, went through the supported pipeline untouched: the evidence
// helper copied the status, `record-evidence` admitted the record, and
// `authorize` minted a receipt, because "every required check reached PASS"
// is vacuously true of zero required checks (Astra corroboration, 2026-09-05,
// LOW: no honest input reaches it, `audit.mjs check` never emits that status).
//
// The rule is now replicated at every boundary that trusts a caller-authored
// status: the evidence record derives the gate status from its own
// verifications, and the helper, the store's admission and the receipt each
// refuse a record whose claimed status is not what its verifications
// aggregate to. Zero required checks aggregate to UNKNOWN, so they refuse.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { openStore, StoreError } from '../lib/store/store.mjs';
import { bodyDigest } from '../lib/ticket.mjs';
import { buildEvidence, derivedGateStatus } from '../lib/evidence-record.mjs';
import { authorize } from '../lib/authorization.mjs';
import { aggregate, STATUS } from '../lib/status.mjs';
import { REQUIRED_SOURCES, READING, CONTRIBUTION } from '../lib/intake.mjs';
import { completeCoverage, auditorResult, TASK_CONTRACT } from './helpers/documents.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_HELPER = join(HERE, '..', '..', '..', 'skills', 'gentle-ai-aporte', 'scripts', 'evidence.mjs');

const scratch = mkdtempSync(join(tmpdir(), 'audit-verifies-nothing-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const id = (character) => `sha256:${character.repeat(64)}`;
const CANDIDATE = id('c');
const REPO = 'Gentleman-Programming/gentle-ai';
const BODY = 'body\n';
const PUBLICATION = { operation: 'issue-comment', targetRepo: REPO, targetNumber: 1, bodySha256: bodyDigest(BODY), titleSha256: null, dependsOn: [] };
const BINDING = { snapshotHash: CANDIDATE, snapshotHashAfter: CANDIDATE, stable: true, policyHash: id('7'), toolVersion: '0.1.0', decisionId: id('9') };
const INTAKE = {
  repository: REPO, contributionType: CONTRIBUTION.ISSUE, competing: [],
  readings: REQUIRED_SOURCES.map((source) => ({ source, command: `${source} --repo ${REPO}`, result: READING.COMPLETE, matches: 0, reviewed: false, coverage: completeCoverage({ source }) })),
};

const REQUIRED_PASS = { id: 'a.one', status: STATUS.PASS, required: true, reason: 'ok' };
const OPTIONAL_PASS = { id: 'opt', status: STATUS.PASS, required: false, reason: 'optional' };
const REQUIRED_FAIL = { id: 'a.two', status: STATUS.FAIL, required: true, reason: 'broken' };

const resultWith = (checks, status = STATUS.PASS) => ({
  gate: 'preflight', status, binding: BINDING, checks,
  summary: { pass: checks.filter((c) => c.status === STATUS.PASS).length, fail: checks.filter((c) => c.status === STATUS.FAIL).length, unknown: 0, notRun: 0 },
});
const evidenceWith = (checks, status = STATUS.PASS) => buildEvidence({ result: resultWith(checks, status), candidate: { status: STATUS.PASS, candidateId: CANDIDATE, reason: 'identified' } });
const grant = (evidence) => authorize({ evidence, publication: PUBLICATION });

function auditedStore() {
  const api = openStore({ override: mkdtempSync(join(scratch, 'store-')), allowOutsideWorkspace: true, lockOptions: { waitMs: 4000 } });
  const frozen = api.freeze({
    lineage: 'zero-checks', candidateId: CANDIDATE, intake: INTAKE, taskContract: TASK_CONTRACT,
    baseTree: 'abc', candidateTree: 'def', pathsDigest: id('1'), draftDigest: id('2'), policyDigest: id('3'), testManifestDigest: id('4'),
    draftBodySha256: bodyDigest(BODY),
  });
  api.recordAudit({ lineage: 'zero-checks', result: auditorResult(frozen.subject_id, 'PASS') });
  return { api, subjectId: frozen.subject_id };
}
const refusal = (failure) => (error) => error instanceof StoreError && error.detail?.failure === failure;

// -- the record knows what its own verifications say ----------------------------------------

test('the evidence record derives its gate status from its verifications, exactly like the engine', () => {
  assert.equal(derivedGateStatus(evidenceWith([REQUIRED_PASS])), STATUS.PASS);
  assert.equal(derivedGateStatus(evidenceWith([REQUIRED_PASS, OPTIONAL_PASS])), STATUS.PASS);
  assert.equal(derivedGateStatus(evidenceWith([], STATUS.UNKNOWN)), STATUS.UNKNOWN);
  assert.equal(derivedGateStatus(evidenceWith([OPTIONAL_PASS], STATUS.UNKNOWN)), STATUS.UNKNOWN);
  assert.equal(derivedGateStatus(evidenceWith([REQUIRED_PASS, REQUIRED_FAIL], STATUS.FAIL)), STATUS.FAIL);
  assert.equal(derivedGateStatus(evidenceWith([{ id: 'u', status: STATUS.UNKNOWN, required: true, reason: '?' }], STATUS.UNKNOWN)), STATUS.UNKNOWN);
  assert.equal(derivedGateStatus(evidenceWith([{ id: 'n', status: STATUS.NOT_RUN, required: true, reason: 'skipped' }], STATUS.NOT_RUN)), STATUS.NOT_RUN);
  // and it agrees with the engine on the empty gate
  assert.equal(derivedGateStatus(evidenceWith([], STATUS.UNKNOWN)), aggregate([]).status);
});

// -- the receipt ---------------------------------------------------------------------------------

test('CONTROL: one required PASS still authorises', () => {
  assert.equal(grant(evidenceWith([REQUIRED_PASS])).authorized, true);
});

test('REGRESSION (ASTRA-04): PASS evidence with zero checks authorises nothing, and the refusal names the rule', () => {
  const outcome = grant(evidenceWith([]));
  assert.equal(outcome.authorized, false);
  assert.equal(outcome.receipt, null);
  assert.match(outcome.refusals.join('\n'), /verifies nothing/);
  assert.match(outcome.refusals.join('\n'), /PASS.*UNKNOWN/);
});

test('REGRESSION (ASTRA-04): PASS evidence whose only checks are optional authorises nothing', () => {
  const outcome = grant(evidenceWith([OPTIONAL_PASS]));
  assert.equal(outcome.authorized, false);
  assert.match(outcome.refusals.join('\n'), /verifies nothing/);
});

test('REGRESSION (ASTRA-04): a claimed PASS that its own verifications contradict is refused as a contradiction, not only as a FAIL', () => {
  const outcome = grant(evidenceWith([REQUIRED_PASS, REQUIRED_FAIL], STATUS.PASS));
  assert.equal(outcome.authorized, false);
  assert.match(outcome.refusals.join('\n'), /PASS.*aggregate to FAIL/);
});

// -- the store's admission -------------------------------------------------------------------

test('REGRESSION (ASTRA-04): record-evidence refuses a PASS record with zero required verifications', () => {
  const { api } = auditedStore();
  assert.throws(() => api.recordEvidence({ lineage: 'zero-checks', evidence: evidenceWith([]) }), refusal('evidence-verifies-nothing'));
  assert.throws(() => api.recordEvidence({ lineage: 'zero-checks', evidence: evidenceWith([REQUIRED_PASS, REQUIRED_FAIL], STATUS.PASS) }), refusal('evidence-verifies-nothing'));
  assert.equal(api.status('zero-checks').evidenceId, null);
});

test('CONTROL: record-evidence still admits a consistent record, PASS or not', () => {
  const { api } = auditedStore();
  api.recordEvidence({ lineage: 'zero-checks', evidence: evidenceWith([REQUIRED_PASS, REQUIRED_FAIL], STATUS.FAIL) });
  assert.notEqual(api.status('zero-checks').evidenceId, null);
  const { api: other } = auditedStore();
  other.recordEvidence({ lineage: 'zero-checks', evidence: evidenceWith([REQUIRED_PASS]) });
  assert.equal(other.authorize({ lineage: 'zero-checks', publication: PUBLICATION }).state, 'AUTHORIZED');
});

// -- the helper that turns a gate result into evidence ------------------------------------------

function runHelper(gateResult, subjectId) {
  const gatePath = join(scratch, `gate-${Date.now()}-${Math.random()}.json`);
  const reasonPath = join(scratch, 'reason.txt');
  const outPath = join(scratch, `evidence-${Date.now()}-${Math.random()}.json`);
  writeFileSync(gatePath, JSON.stringify(gateResult));
  writeFileSync(reasonPath, `reason for ${subjectId}\n`);
  return spawnSync(process.execPath, [EVIDENCE_HELPER, '--gate-result', gatePath, '--subject-id', subjectId, '--reason-file', reasonPath, '--out', outPath], { encoding: 'utf8' });
}

test('REGRESSION (ASTRA-04): the evidence helper refuses a gate result whose status is not what its checks aggregate to', () => {
  const { subjectId } = auditedStore();
  const edited = runHelper(resultWith([], STATUS.PASS), subjectId);
  assert.equal(edited.status, 1, edited.stderr);
  assert.match(edited.stderr, /aggregate to UNKNOWN/);
  const engine = runHelper(resultWith([], aggregate([]).status), subjectId);
  assert.equal(engine.status, 0, engine.stderr);
  const honest = runHelper(resultWith([REQUIRED_PASS]), subjectId);
  assert.equal(honest.status, 0, honest.stderr);
});
