// Candidate identity.
//
// WHAT THIS IS: a verifiable identity of the candidate as it stands right now.
// Given the same repository state, policy and tool it reproduces the same
// `candidateId`; given anything different it reproduces a different one. That
// is what an authorisation can be bound to.
//
// WHAT THIS IS NOT, stated plainly so nobody builds on a promise it does not
// make: it is not a recoverable snapshot and not permanent storage. It does not
// keep the candidate and cannot reconstruct it once the index moves. The blobs
// it names exist because `git add` wrote them; nothing here writes an object,
// and nothing here holds one alive. A later `git gc` may remove blobs no ref
// reaches, and the identity will then simply fail to verify -- which is the
// correct outcome, not a loss this module was supposed to prevent.
//
// The alternative -- freezing with `git write-tree` / `commit-tree` -- was
// weighed and refused: it writes into .git/objects, which contradicts the
// read-only invariant proven from delivery 2 onward, and it needs a ref to
// survive `git gc`, which is a real modification of someone else's repository.

import {
  readIndexEntries, verifyObjects, ConflictedIndexError,
  GitUnexpectedOutputError, GitCommandError, GitUnavailableError,
} from './adapters/git.mjs';
import { readFileBytes, FileUnreadableError, PathOutsideRepositoryError } from './adapters/files.mjs';
import { digest, sha256Hex } from './canonical.mjs';
import { makeEvidence, EVIDENCE_TYPE } from './evidence.mjs';
import { STATUS } from './status.mjs';

/** A gitlink entry points at a commit in another repository, not at content here. */
const GITLINK_MODE = '160000';

/**
 * Compute the identity of the candidate currently in the repository.
 *
 * @param {object}   input
 * @param {object}   input.snapshot     the snapshot every check consumed
 * @param {string}   input.policyHash
 * @param {string}   input.toolVersion
 * @param {string[]} [input.artifacts]  repository-relative paths whose bytes bind too
 * @returns {{status, candidateId: string|null, reason, evidence}}
 */
export function identifyCandidate({ snapshot, policyHash, toolVersion, artifacts = [] }) {
  const inconclusive = (reason, observed) => ({
    status: STATUS.UNKNOWN,
    candidateId: null,
    reason,
    evidence: [makeEvidence({ type: EVIDENCE_TYPE.GIT, source: 'git ls-files --stage -z', observed })],
  });

  if (snapshot === null || snapshot === undefined) {
    return inconclusive('there is no snapshot, so there is no candidate to identify', { snapshot: null });
  }

  let entries;
  try {
    entries = readIndexEntries(snapshot.root);
  } catch (error) {
    if (error instanceof ConflictedIndexError) {
      return inconclusive(
        `${error.message}; an index mid-merge holds several versions of the same path and describes no single candidate`,
        { conflicted: true, unmergedPaths: error.paths }
      );
    }
    if (error instanceof GitUnexpectedOutputError || error instanceof GitCommandError || error instanceof GitUnavailableError) {
      return inconclusive(`the index could not be read: ${error.message}`, { error: error.message });
    }
    throw error;
  }

  if (entries.length === 0) {
    return inconclusive(
      'the index holds no entry, so there is no candidate to identify; nothing can be authorised for publication',
      { entries: 0 }
    );
  }

  const gitlinks = entries.filter((entry) => entry.mode === GITLINK_MODE);
  if (gitlinks.length > 0) {
    return inconclusive(
      `${gitlinks.length} index entr(y|ies) are gitlinks, whose content lives in another repository and cannot be verified from here: ${gitlinks.map((entry) => entry.path).join(', ')}`,
      { gitlinks: gitlinks.map((entry) => entry.path) }
    );
  }

  // Every named object must exist and be a blob. A candidate that names
  // content Git can no longer produce is not a candidate.
  let verified;
  try {
    verified = verifyObjects(snapshot.root, [...new Set(entries.map((entry) => entry.blobSha))]);
  } catch (error) {
    return inconclusive(`the index objects could not be verified: ${error.message}`, { error: error.message });
  }

  const missing = entries.filter((entry) => verified.get(entry.blobSha)?.present !== true);
  if (missing.length > 0) {
    return inconclusive(
      `${missing.length} index entr(y|ies) name an object Git cannot produce: ${missing.map((entry) => `${entry.path} (${entry.blobSha})`).join(', ')}`,
      { missingObjects: missing.map((entry) => ({ path: entry.path, blobSha: entry.blobSha })) }
    );
  }

  const wrongType = entries.filter((entry) => verified.get(entry.blobSha)?.type !== 'blob');
  if (wrongType.length > 0) {
    return inconclusive(
      `${wrongType.length} index entr(y|ies) name an object that is not a blob: ${wrongType.map((entry) => `${entry.path} (${verified.get(entry.blobSha)?.type})`).join(', ')}`,
      { wrongType: wrongType.map((entry) => ({ path: entry.path, type: verified.get(entry.blobSha)?.type ?? null })) }
    );
  }

  // Declared artifacts bind by content, read from the working tree.
  const artifactHashes = [];
  for (const path of [...artifacts].sort()) {
    try {
      artifactHashes.push({ path, sha256: `sha256:${sha256Hex(readFileBytes(snapshot.root, path).toString('binary'))}` });
    } catch (error) {
      if (error instanceof FileUnreadableError || error instanceof PathOutsideRepositoryError) {
        return inconclusive(`the declared artifact ${path} could not be read: ${error.message}`, { artifact: path, error: error.message });
      }
      throw error;
    }
  }

  const identity = {
    headOid: snapshot.identity.head,
    indexEntries: entries,
    snapshotHash: snapshot.hash,
    policyHash,
    toolVersion,
    artifacts: artifactHashes,
  };

  return {
    status: STATUS.PASS,
    candidateId: digest(identity),
    reason: `the candidate is identified by ${entries.length} index entr(y|ies) at ${snapshot.identity.head ?? '(unborn HEAD)'}${artifactHashes.length > 0 ? ` and ${artifactHashes.length} declared artifact(s)` : ''}`,
    evidence: [
      makeEvidence({
        type: EVIDENCE_TYPE.GIT,
        source: 'git ls-files --stage -z + git cat-file --batch-check',
        observed: {
          headOid: identity.headOid,
          entryCount: entries.length,
          entriesDigest: digest(entries),
          snapshotHash: identity.snapshotHash,
          policyHash,
          toolVersion,
          artifacts: artifactHashes,
          scope: 'a verifiable identity of the candidate as it stands; not a recoverable snapshot and not storage',
        },
      }),
    ],
  };
}

/**
 * Does the repository still reproduce this exact candidate?
 *
 * An authorisation is valid only while it does. Anything that moves -- the
 * commit, a staged byte, a file mode, a path, the snapshot, the policy, the
 * tool, a declared artifact -- yields a different id and the authorisation
 * stops applying. It is never repaired; it is recomputed.
 */
export function candidateStillHolds(expectedId, current) {
  return current.status === STATUS.PASS && current.candidateId === expectedId;
}
