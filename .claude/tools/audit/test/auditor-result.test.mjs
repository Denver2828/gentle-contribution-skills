import test from 'node:test';
import assert from 'node:assert/strict';
import { admitAuditorResult, auditorResultIntact, deriveAuditDecision } from '../lib/auditor-result.mjs';
import { admitTaskContract } from '../lib/task-contract.mjs';
import { validateAuditorResult } from '../lib/validate.mjs';
import {
  assessedDesignCoverage,
  auditorResult,
  auditorResultV2,
  auditorResultV3,
  historicalAuditorResult,
  legacyAcceptanceCoverage,
  maintainerDecision,
  passingAcceptanceCoverage,
  TASK_CONTRACT,
} from './helpers/documents.mjs';

const subject = `sha256:${'a'.repeat(64)}`;
const taskContract = admitTaskContract(TASK_CONTRACT);
const admit = (result) => admitAuditorResult(result, { taskContract });

test('native admission derives verdict, correction eligibility and content identity', () => {
  const admitted = admit(auditorResult(subject, 'NEEDS_CHANGES'));
  assert.equal(admitted.verdict, 'NEEDS_CHANGES');
  assert.equal(admitted.correctionEligible, true);
  assert.equal(auditorResultIntact(admitted), true);
  assert.equal(auditorResultIntact({ ...admitted, recommendation: 'changed' }), false);
});

test('caller cannot supply verdict, identity or correction eligibility', () => {
  for (const override of [{ verdict: 'PASS' }, { correctionEligible: true }, { auditResultId: `sha256:${'b'.repeat(64)}` }]) {
    assert.throws(() => admit({ ...auditorResult(subject), ...override }), /forbidden/);
  }
});

test('causal admission distinguishes candidate defects, external uncertainty and history', () => {
  assert.equal(admit(auditorResult(subject, 'PASS')).verdict, 'PASS');
  assert.equal(admit(auditorResult(subject, 'NEEDS_MAINTAINER')).verdict, 'NEEDS_MAINTAINER');
  assert.equal(admit(auditorResult(subject, 'BLOCKED_INCOMPLETE')).verdict, 'BLOCKED_INCOMPLETE');
  const historical = auditorResult(subject);
  historical.findings = [{ severity: 'BLOCKER', evidenceClass: 'observed', causalDisposition: 'pre_existing', claim: 'old defect', evidence: 'base', why: 'not caused here', smallestCorrection: 'follow up separately' }];
  assert.equal(admit(historical).verdict, 'PASS');
});

test('historical v1 results remain readable only through the explicit historical path', () => {
  const historical = historicalAuditorResult(subject);
  const admitted = admitAuditorResult(historical);
  assert.equal(admitted.schemaVersion, 'auditor-result/v1');
  assert.equal(admitted.verdict, 'PASS');
  assert.throws(() => admitAuditorResult(historical, { taskContract }), /requires auditor-result\/v4/);
  assert.throws(() => admitAuditorResult(auditorResult(subject)), /requires the accepted task contract/);
});

// -- auditor-result/v3: maintainer decisions and design coverage --------------------------

const major = (causalDisposition) => ({
  severity: 'MAJOR', evidenceClass: 'deterministic', causalDisposition,
  claim: `${causalDisposition} defect`, evidence: 'evidence', why: 'why', smallestCorrection: 'correct it',
});

test('new task-bound audits require v4; v2 and v3 are refused for admission but stay readable', () => {
  for (const historical of [auditorResultV2(subject), auditorResultV3(subject)]) {
    assert.throws(() => admit(historical), /requires auditor-result\/v4/, historical.schemaVersion);
    assert.equal(validateAuditorResult(historical).valid, true, historical.schemaVersion);
  }
  const { designCoverage: _d, ...missingDesign } = auditorResult(subject);
  assert.equal(validateAuditorResult(missingDesign).valid, false);
  const { maintainerDecisions: _m, ...missingDecisions } = auditorResult(subject);
  assert.equal(validateAuditorResult(missingDecisions).valid, false);
});

test('reproduced case: five introduced MAJOR findings plus a pending decision route to the maintainer', () => {
  const result = auditorResult(subject, 'PASS', { maintainerDecisions: [maintainerDecision('introduced')] });
  result.findings = Array.from({ length: 5 }, () => major('introduced'));
  const admitted = admit(result);
  assert.equal(admitted.verdict, 'NEEDS_MAINTAINER');
  assert.equal(admitted.correctionEligible, false);
  assert.equal(admitted.maintainerDecisions[0].causalDisposition, 'introduced');
});

test('reproduced case: empty design coverage cannot PASS', () => {
  const admitted = admit(auditorResult(subject, 'PASS', { designCoverage: [] }));
  assert.equal(admitted.verdict, 'BLOCKED_INCOMPLETE');
  assert.equal(admitted.correctionEligible, false);
  assert.match(admitted.completeness.reason, /design coverage/);
});

test('a pending decision blocks PASS and correction regardless of its true causality', () => {
  for (const causality of ['introduced', 'pre_existing', 'external', 'unknown']) {
    const admitted = admit(auditorResult(subject, 'PASS', { maintainerDecisions: [maintainerDecision(causality)] }));
    assert.equal(admitted.verdict, 'NEEDS_MAINTAINER', causality);
    assert.equal(admitted.correctionEligible, false, causality);
  }
});

test('incompleteness takes precedence over a pending decision', () => {
  const decisions = [maintainerDecision()];
  const incompleteDesign = assessedDesignCoverage().slice(1);
  const failingAcceptance = passingAcceptanceCoverage();
  failingAcceptance[0] = { ...failingAcceptance[0], status: 'NOT_RUN', reason: 'not run', remediation: 'run it' };
  const cases = [
    ['design gap', auditorResult(subject, 'PASS', { designCoverage: incompleteDesign, maintainerDecisions: decisions })],
    ['acceptance gap', auditorResult(subject, 'PASS', { coverage: failingAcceptance, maintainerDecisions: decisions })],
    ['declared incomplete', auditorResult(subject, 'BLOCKED_INCOMPLETE', { maintainerDecisions: decisions })],
  ];
  for (const [label, result] of cases) {
    const admitted = admit(result);
    assert.equal(admitted.verdict, 'BLOCKED_INCOMPLETE', label);
    assert.equal(admitted.correctionEligible, false, label);
    assert.equal(admitted.maintainerDecisions.length, 1, `${label}: the decision is preserved, not dropped`);
  }
});

test('design coverage: each aspect exactly once; material not_assessed blocks PASS; immaterial does not', () => {
  const base = assessedDesignCoverage();
  const duplicate = [...base, { ...base[0] }];
  assert.equal(admit(auditorResult(subject, 'PASS', { designCoverage: duplicate })).verdict, 'BLOCKED_INCOMPLETE');

  const material = assessedDesignCoverage();
  material[2] = { ...material[2], status: 'not_assessed', justification: 'no runnable build', material: true };
  const blocked = admit(auditorResult(subject, 'PASS', { designCoverage: material }));
  assert.equal(blocked.verdict, 'BLOCKED_INCOMPLETE');
  assert.match(blocked.completeness.reason, /design\.user-qol/);

  const residual = assessedDesignCoverage();
  residual[2] = { ...residual[2], status: 'not_assessed', justification: 'no runnable build; impact bounded to wording', material: false };
  assert.equal(admit(auditorResult(subject, 'PASS', { designCoverage: residual })).verdict, 'PASS');

  const notApplicable = assessedDesignCoverage();
  notApplicable[6] = { ...notApplicable[6], status: 'not_applicable', justification: 'comment-only candidate ships no product surface' };
  assert.equal(admit(auditorResult(subject, 'PASS', { designCoverage: notApplicable })).verdict, 'PASS');
});

test('design coverage declarations are refused when their required fields are missing', () => {
  const cases = [
    ['not_applicable without justification', { status: 'not_applicable', justification: null, material: null }, /justification/],
    ['not_assessed without materiality', { status: 'not_assessed', justification: 'no build', material: null }, /material/],
    ['not_assessed without justification', { status: 'not_assessed', justification: ' ', material: false }, /justification/],
    ['assessed declaring materiality', { status: 'assessed', justification: null, material: true }, /material/],
  ];
  for (const [label, patch, pattern] of cases) {
    const designCoverage = assessedDesignCoverage();
    designCoverage[0] = { ...designCoverage[0], ...patch };
    assert.throws(() => admit(auditorResult(subject, 'PASS', { designCoverage })), pattern, label);
  }
  const unknownAspect = assessedDesignCoverage();
  unknownAspect[0] = { ...unknownAspect[0], aspect: 'design.taste' };
  assert.throws(() => admit(auditorResult(subject, 'PASS', { designCoverage: unknownAspect })), /violates/);
});

test('v3 precedence below decisions is unchanged: external severe, then introduced severe, then PASS', () => {
  const ext = auditorResult(subject);
  ext.findings = [major('introduced'), major('external')];
  assert.equal(admit(ext).verdict, 'NEEDS_MAINTAINER');
  const intro = auditorResult(subject);
  intro.findings = [major('introduced')];
  assert.deepEqual([admit(intro).verdict, admit(intro).correctionEligible], ['NEEDS_CHANGES', true]);
  assert.equal(admit(auditorResult(subject)).verdict, 'PASS');
});

test('v3 decisions and design coverage are part of the durable result identity', () => {
  const admitted = admit(auditorResult(subject, 'PASS', { maintainerDecisions: [maintainerDecision()] }));
  assert.equal(auditorResultIntact(admitted), true);
  assert.equal(auditorResultIntact({ ...admitted, maintainerDecisions: [] }), false);
  assert.equal(auditorResultIntact({ ...admitted, designCoverage: admitted.designCoverage.slice(1) }), false);
});

test('admission refuses unknown versions, loose declarations and unbounded lists', () => {
  assert.throws(() => admit({ ...auditorResult(subject), schemaVersion: 'auditor-result/v5' }), /expected constant "auditor-result\/v4"/);
  assert.equal(validateAuditorResult({ ...auditorResult(subject), schemaVersion: 'auditor-result/v5' }).valid, false);

  const assessedWithJustification = assessedDesignCoverage();
  assessedWithJustification[0] = { ...assessedWithJustification[0], justification: 'why' };
  assert.throws(() => admit(auditorResult(subject, 'PASS', { designCoverage: assessedWithJustification })), /justification must be null/);

  const sameOptions = { ...maintainerDecision(), options: ['keep it', ' keep it'] };
  assert.throws(() => admit(auditorResult(subject, 'PASS', { maintainerDecisions: [sameOptions] })), /distinct options/);
  assert.throws(() => admit(auditorResult(subject, 'PASS', { maintainerDecisions: [{ ...maintainerDecision(), options: ['only one'] }] })), /violates/);

  const tooMany = Array.from({ length: 21 }, () => maintainerDecision());
  assert.throws(() => admit(auditorResult(subject, 'PASS', { maintainerDecisions: tooMany })), /at most 20/);
  const manyOptions = { ...maintainerDecision(), options: Array.from({ length: 11 }, (_, index) => `option ${index}`) };
  assert.throws(() => admit(auditorResult(subject, 'PASS', { maintainerDecisions: [manyOptions] })), /at most 10/);
  const manyRows = Array.from({ length: 51 }, () => assessedDesignCoverage()[0]);
  assert.throws(() => admit(auditorResult(subject, 'PASS', { designCoverage: manyRows })), /at most 50/);
});

test('whitespace-only text is refused in design evidence and in every decision field', () => {
  for (const blankText of ['   ', '\t', '\n', ' \t\r\n ']) {
    const label = JSON.stringify(blankText);
    const allBlank = assessedDesignCoverage().map((row) => ({ ...row, evidence: blankText }));
    assert.throws(() => admit(auditorResult(subject, 'PASS', { designCoverage: allBlank })), /non-blank evidence/, `${label}: assessed evidence`);

    const notApplicable = assessedDesignCoverage();
    notApplicable[0] = { ...notApplicable[0], status: 'not_applicable', justification: 'no product surface', evidence: blankText };
    assert.throws(() => admit(auditorResult(subject, 'PASS', { designCoverage: notApplicable })), /non-blank evidence/, `${label}: not_applicable evidence`);

    for (const [field, patch, pattern] of [
      ['decision', { decision: blankText }, /state what is to be decided/],
      ['evidence', { evidence: blankText }, /non-blank evidence/],
      ['option', { options: [blankText, 'real option'] }, /option must not be blank/],
    ]) {
      const decision = { ...maintainerDecision(), ...patch };
      assert.throws(() => admit(auditorResult(subject, 'PASS', { maintainerDecisions: [decision] })), pattern, `${label}: ${field}`);
    }
  }
});

test("the auditor's own incompleteness reason survives the derived design gaps", () => {
  const result = auditorResult(subject, 'BLOCKED_INCOMPLETE', { designCoverage: [] });
  result.completeness = { status: 'incomplete', reason: 'the sandbox build failed' };
  const admitted = admit(result);
  assert.equal(admitted.verdict, 'BLOCKED_INCOMPLETE');
  assert.match(admitted.completeness.reason, /^the sandbox build failed /);
  assert.match(admitted.completeness.reason, /design coverage incomplete/);

  const long = auditorResult(subject, 'BLOCKED_INCOMPLETE', { designCoverage: [] });
  long.completeness = { status: 'incomplete', reason: 'x'.repeat(4096) };
  const bounded = admit(long);
  assert.equal(bounded.completeness.reason.length, 4096);
  assert.equal(validateAuditorResult(bounded).valid, true, 'the persisted result stays schema-valid');
});

test('historical v2 derivation is not reinterpreted', () => {
  const v2 = { ...auditorResultV2(subject), auditResultId: null };
  assert.deepEqual(deriveAuditDecision(v2), { verdict: 'PASS', correctionEligible: false });
  v2.findings = Array.from({ length: 5 }, () => major('introduced'));
  assert.deepEqual(deriveAuditDecision(v2), { verdict: 'NEEDS_CHANGES', correctionEligible: true });
});

test('coverage must map every done_when id exactly once', () => {
  const pass = passingAcceptanceCoverage();
  const cases = [
    ['missing', pass.slice(0, 1)],
    ['duplicate', [...pass, { ...pass[0] }]],
    ['unexpected', [...pass, { ...pass[0], acceptanceId: 'unexpected' }]],
  ];
  for (const [label, coverage] of cases) {
    const admitted = admit(auditorResult(subject, 'PASS', { coverage }));
    assert.equal(admitted.verdict, 'BLOCKED_INCOMPLETE', label);
    assert.equal(admitted.completeness.status, 'incomplete', label);
    assert.match(admitted.coverageRemediation, /exactly one coverage row/, label);
  }
});

test('NOT_RUN and N/A acceptance coverage cannot complete', () => {
  for (const status of ['NOT_RUN', 'N/A']) {
    const coverage = passingAcceptanceCoverage();
    coverage[0] = {
      ...coverage[0], status,
      reason: `${status} reason`,
      remediation: `Resolve ${status} before completion.`,
    };
    const admitted = admit(auditorResult(subject, 'PASS', { coverage }));
    assert.equal(admitted.verdict, 'BLOCKED_INCOMPLETE', status);
    assert.match(admitted.completeness.reason, new RegExp(`acceptance-1=${status.replace('/', '\\/')}`));
  }
});

test('a decisive acceptance FAIL remains complete and admits an introduced correction', () => {
  const coverage = passingAcceptanceCoverage();
  coverage[0] = { ...coverage[0], status: 'FAIL', reason: 'False claim disproved by the reproduction.', remediation: 'Correct the false claim.' };
  const admitted = admit(auditorResult(subject, 'NEEDS_CHANGES', { coverage }));
  assert.equal(admitted.completeness.status, 'complete');
  assert.equal(admitted.coverageRemediation, null);
  assert.equal(admitted.verdict, 'NEEDS_CHANGES');
  assert.equal(admitted.correctionEligible, true);
  assert.equal(validateAuditorResult(admitted).valid, true);
  assert.equal(auditorResultIntact(admitted), true);
});

test('failed acceptance cannot PASS without an introduced severe finding', () => {
  const coverage = passingAcceptanceCoverage();
  coverage[0] = { ...coverage[0], status: 'FAIL', reason: 'Required condition failed.', remediation: 'Resolve the failed condition.' };
  for (const findings of [[], [major('pre_existing')], [major('external')], [major('unknown')], [{ ...major('introduced'), severity: 'WARNING' }]]) {
    const result = auditorResult(subject, 'PASS', { coverage });
    result.findings = findings;
    const admitted = admit(result);
    assert.equal(admitted.completeness.status, 'complete');
    assert.equal(admitted.verdict, 'NEEDS_MAINTAINER');
    assert.equal(admitted.correctionEligible, false);
  }
});

test('decisive acceptance failure does not hide incomplete evidence or pending decisions', () => {
  const coverage = passingAcceptanceCoverage();
  coverage[0] = { ...coverage[0], status: 'FAIL', reason: 'False claim disproved.', remediation: 'Correct it.' };
  for (const [label, patch, expected] of [
    ['missing row', { acceptanceCoverage: coverage.slice(0, 1) }, 'BLOCKED_INCOMPLETE'],
    ['unrun row', { acceptanceCoverage: [coverage[0], { ...coverage[1], status: 'NOT_RUN', reason: 'Not executed.', remediation: 'Run it.' }] }, 'BLOCKED_INCOMPLETE'],
    ['design gap', { designCoverage: [] }, 'BLOCKED_INCOMPLETE'],
    ['declared incomplete', { completeness: { status: 'incomplete', reason: 'Sandbox unavailable.' } }, 'BLOCKED_INCOMPLETE'],
    ['pending decision', { maintainerDecisions: [maintainerDecision()] }, 'NEEDS_MAINTAINER'],
  ]) {
    const admitted = admit({ ...auditorResult(subject, 'NEEDS_CHANGES', { coverage }), ...patch });
    assert.equal(admitted.verdict, expected, label);
    assert.equal(admitted.correctionEligible, false, label);
  }
});

test('acceptance refuses whitespace-only evidence for PASS and FAIL in a new audit; historical v2 and v3 remain readable', () => {
  for (const status of ['PASS', 'FAIL']) {
    for (const evidence of ['   ', '\t', '\n', ' \t\r\n ']) {
      const coverage = passingAcceptanceCoverage();
      coverage[0] = { ...coverage[0], status, evidence,
        reason: status === 'FAIL' ? 'Observed failure.' : null,
        remediation: status === 'FAIL' ? 'Fix it.' : null };
      const result = auditorResult(subject, status === 'FAIL' ? 'NEEDS_CHANGES' : 'PASS', { coverage });
      assert.equal(validateAuditorResult(result).valid, false);
      assert.throws(() => admit(result), /coverage must carry non-blank evidence/);
      const legacy = legacyAcceptanceCoverage();
      legacy[0] = { ...legacy[0], status, evidence, reason: coverage[0].reason, remediation: coverage[0].remediation };
      assert.equal(validateAuditorResult(auditorResultV3(subject, 'PASS', { coverage: legacy })).valid, true, 'v3 is history now: the committed v3 contract never refused it, and no new v3 can be admitted');
      assert.equal(validateAuditorResult(auditorResultV2(subject, 'PASS', { coverage: legacy })).valid, true);
    }
  }
});

test('non-PASS coverage without specific remediation is refused structurally', () => {
  const coverage = passingAcceptanceCoverage();
  coverage[0] = { ...coverage[0], status: 'FAIL', reason: 'the assertion failed', remediation: '  ' };
  assert.throws(() => admit(auditorResult(subject, 'PASS', { coverage })), /actionable non-empty remediation/);
});

test('task binding and acceptance coverage are part of the durable result identity', () => {
  const admitted = admit(auditorResult(subject));
  assert.equal(typeof admitted.acceptanceCoverageDigest, 'string');
  assert.equal(auditorResultIntact({
    ...admitted,
    acceptanceCoverage: admitted.acceptanceCoverage.map((entry, index) => (
      index === 0 ? { ...entry, evidence: 'tampered evidence' } : entry
    )),
  }), false);

  const mismatched = { ...auditorResult(subject), taskContractDigest: `sha256:${'b'.repeat(64)}` };
  assert.throws(() => admit(mismatched), /not frozen contract/);
});
