import { admitTaskContract } from '../../lib/task-contract.mjs';

export const completeCoverage = ({ source = 'test-source', count = 0, scope = 'Gentleman-Programming/gentle-ai', query = `${source} --repo Gentleman-Programming/gentle-ai`, interval = null, retrieval = 'not-applicable' } = {}) => ({
  schemaVersion: 'coverage-receipt/v1', source, scope, query, interval,
  sourceVersion: 'test-v1',
  pages: [{ cursor: null, nextCursor: null, count }],
  returnedCount: count, reviewedCount: count, authoritativeTotal: count,
  termination: 'finite-listing', exclusions: [], retrieval,
});

export const TASK_CONTRACT = Object.freeze({
  schemaVersion: 'task-contract/v1',
  goal: 'Publish the reviewed contribution without changing its declared scope.',
  constraints: ['Preserve the frozen candidate and publication binding.'],
  done_when: [
    { id: 'acceptance-1', condition: 'The candidate matches the declared contribution scope.' },
    { id: 'acceptance-2', condition: 'The supporting evidence verifies every material public claim.' },
  ],
  escalate_when: ['A required decision or decisive verification is unavailable.'],
});

/** Pre-v4 rows (auditor-result/v2 and /v3): no verification, no limit. */
export const legacyAcceptanceCoverage = (taskContract = TASK_CONTRACT) => taskContract.done_when.map(({ id }) => ({
  acceptanceId: id,
  status: 'PASS',
  evidence: `fixture evidence for ${id}`,
  reason: null,
  remediation: null,
}));

/** auditor-result/v4 rows: claim -> pertinent check -> result -> limit. */
export const passingAcceptanceCoverage = (taskContract = TASK_CONTRACT) => taskContract.done_when.map(({ id }) => ({
  acceptanceId: id,
  status: 'PASS',
  evidence: `fixture evidence for ${id}`,
  verification: {
    method: `fixture check executed for ${id}`,
    falsifier: `a fixture observation contradicting ${id}`,
  },
  limit: `fixture inputs only; ${id} is not shown outside them`,
  reason: null,
  remediation: null,
}));

export const DESIGN_ASPECTS = Object.freeze([
  'design.over-engineering', 'design.side-effects', 'design.user-qol', 'design.shrinkability',
  'cost.system', 'cost.user', 'cost.product',
]);

export const assessedDesignCoverage = () => DESIGN_ASPECTS.map((aspect) => ({
  aspect, status: 'assessed', evidence: `fixture assessment of ${aspect}`, justification: null, material: null,
}));

export const maintainerDecision = (causalDisposition = 'introduced') => ({
  decision: 'Whether the new default belongs in the product',
  options: ['keep the new default', 'keep the previous default'],
  evidence: 'fixture evidence for the open decision',
  causalDisposition,
});

export const auditorResult = (subjectId, verdict = 'PASS', {
  taskContract = TASK_CONTRACT,
  coverage = passingAcceptanceCoverage(taskContract),
  designCoverage = assessedDesignCoverage(),
  maintainerDecisions = [],
} = {}) => ({
  ...auditorResultV2(subjectId, verdict, { taskContract, coverage }),
  schemaVersion: 'auditor-result/v4',
  designCoverage,
  maintainerDecisions,
});

/** Historical shape: readable and verifiable, refused for a new audit. */
export const auditorResultV3 = (subjectId, verdict = 'PASS', {
  taskContract = TASK_CONTRACT,
  coverage = legacyAcceptanceCoverage(taskContract),
  designCoverage = assessedDesignCoverage(),
  maintainerDecisions = [],
} = {}) => ({
  ...auditorResultV2(subjectId, verdict, { taskContract, coverage }),
  schemaVersion: 'auditor-result/v3',
  designCoverage,
  maintainerDecisions,
});

export const auditorResultV2 = (subjectId, verdict = 'PASS', { taskContract = TASK_CONTRACT, coverage = legacyAcceptanceCoverage(taskContract) } = {}) => {
  const findings = verdict === 'NEEDS_CHANGES' ? [{
    severity: 'MAJOR', evidenceClass: 'deterministic', causalDisposition: 'introduced',
    claim: 'candidate defect', evidence: 'test evidence', why: 'publication would be wrong', smallestCorrection: 'correct the candidate',
  }] : verdict === 'NEEDS_MAINTAINER' ? [{
    severity: 'MAJOR', evidenceClass: 'inferential', causalDisposition: 'unknown',
    claim: 'causality unresolved', evidence: 'bounded evidence', why: 'ownership is unknown', smallestCorrection: 'maintainer decides ownership',
  }] : [];
  return {
    schemaVersion: 'auditor-result/v2', kind: 'no-code-aporte-audit', auditResultId: null,
    subject_id: subjectId, candidateKind: 'no-code-aporte',
    taskContractDigest: admitTaskContract(taskContract).taskContractDigest,
    completeness: { status: verdict === 'BLOCKED_INCOMPLETE' ? 'incomplete' : 'complete', reason: 'test fixture completed its bounded inspection' },
    acceptanceCoverage: coverage,
    acceptanceCoverageDigest: null,
    coverageRemediation: null,
    verification: ['fixture inspection'], findings, strengths: [], recommendation: 'follow the derived verdict',
    verdict: null, correctionEligible: null,
  };
};

export const historicalAuditorResult = (subjectId, verdict = 'PASS') => {
  const current = auditorResultV2(subjectId, verdict);
  const {
    taskContractDigest: ignoredTask,
    acceptanceCoverage: ignoredCoverage,
    acceptanceCoverageDigest: ignoredCoverageDigest,
    coverageRemediation: ignoredRemediation,
    ...historical
  } = current;
  return { ...historical, schemaVersion: 'auditor-result/v1' };
};
