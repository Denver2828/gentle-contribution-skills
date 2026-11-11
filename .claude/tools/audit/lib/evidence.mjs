// The evidence model.
//
// An evidence item answers three questions and nothing else: where the fact
// came from, what was observed, and what the observation hashes to. Anything a
// reader cannot re-derive from `type` + `source` does not belong here.

import { digest } from './canonical.mjs';
import { redact } from './redact.mjs';

export const EVIDENCE_TYPE = Object.freeze({
  /** Output of a read-only git plumbing command. */
  GIT: 'git',
  /** Response from the GitHub API, via the gh CLI. */
  GITHUB: 'github',
  /** Presence, mode or content-derived fact about a file. */
  FILE: 'file',
  /** Exit status or output of any other subprocess. */
  PROCESS: 'process',
  /** A value derived from other evidence in the same result. */
  COMPUTED: 'computed',
});

const TYPES = new Set(Object.values(EVIDENCE_TYPE));

/**
 * Build one evidence item.
 *
 * @param {object}  input
 * @param {string}  input.type      one of EVIDENCE_TYPE
 * @param {string}  input.source    the exact command or origin, e.g. "git rev-parse --show-toplevel"
 * @param {object}  input.observed  the narrow facts read, already scoped by the caller
 */
export function makeEvidence({ type, source, observed }) {
  if (!TYPES.has(type)) {
    throw new TypeError(`evidence.type must be one of ${[...TYPES].join(', ')}, received ${JSON.stringify(type)}`);
  }
  if (typeof source !== 'string' || source.trim() === '') {
    throw new TypeError('evidence.source must be a non-empty string naming the command or origin');
  }
  if (observed === null || typeof observed !== 'object' || Array.isArray(observed)) {
    throw new TypeError('evidence.observed must be an object of named facts');
  }

  // Redact before hashing so the digest describes exactly what is stored.
  const safe = redact(observed);
  return { type, source, observed: safe, hash: digest(safe) };
}

/** Re-derive the hash of an evidence item and compare it to the recorded one. */
export function evidenceIntact(item) {
  return item.hash === digest(item.observed);
}
