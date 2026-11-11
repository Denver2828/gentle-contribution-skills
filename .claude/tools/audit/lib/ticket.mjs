// Public edition: private incident history omitted. See the operational contract.

import { digest, sha256Hex } from './canonical.mjs';

export const TICKET_VERSION = '1.0.0';

/**
 * How long a ticket stays valid. Long enough to run one gh command and read
 * the result back; short enough that a ticket forgotten by a dead session
 * cannot block its lineage past the next half hour.
 */
export const TICKET_TTL_MS = 30 * 60 * 1000;

// The two supported operations, kept in lockstep with the receipt's
// PUBLICATION_OPERATIONS (a test pins the equality). pr-create is retired:
// its result could not be fully bound, so no ticket names it any more.
export const TICKET_OPERATIONS = Object.freeze(['issue-create', 'issue-comment']);

/**
 * The normalization applied to a publication body before hashing.
 *
 * The SAME function runs on the local draft when the ticket is minted and on
 * the body fetched back from GitHub after publishing, which is the only reason
 * the two digests are comparable at all:
 *
 *   - EVERY leading UTF-8 BOM is stripped (`+`, not one), because editors on
 *     Windows add one and GitHub does not echo it back -- and a tool that
 *     re-saves an already-BOMed file can stack a second. One-BOM stripping
 *     broke idempotence: normalize('\uFEFF\uFEFFx') left a leading BOM for a
 *     second pass to remove, so the ledger-side hash of the raw draft and the
 *     publisher-side hash of the canonical form diverged, minting a ticket no
 *     publisher could ever satisfy;
 *   - CRLF and lone CR become LF, because line endings describe the transport,
 *     not the text;
 *   - trailing newlines are dropped, because a file almost always ends in one
 *     and a body read back from the API does not reliably keep it.
 *
 * IDEMPOTENT, and provably: the output has no leading BOM (`^\uFEFF+` took
 * them all), and neither of the later rules can expose a new one -- folding
 * CR/CRLF to LF and dropping trailing newlines never move a mid-string BOM to
 * the front. So a second pass finds nothing to change, which is what lets
 * bodyDigest re-normalize internally without the two hashes diverging. The
 * hostile set in the idempotence test pins this, double-BOM case included.
 */
export function normalizeBody(text) {
  return text
    .replace(/^\uFEFF+/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+$/, '');
}

/** Digest of a publication body AFTER normalization, never of raw bytes. */
export function bodyDigest(text) {
  return `sha256:${sha256Hex(normalizeBody(text))}`;
}

/**
 * Build a ticket. `expiresAt` is derived from `issuedAt`, not read from the
 * caller: a ticket that could declare its own lifetime would not have one.
 */
export function ticketOf({
  lineage, candidateId, receiptId, evidenceId, attemptNumber,
  operation, targetRepo, targetNumber, bodySha256, titleSha256, dependsOn = [], sessionId, issuedAt,
}) {
  const record = {
    ticketVersion: TICKET_VERSION,
    lineage,
    candidateId,
    receiptId,
    evidenceId,
    attemptNumber,
    operation,
    targetRepo,
    targetNumber,
    bodySha256,
    titleSha256,
    // Copied from the receipt and bound in the id: the publisher enforces the
    // ordering from the ticket alone, and a ticket with a different list is a
    // different ticket.
    dependsOn: [...dependsOn],
    sessionId,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + TICKET_TTL_MS).toISOString(),
  };
  return Object.freeze({ ...record, ticketId: digest(record) });
}

/**
 * Re-derive the ticket id from its own fields. Any edit shows up here.
 *
 * `consumedAt` is excluded on purpose: the consumption stamp is added after
 * issuance and is not part of the issued identity. A LIVE ticket carrying one
 * is still refused, by the schema rather than by this function -- the schema
 * admits no such property.
 */
export function ticketIntact(ticket) {
  if (ticket === null || typeof ticket !== 'object') return false;
  const { ticketId, consumedAt, ...record } = ticket;
  return ticketId === digest(record);
}

/** Has this ticket's validity window closed? An unparseable date never expires, which blocks rather than permits: the pending-ticket refusal keeps holding. */
export function ticketExpired(ticket, at = Date.now()) {
  return Date.parse(ticket.expiresAt) <= at;
}
