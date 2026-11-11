// The trust anchor for the receipt-signing public key.
//
// The public key PEM lives in the repository, which means anyone who can write
// the repository can replace it. The anchor is the counterweight: a small JSON
// document under `C:\Program Files\GentleAporte\`, a directory that Windows
// default ACLs make writable by administrators only, while this tooling runs
// unelevated. Substituting the repo pubkey without also editing the anchor
// produces a fingerprint mismatch, and editing the anchor requires an
// elevation this agent does not have. That is the point of the location.
//
// Stated honestly: an administrator, or a human who elevates, can still
// rewrite it. The anchor raises the bar from "can write the repo" to "can
// write Program Files"; it is not a hardware root of trust. The externally
// recorded fingerprint (printed LARGE by keygen, written down outside every
// machine) is the layer above it.

import { readFileSync } from 'node:fs';

export const ANCHOR_PATH = 'C:\\Program Files\\GentleAporte\\receipt-signing.anchor.json';

const FINGERPRINT = /^[0-9a-f]{64}$/;

export class AnchorError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'AnchorError';
    this.detail = detail;
  }
}

const refuse = (message, detail) => { throw new AnchorError(message, detail); };

/**
 * Read the anchor document.
 *
 * Missing is a state, reported as `{present: false}`: whether absence blocks
 * depends on whether signing is required, and that decision belongs to the
 * caller. A file that EXISTS but cannot be read or does not describe an
 * anchor always refuses -- a present-but-broken anchor is never treated as an
 * absent one, because that downgrade is exactly how a deleted-and-replaced
 * anchor would want to be read.
 */
export function readAnchor({ path = ANCHOR_PATH } = {}) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, anchor: null, path };
    refuse(`the anchor at ${path} exists but cannot be read: ${error.message}`, { failure: 'unreadable-anchor', path });
  }

  let parsed;
  try {
    // PowerShell 5.1 writes a BOM under -Encoding utf8; the anchor install
    // commands use exactly that shell, so the BOM is stripped, not refused.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    refuse(`the anchor at ${path} is not readable JSON`, { failure: 'corrupt-anchor', path, error: error.message });
  }

  if (typeof parsed?.pubkeyFingerprint !== 'string' || !FINGERPRINT.test(parsed.pubkeyFingerprint)) {
    refuse('the anchor carries no pubkeyFingerprint of 64 lowercase hex characters', { failure: 'malformed-anchor', path });
  }
  if (parsed.signerSha256 !== undefined && parsed.signerSha256 !== null && !FINGERPRINT.test(parsed.signerSha256)) {
    refuse('the anchor carries a signerSha256 that is not 64 lowercase hex characters', { failure: 'malformed-anchor', path });
  }
  if (typeof parsed.anchoredAt !== 'string' || parsed.anchoredAt === '') {
    refuse('the anchor does not say when it was anchored', { failure: 'malformed-anchor', path });
  }

  return {
    present: true,
    anchor: {
      pubkeyFingerprint: parsed.pubkeyFingerprint,
      signerSha256: parsed.signerSha256 ?? null,
      anchoredAt: parsed.anchoredAt,
    },
    path,
  };
}

/**
 * Compare a fingerprint against the anchored one.
 *
 * @returns {{status: 'match'|'mismatch'|'missing', anchored: string|null, anchor: object|null}}
 */
export function anchorVerdict({ fingerprint, path = ANCHOR_PATH }) {
  const read = readAnchor({ path });
  if (!read.present) return { status: 'missing', anchored: null, anchor: null };
  return {
    status: read.anchor.pubkeyFingerprint === fingerprint ? 'match' : 'mismatch',
    anchored: read.anchor.pubkeyFingerprint,
    anchor: read.anchor,
  };
}

/**
 * Refuse unless the fingerprint is the anchored one.
 *
 * A mismatch ALWAYS refuses: a wrong key is wrong whether or not signing is
 * required. A missing anchor refuses only when signing is required -- while
 * the requirement is off, verification code runs and reports, and an
 * unanchored machine is not yet an error.
 */
export function assertAnchoredFingerprint({ fingerprint, path = ANCHOR_PATH, required = true }) {
  const verdict = anchorVerdict({ fingerprint, path });
  if (verdict.status === 'match') return verdict;
  if (verdict.status === 'missing') {
    if (!required) return verdict;
    refuse(
      `no anchor exists at ${path}; signing is required and an unanchored public key verifies nothing. Run keygen and install the anchor from an elevated shell first`,
      { failure: 'missing-anchor', path }
    );
  }
  refuse(
    `the public key fingerprint ${fingerprint} does not match the anchored ${verdict.anchored}; the repository key is not the anchored key`,
    { failure: 'anchor-mismatch', found: fingerprint, anchored: verdict.anchored, path }
  );
}
