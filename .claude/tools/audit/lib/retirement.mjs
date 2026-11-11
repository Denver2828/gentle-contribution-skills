// Retirement: how a lineage closes.
//
// Every other transition in the store either advances a lineage or refuses
// it; none of them ends it. A lineage in AUTHORIZED kept a live unsigned
// receipt forever, PUBLISHABLE could mint attempt after attempt, and the only
// terminal state reachable on purpose was STALE -- through a candidate
// mismatch, never through a decision. A retirement is that decision made
// durable: a content-addressed record saying this lineage is closed, why, and
// what it was carrying when it closed.
//
// Like every other artifact here it is a record, not a credential. Anyone able
// to write into the store can write a consistent one; what it resists is a
// lineage that was closed in conversation and stayed open in the index.

import { digest } from './canonical.mjs';

export const RETIREMENT_VERSION = '1.0.0';

/**
 * Build a retirement record. The id is the digest of everything else, in the
 * same idiom as evidenceId, receiptId, ticketId and attemptId.
 */
export function retirementOf({ lineage, retiredAt, reason, supersededBy, priorState, receiptId, ticketId, attempts }) {
  const record = {
    retirementVersion: RETIREMENT_VERSION,
    lineage,
    retiredAt,
    reason,
    supersededBy,
    priorState,
    receiptId,
    ticketId,
    attempts,
  };
  return Object.freeze({ ...record, retirementId: digest(record) });
}

/** Re-derive the id from the record's own fields. Any edit shows up here. */
export function retirementIntact(retirement) {
  if (retirement === null || typeof retirement !== 'object') return false;
  const { retirementId, ...record } = retirement;
  return retirementId === digest(record);
}
