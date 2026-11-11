// Act one: evidence.
//
// Evidence exists for any state, including a state nobody should publish. It
// records what was verified, what was skipped, what failed and what could not
// be concluded -- and it authorises nothing. That separation is the point:
// when producing evidence and granting permission are the same act, a
// thorough-looking report becomes the permission, and "we checked" starts
// meaning "go ahead".
//
// The document carries `authorises: false` as a constant, so it cannot even
// claim otherwise.

import { digest } from './canonical.mjs';
import { STATUS } from './status.mjs';

export const EVIDENCE_VERSION = '1.0.0';

const entryOf = (check) => ({ id: check.id, required: check.required, reason: check.reason });

/**
 * Build the evidence record for one gate run.
 *
 * @param {object} result     the preflight result
 * @param {object} candidate  the outcome of identifyCandidate
 */
export function buildEvidence({ result, candidate }) {
  const buckets = { passed: [], failed: [], inconclusive: [], skipped: [] };

  // Every check lands in exactly one bucket. One that landed in none would be
  // a verification nobody can account for.
  for (const check of result.checks) {
    switch (check.status) {
      case STATUS.PASS: buckets.passed.push(entryOf(check)); break;
      case STATUS.FAIL: buckets.failed.push(entryOf(check)); break;
      case STATUS.UNKNOWN: buckets.inconclusive.push(entryOf(check)); break;
      default: buckets.skipped.push(entryOf(check)); break;
    }
  }

  const record = {
    evidenceVersion: EVIDENCE_VERSION,
    evidenceId: null,
    gate: result.gate,
    gateStatus: result.status,
    candidate: {
      status: candidate.status,
      candidateId: candidate.candidateId,
      reason: candidate.reason,
    },
    binding: { ...result.binding },
    verifications: buckets,
    summary: { ...result.summary },
    authorises: false,
  };

  const { evidenceId, ...hashed } = record;
  return Object.freeze({ ...record, evidenceId: digest(hashed) });
}

/** Re-derive the id and compare it to the recorded one. */
export function evidenceIntact(record) {
  const { evidenceId, ...hashed } = record;
  return evidenceId === digest(hashed);
}

/** Required checks that did not reach PASS, whatever the reason. */
export function unsatisfiedRequirements(record) {
  return [...record.verifications.failed, ...record.verifications.inconclusive, ...record.verifications.skipped]
    .filter((entry) => entry.required === true)
    .sort((left, right) => (left.id < right.id ? -1 : 1));
}

/**
 * The gate status the record's OWN verifications aggregate to, by the engine's
 * rule (status.mjs `aggregate`): the worst required state, FAIL > UNKNOWN >
 * NOT_RUN > PASS, and UNKNOWN when no required check exists at all. A gate
 * that verifies nothing is UNKNOWN, not PASS.
 *
 * `gateStatus` is copied from a caller-supplied result and was trusted as
 * written; a result whose status had been set to PASS by hand over
 * `checks: []` reached a receipt because "every required check reached PASS"
 * is vacuously true of zero checks (ASTRA-04). Every boundary that admits or
 * acts on a record now compares the claimed status against this derivation.
 */
export function derivedGateStatus(record) {
  const required = (bucket) => bucket.filter((entry) => entry.required === true);
  const { passed, failed, inconclusive, skipped } = record.verifications;
  if (required(failed).length > 0) return STATUS.FAIL;
  if (required(inconclusive).length > 0) return STATUS.UNKNOWN;
  if (required(skipped).length > 0) return STATUS.NOT_RUN;
  if (required(passed).length === 0) return STATUS.UNKNOWN;
  return STATUS.PASS;
}

/**
 * Why a record's claimed gate status is not to be believed, or null when it
 * matches its own verifications. One sentence, reused by the helper, the
 * store's admission and the receipt so all three refuse in the same words.
 */
export function gateStatusContradiction(record) {
  const derived = derivedGateStatus(record);
  if (derived === record.gateStatus) return null;
  const nothingRequired = Object.values(record.verifications).flat().every((entry) => entry.required !== true);
  const why = nothingRequired
    ? ': the evidence verifies nothing, no required check was recorded, and a gate that verifies nothing must not authorise'
    : '; a claimed status its own verifications contradict authorises nothing';
  return `the gate reported ${record.gateStatus} but its own verifications aggregate to ${derived}${why}`;
}
