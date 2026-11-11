// Act two: authorization.
//
// An authorization is issued only when there is nothing left unresolved: the
// gate passed, the candidate was identified, and every required check reached
// PASS. Anything else -- a FAIL, an UNKNOWN, a required check that never ran --
// refuses, and the refusal names what stood in the way.
//
// WHAT A RECEIPT IS: a content-addressed binding between one decision, one
// candidate, and -- since 1.1.0 -- one exact publication: the operation, the
// target, and the hash of the exact bytes. The binding sits in the record
// BEFORE receiptId is computed, so a detached signature over receiptId
// expresses exactly: "I authorize publishing these exact bytes, via this
// operation, to this target." Recomputing the id from the record's own fields
// detects any edit.
//
// WHAT IT IS NOT, by itself: a signature. There is no key here. The receipt
// proves nothing about who issued it and resists no forgery -- anyone who can
// write the document can write a consistent one. The document says so in its
// own `notASignature` field. The signature, when one exists, is the separate
// signatures/<receiptId>.sig.json artifact produced by the human-run signer.
//
// The three artifacts, said once and repeated in the docs: the receipt is
// WHICH publication you authorized, the ticket is the consumable right to
// execute it, and the attempt is what actually happened.

import { digest } from './canonical.mjs';
import { STATUS } from './status.mjs';
import { evidenceIntact, unsatisfiedRequirements, gateStatusContradiction } from './evidence-record.mjs';

export const AUTHORIZATION_VERSION = '1.1.0';

export const PUBLICATION_OPERATIONS = Object.freeze(['issue-create', 'issue-comment']);

/**
 * pr-create is RETIRED, not merely absent. The publisher's argv carried no
 * --base/--head, so gh resolved the head from whatever branch the CWD had
 * checked out and the base from the repository default: the commits being
 * proposed and the target branch sat entirely outside the signed binding, and
 * a valid receipt could be spent from any branch. Retirarla es reducción de
 * superficie; dejarla parcialmente ligada es deuda disfrazada de capacidad.
 * The bound version gets designed when a real PR needs it, against the
 * requirements bar recorded in the README.
 */
export const PR_CREATE_UNSUPPORTED_REASON =
  'pr-create is not supported: its result cannot be fully bound under the current contract (the proposed commits and target branch would sit outside the signature). '
  + 'Full binding will require: baseRef; headRef with owner:branch semantics; immutable commit identity (SHA, never only branch names); '
  + 'mandatory --base/--head in the executed argv; and post-publish verification of effective body, title, base and head/commits.';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REPO_NAME = /^[^/\s]+\/[^/\s]+$/;
/** Same shape lib/store/paths.mjs admits as a lineage name; the store re-checks existence. */
const LINEAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The lineages a receipt declares it depends on, as the record carries them.
 * A receipt written before the field existed carries none, and none is what
 * it means: the field is additive, so every 1.1.0 receipt on disk still
 * validates and reads as `[]`.
 */
export const receiptDependsOn = (receipt) => [...(receipt?.publication?.dependsOn ?? [])];

/**
 * Everything wrong with a publication binding, as refusal sentences.
 *
 * The same cross-field rules the ticket used to enforce at reservation now
 * hold at authorization, because the receipt is where the binding lives: a
 * comment names its target, a create cannot have one yet, and issue-create --
 * the one supported operation that publishes a title -- binds its hash. A
 * title outside the binding would let a valid signed receipt publish under a
 * changed title without invalidating anything, which contradicts the one
 * sentence the signature expresses. The retired pr-create refuses with its
 * own complete reason, never as a generic enum miss.
 */
export function publicationBindingProblems(publication) {
  if (publication === null || publication === undefined || typeof publication !== 'object') {
    return ['the authorization names no publication binding: the operation, the target repository, and the hash of the exact bytes are required before a receipt exists'];
  }

  const problems = [];
  const { operation, targetRepo, targetNumber, bodySha256, titleSha256, dependsOn } = publication;

  // Shape only, here: an array of lineage names. Whether each one exists,
  // is open, is not this lineage, and does not depend back is the store's
  // question, because only the store can see the other lineages.
  if (dependsOn !== undefined && dependsOn !== null) {
    if (!Array.isArray(dependsOn) || dependsOn.some((name) => typeof name !== 'string' || !LINEAGE_NAME.test(name))) {
      problems.push('dependsOn must be a list of lineage names (1-128 chars of [A-Za-z0-9._-], starting alphanumeric)');
    }
  }

  if (operation === 'pr-create') {
    problems.push(PR_CREATE_UNSUPPORTED_REASON);
  } else if (!PUBLICATION_OPERATIONS.includes(operation)) {
    problems.push(`the operation must be one of ${PUBLICATION_OPERATIONS.join(', ')}`);
  }
  if (typeof targetRepo !== 'string' || !REPO_NAME.test(targetRepo)) {
    problems.push('the target repository must be owner/name');
  }
  if (typeof bodySha256 !== 'string' || !SHA256.test(bodySha256)) {
    problems.push('the body hash must be sha256:<64 hex> over the normalized body');
  }
  if (operation === 'issue-comment') {
    if (!Number.isInteger(targetNumber) || targetNumber < 1) {
      problems.push('a comment names the issue or pull request it lands on');
    }
  } else if (targetNumber !== null && targetNumber !== undefined) {
    problems.push(`${operation} creates its target, so a target number cannot exist yet`);
  }
  if (operation === 'issue-create') {
    if (typeof titleSha256 !== 'string' || !SHA256.test(titleSha256)) {
      problems.push('issue-create publishes a title too, and its hash is part of the binding');
    }
  } else if (titleSha256 !== null && titleSha256 !== undefined && PUBLICATION_OPERATIONS.includes(operation)) {
    problems.push(`${operation} binds no title; titleSha256 must be null`);
  }
  return problems;
}

/** The binding exactly as the receipt records it: absent optionals become explicit nulls. */
export function normalizedPublicationBinding({ operation, targetRepo, targetNumber, bodySha256, titleSha256, dependsOn }) {
  return {
    operation,
    targetRepo,
    targetNumber: targetNumber ?? null,
    bodySha256,
    titleSha256: titleSha256 ?? null,
    // Publication dependencies: lineages that must have PUBLISHED (a recorded
    // attempt with outcome published and bodyIdentical true) before this one
    // may. Inside the binding, so the signature over receiptId covers the
    // ordering the body assumes -- a body true at audit time and false at
    // publish time is refused by the store, not remembered by a person.
    dependsOn: [...(dependsOn ?? [])],
  };
}

export const NOT_A_SIGNATURE =
  'This is a content-addressed receipt, not a cryptographic signature. It binds a decision to a candidate and detects edits to itself; it proves nothing about who issued it and resists no forgery.';

/**
 * Issue an authorization for an evidence record, or refuse and say why.
 *
 * @returns {{authorized: boolean, receipt: object|null, refusals: string[]}}
 */
export function authorize({ evidence, artifacts = [], publication }) {
  const refusals = [];

  if (!evidenceIntact(evidence)) {
    // Nothing else is worth checking: the document does not describe itself.
    return { authorized: false, receipt: null, refusals: ['the evidence record does not match its own id; it was altered after it was produced'] };
  }
  if (evidence.authorises !== false) {
    refusals.push('the evidence record claims to authorise, which no evidence record may do');
  }

  // No binding, no receipt. An authorization that does not say what it
  // authorizes publishing is the blank check this version removes.
  refusals.push(...publicationBindingProblems(publication));

  const artifactPathCounts = new Map();
  for (const artifact of artifacts) {
    if (typeof artifact?.path !== 'string') continue;
    artifactPathCounts.set(artifact.path, (artifactPathCounts.get(artifact.path) ?? 0) + 1);
  }
  const duplicateArtifactPaths = [...artifactPathCounts]
    .filter(([, count]) => count > 1)
    .map(([path]) => path)
    .sort();
  if (duplicateArtifactPaths.length > 0) {
    refusals.push(`artifact paths must be unique; duplicated: ${duplicateArtifactPaths.join(', ')}`);
  }

  if (evidence.gateStatus !== STATUS.PASS) {
    refusals.push(`the gate reported ${evidence.gateStatus}, and only PASS authorises`);
  }
  // The claimed status is compared against what the record's own
  // verifications aggregate to. Zero required checks aggregate to UNKNOWN, so
  // a PASS over nothing refuses here even though "every required check
  // reached PASS" below is vacuously true of it (ASTRA-04). The engine never
  // emits such a record; a hand-edited one did.
  const contradiction = gateStatusContradiction(evidence);
  if (contradiction !== null) refusals.push(contradiction);
  if (evidence.binding.stable === false) {
    refusals.push('the repository changed while the gate ran, so the verifications describe a state that is no longer present');
  }
  if (evidence.candidate.status !== STATUS.PASS || evidence.candidate.candidateId === null) {
    refusals.push(`the candidate could not be identified: ${evidence.candidate.reason}`);
  }

  const unsatisfied = unsatisfiedRequirements(evidence);
  if (unsatisfied.length > 0) {
    refusals.push(
      `${unsatisfied.length} required check(s) did not reach PASS: ${unsatisfied.map((entry) => entry.id).join(', ')}`
    );
  }

  if (refusals.length > 0) return { authorized: false, receipt: null, refusals };

  const bound = {
    authorizationVersion: AUTHORIZATION_VERSION,
    kind: 'content-addressed-receipt',
    notASignature: NOT_A_SIGNATURE,
    gate: evidence.gate,
    evidenceId: evidence.evidenceId,
    candidateId: evidence.candidate.candidateId,
    decisionId: evidence.binding.decisionId,
    snapshotHash: evidence.binding.snapshotHash,
    policyHash: evidence.binding.policyHash,
    toolVersion: evidence.binding.toolVersion,
    // Inside the record BEFORE receiptId is computed: the signature over the
    // id therefore covers the exact publication, not just the candidate.
    publication: normalizedPublicationBinding(publication),
    artifacts: [...artifacts].sort((left, right) => (left.path < right.path ? -1 : 1)),
  };

  // Frozen: a correction produces another identity and another receipt, never
  // an amended one.
  return { authorized: true, refusals: [], receipt: Object.freeze({ ...bound, receiptId: digest(bound) }) };
}

/** Re-derive the receipt id from its own fields. Any edit shows up here. */
export function receiptIntact(receipt) {
  if (receipt === null || typeof receipt !== 'object') return false;
  const { receiptId, ...bound } = receipt;
  return receiptId === digest(bound);
}

/**
 * Does this receipt authorise this exact candidate, right now?
 *
 * Both halves matter: the receipt must be unaltered, and the identity computed
 * from the current repository must equal the one it names.
 */
export function receiptGoverns(receipt, currentCandidate) {
  if (!receiptIntact(receipt)) return { governs: false, reason: 'the receipt does not match its own id; it was altered' };
  if (currentCandidate.status !== STATUS.PASS || currentCandidate.candidateId === null) {
    return { governs: false, reason: `the candidate cannot be identified now: ${currentCandidate.reason}` };
  }
  if (currentCandidate.candidateId !== receipt.candidateId) {
    return {
      governs: false,
      reason: `the receipt authorises ${receipt.candidateId} and the repository now holds ${currentCandidate.candidateId}`,
    };
  }
  return { governs: true, reason: 'the repository still reproduces the candidate this receipt authorises' };
}
