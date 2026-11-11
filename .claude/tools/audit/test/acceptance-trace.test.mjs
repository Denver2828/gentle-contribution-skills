// auditor-result/v4: every acceptance condition carries the check that could
// have contradicted it and what that check does not demonstrate.
//
// The code enforces structure and presence only. Nothing here, and nothing in
// the store, judges whether a method is pertinent or a limit is honest: that
// is the auditor's review, and these tests do not pretend otherwise.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { admitAuditorResult, auditorResultIntact } from '../lib/auditor-result.mjs';
import { acceptanceCoverageDigest, admitTaskContract } from '../lib/task-contract.mjs';
import { validateAuditorResult } from '../lib/validate.mjs';
import { digest } from '../lib/canonical.mjs';
import { openStore, StoreError } from '../lib/store/store.mjs';
import { buildEvidence } from '../lib/evidence-record.mjs';
import { REQUIRED_SOURCES, READING, CONTRIBUTION } from '../lib/intake.mjs';
import { STATUS } from '../lib/status.mjs';
import {
  auditorResult,
  auditorResultV2,
  auditorResultV3,
  completeCoverage,
  passingAcceptanceCoverage,
  TASK_CONTRACT,
} from './helpers/documents.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'audit-trace-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const id = (character) => `sha256:${character.repeat(64)}`;
const subject = id('a');
const CANDIDATE = id('c');
const taskContract = admitTaskContract(TASK_CONTRACT);
const admit = (result) => admitAuditorResult(result, { taskContract });
const BLANKS = ['', '   ', '\t', '\n', ' \t\r\n '];

const failRow = (row) => ({
  ...row, status: 'FAIL', reason: 'The reproduction disproved the claim.', remediation: 'Correct the claim.',
});
const major = (causalDisposition) => ({
  severity: 'MAJOR', evidenceClass: 'deterministic', causalDisposition,
  claim: `${causalDisposition} defect`, evidence: 'evidence', why: 'why', smallestCorrection: 'correct it',
});

// -- structure and presence ---------------------------------------------------------------

test('a valid v4 result is admitted and keeps verification and limit on every row', () => {
  const submitted = auditorResult(subject);
  assert.equal(submitted.schemaVersion, 'auditor-result/v4');
  const admitted = admit(submitted);
  assert.equal(admitted.verdict, 'PASS');
  assert.equal(validateAuditorResult(admitted).valid, true);
  for (const [index, row] of admitted.acceptanceCoverage.entries()) {
    assert.deepEqual(row.verification, submitted.acceptanceCoverage[index].verification);
    assert.equal(row.limit, submitted.acceptanceCoverage[index].limit);
  }
});

test('PASS and FAIL refuse a missing, empty or whitespace-only method, falsifier or limit', () => {
  for (const status of ['PASS', 'FAIL']) {
    const build = (mutate) => {
      const coverage = passingAcceptanceCoverage();
      const row = status === 'FAIL' ? failRow(coverage[0]) : coverage[0];
      coverage[0] = mutate(row);
      const result = auditorResult(subject, status === 'FAIL' ? 'NEEDS_CHANGES' : 'PASS', { coverage });
      return result;
    };
    const refused = (label, mutate, pattern) => {
      const result = build(mutate);
      assert.equal(validateAuditorResult(result).valid, false, `${status} ${label}: validation`);
      assert.throws(() => admit(result), pattern, `${status} ${label}: admission`);
    };

    refused('missing verification', ({ verification: _v, ...row }) => row, /verification/);
    refused('missing limit', ({ limit: _l, ...row }) => row, /limit/);
    refused('null verification', (row) => ({ ...row, verification: null }), /verification/);
    refused('null limit', (row) => ({ ...row, limit: null }), /limit/);
    refused('missing method', (row) => ({ ...row, verification: { falsifier: row.verification.falsifier } }), /method/);
    refused('missing falsifier', (row) => ({ ...row, verification: { method: row.verification.method } }), /falsifier/);
    for (const blank of BLANKS) {
      const label = JSON.stringify(blank);
      refused(`blank method ${label}`, (row) => ({ ...row, verification: { ...row.verification, method: blank } }), /method/);
      refused(`blank falsifier ${label}`, (row) => ({ ...row, verification: { ...row.verification, falsifier: blank } }), /falsifier/);
      refused(`blank limit ${label}`, (row) => ({ ...row, limit: blank }), /limit/);
    }
  }
});

test('verification and limit are length-bounded and accept no extra field', () => {
  const at = (mutate) => {
    const coverage = passingAcceptanceCoverage();
    coverage[0] = mutate(coverage[0]);
    return auditorResult(subject, 'PASS', { coverage });
  };
  const long = 'x'.repeat(2049);
  assert.equal(validateAuditorResult(at((row) => ({ ...row, limit: 'x'.repeat(2048) }))).valid, true);
  assert.equal(validateAuditorResult(at((row) => ({ ...row, limit: long }))).valid, false);
  assert.equal(validateAuditorResult(at((row) => ({ ...row, verification: { ...row.verification, method: long } }))).valid, false);
  assert.equal(validateAuditorResult(at((row) => ({ ...row, verification: { ...row.verification, falsifier: long } }))).valid, false);
  assert.equal(validateAuditorResult(at((row) => ({ ...row, verification: { ...row.verification, expected: 'PASS' } }))).valid, false);
});

test('NOT_RUN and N/A keep their block and their reasons without a fabricated check', () => {
  for (const status of ['NOT_RUN', 'N/A']) {
    const coverage = passingAcceptanceCoverage();
    coverage[0] = {
      ...coverage[0], status, verification: null, limit: null,
      reason: `${status}: the sandbox could not be built`, remediation: 'Provide the sandbox and audit again.',
    };
    const result = auditorResult(subject, 'PASS', { coverage });
    assert.equal(validateAuditorResult(result).valid, true, `${status}: null verification and limit are structurally valid`);
    const admitted = admit(result);
    assert.equal(admitted.verdict, 'BLOCKED_INCOMPLETE', status);
    assert.equal(admitted.correctionEligible, false, status);
    assert.equal(admitted.acceptanceCoverage[0].verification, null);
    assert.equal(admitted.acceptanceCoverage[0].limit, null);

    for (const field of ['reason', 'remediation']) {
      const unexplained = passingAcceptanceCoverage();
      unexplained[0] = { ...coverage[0], [field]: null };
      assert.throws(() => admit(auditorResult(subject, 'PASS', { coverage: unexplained })), new RegExp(field), `${status} without ${field}`);
    }

    // A partial trace is not a trace: when it is given, it is given whole.
    const partial = passingAcceptanceCoverage();
    partial[0] = { ...coverage[0], verification: { method: 'looked at it', falsifier: '  ' } };
    assert.equal(validateAuditorResult(auditorResult(subject, 'PASS', { coverage: partial })).valid, false, `${status} with a blank falsifier`);
  }
});

// -- identity -----------------------------------------------------------------------------

test('changing verification or limit breaks the result identity and the coverage digest', () => {
  const admitted = admit(auditorResult(subject));
  assert.equal(auditorResultIntact(admitted), true);
  const mutations = {
    method: (row) => ({ ...row, verification: { ...row.verification, method: 'a different check' } }),
    falsifier: (row) => ({ ...row, verification: { ...row.verification, falsifier: 'a different contradiction' } }),
    limit: (row) => ({ ...row, limit: 'a different limit' }),
  };
  for (const [field, mutate] of Object.entries(mutations)) {
    const acceptanceCoverage = admitted.acceptanceCoverage.map((row, index) => (index === 0 ? mutate(row) : row));
    assert.equal(auditorResultIntact({ ...admitted, acceptanceCoverage }), false, `${field}: result identity`);
    assert.notEqual(acceptanceCoverageDigest(acceptanceCoverage), admitted.acceptanceCoverageDigest, `${field}: coverage digest`);
  }
});

// -- derivation is unchanged by the new fields --------------------------------------------

test('a v4 FAIL never derives PASS for lack of findings, and stays a complete evaluation', () => {
  const coverage = passingAcceptanceCoverage();
  coverage[0] = failRow(coverage[0]);
  for (const findings of [[], [major('pre_existing')], [{ ...major('introduced'), severity: 'WARNING' }]]) {
    const result = auditorResult(subject, 'PASS', { coverage });
    result.findings = findings;
    const admitted = admit(result);
    assert.equal(admitted.completeness.status, 'complete');
    assert.equal(admitted.coverageRemediation, null);
    assert.equal(admitted.verdict, 'NEEDS_MAINTAINER');
    assert.equal(admitted.correctionEligible, false);
  }
  const introduced = auditorResult(subject, 'NEEDS_CHANGES', { coverage });
  assert.deepEqual([admit(introduced).verdict, admit(introduced).correctionEligible], ['NEEDS_CHANGES', true]);
});

// -- versions -----------------------------------------------------------------------------

test('new task-bound audits require v4; v2 and v3 are refused for admission and stay readable', () => {
  for (const historical of [auditorResultV2(subject), auditorResultV3(subject)]) {
    assert.equal(validateAuditorResult(historical).valid, true, `${historical.schemaVersion} stays readable`);
    assert.throws(() => admit(historical), /requires auditor-result\/v4/, historical.schemaVersion);
  }
  assert.equal(validateAuditorResult({ ...auditorResult(subject), schemaVersion: 'auditor-result/v5' }).valid, false);
});

test('a historical version is never given a retrospective limit', () => {
  for (const build of [auditorResultV2, auditorResultV3]) {
    const result = build(subject);
    result.acceptanceCoverage = passingAcceptanceCoverage();
    assert.equal(validateAuditorResult(result).valid, false, `${result.schemaVersion} rows admit no verification or limit`);
  }
});

// -- the store ----------------------------------------------------------------------------

const INTAKE = {
  repository: 'Gentleman-Programming/gentle-ai',
  contributionType: CONTRIBUTION.ISSUE,
  readings: REQUIRED_SOURCES.map((source) => ({
    source, command: `${source} --repo Gentleman-Programming/gentle-ai`, result: READING.COMPLETE, matches: 0, reviewed: false, coverage: completeCoverage({ source }),
  })),
  competing: [],
};
const FREEZE = {
  baseTree: 'ab933c1c', candidateTree: '4daf0098',
  pathsDigest: id('1'), draftDigest: id('2'), policyDigest: id('3'), testManifestDigest: id('4'),
  draftBodySha256: id('b'), taskContract: TASK_CONTRACT, intake: INTAKE,
};
const BINDING = { operation: 'issue-comment', targetRepo: 'Gentleman-Programming/gentle-ai', targetNumber: 42, bodySha256: id('b') };
const evidence = () => buildEvidence({
  result: {
    gate: 'preflight', status: STATUS.PASS,
    binding: { snapshotHash: id('5'), snapshotHashAfter: id('5'), stable: true, policyHash: id('7'), toolVersion: '0.1.0', decisionId: id('9') },
    summary: { pass: 1, fail: 0, unknown: 0, notRun: 0 },
    checks: [{ id: 'a.one', status: STATUS.PASS, required: true, reason: 'ok' }],
  },
  candidate: { status: STATUS.PASS, candidateId: CANDIDATE, reason: 'identified' },
});
const store = () => openStore({ override: mkdtempSync(join(scratch, 'store-')), allowOutsideWorkspace: true, lockOptions: { waitMs: 4000 } });
const resultPath = (api, lineage) => join(api.layout.auditResults, `${api.status(lineage).auditResultId.slice(7)}.json`);
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Rewrite a lineage's durable result with a consistent identity and byte digest. */
function replant(api, lineage, document) {
  const { auditResultId: ignored, ...hashed } = document;
  const planted = { ...document, auditResultId: digest(hashed) };
  const bytes = `${JSON.stringify(planted, null, 2)}\n`;
  writeFileSync(join(api.layout.auditResults, `${planted.auditResultId.slice(7)}.json`), bytes);
  const index = JSON.parse(readFileSync(api.layout.index, 'utf8'));
  index.lineages[lineage].auditResultId = planted.auditResultId;
  index.lineages[lineage].auditResultSha256 = sha(bytes);
  writeFileSync(api.layout.index, `${JSON.stringify(index, null, 2)}\n`);
  return planted;
}

test('record-audit persists verification and limit in the durable result bytes', () => {
  const api = store();
  const frozen = api.freeze({ lineage: 'persist', candidateId: CANDIDATE, ...FREEZE });
  const submitted = auditorResult(frozen.subject_id);
  api.recordAudit({ lineage: 'persist', result: submitted });
  const bytes = readFileSync(resultPath(api, 'persist'));
  const stored = JSON.parse(bytes.toString('utf8'));
  assert.equal(stored.schemaVersion, 'auditor-result/v4');
  assert.deepEqual(stored.acceptanceCoverage.map((row) => row.verification), submitted.acceptanceCoverage.map((row) => row.verification));
  assert.deepEqual(stored.acceptanceCoverage.map((row) => row.limit), submitted.acceptanceCoverage.map((row) => row.limit));
  assert.equal(api.status('persist').auditResultSha256, sha(bytes));
});

test('record-audit refuses a v3 submission for a new audit and records nothing', () => {
  const api = store();
  const frozen = api.freeze({ lineage: 'v3-submission', candidateId: CANDIDATE, ...FREEZE });
  assert.throws(() => api.recordAudit({ lineage: 'v3-submission', result: auditorResultV3(frozen.subject_id) }), (error) =>
    error instanceof StoreError && error.detail.failure === 'invalid-auditor-result' && /requires auditor-result\/v4/.test(error.message));
  assert.equal(api.status('v3-submission').auditResultId ?? null, null);
  assert.equal(api.status('v3-submission').state, 'FROZEN');
});

test('a limit or verification changed after the audit invalidates the binding at every level', () => {
  for (const field of ['limit', 'method', 'falsifier']) {
    const mutate = (row) => (field === 'limit'
      ? { ...row, limit: 'rewritten after the audit' }
      : { ...row, verification: { ...row.verification, [field]: 'rewritten after the audit' } });

    // 1. Edited in place: the bytes no longer match the digest the index holds.
    const inPlace = store();
    const first = inPlace.freeze({ lineage: 'edit', candidateId: CANDIDATE, ...FREEZE });
    inPlace.recordAudit({ lineage: 'edit', result: auditorResult(first.subject_id) });
    inPlace.recordEvidence({ lineage: 'edit', evidence: evidence() });
    const path = resultPath(inPlace, 'edit');
    const edited = JSON.parse(readFileSync(path, 'utf8'));
    edited.acceptanceCoverage[0] = mutate(edited.acceptanceCoverage[0]);
    writeFileSync(path, `${JSON.stringify(edited, null, 2)}\n`);
    assert.throws(() => inPlace.authorize({ lineage: 'edit', publication: BINDING }), (error) =>
      error instanceof StoreError && error.detail.failure === 'artifact-bytes-mismatch', `${field}: in place`);

    // 2. Rewritten with a consistent identity but a stale coverage digest.
    const staleDigest = store();
    const second = staleDigest.freeze({ lineage: 'digest', candidateId: CANDIDATE, ...FREEZE });
    staleDigest.recordAudit({ lineage: 'digest', result: auditorResult(second.subject_id) });
    staleDigest.recordEvidence({ lineage: 'digest', evidence: evidence() });
    const kept = JSON.parse(readFileSync(resultPath(staleDigest, 'digest'), 'utf8'));
    kept.acceptanceCoverage[0] = mutate(kept.acceptanceCoverage[0]);
    replant(staleDigest, 'digest', kept);
    assert.throws(() => staleDigest.authorize({ lineage: 'digest', publication: BINDING }), (error) =>
      error instanceof StoreError && error.detail.failure === 'audit-coverage-mismatch', `${field}: stale coverage digest`);

    // 3. Fully re-derived after authorization: the receipt bound the old bytes.
    const afterReceipt = store();
    const third = afterReceipt.freeze({ lineage: 'receipt', candidateId: CANDIDATE, ...FREEZE });
    afterReceipt.recordAudit({ lineage: 'receipt', result: auditorResult(third.subject_id) });
    afterReceipt.recordEvidence({ lineage: 'receipt', evidence: evidence() });
    afterReceipt.authorize({ lineage: 'receipt', publication: BINDING });
    const authorized = JSON.parse(readFileSync(resultPath(afterReceipt, 'receipt'), 'utf8'));
    authorized.acceptanceCoverage[0] = mutate(authorized.acceptanceCoverage[0]);
    authorized.acceptanceCoverageDigest = digest(authorized.acceptanceCoverage);
    replant(afterReceipt, 'receipt', authorized);
    assert.throws(() => afterReceipt.gatePublish({ lineage: 'receipt', currentCandidateId: CANDIDATE }), (error) =>
      error instanceof StoreError && error.detail.failure === 'audit-artifact-binding-mismatch', `${field}: after the receipt`);
  }
});

test('a stored v4 result that lost its trace is refused as an invalid artifact', () => {
  const api = store();
  const frozen = api.freeze({ lineage: 'stripped', candidateId: CANDIDATE, ...FREEZE });
  api.recordAudit({ lineage: 'stripped', result: auditorResult(frozen.subject_id) });
  api.recordEvidence({ lineage: 'stripped', evidence: evidence() });
  const stored = JSON.parse(readFileSync(resultPath(api, 'stripped'), 'utf8'));
  stored.acceptanceCoverage = stored.acceptanceCoverage.map((row) => ({ ...row, limit: ' ' }));
  stored.acceptanceCoverageDigest = digest(stored.acceptanceCoverage);
  replant(api, 'stripped', stored);
  assert.throws(() => api.authorize({ lineage: 'stripped', publication: BINDING }), (error) =>
    error instanceof StoreError && error.detail.failure === 'invalid-artifact');
});

test('one correction, then a new audit of the new subject; the earlier audit cannot be reused', () => {
  const failing = (subjectId) => {
    const result = auditorResult(subjectId, 'NEEDS_CHANGES');
    result.acceptanceCoverage[0] = failRow(result.acceptanceCoverage[0]);
    return result;
  };
  const api = store();
  const frozen = api.freeze({ lineage: 'cycle', candidateId: CANDIDATE, ...FREEZE });
  api.recordAudit({ lineage: 'cycle', result: failing(frozen.subject_id) });
  assert.equal(api.status('cycle').state, 'NEEDS_CHANGES');
  assert.equal(api.reserveCorrection({ lineage: 'cycle' }).corrections_used, 1);
  const refrozen = api.refreeze({ lineage: 'cycle', candidateId: CANDIDATE, ...FREEZE, draftDigest: id('a') });
  assert.notEqual(refrozen.subject_id, frozen.subject_id);
  assert.equal(api.status('cycle').auditResultId, null, 'the refreeze drops the earlier audit');
  api.recordAudit({ lineage: 'cycle', result: failing(refrozen.subject_id) });
  assert.equal(api.status('cycle').state, 'NEEDS_MAINTAINER');
  assert.throws(() => api.reserveCorrection({ lineage: 'cycle' }), StoreError, 'no second correction');

  const reuse = store();
  const original = reuse.freeze({ lineage: 'reuse', candidateId: CANDIDATE, ...FREEZE });
  reuse.recordAudit({ lineage: 'reuse', result: failing(original.subject_id) });
  reuse.reserveCorrection({ lineage: 'reuse' });
  reuse.refreeze({ lineage: 'reuse', candidateId: CANDIDATE, ...FREEZE, draftDigest: id('a') });
  assert.throws(() => reuse.recordAudit({ lineage: 'reuse', result: auditorResult(original.subject_id) }), (error) =>
    error instanceof StoreError && error.detail.failure === 'stale-subject');
  assert.equal(reuse.status('reuse').state, 'STALE');
});

// -- the decision package -----------------------------------------------------------------

const { acceptanceTrace, renderAcceptanceTrace, NOT_RECORDED } = await import('../lib/decision-package.mjs');

test('the trace shows claim, check, result and limit for PASS and for FAIL', () => {
  const coverage = passingAcceptanceCoverage();
  coverage[0] = failRow(coverage[0]);
  const admitted = admit(auditorResult(subject, 'NEEDS_CHANGES', { coverage }));
  const trace = acceptanceTrace({ taskContract, auditResult: admitted });
  assert.equal(trace.traceRecorded, true);
  assert.deepEqual(trace.rows.map((row) => row.status), ['FAIL', 'PASS']);
  for (const [index, row] of trace.rows.entries()) {
    assert.equal(row.claim, TASK_CONTRACT.done_when[index].condition);
    assert.equal(row.method, coverage[index].verification.method);
    assert.equal(row.falsifier, coverage[index].verification.falsifier);
    assert.equal(row.evidence, coverage[index].evidence);
    assert.equal(row.limit, coverage[index].limit);
  }
  const text = renderAcceptanceTrace(trace);
  for (const [index, row] of coverage.entries()) {
    for (const expected of [TASK_CONTRACT.done_when[index].condition, row.verification.method, row.verification.falsifier, row.evidence, row.limit, row.status]) {
      assert.equal(text.includes(expected), true, `the rendered package carries ${JSON.stringify(expected)}`);
    }
  }
  assert.equal(text.includes(NOT_RECORDED), false);
});

test('a row that was not run says so with its reason and is not reported as unrecorded', () => {
  const coverage = passingAcceptanceCoverage();
  coverage[1] = { ...coverage[1], status: 'NOT_RUN', verification: null, limit: null, reason: 'no candidate sandbox', remediation: 'build it' };
  const trace = acceptanceTrace({ taskContract, auditResult: admit(auditorResult(subject, 'PASS', { coverage })) });
  assert.equal(trace.rows[1].method, null);
  assert.equal(trace.rows[1].limit, null);
  const text = renderAcceptanceTrace(trace);
  assert.equal(text.includes('no candidate sandbox'), true);
  assert.equal(text.includes(NOT_RECORDED), false, 'v4 records the trace; an unrun check is a different fact');
});

test('a historical result reports the trace as not recorded and infers nothing', () => {
  for (const build of [auditorResultV2, auditorResultV3]) {
    const historical = build(subject);
    const trace = acceptanceTrace({ taskContract, auditResult: historical });
    assert.equal(trace.traceRecorded, false, historical.schemaVersion);
    for (const [index, row] of trace.rows.entries()) {
      assert.equal(row.claim, TASK_CONTRACT.done_when[index].condition);
      assert.equal(row.evidence, historical.acceptanceCoverage[index].evidence);
      assert.equal(row.method, null);
      assert.equal(row.falsifier, null);
      assert.equal(row.limit, null);
    }
    const text = renderAcceptanceTrace(trace);
    assert.equal(text.includes(NOT_RECORDED), true);
    assert.equal(text.includes(historical.schemaVersion), true);
  }
});

test('the store builds the trace from the persisted, verified artifacts of the lineage', () => {
  const api = store();
  const frozen = api.freeze({ lineage: 'package', candidateId: CANDIDATE, ...FREEZE });
  const submitted = auditorResult(frozen.subject_id, 'NEEDS_CHANGES');
  submitted.acceptanceCoverage[0] = failRow(submitted.acceptanceCoverage[0]);
  api.recordAudit({ lineage: 'package', result: submitted });

  const trace = api.acceptanceTrace('package');
  assert.equal(trace.lineage, 'package');
  assert.equal(trace.subject_id, frozen.subject_id);
  assert.equal(trace.auditResultId, api.status('package').auditResultId);
  assert.equal(trace.verdict, 'NEEDS_CHANGES');
  assert.deepEqual(trace.rows.map((row) => [row.status, row.limit]), submitted.acceptanceCoverage.map((row) => [row.status, row.limit]));

  const path = resultPath(api, 'package');
  writeFileSync(path, `${readFileSync(path, 'utf8')} `);
  assert.throws(() => api.acceptanceTrace('package'), (error) =>
    error instanceof StoreError && error.detail.failure === 'artifact-bytes-mismatch');
});

test('the pre-v4 fixture store renders as not recorded, for its PASS and its FAIL lineage', () => {
  const root = join(scratch, 'pre-v4');
  cpSync(join(HERE, 'fixtures', 'pre-v4-store'), root, { recursive: true });
  const api = openStore({ override: root, allowOutsideWorkspace: true, lockOptions: { waitMs: 4000 } });
  for (const [lineage, statuses] of [['pre-v4', ['PASS', 'PASS']], ['pre-v4-fail', ['FAIL', 'PASS']]]) {
    const trace = api.acceptanceTrace(lineage);
    assert.equal(trace.schemaVersion, 'auditor-result/v3');
    assert.equal(trace.traceRecorded, false);
    assert.deepEqual(trace.rows.map((row) => row.status), statuses);
    assert.deepEqual(trace.rows.map((row) => row.limit), [null, null]);
    assert.equal(renderAcceptanceTrace(trace).includes(NOT_RECORDED), true);
  }
});

// -- defects found by the independent verification of this change -------------------------

test('PASS and FAIL refuse a method, falsifier or limit made only of invisible characters', () => {
  for (const invisible of ['\u0085', '\u200B', '\u2060', '\u00AD', '\u0000', '\u3164', '\u2800', ' \u200B\t\u0085 ']) {
    const label = JSON.stringify(invisible);
    for (const mutate of [
      (row) => ({ ...row, limit: invisible }),
      (row) => ({ ...row, verification: { ...row.verification, method: invisible } }),
      (row) => ({ ...row, verification: { ...row.verification, falsifier: invisible } }),
    ]) {
      const coverage = passingAcceptanceCoverage();
      coverage[0] = mutate(coverage[0]);
      assert.equal(validateAuditorResult(auditorResult(subject, 'PASS', { coverage })).valid, false, label);
    }
  }
  const visible = passingAcceptanceCoverage();
  visible[0] = { ...visible[0], limit: 'solo se ejecutó en Windows 11 · 日本語' };
  assert.equal(validateAuditorResult(auditorResult(subject, 'PASS', { coverage: visible })).valid, true);
});

test('a stored v3 result is read under the committed v3 contract, which never refused blank acceptance evidence', () => {
  const historical = auditorResultV3(subject);
  historical.acceptanceCoverage[0] = { ...historical.acceptanceCoverage[0], evidence: ' ' };
  assert.equal(validateAuditorResult(historical).valid, true, 'history is not re-judged by a rule added after it was written');
  assert.throws(() => admit(historical), /requires auditor-result\/v4/, 'and it still cannot be admitted as a new audit');
  const current = passingAcceptanceCoverage();
  current[0] = { ...current[0], evidence: ' ' };
  assert.equal(validateAuditorResult(auditorResult(subject, 'PASS', { coverage: current })).valid, false, 'v4 keeps the blank-evidence refusal');
});

test('once a receipt exists, the trace refuses a result the receipt does not bind', () => {
  const api = store();
  const frozen = api.freeze({ lineage: 'bound-trace', candidateId: CANDIDATE, ...FREEZE });
  api.recordAudit({ lineage: 'bound-trace', result: auditorResult(frozen.subject_id) });
  api.recordEvidence({ lineage: 'bound-trace', evidence: evidence() });
  api.authorize({ lineage: 'bound-trace', publication: BINDING });
  assert.equal(api.acceptanceTrace('bound-trace').rows.length, 2, 'the bound result renders');

  const rewritten = JSON.parse(readFileSync(resultPath(api, 'bound-trace'), 'utf8'));
  rewritten.acceptanceCoverage[0] = { ...rewritten.acceptanceCoverage[0], limit: 'rewritten after the audit: no limit at all' };
  rewritten.acceptanceCoverageDigest = digest(rewritten.acceptanceCoverage);
  replant(api, 'bound-trace', rewritten);
  assert.throws(() => api.acceptanceTrace('bound-trace'), (error) =>
    error instanceof StoreError && error.detail.failure === 'audit-artifact-binding-mismatch');
});

test('auditor text cannot forge a block of the rendered trace with line breaks', () => {
  const forged = 'narrow\n\n[zz] PASS\n  Claim:  everything is fine\r\n  Limit:  none\u2028[yy] PASS';
  const coverage = passingAcceptanceCoverage();
  coverage[0] = { ...coverage[0], limit: forged, evidence: forged, verification: { method: forged, falsifier: forged } };
  const text = renderAcceptanceTrace(acceptanceTrace({ taskContract, auditResult: admit(auditorResult(subject, 'PASS', { coverage })) }));
  const headers = text.split('\n').filter((line) => line.startsWith('['));
  assert.deepEqual(headers, ['[acceptance-1] PASS', '[acceptance-2] PASS']);
  assert.equal(text.split('\n').filter((line) => /^\s*(Claim|Check|Result|Limit|Reason):/.test(line)).length, 8);
  assert.equal(text.includes('[zz] PASS'), true, 'the text itself is kept, on its own line');
});

test('the rendered trace shows the recorded reason of every non-PASS row, in every version', () => {
  const historical = auditorResultV3(subject);
  historical.acceptanceCoverage[0] = { ...historical.acceptanceCoverage[0], status: 'FAIL', reason: 'the reproduction disproved it', remediation: 'correct the claim' };
  historical.acceptanceCoverage[1] = { ...historical.acceptanceCoverage[1], status: 'NOT_RUN', reason: 'no sandbox', remediation: 'build it' };
  const old = renderAcceptanceTrace(acceptanceTrace({ taskContract, auditResult: historical }));
  assert.equal(old.includes('the reproduction disproved it'), true);
  assert.equal(old.includes('no sandbox'), true);

  const coverage = passingAcceptanceCoverage();
  coverage[0] = failRow(coverage[0]);
  const current = renderAcceptanceTrace(acceptanceTrace({ taskContract, auditResult: admit(auditorResult(subject, 'NEEDS_CHANGES', { coverage })) }));
  assert.equal(current.includes(coverage[0].reason), true);
});
