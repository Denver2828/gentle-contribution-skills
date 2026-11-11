// Act three: publication.
//
// Publication consumes an authorization; it never produces one, and it never
// completes evidence that is missing. Before acting it recomputes the identity
// of the candidate and demands exact equality with the one the receipt names --
// a receipt is permission for a specific candidate, not a token that stays
// valid while the thing it described moves.
//
// A failed attempt changes nothing. The evidence and the receipt are frozen
// documents produced earlier; an attempt is a THIRD artifact that refers to
// them. That is what stops a publishing failure from retroactively turning a
// gate into a FAIL, and what lets a second attempt exist beside the first
// instead of overwriting it.
//
// There is no default publisher. Nothing can be published by omission: the
// caller names a module, and in tests that module is a fake.

import { runWorker, ISOLATION } from './isolate.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { receiptGoverns } from './authorization.mjs';
import { digest } from './canonical.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PUBLISH_WORKER_PATH = join(HERE, 'publish-worker.mjs');

export const ATTEMPT_VERSION = '1.0.0';
export const DEFAULT_PUBLISH_TIMEOUT_MS = 30_000;

export const OUTCOME = Object.freeze({
  PUBLISHED: 'published',
  /** The gate would not act. The publisher was never reached. */
  REFUSED: 'refused',
  /** The publisher was reached and did not succeed. */
  FAILED: 'failed',
});

function attemptOf({ receipt, evidence, attemptNumber, outcome, reason, detail, publisherModule }) {
  const record = {
    attemptVersion: ATTEMPT_VERSION,
    attemptNumber,
    receiptId: receipt?.receiptId ?? null,
    evidenceId: evidence.evidenceId,
    candidateId: receipt?.candidateId ?? evidence.candidate.candidateId,
    outcome,
    reason,
    detail,
    publisher: { module: publisherModule },
  };
  return Object.freeze({ ...record, attemptId: digest(record) });
}

/**
 * Re-derive the attempt id from its own fields. Any edit shows up here.
 *
 * The same idiom as evidenceIntact and receiptIntact: `attemptOf` freezes
 * `attemptId: digest(record)`, so recomputing the digest over everything but
 * the id detects a record altered after it was built.
 */
export function attemptIntact(attempt) {
  if (attempt === null || typeof attempt !== 'object') return false;
  const { attemptId, ...record } = attempt;
  return attemptId === digest(record);
}

/**
 * Attempt to publish under an authorization.
 *
 * @param {object}   input
 * @param {object}   input.evidence          the frozen evidence record
 * @param {object}   input.receipt           the frozen authorization receipt
 * @param {object}   input.currentCandidate  identity recomputed NOW
 * @param {string}   input.publisherModule   path to the publisher; there is no default
 * @param {number}   input.attemptNumber     1 for the first attempt, 2 for the next, ...
 * @returns {Promise<{attempt: object}>} the attempt artifact. Evidence and
 *          receipt are returned untouched, because they are never modified.
 */
export async function publish({
  evidence, receipt, currentCandidate, publisherModule, attemptNumber = 1,
  timeoutMs = DEFAULT_PUBLISH_TIMEOUT_MS,
}) {
  const refuse = (reason, detail = {}) => ({
    attempt: attemptOf({ receipt, evidence, attemptNumber, outcome: OUTCOME.REFUSED, reason, detail, publisherModule: publisherModule ?? '(none)' }),
    evidence,
    receipt,
  });

  if (typeof publisherModule !== 'string' || publisherModule.trim() === '') {
    return refuse('no publisher was named, and there is no default one', { failure: 'no-publisher' });
  }
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    return refuse('an attempt must carry a positive attempt number', { failure: 'bad-attempt-number', attemptNumber });
  }
  if (receipt === null || receipt === undefined) {
    return refuse('publication consumes an authorization, and none was supplied', { failure: 'no-authorization' });
  }
  if (evidence.evidenceId !== receipt.evidenceId) {
    return refuse('the receipt was issued for different evidence', {
      failure: 'evidence-mismatch', receiptEvidenceId: receipt.evidenceId, evidenceId: evidence.evidenceId,
    });
  }

  // The identity is recomputed and must match exactly. Nothing here repairs a
  // mismatch; a moved candidate needs a new gate run.
  const verdict = receiptGoverns(receipt, currentCandidate);
  if (!verdict.governs) {
    return refuse(verdict.reason, {
      failure: 'candidate-mismatch',
      authorised: receipt.candidateId,
      current: currentCandidate.candidateId,
    });
  }

  const isolation = await runWorker({
    workerPath: PUBLISH_WORKER_PATH,
    workerData: { publisherModule, receipt },
    timeoutMs,
  });

  const failed = (reason, detail) => ({
    attempt: attemptOf({ receipt, evidence, attemptNumber, outcome: OUTCOME.FAILED, reason, detail, publisherModule }),
    evidence,
    receipt,
  });

  switch (isolation.kind) {
    case ISOLATION.TIMEOUT:
      return failed(`the publisher did not finish within ${timeoutMs}ms and its worker was terminated`, { failure: 'timeout', timeoutMs, terminated: true });

    case ISOLATION.EXCEPTION:
      return failed(`the publisher threw: ${isolation.detail?.message ?? 'no detail'}`, { failure: 'exception', ...isolation.detail });

    case ISOLATION.TERMINATED:
      return failed(`the publisher's worker exited before reporting (exit code ${isolation.detail?.exitCode})`, { failure: 'terminated', exitCode: isolation.detail?.exitCode ?? null });

    default: {
      const outcome = isolation.message?.outcome;
      if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome) || typeof outcome.published !== 'boolean') {
        return failed('the publisher returned an outcome this gate cannot read', { failure: 'malformed-result', returned: typeof outcome });
      }
      if (outcome.published !== true) {
        return failed(`the publisher did not publish: ${outcome.reason ?? 'no reason given'}`, { failure: 'publisher-declined', reason: outcome.reason ?? null });
      }

      return {
        attempt: attemptOf({
          receipt, evidence, attemptNumber,
          outcome: OUTCOME.PUBLISHED,
          reason: `the publisher reported success${outcome.reference ? ` (${outcome.reference})` : ''}`,
          detail: { reference: outcome.reference ?? null },
          publisherModule,
        }),
        evidence,
        receipt,
      };
    }
  }
}
