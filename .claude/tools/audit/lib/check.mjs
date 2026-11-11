// Check definition and execution.
//
// The single rule this module enforces: a check can only ever downgrade its
// own conclusion here, never upgrade it. A thrown error, a malformed return,
// or a PASS that cites no evidence all become UNKNOWN with the reason
// attached. There is no path from a broken check to PASS.

import { STATUS, isStatus } from './status.mjs';
import { makeEvidence, EVIDENCE_TYPE } from './evidence.mjs';

const ID_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/**
 * Declare a check. Validation happens here, at definition time, so a
 * malformed check fails the run instead of silently misreporting.
 *
 * @param {object}   input
 * @param {string}   input.id        stable dotted id, e.g. "git.repository-readable"
 * @param {string}   input.title     one line, human readable
 * @param {boolean}  input.required  whether this check can block the gate
 * @param {Function} input.run       async (context) => {status, reason, evidence[], remediation?}
 */
export function defineCheck({ id, title, required, run }) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new TypeError(`check id must match ${ID_PATTERN}, received ${JSON.stringify(id)}`);
  }
  if (typeof title !== 'string' || title.trim() === '') {
    throw new TypeError(`check "${id}": title must be a non-empty string`);
  }
  if (typeof required !== 'boolean') {
    throw new TypeError(`check "${id}": required must be an explicit boolean`);
  }
  if (typeof run !== 'function') {
    throw new TypeError(`check "${id}": run must be a function`);
  }
  return Object.freeze({ id, title, required, run });
}

export const TOOL_DEFECT_REMEDIATION = 'Fix the check implementation; this is a defect in the audit tool, not in the repository.';

export function inconclusive(check, reason, detail, remediation = TOOL_DEFECT_REMEDIATION) {
  return {
    id: check.id,
    title: check.title,
    status: STATUS.UNKNOWN,
    required: check.required,
    durationMs: 0,
    reason,
    evidence: [
      makeEvidence({
        type: EVIDENCE_TYPE.COMPUTED,
        source: `check-contract:${check.id}`,
        observed: detail,
      }),
    ],
    remediation,
  };
}

/**
 * Turn whatever a check returned into a contract-shaped result.
 *
 * Shared by the in-process path and the isolated one, so a check cannot mean
 * different things depending on where it ran.
 */
export function normaliseOutcome(check, outcome, durationMs) {
  if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome)) {
    return { ...inconclusive(check, 'the check returned a non-object outcome', { returned: typeof outcome }), durationMs };
  }
  if (!isStatus(outcome.status)) {
    return { ...inconclusive(check, 'the check returned an unrecognised status', { returned: String(outcome.status) }), durationMs };
  }
  if (typeof outcome.reason !== 'string' || outcome.reason.trim() === '') {
    return { ...inconclusive(check, 'the check returned no reason for its conclusion', { status: outcome.status }), durationMs };
  }

  const evidence = Array.isArray(outcome.evidence) ? outcome.evidence : [];

  // A conclusion about the repository must cite what was observed. NOT_RUN is
  // exempt: by definition nothing was observed, which is why it carries a
  // reason instead.
  const needsEvidence = outcome.status === STATUS.PASS || outcome.status === STATUS.FAIL;
  if (needsEvidence && evidence.length === 0) {
    return {
      ...inconclusive(check, `a ${outcome.status} must cite at least one evidence item`, { status: outcome.status }),
      durationMs,
    };
  }

  const remediation = typeof outcome.remediation === 'string' && outcome.remediation.trim() !== ''
    ? outcome.remediation.trim()
    : null;

  // A required blocking result must tell the operator how to make progress.
  // Silently accepting a bare FAIL/UNKNOWN/NOT_RUN would move diagnosis out of
  // the harness and into human guesswork. That is a broken check contract, so
  // preserve what the check observed and downgrade the claim to tool UNKNOWN.
  if (check.required && outcome.status !== STATUS.PASS && remediation === null) {
    const defect = inconclusive(
      check,
      `a required ${outcome.status} must include a non-empty remediation`,
      { returnedStatus: outcome.status, returnedReason: outcome.reason }
    );
    return {
      ...defect,
      durationMs,
      evidence: [...evidence, ...defect.evidence],
    };
  }

  return {
    id: check.id,
    title: check.title,
    status: outcome.status,
    required: check.required,
    durationMs,
    reason: outcome.reason,
    evidence,
    remediation,
  };
}

/**
 * Run one check and normalise its outcome into a contract-shaped result.
 *
 * @param {object} check    produced by defineCheck
 * @param {object} context  read-only inputs handed to the check
 * @param {object} options
 * @param {Function} options.now  monotonic-ish clock, injected for determinism in tests
 */
export async function runCheck(check, context, { now = () => Date.now() } = {}) {
  const startedAt = now();

  let outcome;
  try {
    outcome = await check.run(context);
  } catch (error) {
    return {
      ...inconclusive(check, `the check threw and cannot conclude: ${error?.message ?? String(error)}`, {
        error: error?.message ?? String(error),
        errorName: error?.name ?? 'Error',
      }),
      durationMs: Math.max(0, now() - startedAt),
    };
  }

  return normaliseOutcome(check, outcome, Math.max(0, now() - startedAt));
}

/** A NOT_RUN result for a check that was selected but deliberately skipped. */
export function notRun(check, reason, remediation = null) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new TypeError(`check "${check.id}": NOT_RUN requires a reason`);
  }
  return normaliseOutcome(check, {
    status: STATUS.NOT_RUN,
    reason,
    evidence: [],
    remediation,
  }, 0);
}
