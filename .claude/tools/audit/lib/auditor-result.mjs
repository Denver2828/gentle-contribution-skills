import { digest } from './canonical.mjs';
import { validateAuditorResult } from './validate.mjs';
import {
  acceptanceCoverageDigest,
  assessAcceptanceCoverage,
  taskContractIntact,
} from './task-contract.mjs';

const severe = (finding) => finding.severity === 'BLOCKER' || finding.severity === 'MAJOR';

export const DESIGN_ASPECTS = Object.freeze([
  'design.over-engineering', 'design.side-effects', 'design.user-qol', 'design.shrinkability',
  'cost.system', 'cost.user', 'cost.product',
]);

/**
 * Whether a v3 result declares every design and cost aspect exactly once, and
 * leaves none of them unassessed in a way it calls material. A missing,
 * duplicated or material-pending aspect makes the audit incomplete.
 */
export function assessDesignCoverage(designCoverage) {
  const gaps = [];
  for (const aspect of DESIGN_ASPECTS) {
    const rows = designCoverage.filter((row) => row.aspect === aspect);
    if (rows.length !== 1) gaps.push(`${aspect} declared ${rows.length} times`);
    else if (rows[0].status === 'not_assessed' && rows[0].material === true) gaps.push(`${aspect} not assessed and material`);
  }
  return gaps.length === 0
    ? { complete: true, reason: null }
    : { complete: false, reason: `design coverage incomplete: ${gaps.join('; ')}. Assess each aspect, or declare it not_applicable with a justification, before asking for approval` };
}

/** The version a new task-bound audit must use. Earlier ones are history. */
export const CURRENT_AUDITOR_RESULT_VERSION = 'auditor-result/v4';

/**
 * v3 introduced design coverage, maintainer decisions, and the rule that a
 * decisive acceptance FAIL cannot be waived. v4 keeps all of it and adds
 * per-row verification and limit, which never enter the verdict: admission
 * requires their presence and nothing is derived from their text.
 */
export const derivesOwnVerdict = (result) => result.schemaVersion === 'auditor-result/v3'
  || result.schemaVersion === CURRENT_AUDITOR_RESULT_VERSION;

/**
 * Verdict precedence, highest first. An incomplete audit outranks a pending
 * decision, so a decision never hides missing evidence; the decision is still
 * persisted in the result. A pending decision outranks every finding, so the
 * five-finding cap cannot push it out of the verdict, and it is routed without
 * rewriting any causality. v1 and v2 results carry neither field, so their
 * derivation is unchanged.
 */
export function deriveAuditDecision(result) {
  if (result.coverageRemediation !== undefined && result.coverageRemediation !== null) {
    return { verdict: 'BLOCKED_INCOMPLETE', correctionEligible: false };
  }
  if (result.completeness.status !== 'complete') return { verdict: 'BLOCKED_INCOMPLETE', correctionEligible: false };
  if (derivesOwnVerdict(result) && !assessDesignCoverage(result.designCoverage).complete) {
    return { verdict: 'BLOCKED_INCOMPLETE', correctionEligible: false };
  }
  if (derivesOwnVerdict(result) && result.maintainerDecisions.length > 0) {
    return { verdict: 'NEEDS_MAINTAINER', correctionEligible: false };
  }
  const severeFindings = result.findings.filter(severe);
  if (severeFindings.some((finding) => ['external', 'unknown'].includes(finding.causalDisposition))) {
    return { verdict: 'NEEDS_MAINTAINER', correctionEligible: false };
  }
  if (severeFindings.some((finding) => finding.causalDisposition === 'introduced')) {
    return { verdict: 'NEEDS_CHANGES', correctionEligible: true };
  }
  // A decisive acceptance failure is not missing evidence, and cannot be
  // waived by absent, minor, or pre-existing findings. Without an introduced
  // severe finding the bounded correction route has no established cause.
  if (derivesOwnVerdict(result) && result.acceptanceCoverage.some((row) => row.status === 'FAIL')) {
    return { verdict: 'NEEDS_MAINTAINER', correctionEligible: false };
  }
  return { verdict: 'PASS', correctionEligible: false };
}

export function admitAuditorResult(submitted, { taskContract = null } = {}) {
  const checked = validateAuditorResult(submitted);
  if (!checked.valid) throw new Error(`auditor result violates ${submitted?.schemaVersion ?? 'the auditor-result contract'}: ${checked.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  if (submitted.findings.length > 5) throw new Error('auditor result carries more than five findings');
  if (submitted.auditResultId !== null || submitted.verdict !== null || submitted.correctionEligible !== null) {
    throw new Error('auditor-supplied identity, verdict, and correction eligibility are forbidden; the native store derives them');
  }

  let result = submitted;
  if (taskContract === null) {
    if (submitted.schemaVersion !== 'auditor-result/v1') {
      throw new Error(`${submitted.schemaVersion} requires the accepted task contract it covers`);
    }
  } else {
    if (!taskContractIntact(taskContract)) throw new Error('the accepted task contract is invalid or does not match its own digest');
    if (submitted.schemaVersion !== CURRENT_AUDITOR_RESULT_VERSION) {
      throw new Error(`a new task-bound audit requires ${CURRENT_AUDITOR_RESULT_VERSION} (verification and limit on every decisive acceptance row); ${submitted.schemaVersion} remains readable history only`);
    }
    if (submitted.taskContractDigest !== taskContract.taskContractDigest) {
      throw new Error(`the auditor result covers task contract ${submitted.taskContractDigest}, not frozen contract ${taskContract.taskContractDigest}`);
    }
    if (submitted.acceptanceCoverageDigest !== null || submitted.coverageRemediation !== null) {
      throw new Error('auditor-supplied coverage identity and coverage remediation are forbidden; the native store derives them');
    }
    const coverage = assessAcceptanceCoverage(taskContract, submitted.acceptanceCoverage);
    const design = assessDesignCoverage(submitted.designCoverage);
    const gaps = [
      ...(coverage.complete ? [] : [`${coverage.reason}. ${coverage.remediation}`]),
      ...(design.complete ? [] : [design.reason]),
    ];
    result = {
      ...submitted,
      acceptanceCoverageDigest: acceptanceCoverageDigest(submitted.acceptanceCoverage),
      coverageRemediation: coverage.remediation,
      // The auditor's own reason for an incomplete audit is kept, the derived
      // gaps are appended, and the whole stays within the schema's 4096 bound
      // so the persisted artifact remains readable.
      completeness: gaps.length === 0
        ? submitted.completeness
        : {
          status: 'incomplete',
          reason: [
            ...(submitted.completeness.status === 'incomplete' ? [submitted.completeness.reason] : []),
            ...gaps,
          ].join(' ').slice(0, 4096),
        },
    };
  }

  const decision = deriveAuditDecision(result);
  const bound = { ...result, ...decision };
  const { auditResultId: ignored, ...hashed } = bound;
  return Object.freeze({ ...bound, auditResultId: digest(hashed) });
}

export function auditorResultIntact(result) {
  if (result === null || typeof result !== 'object') return false;
  const { auditResultId, ...hashed } = result;
  return auditResultId === digest(hashed);
}
