// The contribution store.
//
// Immutable artifact kinds live here as separate content-addressed files, and
// an index references them. New immutable artifacts are prepared first, the
// index (the authoritative manifest) commits last, and only non-authoritative
// aliases or cleanup run afterward. A crash can leave extra inert artifacts, but
// a durable index never names an artifact that was not already durable. This is
// manifest-last ordering, not a claim of whole-filesystem atomicity.
//
// Every mutation happens under the lock. Every read validates the schema and
// recomputes the id; a document that does not describe itself blocks, and is
// never repaired.
//
// NO SIGNATURES. Persisting a receipt does not make it harder to forge:
// anyone who can write into this directory can write a consistent one. The
// store gives continuity and auditability, not authority. That sentence is
// written into store.json itself, for the same reason `notASignature` is
// written into every receipt.

import { readFileSync, existsSync, readdirSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { writeAtomic, sweepTemporaries } from './atomic.mjs';
import { withLock } from './lock.mjs';
import { resolveStoreRoot, withinStore, assertContentId, assertLineageName } from './paths.mjs';
import { digest } from '../canonical.mjs';
import { STATUS } from '../status.mjs';
import { evaluateIntake } from '../intake.mjs';
import { evidenceIntact, derivedGateStatus, gateStatusContradiction } from '../evidence-record.mjs';
import { authorize as issueAuthorization, receiptIntact, receiptDependsOn, PR_CREATE_UNSUPPORTED_REASON } from '../authorization.mjs';
import { attemptIntact } from '../publication.mjs';
import { ticketOf, ticketIntact, ticketExpired, normalizeBody } from '../ticket.mjs';
import { retirementOf, retirementIntact } from '../retirement.mjs';
import { validateEvidence, validateAuthorization, validatePublication, validateTicket, validateSignature, validateAuditorResult, validateRetirement } from '../validate.mjs';
import { admitAuditorResult, auditorResultIntact, deriveAuditDecision, derivesOwnVerdict } from '../auditor-result.mjs';
import { acceptanceTrace } from '../decision-package.mjs';
import {
  admitTaskContract,
  assessAcceptanceCoverage,
  taskContractIntact,
  validateTaskContractDocument,
} from '../task-contract.mjs';
import { readEnforcement, signedReceiptsRequired } from '../enforcement.mjs';
import { keyFingerprint, verifySignedReceiptId, DEFAULT_PUBKEY_PATH } from '../signing.mjs';
import { assertAnchoredFingerprint, ANCHOR_PATH, AnchorError } from '../anchor.mjs';

export const STORE_VERSION = '1.0.0';

export const NO_SIGNATURE_WARNING =
  'This store uses no cryptographic signature and establishes no issuer identity. Anyone able to write into this directory can write a consistent receipt. It provides continuity and auditability, not authority.';

/** state -> operation -> next state. An operation absent from a state is refused. */
const MACHINE = Object.freeze({
  FROZEN: { 'record-audit': true, retire: 'RETIRED' },
  AUDITED_PASS: { authorize: 'AUTHORIZED', 'record-audit': true, retire: 'RETIRED' },
  NEEDS_CHANGES: { 'reserve-correction': 'CORRECTION_RESERVED', 'record-audit': true, retire: 'RETIRED' },
  CORRECTION_RESERVED: { refreeze: 'REFROZEN', retire: 'RETIRED' },
  REFROZEN: { 'record-audit': true, retire: 'RETIRED' },
  REAUDITED: { authorize: 'AUTHORIZED', 'record-audit': true, retire: 'RETIRED' },
  // `authorize` from AUTHORIZED/PUBLISHABLE is re-authorization: publishing
  // the same candidate to a DIFFERENT target is a new authorization, and the
  // lineage holds one current receipt. The previous receipt is archived, any
  // live ticket is superseded, and the lineage resets to AUTHORIZED.
  AUTHORIZED: { 'gate-publish': 'PUBLISHABLE', authorize: 'AUTHORIZED', 'attach-signature': 'AUTHORIZED', retire: 'RETIRED' },
  PUBLISHABLE: { 'reserve-attempt': 'PUBLISHABLE', 'record-attempt': 'PUBLISHABLE', authorize: 'AUTHORIZED', 'attach-signature': 'PUBLISHABLE', retire: 'RETIRED' },
  NEEDS_MAINTAINER: { retire: 'RETIRED' },
  BLOCKED_INCOMPLETE: { refreeze: 'REFROZEN', retire: 'RETIRED' },
  // Two terminal states. STALE is reached by refusal (the candidate moved);
  // RETIRED is reached by decision (`retire`, from any non-terminal state).
  // Neither leads anywhere, and neither can be retired: a STALE lineage never
  // held anything spendable, and a retired one is already closed.
  STALE: {},
  RETIRED: {},
});

/** The states `retire` starts from: everything that is not already terminal. */
export const RETIRABLE_STATES = Object.freeze(
  Object.entries(MACHINE).filter(([, operations]) => 'retire' in operations).map(([state]) => state)
);

export class StoreError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'StoreError';
    this.detail = detail;
  }
}

/**
 * A refusal that could not be made durable.
 *
 * Raised when a typed refusal carried a transition -- STALE, NEEDS_MAINTAINER --
 * and persisting it failed. It deliberately does NOT claim the lineage reached
 * that state, because it did not: the refusal stands, the transition was lost.
 * Reporting the state anyway would be the exact overclaim this layer exists to
 * prevent.
 */
export class StoreDurabilityError extends Error {
  constructor(refusal, cause) {
    super(
      'the refusal was decided but its state transition could not be persisted, so the lineage did NOT reach the state the refusal implies. '
      + `Refusal: ${refusal.message}. Durability failure: ${cause?.message ?? String(cause)}`
    );
    this.name = 'StoreDurabilityError';
    this.refusal = refusal;
    this.cause = cause;
    this.detail = { failure: 'durability', transitionPersisted: false, refusal: refusal.detail ?? {} };
  }
}

const refuse = (message, detail) => { throw new StoreError(message, detail); };

/** A refusal that IS a transition, and must survive being refused. */
const refuseAndCommit = (message, detail) => { throw new StoreError(message, { ...detail, commitTransition: true }); };

const commitsTransition = (error) => error instanceof StoreError && error.detail?.commitTransition === true;

const LINEAGE_FIELDS = Object.freeze({
  lineage: 'string', state: 'string',
  correction_budget: 'number', corrections_used: 'number', attempts: 'number',
  intake_status: 'string',
  taskContractDigest: 'string', taskContractSha256: 'string',
  draftBodySha256: 'string',
  // Consumptions this store CONFIRMED, written in the same transaction as the
  // consumption, each carrying the consumed ticket's immutable identity:
  // {attemptNumber, ticketId, receiptId, candidateId, evidenceId}. The index
  // is the only authority: tickets/consumed/<lineage>-<n>.json is prepared
  // BEFORE the manifest write, so a failure between the two leaves that
  // artifact on disk with no consumption having happened. recordAttempt
  // believes this list, never the file -- and compares the attempt against
  // the consumed ticket, never against the lineage's CURRENT receipt or
  // evidence, which re-authorization and record-evidence can move after the
  // consumption (ASTRA-03, and its first-candidate escalation).
  consumedAttempts: 'object',
});

const CONSUMPTION_IDS = Object.freeze(['ticketId', 'receiptId', 'candidateId', 'evidenceId']);

function assertConsumptionsShape(name, entry) {
  if (!Object.hasOwn(entry, 'consumedAttempts')) return;
  const bad = (why) => { throw new StoreError(`lineage "${name}" carries consumedAttempts that ${why}`, { failure: 'invalid-draft', lineage: name, field: 'consumedAttempts' }); };
  if (!Array.isArray(entry.consumedAttempts)) bad('is not a list');
  const seen = new Set();
  for (const consumption of entry.consumedAttempts) {
    if (consumption === null || typeof consumption !== 'object' || Array.isArray(consumption)) bad('hold a non-object consumption');
    const { attemptNumber } = consumption;
    if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > entry.attempts) bad('name an attempt number the lineage never issued');
    if (seen.has(attemptNumber)) bad(`confirm attempt ${attemptNumber} twice`);
    seen.add(attemptNumber);
    for (const field of CONSUMPTION_IDS) {
      if (typeof consumption[field] !== 'string' || !SHA256_ID.test(consumption[field])) bad(`lack the consumed ticket's ${field}`);
    }
  }
}

/**
 * Fields validated only when the entry carries them.
 *
 * Stores written before intake, task-contract or draft binding hold lineages
 * without those fields. Refusing to read them would turn a new requirement
 * into corruption of an existing record. Every lineage frozen from here on
 * carries them; the exemption covers history, not new writes or new
 * authorization.
 */
const OPTIONAL_LINEAGE_FIELDS = new Set(['intake_status', 'taskContractDigest', 'taskContractSha256', 'draftBodySha256', 'consumedAttempts']);

/** The confirmed consumptions a lineage carries; a historical entry without the field carries none. */
const consumedAttemptsOf = (entry) => (Array.isArray(entry.consumedAttempts) ? entry.consumedAttempts : []);

const SHA256_ID = /^sha256:[0-9a-f]{64}$/;

/**
 * The draft binding a freeze must declare: the digest of the draft AFTER the
 * publication normalization (`bodyDigest`), which is the representation the
 * receipt, the ticket and the publisher all hash. It sits BESIDE subject_id,
 * never inside it: subject_id keeps the raw `draftDigest`, so no identity
 * ever minted moves. Without this field `authorize` had nothing to compare
 * the publication body against, and a body other than the audited draft
 * could be authorized while the audit PASS stayed attached to the lineage.
 */
function admitDraftBinding(input) {
  if (typeof input.draftBodySha256 !== 'string' || !SHA256_ID.test(input.draftBodySha256)) {
    refuse(
      'freeze requires draftBodySha256: the sha256:<64 hex> digest of the draft after publication normalization (bodyDigest), which authorize compares the publication body against',
      { failure: 'missing-input', key: 'draftBodySha256' }
    );
  }
  const draftTitleSha256 = input.draftTitleSha256 ?? null;
  if (draftTitleSha256 !== null && (typeof draftTitleSha256 !== 'string' || !SHA256_ID.test(draftTitleSha256))) {
    refuse('draftTitleSha256 must be null or a sha256:<64 hex> digest', { failure: 'missing-input', key: 'draftTitleSha256' });
  }
  const { draftBodySha256, ...subjectFields } = input;
  return { draftBodySha256, draftTitleSha256, subjectFields };
}

/** Full validation of a draft before it is allowed to become the store. */
export function assertIndexShape(index) {
  if (index === null || typeof index !== 'object' || Array.isArray(index)) {
    throw new StoreError('the draft index is not an object', { failure: 'invalid-draft' });
  }
  if (index.storeVersion !== STORE_VERSION) {
    throw new StoreError(`the draft index declares storeVersion ${JSON.stringify(index.storeVersion)}`, { failure: 'invalid-draft' });
  }
  if (index.lineages === null || typeof index.lineages !== 'object' || Array.isArray(index.lineages)) {
    throw new StoreError('the draft index holds no lineages object', { failure: 'invalid-draft' });
  }
  if (!Array.isArray(index.migratedFrom)) {
    throw new StoreError('the draft index holds no migratedFrom array', { failure: 'invalid-draft' });
  }

  for (const [name, entry] of Object.entries(index.lineages)) {
    assertLineageName(name);
    if (entry === null || typeof entry !== 'object') {
      throw new StoreError(`lineage "${name}" is not an object`, { failure: 'invalid-draft', lineage: name });
    }
    for (const [field, type] of Object.entries(LINEAGE_FIELDS)) {
      if (OPTIONAL_LINEAGE_FIELDS.has(field) && !Object.hasOwn(entry, field)) continue;
      if (typeof entry[field] !== type) {
        throw new StoreError(`lineage "${name}" has no ${field} of type ${type}`, { failure: 'invalid-draft', lineage: name, field });
      }
    }
    if (Object.hasOwn(entry, 'draftTitleSha256') && entry.draftTitleSha256 !== null
      && (typeof entry.draftTitleSha256 !== 'string' || !SHA256_ID.test(entry.draftTitleSha256))) {
      throw new StoreError(`lineage "${name}" has an invalid draftTitleSha256`, { failure: 'invalid-draft', lineage: name });
    }
    if (entry.lineage !== name) {
      throw new StoreError(`lineage "${name}" carries the name ${JSON.stringify(entry.lineage)}`, { failure: 'invalid-draft', lineage: name });
    }
    if (!Object.hasOwn(MACHINE, entry.state)) {
      throw new StoreError(`lineage "${name}" is in unknown state ${JSON.stringify(entry.state)}`, { failure: 'invalid-draft', lineage: name });
    }
    if (entry.corrections_used > entry.correction_budget) {
      throw new StoreError(`lineage "${name}" spent more corrections than its budget`, { failure: 'invalid-draft', lineage: name });
    }
    assertConsumptionsShape(name, entry);
    // A retired lineage names its retirement. RETIRED without a retirementId
    // would be a closed door with no record of who closed it.
    if (entry.state === 'RETIRED' && (typeof entry.retirementId !== 'string' || typeof entry.retiredAt !== 'string')) {
      throw new StoreError(`lineage "${name}" is RETIRED but names no retirement`, { failure: 'invalid-draft', lineage: name });
    }
  }
  return index;
}

/**
 * One transaction over the index.
 *
 * The work receives a COPY. The persisted index is never handed to it, so a
 * partial mutation followed by an unexpected exception reaches neither disk
 * nor any later reader.
 *
 * Exactly two outcomes persist:
 *   - the work completed;
 *   - the work refused with a typed refusal declaring `commitTransition`,
 *     because some refusals ARE transitions, and losing them would leave a
 *     lineage that refuses once and then behaves as if nothing happened.
 *
 * Everything else discards the draft. And when persisting a committing refusal
 * fails, that is a durability error, not something to swallow: the refusal
 * stands, the transition did not.
 */
export function runTransaction({ read, write, work, validate = assertIndexShape }) {
  const persisted = read();
  const draft = structuredClone(persisted);
  const effects = [];
  const transaction = Object.freeze({
    stage(effect) {
      if (effect === null || typeof effect !== 'object') {
        throw new StoreError('a transaction effect must be an object', { failure: 'invalid-transaction-effect' });
      }
      effects.push({
        prepare: typeof effect.prepare === 'function' ? effect.prepare : () => {},
        cleanup: typeof effect.cleanup === 'function' ? effect.cleanup : () => {},
      });
    },
  });

  const persist = () => {
    validate(draft);
    // Manifest-last: every authoritative artifact reaches its final immutable
    // path before the draft can become the durable index. Preparation failure
    // or index failure may leave extra files, but readers treat them as inert
    // unless this committed draft names their exact identity.
    for (const effect of effects) effect.prepare();
    write(draft);

    // Once the authoritative index is durable, cleanup cannot reverse the
    // operation. Keep every failure as explicit evidence and leave the debris
    // inert for a later cleanup rather than reporting a committed operation as
    // failed. Each cleanup is independent, so one failure does not suppress the
    // evidence from later effects.
    const cleanupWarnings = [];
    for (const effect of effects) {
      try {
        effect.cleanup();
      } catch (cause) {
        cleanupWarnings.push({
          failure: 'artifact-cleanup',
          indexPersisted: true,
          message: cause?.message ?? String(cause),
        });
      }
    }
    return cleanupWarnings;
  };

  let outcome;
  try {
    outcome = work(draft, transaction);
  } catch (error) {
    if (!commitsTransition(error)) throw error;
    let cleanupWarnings;
    try {
      cleanupWarnings = persist();
    } catch (cause) {
      throw new StoreDurabilityError(error, cause);
    }
    if (cleanupWarnings.length > 0) error.detail = { ...error.detail, cleanupWarnings };
    throw error;
  }

  const cleanupWarnings = persist();
  if (cleanupWarnings.length === 0) return outcome;
  if (outcome !== null && typeof outcome === 'object' && !Array.isArray(outcome)) {
    return { ...outcome, cleanupWarnings };
  }
  return { value: outcome, cleanupWarnings };
}
// -- layout ---------------------------------------------------------------------

export function storeLayout(root) {
  return {
    root,
    index: withinStore(root, 'store.json'),
    lock: withinStore(root, 'store.lock'),
    evidence: withinStore(root, 'evidence'),
    auditResults: withinStore(root, 'audit-results'),
    taskContracts: withinStore(root, 'task-contracts'),
    authorizations: withinStore(root, 'authorizations'),
    // A replaced receipt is archived here untouched: attempts already recorded
    // keep referring to its receiptId, and history is never rewritten.
    authorizationsSuperseded: withinStore(root, 'authorizations', 'superseded'),
    attempts: withinStore(root, 'attempts'),
    tickets: withinStore(root, 'tickets'),
    ticketArtifacts: withinStore(root, 'tickets', 'artifacts'),
    // Never deleted, only moved: a swept or consumed ticket is the record that
    // an attempt was reserved, and deleting it would delete the accounting.
    ticketsExpired: withinStore(root, 'tickets', 'expired'),
    ticketsConsumed: withinStore(root, 'tickets', 'consumed'),
    // A ticket invalidated by re-authorization: its receipt is no longer the
    // lineage's current one, so the right it carried no longer exists.
    ticketsSuperseded: withinStore(root, 'tickets', 'superseded'),
    // Two-phase authorize: the request the human signer answers, and the
    // detached signatures it produces.
    pendingSignature: withinStore(root, 'pending-signature'),
    signatures: withinStore(root, 'signatures'),
    // One content-addressed record per closed lineage: from which state, why,
    // and what it carried. The receipt it held goes to authorizations/superseded/.
    retirements: withinStore(root, 'retirements'),
  };
}

const artifactPath = (directory, id) => join(directory, `${assertContentId(id)}.json`);

// -- index ------------------------------------------------------------------------

function emptyIndex() {
  return { storeVersion: STORE_VERSION, notASignature: NO_SIGNATURE_WARNING, lineages: {}, migratedFrom: [] };
}

function readIndex(layout) {
  if (!existsSync(layout.index)) return emptyIndex();

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(layout.index, 'utf8'));
  } catch (error) {
    refuse(`the store index at ${layout.index} is unreadable; refusing to guess its contents`, { failure: 'unreadable-index', error: error.message });
  }

  if (parsed?.storeVersion !== STORE_VERSION) {
    refuse(
      `the store declares storeVersion ${JSON.stringify(parsed?.storeVersion)} and this engine only supports ${STORE_VERSION}`,
      { failure: 'incompatible-version', found: parsed?.storeVersion ?? null }
    );
  }
  if (parsed.lineages === null || typeof parsed.lineages !== 'object' || Array.isArray(parsed.lineages)) {
    refuse('the store index holds no lineages object', { failure: 'malformed-index' });
  }

  return { ...emptyIndex(), ...parsed };
}

function writeIndex(layout, index, writer = writeAtomic) {
  writer(layout.index, `${JSON.stringify({ ...index, notASignature: NO_SIGNATURE_WARNING }, null, 2)}\n`);
}

/** Read a stored artifact, validating its schema and its own id. */
const sha256Bytes = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function readArtifact(path, { validate, idField, recompute, expectedByteSha256 = null }) {
  if (!existsSync(path)) refuse(`the artifact ${path} is referenced by the index but absent`, { failure: 'missing-artifact', path });

  let bytes;
  let document;
  try {
    bytes = readFileSync(path);
    document = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    refuse(`the artifact ${path} is not readable JSON`, { failure: 'corrupt-artifact', path, error: error.message });
  }

  if (expectedByteSha256 !== null && sha256Bytes(bytes) !== expectedByteSha256) {
    refuse(`the artifact ${path} bytes do not match the digest recorded by the index`, {
      failure: 'artifact-bytes-mismatch', path, expected: expectedByteSha256, found: sha256Bytes(bytes),
    });
  }

  const { valid, errors } = validate(document);
  if (!valid) {
    refuse(`the artifact ${path} violates its schema: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { failure: 'invalid-artifact', path });
  }
  if (!recompute(document)) {
    refuse(`the artifact ${path} does not match its own ${idField}; it was altered`, { failure: 'tampered-artifact', path });
  }
  return document;
}

const readEvidence = (path) => readArtifact(path, { validate: validateEvidence, idField: 'evidenceId', recompute: evidenceIntact });
const readAuditResult = (path, expectedByteSha256 = null) => readArtifact(path, {
  validate: validateAuditorResult, idField: 'auditResultId', recompute: auditorResultIntact, expectedByteSha256,
});
const readTaskContract = (path, expectedByteSha256 = null) => readArtifact(path, {
  validate: validateTaskContractDocument,
  idField: 'taskContractDigest',
  recompute: taskContractIntact,
  expectedByteSha256,
});
const readReceipt = (path) => readArtifact(path, { validate: validateAuthorization, idField: 'receiptId', recompute: receiptIntact });
const readLiveTicket = (path) => readArtifact(path, { validate: validateTicket, idField: 'ticketId', recompute: ticketIntact });
const readRetirement = (path) => readArtifact(path, { validate: validateRetirement, idField: 'retirementId', recompute: retirementIntact });

/**
 * The forward path -- gate-publish, reserve-attempt -- runs only over receipts
 * that carry the publication binding. A 1.0.0 receipt stays readable as
 * history (its attempts remain listable), but it never authorizes another
 * publication: the refusal names re-authorization as the way through.
 */
function assertReceiptBinding(receipt, lineage) {
  if (receipt.publication === undefined) {
    refuse(
      `the receipt for lineage "${lineage}" (authorizationVersion ${receipt.authorizationVersion}) predates publication-bound authorization and names no publication; re-authorize with the publication binding (authorize --operation ... --target-repo ... --body-file ...) to proceed`,
      { failure: 'bindingless-receipt', lineage, receiptId: receipt.receiptId, authorizationVersion: receipt.authorizationVersion }
    );
  }
  return receipt.publication;
}

function boundTaskContract(layout, entry, receipt = null) {
  const hasDigest = entry.taskContractDigest !== undefined;
  const hasByteDigest = entry.taskContractSha256 !== undefined;
  if (!hasDigest && !hasByteDigest) return null;
  if (!hasDigest || !hasByteDigest) {
    refuse('the lineage carries a partial task-contract binding; refusing to guess whether it is historical or task-bound', {
      failure: 'partial-task-contract-binding',
      lineage: entry.lineage,
      remediation: 'Restore both original taskContractDigest and taskContractSha256 fields from the authoritative store backup, or freeze a new lineage.',
    });
  }
  const relativePath = `task-contracts/${assertContentId(entry.taskContractDigest)}.json`;
  const taskContract = readTaskContract(
    artifactPath(layout.taskContracts, entry.taskContractDigest),
    entry.taskContractSha256
  );
  if (receipt !== null) {
    const descriptor = receipt.artifacts.find((artifact) => artifact.path === relativePath);
    if (descriptor?.sha256 !== entry.taskContractSha256) {
      refuse('the current authorization does not bind the frozen task-contract bytes', {
        failure: 'task-contract-artifact-binding-mismatch',
        lineage: entry.lineage,
        receiptId: receipt.receiptId,
        path: relativePath,
      });
    }
  }
  return { taskContract, artifact: { path: relativePath, sha256: entry.taskContractSha256 } };
}

function boundAuditResult(layout, entry, receipt = null, taskBinding = undefined) {
  if (entry.auditResultId === null || entry.auditResultId === undefined
    || entry.auditResultSha256 === null || entry.auditResultSha256 === undefined) {
    refuse(
      `this historical lineage has no byte-bound durable auditor result. Next action: run record-audit --result <auditor-result.json> for this unchanged frozen subject; no backfill is inferred.`,
      { failure: 'missing-auditor-result', lineage: entry.lineage }
    );
  }
  const relativePath = `audit-results/${assertContentId(entry.auditResultId)}.json`;
  const auditResult = readAuditResult(artifactPath(layout.auditResults, entry.auditResultId), entry.auditResultSha256);
  if (auditResult.subject_id !== entry.subject_id) {
    refuse('the durable auditor result is not bound to this frozen subject', {
      failure: 'audit-result-not-authorizing', lineage: entry.lineage, auditResultId: entry.auditResultId,
    });
  }
  const task = taskBinding === undefined ? boundTaskContract(layout, entry, receipt) : taskBinding;
  if (task !== null) {
    if (!['auditor-result/v2', 'auditor-result/v3', 'auditor-result/v4'].includes(auditResult.schemaVersion)
      || auditResult.taskContractDigest !== task.taskContract.taskContractDigest) {
      refuse('the durable auditor result does not cover this frozen task contract', {
        failure: 'audit-task-contract-mismatch',
        lineage: entry.lineage,
        auditResultId: entry.auditResultId,
      });
    }
    const coverage = assessAcceptanceCoverage(task.taskContract, auditResult.acceptanceCoverage);
    if (auditResult.acceptanceCoverageDigest !== digest(auditResult.acceptanceCoverage)
      || (auditResult.verdict === 'PASS' && !coverage.satisfied)) {
      refuse('the durable auditor result does not carry intact complete acceptance coverage for this task contract', {
        failure: 'audit-coverage-mismatch',
        lineage: entry.lineage,
        auditResultId: entry.auditResultId,
        remediation: coverage.remediation,
      });
    }
    // v3 and v4: the stored verdict must be the one its own decisions and design
    // coverage derive. v2 results are history and are never re-derived here.
    if (derivesOwnVerdict(auditResult)) {
      const derived = deriveAuditDecision(auditResult);
      if (derived.verdict !== auditResult.verdict || derived.correctionEligible !== auditResult.correctionEligible) {
        refuse('the durable auditor result carries a verdict its own maintainer decisions and design coverage do not derive', {
          failure: 'audit-verdict-mismatch',
          lineage: entry.lineage,
          auditResultId: entry.auditResultId,
        });
      }
    }
  }
  if (receipt !== null) {
    const descriptor = receipt.artifacts.find((artifact) => artifact.path === relativePath);
    if (descriptor?.sha256 !== entry.auditResultSha256) {
      refuse('the current authorization does not bind the durable auditor-result bytes', {
        failure: 'audit-artifact-binding-mismatch', lineage: entry.lineage, receiptId: receipt.receiptId, path: relativePath,
      });
    }
  }
  return { auditResult, artifact: { path: relativePath, sha256: entry.auditResultSha256 } };
}

// Public edition: private incident history omitted. See the operational contract.

const TERMINAL_STATES = new Set(['STALE', 'RETIRED']);

/** Every attempt artifact recorded under one receipt, validated and intact. */
function attemptsUnder(layout, receiptId) {
  if (typeof receiptId !== 'string') return [];
  const directory = withinStore(layout.attempts, assertContentId(receiptId));
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith('.json')).sort()
    .map((name) => readArtifact(join(directory, name), { validate: validatePublication, idField: 'attemptId', recompute: attemptIntact }));
}

/** Did this attempt publish, and did the read-back confirm the bytes? The exact fields publish.mjs records. */
const attemptPublished = (attempt) => attempt.outcome === 'published' && attempt.detail?.bodyIdentical === true;

/**
 * At authorization: every declared dependency must name another, existing,
 * open lineage, once, and must not depend back on this one through its own
 * current receipt or any receipt further down the chain. Refused BEFORE any
 * artifact is prepared. Satisfaction is not required here -- the point of
 * declaring is to let the store hold the order until it is satisfied.
 */
function assertDependenciesDeclarable(index, layout, lineage, dependsOn) {
  const seen = new Set();
  for (const dependency of dependsOn) {
    assertLineageName(dependency);
    if (dependency === lineage) {
      refuse(`lineage "${lineage}" cannot depend on itself`, { failure: 'dependency-self', lineage, dependency });
    }
    if (seen.has(dependency)) {
      refuse(`"${dependency}" is listed more than once in --depends-on`, { failure: 'dependency-duplicate', lineage, dependency });
    }
    seen.add(dependency);
    const entry = index.lineages[dependency];
    if (entry === undefined) {
      refuse(`--depends-on names "${dependency}", which is not a lineage in this store; freeze it first`, {
        failure: 'dependency-unknown', lineage, dependency,
      });
    }
    if (TERMINAL_STATES.has(entry.state)) {
      refuse(`dependency "${dependency}" is ${entry.state}; a closed lineage will never publish, so nothing can wait for it`, {
        failure: 'dependency-closed', lineage, dependency, dependencyState: entry.state,
      });
    }
  }

  // Cycle: walk each dependency's CURRENT receipt and onward. A visited set
  // bounds the walk; a chain that reaches this lineage is refused with the
  // path that reached it.
  const walk = (name, path) => {
    const entry = index.lineages[name];
    if (entry === undefined || typeof entry.receiptId !== 'string') return;
    const receiptPath = artifactPath(layout.authorizations, entry.receiptId);
    if (!existsSync(receiptPath)) return;
    for (const next of receiptDependsOn(readReceipt(receiptPath))) {
      if (next === lineage) {
        refuse(`dependency cycle: ${[lineage, ...path, name, next].join(' -> ')}`, {
          failure: 'dependency-cycle', lineage, chain: [lineage, ...path, name, next],
        });
      }
      if (!path.includes(next) && next !== name) walk(next, [...path, name]);
    }
  };
  for (const dependency of dependsOn) walk(dependency, []);
}

/**
 * At every forward step: each dependency has published (one recorded attempt
 * with outcome `published` and `detail.bodyIdentical: true` under its current
 * receipt) and is not RETIRED. Re-evaluated every time; never cached in a state.
 */
function assertDependenciesSatisfied(index, layout, lineage, dependsOn, operation) {
  for (const dependency of dependsOn) {
    assertLineageName(dependency);
    const entry = index.lineages[dependency];
    if (entry === undefined) {
      refuse(`${operation} for "${lineage}" depends on "${dependency}", which is not a lineage in this store`, {
        failure: 'dependency-unknown', lineage, dependency, operation,
      });
    }
    if (entry.state === 'RETIRED') {
      refuse(`${operation} for "${lineage}" depends on "${dependency}", which is RETIRED (retirement ${entry.retirementId}) and will never publish`, {
        failure: 'dependency-closed', lineage, dependency, dependencyState: entry.state, retirementId: entry.retirementId, operation,
      });
    }
    const attempts = attemptsUnder(layout, entry.receiptId);
    const published = attempts.find(attemptPublished);
    if (published === undefined) {
      const missing = typeof entry.receiptId !== 'string'
        ? 'it holds no authorization yet'
        : attempts.length === 0
          ? 'no attempt has been recorded under its current receipt'
          : `its ${attempts.length} recorded attempt(s) include none with outcome published and bodyIdentical true`;
      refuse(`${operation} for "${lineage}" depends on "${dependency}", which has not published: ${missing}. Publish the dependency first.`, {
        failure: 'dependency-unpublished', lineage, dependency, dependencyState: entry.state, dependencyReceiptId: entry.receiptId ?? null, missing, operation,
      });
    }
  }
}

// -- lineage helpers ------------------------------------------------------------------

function lineageOf(index, name) {
  assertLineageName(name);
  const entry = index.lineages[name];
  if (entry === undefined) refuse(`unknown lineage "${name}"; freeze it first`, { failure: 'unknown-lineage', lineage: name });
  return entry;
}

/**
 * RETIRED is closed from every direction. Every operation that would read,
 * spend or advance a lineage passes through here first, so the refusal always
 * carries the same code and names the retirement that closed it -- including
 * the operations that never consulted the machine (record-evidence, the
 * ticket reads the publisher runs), because "any state" stopped meaning
 * "any state" the day a lineage could close.
 */
function assertNotRetired(entry, operation) {
  if (entry.state !== 'RETIRED') return;
  refuse(
    `lineage "${entry.lineage}" is RETIRED (retirement ${entry.retirementId}, retired at ${entry.retiredAt}); "${operation}" is refused, and so is everything else: a retired lineage does not reopen`,
    {
      failure: 'lineage-retired',
      lineage: entry.lineage,
      state: entry.state,
      operation,
      retirementId: entry.retirementId,
      retiredAt: entry.retiredAt,
      supersededBy: entry.supersededBy ?? null,
    }
  );
}

function allow(entry, operation) {
  assertNotRetired(entry, operation);
  const permitted = MACHINE[entry.state];
  if (permitted === undefined || !(operation in permitted)) {
    refuse(
      `operation "${operation}" is not reachable from state "${entry.state}"`,
      { failure: 'illegal-transition', lineage: entry.lineage, state: entry.state, operation }
    );
  }
  return permitted[operation];
}

export function deriveSubjectId(input) {
  for (const key of ['baseTree', 'candidateTree', 'pathsDigest', 'draftDigest', 'policyDigest', 'testManifestDigest', 'taskContractDigest']) {
    if (typeof input[key] !== 'string' || input[key] === '') refuse(`freeze requires ${key}`, { failure: 'missing-input', key });
  }
  if (input.draftTitleSha256 != null && (typeof input.draftTitleSha256 !== 'string' || !SHA256_ID.test(input.draftTitleSha256))) {
    refuse('draftTitleSha256 must be null or a sha256:<64 hex> digest', { failure: 'missing-input', key: 'draftTitleSha256' });
  }
  return digest([
    `base_tree=${input.baseTree}`,
    `candidate_tree=${input.candidateTree}`,
    `changed_paths_and_modes=${input.pathsDigest}`,
    `draft=${input.draftDigest}`,
    `policy=${input.policyDigest}`,
    `test_manifest=${input.testManifestDigest}`,
    `task_contract=${input.taskContractDigest}`,
    // Extend only titled candidates; historical and untitled identities stay unchanged.
    ...(input.draftTitleSha256 == null ? [] : [`draft_title=${input.draftTitleSha256}`]),
  ].join('\n'));
}

function admitFreezeTaskContract(taskContract) {
  if (taskContract === undefined || taskContract === null) {
    refuse('freeze requires --task-contract: a candidate without a declared goal and acceptance conditions cannot be audited for completion', {
      failure: 'missing-task-contract',
      remediation: 'Provide a valid task-contract/v1 document with goal, constraints, done_when, and escalate_when, then freeze again.',
    });
  }
  try {
    return admitTaskContract(taskContract);
  } catch (error) {
    refuse(error.message, {
      failure: 'invalid-task-contract',
      remediation: 'Correct the task contract reported by the validation error, then freeze again.',
    });
  }
  return null;
}

/**
 * No lineage is created or advanced over an intake that did not conclude.
 *
 * This runs before any state mutation and refuses WITHOUT committing a
 * transition: a freeze that never happened must leave no lineage behind, and a
 * refreeze that is refused must leave the previous state exactly as it was.
 * The record is evaluated every time -- a PASS granted to an earlier candidate
 * describes an earlier reading of upstream, and upstream moves.
 */
function assertIntakeSatisfied(operation, lineage, intake) {
  const outcome = evaluateIntake(intake);
  if (outcome.status !== STATUS.PASS) {
    refuse(
      `${operation} requires an intake that concluded no competing work exists, and this one did not: ${outcome.reason}`,
      { failure: 'intake-not-satisfied', refusal: outcome.refusal, intakeStatus: outcome.status, lineage }
    );
  }
  return outcome;
}

/**
 * Both documents must belong to THIS lineage and THIS candidate.
 *
 * Valid evidence for another candidate is still valid evidence -- and still
 * says nothing about this one. Without this check the strongest attack on the
 * whole gate is trivial: run it somewhere clean, bring the receipt here.
 */
function assertBoundToLineage(entry, { candidateId, decisionId, snapshotHash, label }) {
  if (entry.candidateId === null || entry.candidateId === undefined) {
    refuse(
      `lineage "${entry.lineage}" carries no candidateId, so nothing can be bound to it; it predates this contract and needs a refreeze`,
      { failure: 'legacy-lineage', lineage: entry.lineage }
    );
  }
  if (candidateId !== entry.candidateId) {
    refuse(
      `the ${label} names candidate ${candidateId} and lineage "${entry.lineage}" is frozen on ${entry.candidateId}`,
      { failure: 'candidate-mismatch', lineage: entry.lineage, expected: entry.candidateId, found: candidateId }
    );
  }
  if (entry.decisionId !== null && entry.decisionId !== undefined && decisionId !== entry.decisionId) {
    refuse(
      `the ${label} belongs to decision ${decisionId} and this lineage recorded ${entry.decisionId}`,
      { failure: 'decision-mismatch', lineage: entry.lineage, expected: entry.decisionId, found: decisionId }
    );
  }
  if (entry.snapshotHash !== null && entry.snapshotHash !== undefined && snapshotHash !== entry.snapshotHash) {
    refuse(
      `the ${label} describes snapshot ${snapshotHash} and this lineage recorded ${entry.snapshotHash}`,
      { failure: 'snapshot-mismatch', lineage: entry.lineage, expected: entry.snapshotHash, found: snapshotHash }
    );
  }
}

// -- the store ---------------------------------------------------------------------------

/**
 * @param {Function} [input.writer]  the write boundary, injectable so a test can
 *        fault it. Production always uses writeAtomic; a platform-permission
 *        trick is a diagnostic, not the authoritative way to exercise the
 *        durability path, because permissions mean different things per system.
 * @param {string}   [input.enforcementPath]  where the enforcement declaration
 *        lives. Injectable for the same reason the writer is; production reads
 *        the one shipped declaration.
 * @param {object}   [input.signing]  `{pubkeyPath, anchorPath}` for signature
 *        verification. Injectable so tests never touch Program Files.
 * @param {Function} [input.cleanup]  post-index cleanup runner, injectable for
 *        deterministic failure tests; production executes the action directly.
 */
export function openStore({
  override, allowOutsideWorkspace = false, lockOptions = {}, writer = writeAtomic,
  enforcementPath, signing = {}, cleanup = (action) => action(),
} = {}) {
  const root = resolveStoreRoot({ override, allowOutsideWorkspace });
  const layout = storeLayout(root);
  mkdirSync(root, { recursive: true });
  /**
   * Prepare immutable bytes at their final identity before the manifest write.
   * A failed manifest commit deliberately leaves the file in place: without an
   * exact committed reference it is inert, and deleting it during recovery
   * would reintroduce a crash window.
   */
  const prepareArtifact = (transaction, target, text) => {
    transaction.stage({
      prepare: () => {
        if (existsSync(target)) {
          if (readFileSync(target, 'utf8') !== text) {
            throw new StoreError(`artifact identity collision at ${target}`, { failure: 'artifact-collision', path: target });
          }
          return;
        }
        writeAtomic(target, text);
      },
    });
  };

  const cleanupAfterIndex = (transaction, action) => transaction.stage({ cleanup: () => cleanup(action) });

  const pubkeyPath = signing.pubkeyPath ?? DEFAULT_PUBKEY_PATH;
  const anchorPath = signing.anchorPath ?? ANCHOR_PATH;

  /** Reads the declaration every time: the flag is live, not cached. Unreadable blocks. */
  const signatureRequired = () =>
    signedReceiptsRequired(readEnforcement(enforcementPath === undefined ? {} : { path: enforcementPath }));

  /**
   * Classify the signature situation for one receipt WITHOUT blocking:
   * `valid`, `absent` (no signature file), or `invalid` (a file exists and
   * something about it does not verify -- schema, wrong receipt, unanchored or
   * substituted key, or the Ed25519 check itself). The three states are
   * distinguishable on purpose: while the requirement is off, verification
   * still RUNS and the state is recorded in every forward-path result, so the
   * burn-in observes real verdicts instead of silence.
   */
  const signatureStateOf = (receiptId) => {
    try {
      verifyStoredSignature(receiptId);
      return { state: 'valid', failure: null, reason: 'the signature verifies over this receiptId with the anchored key' };
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      return {
        state: error.detail?.failure === 'no-signature' ? 'absent' : 'invalid',
        failure: error.detail?.failure ?? 'unknown',
        reason: error.message,
      };
    }
  };

  /**
   * The forward-path signature gate. Verification always runs; whether a
   * non-valid state BLOCKS depends on the live requireSignedReceipts flag.
   * Absent and invalid refuse with distinct failure codes, because "you have
   * not signed yet" and "what is here does not verify" call for different
   * responses from a human.
   */
  const signatureGate = (entry, operation) => {
    const required = signatureRequired();
    const outcome = { required, ...signatureStateOf(entry.receiptId) };
    if (!required || outcome.state === 'valid') return outcome;
    if (outcome.state === 'absent') {
      refuse(
        `${operation} requires a verified receipt signature while requireSignedReceipts is on, and none exists; run the human signer (bin/sign-receipt.mjs --lineage ${entry.lineage}) in your own terminal, then attach-signature`,
        { failure: 'signature-absent', lineage: entry.lineage, receiptId: entry.receiptId }
      );
    }
    refuse(
      `${operation} requires a verified receipt signature while requireSignedReceipts is on, and the one present does not verify: ${outcome.reason}`,
      { failure: 'signature-invalid', cause: outcome.failure, lineage: entry.lineage, receiptId: entry.receiptId }
    );
  };

  /**
   * Full cryptographic verification of the signature for one receiptId:
   * the signature file exists and is schema-valid, names this exact receipt,
   * the repository public key's fingerprint equals the ANCHORED fingerprint,
   * the signature names that same fingerprint, and the Ed25519 verification
   * succeeds over the receiptId string. Any gap refuses.
   */
  const verifyStoredSignature = (receiptId) => {
    const signaturePath = join(layout.signatures, `${assertContentId(receiptId)}.sig.json`);
    if (!existsSync(signaturePath)) {
      refuse(`no signature exists for receipt ${receiptId}; the human signer has not produced one`, { failure: 'no-signature', receiptId, path: signaturePath });
    }
    let signature;
    try {
      signature = JSON.parse(readFileSync(signaturePath, 'utf8'));
    } catch (error) {
      refuse(`the signature at ${signaturePath} is not readable JSON`, { failure: 'corrupt-signature', path: signaturePath, error: error.message });
    }
    const { valid, errors } = validateSignature(signature);
    if (!valid) {
      refuse(`the signature violates its schema: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { failure: 'invalid-signature', path: signaturePath });
    }
    if (signature.receiptId !== receiptId) {
      refuse('the signature names another receipt; a signature is never transferable', { failure: 'signature-receipt-mismatch', expected: receiptId, found: signature.receiptId });
    }

    if (!existsSync(pubkeyPath)) {
      refuse(`the repository public key is absent at ${pubkeyPath}; nothing can verify a signature`, { failure: 'no-public-key', path: pubkeyPath });
    }
    const publicKeyPem = readFileSync(pubkeyPath, 'utf8');
    let fingerprint;
    try {
      fingerprint = keyFingerprint(publicKeyPem);
    } catch (error) {
      refuse(`the repository public key at ${pubkeyPath} is not a usable ed25519 key: ${error.message}`, { failure: 'unreadable-public-key', path: pubkeyPath });
    }
    try {
      // Always required here: verification against an unanchored key would
      // verify only that SOMEONE generated a pair, which is the substitution
      // the anchor exists to catch.
      assertAnchoredFingerprint({ fingerprint, path: anchorPath, required: true });
    } catch (error) {
      if (!(error instanceof AnchorError)) throw error;
      refuse(error.message, { failure: error.detail.failure, ...error.detail });
    }
    if (signature.keyFingerprint !== fingerprint) {
      refuse('the signature was made with a key other than the anchored one', { failure: 'signature-key-mismatch', expected: fingerprint, found: signature.keyFingerprint });
    }
    if (!verifySignedReceiptId({ receiptId, signature: signature.signature, publicKeyPem })) {
      refuse(`the signature does not verify over receipt ${receiptId}`, { failure: 'signature-unverifiable', receiptId });
    }
    return { verified: true, signature, fingerprint };
  };

  /**
   * Re-authorization housekeeping. The old receipt file is MOVED to
   * authorizations/superseded/ byte-identical -- content-addressed history,
   * never rewritten -- and a live ticket derived from it is swept to
   * tickets/superseded/, because the right it carried no longer exists. The
   * stale pending-signature request is dropped; a fresh one is written for
   * the new receipt.
   */
  const supersedeAuthorization = (entry) => {
    const previousPath = artifactPath(layout.authorizations, entry.receiptId);
    if (existsSync(previousPath)) {
      mkdirSync(layout.authorizationsSuperseded, { recursive: true });
      renameSync(previousPath, artifactPath(layout.authorizationsSuperseded, entry.receiptId));
    }

    const legacyAlias = withinStore(layout.tickets, `${entry.lineage}.json`);
    const ticketPath = typeof entry.ticketId === 'string'
      ? artifactPath(layout.ticketArtifacts, entry.ticketId)
      : legacyAlias;
    if (existsSync(ticketPath)) {
      const pending = readLiveTicket(ticketPath);
      mkdirSync(layout.ticketsSuperseded, { recursive: true });
      renameSync(ticketPath, join(layout.ticketsSuperseded, `${entry.lineage}-${pending.attemptNumber}.json`));
    }
    if (ticketPath !== legacyAlias) rmSync(legacyAlias, { force: true });

    rmSync(artifactPath(layout.pendingSignature, entry.receiptId), { force: true });
    rmSync(withinStore(layout.pendingSignature, `${entry.lineage}.json`), { force: true });
  };

  const ticketPathFor = (entry) => {
    if (typeof entry.ticketId === 'string') return artifactPath(layout.ticketArtifacts, entry.ticketId);
    if (entry.ticketId === undefined) return withinStore(layout.tickets, `${entry.lineage}.json`);
    return null;
  };

  const assertTicketIssued = (entry, ticket) => {
    const exactId = entry.ticketId === ticket.ticketId;
    const exactAttempt = ticket.attemptNumber === entry.attempts;
    const exactBinding = ticket.lineage === entry.lineage
      && ticket.receiptId === entry.receiptId
      && ticket.candidateId === entry.candidateId
      && ticket.evidenceId === entry.evidenceId;
    if (!exactId || !exactAttempt || !exactBinding) {
      refuse('the ticket was not issued by the committed index for this exact authorization and attempt', {
        failure: 'unissued-ticket',
        ticketId: ticket.ticketId,
        committedTicketId: entry.ticketId ?? null,
        attemptNumber: ticket.attemptNumber,
        committedAttempts: entry.attempts,
      });
    }
  };

  /** Every mutation runs as one transaction over a copy of the index. */
  const mutate = (work) => withLock(layout.lock, () => {
    sweepTemporaries(root);
    return runTransaction({
      read: () => readIndex(layout),
      write: (draft) => writeIndex(layout, draft, writer),
      work,
    });
  }, lockOptions);

  return {
    layout,

    read() {
      return withLock(layout.lock, () => readIndex(layout), lockOptions);
    },

    /**
     * The lineage entry as the index holds it. A RETIRED lineage also carries
     * its retirement record, read back through the same validation every
     * artifact gets: a retirement that does not describe itself blocks here
     * rather than being reported as a clean close.
     */
    status(lineage) {
      return withLock(layout.lock, () => {
        const entry = { ...lineageOf(readIndex(layout), lineage) };
        if (entry.state !== 'RETIRED') return entry;
        return { ...entry, retirement: readRetirement(artifactPath(layout.retirements, entry.retirementId)) };
      }, lockOptions);
    },

    /**
     * The per-condition trace the decision package presents: claim, check,
     * result, limit. Read-only, and built only from this lineage's durable,
     * byte-bound artifacts after verifying them, against the receipt when the
     * lineage has one; a result that does not verify is refused, never
     * rendered. Before a receipt exists the only anchor is the index, which
     * is unsigned: a writer who rewrites the result and the index together is
     * not detected here, exactly as on every other pre-authorization step. A
     * result older than auditor-result/v4 reports the check and the limit as
     * not recorded, and nothing is inferred to fill them.
     */
    acceptanceTrace(lineage) {
      return withLock(layout.lock, () => {
        const entry = lineageOf(readIndex(layout), lineage);
        // Once a receipt exists it is the binding that counts: the trace must
        // be of the bytes it authorizes, not of whatever the index now names.
        // A RETIRED lineage's receipt is archived and spends nothing; its trace
        // is a record, read against the index like a pre-receipt one.
        const receipt = entry.state === 'RETIRED' || entry.receiptId === null || entry.receiptId === undefined
          ? null
          : readReceipt(artifactPath(layout.authorizations, entry.receiptId));
        const task = boundTaskContract(layout, entry, receipt);
        const { auditResult } = boundAuditResult(layout, entry, receipt, task);
        return {
          lineage: entry.lineage,
          state: entry.state,
          ...acceptanceTrace({ taskContract: task?.taskContract ?? null, auditResult }),
        };
      }, lockOptions);
    },

    freeze({ lineage, candidateId, intake, taskContract, ...input }) {
      assertLineageName(lineage);
      assertContentId(candidateId, 'candidateId');
      const admittedTaskContract = admitFreezeTaskContract(taskContract);
      const { draftBodySha256, draftTitleSha256, subjectFields } = admitDraftBinding(input);
      const subjectInput = { ...subjectFields, taskContractDigest: admittedTaskContract.taskContractDigest };
      const taskContractText = `${JSON.stringify(admittedTaskContract, null, 2)}\n`;
      const taskContractSha256 = sha256Bytes(Buffer.from(taskContractText, 'utf8'));
      const admitted = assertIntakeSatisfied('freeze', lineage, intake);
      return mutate((index, transaction) => {
        if (index.lineages[lineage] !== undefined) {
          // A retired name is not reusable: the retirement is the record that
          // this name was closed, and a fresh lineage under it would make the
          // record describe two different things.
          assertNotRetired(index.lineages[lineage], 'freeze');
          refuse(`lineage "${lineage}" already exists; use refreeze after a reserved correction`, { failure: 'duplicate-lineage', lineage });
        }
        prepareArtifact(
          transaction,
          artifactPath(layout.taskContracts, admittedTaskContract.taskContractDigest),
          taskContractText
        );
        index.lineages[lineage] = {
          lineage,
          subject_id: deriveSubjectId(subjectInput),
          base_tree: input.baseTree,
          candidate_tree: input.candidateTree,
          candidateId,
          state: 'FROZEN',
          correction_budget: 1,
          corrections_used: 0,
          verdict: null,
          frozen_at_generation: 1,
          decisionId: null,
          snapshotHash: null,
          evidenceId: null,
          auditResultId: null,
          auditResultSha256: null,
          receiptId: null,
          ticketId: null,
          attempts: 0,
          intake_status: admitted.status,
          intake_refusal: admitted.refusal,
          intake_digest: digest(intake),
          taskContractDigest: admittedTaskContract.taskContractDigest,
          taskContractSha256,
          // Beside subject_id, not inside it: what authorize compares the
          // publication body against. The raw draftDigest stays in the identity.
          draftBodySha256,
          draftTitleSha256,
          consumedAttempts: [],
        };
        return { ...index.lineages[lineage] };
      });
    },

    recordAudit({ lineage, result }) {
      return mutate((index, transaction) => {
        const entry = lineageOf(index, lineage);
        allow(entry, 'record-audit');
        const recoveringHistoricalAudit = ['AUDITED_PASS', 'NEEDS_CHANGES', 'REAUDITED'].includes(entry.state);
        if (recoveringHistoricalAudit && entry.auditResultId !== null && entry.auditResultId !== undefined
          && entry.auditResultSha256 !== null && entry.auditResultSha256 !== undefined) {
          refuse('this lineage already has a byte-bound durable auditor result; record-audit is only the historical continuation when that binding is absent', {
            failure: 'audit-result-already-bound', lineage,
          });
        }
        const taskBinding = boundTaskContract(layout, entry);
        let admitted;
        try { admitted = admitAuditorResult(result, { taskContract: taskBinding?.taskContract ?? null }); } catch (error) {
          refuse(error.message, { failure: 'invalid-auditor-result', lineage });
        }

        if (admitted.subject_id !== entry.subject_id) {
          entry.state = 'STALE';
          refuseAndCommit('the audited subject_id does not match the frozen candidate; the verdict is discarded', {
            failure: 'stale-subject', audited: admitted.subject_id, frozen: entry.subject_id,
          });
        }

        const auditText = `${JSON.stringify(admitted, null, 2)}\n`;
        prepareArtifact(transaction, artifactPath(layout.auditResults, admitted.auditResultId), auditText);
        // REFROZEN also follows missing evidence, which spends no correction.
        const inCorrectionCycle = entry.corrections_used > 0;
        if (admitted.verdict === 'PASS') entry.state = inCorrectionCycle ? 'REAUDITED' : 'AUDITED_PASS';
        else if (admitted.verdict === 'NEEDS_CHANGES') entry.state = inCorrectionCycle ? 'NEEDS_MAINTAINER' : 'NEEDS_CHANGES';
        else entry.state = admitted.verdict;
        entry.verdict = admitted.verdict;
        entry.auditResultId = admitted.auditResultId;
        entry.auditResultSha256 = sha256Bytes(Buffer.from(auditText, 'utf8'));
        return { ...entry, auditResult: admitted };
      });
    },

    reserveCorrection({ lineage }) {
      return mutate((index) => {
        const entry = lineageOf(index, lineage);
        const next = allow(entry, 'reserve-correction');
        const { auditResult } = boundAuditResult(layout, entry);
        if (auditResult.subject_id !== entry.subject_id || auditResult.correctionEligible !== true) {
          refuse('the durable auditor result does not authorize a candidate-caused correction. Next action: stop or request maintainer disposition.', { failure: 'correction-not-eligible', lineage, auditResultId: entry.auditResultId });
        }
        if (entry.corrections_used >= entry.correction_budget) {
          entry.state = 'NEEDS_MAINTAINER';
          refuseAndCommit('the correction budget is exhausted; escalated to NEEDS_MAINTAINER', {
            failure: 'budget-exhausted', used: entry.corrections_used, budget: entry.correction_budget,
          });
        }
        entry.corrections_used += 1;
        entry.state = next;
        return { ...entry };
      });
    },

    refreeze({ lineage, candidateId, intake, taskContract, ...input }) {
      assertContentId(candidateId, 'candidateId');
      const admittedTaskContract = admitFreezeTaskContract(taskContract);
      const { draftBodySha256, draftTitleSha256, subjectFields } = admitDraftBinding(input);
      const subjectInput = { ...subjectFields, taskContractDigest: admittedTaskContract.taskContractDigest };
      const taskContractText = `${JSON.stringify(admittedTaskContract, null, 2)}\n`;
      const taskContractSha256 = sha256Bytes(Buffer.from(taskContractText, 'utf8'));
      const admitted = assertIntakeSatisfied('refreeze', lineage, intake);
      return mutate((index, transaction) => {
        const entry = lineageOf(index, lineage);
        const next = allow(entry, 'refreeze');
        prepareArtifact(
          transaction,
          artifactPath(layout.taskContracts, admittedTaskContract.taskContractDigest),
          taskContractText
        );
        entry.subject_id = deriveSubjectId(subjectInput);
        entry.base_tree = input.baseTree;
        entry.candidate_tree = input.candidateTree;
        entry.candidateId = candidateId;
        entry.state = next;
        entry.verdict = null;
        entry.frozen_at_generation += 1;
        entry.intake_status = admitted.status;
        entry.intake_refusal = admitted.refusal;
        entry.intake_digest = digest(intake);
        entry.taskContractDigest = admittedTaskContract.taskContractDigest;
        entry.taskContractSha256 = taskContractSha256;
        // The corrected draft is the new body: the previous binding must not
        // survive a refreeze, or the old text would still authorize.
        entry.draftBodySha256 = draftBodySha256;
        entry.draftTitleSha256 = draftTitleSha256;
        // A new candidate invalidates everything bound to the previous one.
        entry.decisionId = null;
        entry.snapshotHash = null;
        entry.evidenceId = null;
        entry.auditResultId = null;
        entry.auditResultSha256 = null;
        entry.receiptId = null;
        return { ...entry };
      });
    },

    /**
     * Evidence may be recorded from any open state -- it describes, it does
     * not permit. A retired lineage is the one exception: nothing more is
     * recorded against a closed lineage, because a later document would read
     * as a continuation of something that ended.
     */
    recordEvidence({ lineage, evidence }) {
      const { valid, errors } = validateEvidence(evidence);
      if (!valid) refuse(`the evidence violates its schema: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { failure: 'invalid-evidence' });
      if (!evidenceIntact(evidence)) refuse('the evidence does not match its own evidenceId; it was altered', { failure: 'tampered-evidence' });
      // Intact is not honest: an intact record can still claim a PASS its own
      // verifications do not support (zero required checks aggregate to
      // UNKNOWN). Admission refuses it before authorize ever sees it (ASTRA-04).
      const contradiction = gateStatusContradiction(evidence);
      if (contradiction !== null) refuse(contradiction, { failure: 'evidence-verifies-nothing', claimed: evidence.gateStatus, derived: derivedGateStatus(evidence) });

      return mutate((index) => {
        const entry = lineageOf(index, lineage);
        assertNotRetired(entry, 'record-evidence');
        assertBoundToLineage(entry, {
          candidateId: evidence.candidate.candidateId,
          decisionId: evidence.binding.decisionId,
          snapshotHash: evidence.binding.snapshotHash,
          label: 'evidence',
        });

        // Artifact first, index second.
        writeAtomic(artifactPath(layout.evidence, evidence.evidenceId), `${JSON.stringify(evidence, null, 2)}\n`);
        entry.evidenceId = evidence.evidenceId;
        entry.decisionId = evidence.binding.decisionId;
        entry.snapshotHash = evidence.binding.snapshotHash;
        return { ...entry };
      });
    },

    /**
     * Issue the receipt for one exact publication -- and only for one: the
     * binding (operation, target, byte hashes) is refused when incomplete,
     * because a receipt that does not say what it authorizes publishing is a
     * blank check.
     *
     * From AUTHORIZED or PUBLISHABLE this is re-authorization: the same
     * candidate aimed at a different target is a NEW authorization with a new
     * receiptId and, when signing is on, a new signature. The previous receipt
     * is archived untouched, a live ticket is superseded, and the lineage
     * resets to AUTHORIZED. Attempts already recorded keep referring to the
     * old receiptId; history is never rewritten. Re-authorizing to the exact
     * same binding is refused -- there is nothing to replace.
     *
     * Two-phase: the receipt is minted here, and a pending-signature request
     * naming its receiptId is written beside it. The signature itself only
     * ever comes from the human-run signer in the human's own terminal.
     */
    authorize({ lineage, artifacts = [], publication }) {
      return mutate((index, transaction) => {
        const entry = lineageOf(index, lineage);
        const next = allow(entry, 'authorize');
        if (entry.evidenceId === null) refuse('no evidence has been recorded for this lineage', { failure: 'no-evidence', lineage });
        const taskBinding = boundTaskContract(layout, entry);
        const { auditResult, artifact: auditArtifact } = boundAuditResult(layout, entry, null, taskBinding);
        if (taskBinding === null) {
          refuse(
            'this historical lineage predates task-contract binding and cannot mint a new authorization; freeze a new lineage with --task-contract instead of reinterpreting its old subject identity',
            {
              failure: 'missing-task-contract',
              lineage,
              remediation: 'Freeze a new lineage with a valid task-contract/v1 document, audit its exact done_when coverage, and authorize that new subject.',
            }
          );
        }
        if (auditResult.verdict !== 'PASS') {
          refuse('the durable auditor result is not a PASS for this frozen subject', { failure: 'audit-result-not-authorizing', lineage, auditResultId: entry.auditResultId });
        }

        const evidence = readEvidence(artifactPath(layout.evidence, entry.evidenceId));
        assertBoundToLineage(entry, {
          candidateId: evidence.candidate.candidateId,
          decisionId: evidence.binding.decisionId,
          snapshotHash: evidence.binding.snapshotHash,
          label: 'recorded evidence',
        });

        // A retired operation gets its own failure code and the full reason:
        // "not one of the list" would hide WHY pr-create is not on the list.
        if (publication !== null && typeof publication === 'object' && publication.operation === 'pr-create') {
          refuse(PR_CREATE_UNSUPPORTED_REASON, { failure: 'operation-unsupported', operation: 'pr-create' });
        }

        // The body being authorized must be the draft that was audited. The
        // audit PASS is bound to subject_id, which carries the raw draft
        // digest; the publication carries the normalized body digest; the
        // lineage keeps the normalized draft digest so the two can meet here.
        // A lineage frozen before that field existed has nothing to compare
        // against and cannot mint a NEW authorization -- the same rule the
        // task-contract binding applies to history. Shape problems in the
        // binding (no bodySha256 at all) are issueAuthorization's refusal,
        // with its own complete reason; only a present, different digest is
        // a draft mismatch.
        if (typeof entry.draftBodySha256 !== 'string') {
          refuse(
            'this historical lineage predates draft binding and carries no draftBodySha256, so the audited draft cannot be tied to the publication body; freeze a new lineage instead of reinterpreting its old subject identity',
            {
              failure: 'missing-draft-binding',
              lineage,
              remediation: 'Freeze a new lineage (freeze records the normalized draft digest from --draft), audit it, and authorize that new subject with the same draft as --body-file.',
            }
          );
        }
        if (publication !== null && typeof publication === 'object'
          && typeof publication.bodySha256 === 'string' && publication.bodySha256 !== entry.draftBodySha256) {
          refuse(
            `the publication body ${publication.bodySha256} is not the audited draft ${entry.draftBodySha256}; the audit PASS is bound to the draft bytes, and a different body needs its own freeze and audit`,
            { failure: 'draft-mismatch', lineage, expected: entry.draftBodySha256, found: publication.bodySha256 }
          );
        }

        // Dependencies are checked against the store BEFORE the receipt is
        // built: unknown, self, duplicate, closed and cycle each refuse typed,
        // and nothing has been prepared yet.
        const declaredDependencies = publication?.dependsOn ?? [];
        if (!Array.isArray(declaredDependencies) || declaredDependencies.some((name) => typeof name !== 'string')) {
          refuse('dependsOn must be a list of lineage names', { failure: 'refused', refusals: ['dependsOn must be a list of lineage names'] });
        }
        assertDependenciesDeclarable(index, layout, lineage, declaredDependencies);

        const nativeArtifacts = [
          { artifact: taskBinding.artifact, failure: 'task-contract-artifact-conflict', label: 'task-contract' },
          { artifact: auditArtifact, failure: 'audit-artifact-conflict', label: 'auditor-result' },
        ];
        for (const { artifact: nativeArtifact, failure, label } of nativeArtifacts) {
          const samePath = artifacts.find((artifact) => artifact?.path === nativeArtifact.path);
          if (samePath !== undefined && samePath.sha256 !== nativeArtifact.sha256) {
            refuse(`caller artifacts conflict with the native ${label} binding`, {
              failure, lineage, path: nativeArtifact.path,
            });
          }
        }
        const boundArtifacts = [...artifacts];
        for (const { artifact: nativeArtifact } of nativeArtifacts) {
          if (!boundArtifacts.some((artifact) => artifact?.path === nativeArtifact.path)) boundArtifacts.push(nativeArtifact);
        }
        const outcome = issueAuthorization({ evidence, artifacts: boundArtifacts, publication });
        if (!outcome.authorized) {
          refuse(`authorization refused: ${outcome.refusals.join('; ')}`, { failure: 'refused', refusals: outcome.refusals });
        }

        if (publication?.operation === 'issue-create'
          && (typeof entry.draftTitleSha256 !== 'string' || publication.titleSha256 !== entry.draftTitleSha256)) {
          refuse('issue-create requires the exact frozen and audited title; freeze a new candidate with --title-file and audit it', {
            failure: 'title-mismatch', lineage, expected: entry.draftTitleSha256 ?? null, found: publication.titleSha256 ?? null,
          });
        }

        const reauthorizing = entry.receiptId !== null && entry.receiptId !== undefined;
        const previousAuthorization = reauthorizing
          ? { lineage: entry.lineage, receiptId: entry.receiptId, ticketId: entry.ticketId }
          : null;
        if (reauthorizing && outcome.receipt.receiptId === entry.receiptId) {
          refuse('this exact authorization already exists; re-authorization is for a different publication, not a repeat of this one', {
            failure: 'identical-authorization', lineage, receiptId: entry.receiptId,
          });
        }

        const receiptText = `${JSON.stringify(outcome.receipt, null, 2)}\n`;
        prepareArtifact(
          transaction,
          artifactPath(layout.authorizations, outcome.receipt.receiptId),
          receiptText
        );
        if (previousAuthorization !== null) {
          cleanupAfterIndex(transaction, () => supersedeAuthorization(previousAuthorization));
        }
        const pendingSignature = { lineage, receiptId: outcome.receipt.receiptId };
        const pendingText = `${JSON.stringify(pendingSignature, null, 2)}\n`;
        prepareArtifact(
          transaction,
          artifactPath(layout.pendingSignature, outcome.receipt.receiptId),
          pendingText
        );
        cleanupAfterIndex(transaction, () => writeAtomic(
          withinStore(layout.pendingSignature, `${lineage}.json`),
          pendingText
        ));
        entry.receiptId = outcome.receipt.receiptId;
        entry.ticketId = null;
        entry.signatureAttached = false;
        entry.state = next;
        return { ...entry, receipt: outcome.receipt, pendingSignature };
      });
    },

    /**
     * Attach the human signature to the lineage's current receipt, verifying
     * it first: schema, exact receiptId, anchored fingerprint, and the
     * Ed25519 verification itself. Any mismatch refuses and records nothing.
     * The pending request is removed on success; the signature file stays --
     * it is the artifact.
     */
    attachSignature({ lineage }) {
      return mutate((index, transaction) => {
        const entry = lineageOf(index, lineage);
        allow(entry, 'attach-signature');
        const receipt = readReceipt(artifactPath(layout.authorizations, entry.receiptId));
        const { signature } = verifyStoredSignature(receipt.receiptId);
        cleanupAfterIndex(transaction, () => {
          rmSync(artifactPath(layout.pendingSignature, entry.receiptId), { force: true });
          rmSync(withinStore(layout.pendingSignature, `${lineage}.json`), { force: true });
        });
        entry.signatureAttached = true;
        return { ...entry, signature };
      });
    },

    /**
     * Re-verify the attached signature without mutating anything, refusing on
     * anything short of `valid`. This is what attach-signature runs, and what
     * a caller uses when a non-valid state must stop the line.
     */
    verifySignature({ lineage }) {
      assertLineageName(lineage);
      return withLock(layout.lock, () => {
        const entry = lineageOf(readIndex(layout), lineage);
        if (entry.receiptId === null || entry.receiptId === undefined) {
          refuse(`lineage "${lineage}" carries no authorization, so there is no signature to verify`, { failure: 'no-receipt', lineage });
        }
        return verifyStoredSignature(entry.receiptId);
      }, lockOptions);
    },

    /**
     * Classify without blocking: `valid`, `absent` or `invalid`, with the
     * underlying failure code and reason. The publisher runs this before
     * consuming a ticket -- the recorded `signatureAttached` flag is a record,
     * and records get edited, so the crypto runs again at the moment it
     * matters -- and records the state in the attempt whatever the flag says.
     */
    signatureState({ lineage }) {
      assertLineageName(lineage);
      return withLock(layout.lock, () => {
        const entry = lineageOf(readIndex(layout), lineage);
        if (entry.receiptId === null || entry.receiptId === undefined) {
          refuse(`lineage "${lineage}" carries no authorization, so there is no signature to classify`, { failure: 'no-receipt', lineage });
        }
        return { receiptId: entry.receiptId, ...signatureStateOf(entry.receiptId) };
      }, lockOptions);
    },

    gatePublish({ lineage, currentCandidateId }) {
      assertContentId(currentCandidateId, 'currentCandidateId');
      return mutate((index) => {
        const entry = lineageOf(index, lineage);
        const next = allow(entry, 'gate-publish');
        const receipt = readReceipt(artifactPath(layout.authorizations, entry.receiptId));

        if (currentCandidateId !== receipt.candidateId || currentCandidateId !== entry.candidateId) {
          entry.state = 'STALE';
          refuseAndCommit('the candidate changed since it was authorised; there is no reusable authorization', {
            failure: 'stale-candidate', authorised: receipt.candidateId, current: currentCandidateId,
          });
        }
        assertReceiptBinding(receipt, lineage);
        const taskBinding = boundTaskContract(layout, entry, receipt);
        boundAuditResult(layout, entry, receipt, taskBinding);
        // Re-evaluated on every gate: PUBLISHABLE never remembers this.
        assertDependenciesSatisfied(index, layout, lineage, receiptDependsOn(receipt), 'gate-publish');
        const signature = signatureGate(entry, 'gate-publish');

        entry.state = next;
        return { ...entry, receipt, signature };
      });
    },

    /**
     * Reserve the next attempt number, revalidating first, and emit the
     * one-shot ticket binding the reservation to one exact publication.
     *
     * The ticket is DERIVED from the receipt's publication binding -- the
     * reservation takes no binding arguments any more, because letting the
     * reserver restate the target is letting the reserver change it. What was
     * authorized is what gets reserved, field for field. A receipt without a
     * binding refuses, naming re-authorization.
     *
     * PUBLISHABLE is informative, never a durable token: this runs immediately
     * before a publisher is reached, and a candidate that moved since
     * gate-publish lands the lineage in STALE however the index reads.
     *
     * One live ticket per lineage. A second reservation while one is pending
     * refuses instead of burning another number; an expired ticket is swept to
     * tickets/expired/ and the reservation proceeds. The new immutable ticket
     * is prepared before the manifest and becomes live only when that manifest
     * names its exact ticketId and attempt; expired-ticket movement and aliases
     * are non-authoritative cleanup after the commit.
     */
    reserveAttempt({ lineage, currentCandidateId }) {
      assertContentId(currentCandidateId, 'currentCandidateId');

      return mutate((index, transaction) => {
        const entry = lineageOf(index, lineage);
        allow(entry, 'reserve-attempt');
        const receipt = readReceipt(artifactPath(layout.authorizations, entry.receiptId));

        if (!receiptIntact(receipt) || currentCandidateId !== receipt.candidateId || currentCandidateId !== entry.candidateId) {
          entry.state = 'STALE';
          refuseAndCommit('the candidate changed after gate-publish; PUBLISHABLE is not a durable permission', {
            failure: 'stale-candidate', authorised: receipt.candidateId, current: currentCandidateId,
          });
        }
        const binding = { ...assertReceiptBinding(receipt, lineage), dependsOn: receiptDependsOn(receipt) };
        const taskBinding = boundTaskContract(layout, entry, receipt);
        boundAuditResult(layout, entry, receipt, taskBinding);
        assertDependenciesSatisfied(index, layout, lineage, binding.dependsOn, 'reserve-attempt');
        const signature = signatureGate(entry, 'reserve-attempt');

        const legacyAlias = withinStore(layout.tickets, `${lineage}.json`);
        let currentPath = ticketPathFor(entry);
        // Stores predating exact ticket identities may carry an alias but no
        // authoritative ticketId. That alias is inert: archive it only after a
        // new exact ticket commits, rather than treating it as permission.
        if (entry.ticketId === undefined) {
          if (existsSync(legacyAlias)) {
            const legacy = readLiveTicket(legacyAlias);
            cleanupAfterIndex(transaction, () => {
              mkdirSync(layout.ticketsSuperseded, { recursive: true });
              renameSync(legacyAlias, join(layout.ticketsSuperseded, `${lineage}-${legacy.attemptNumber}.json`));
            });
          }
          currentPath = null;
        }
        if (currentPath !== null) {
          if (!existsSync(currentPath)) {
            refuse('the committed index names a ticket artifact that is missing', {
              failure: 'missing-ticket-artifact', ticketId: entry.ticketId ?? null, path: currentPath,
            });
          }
          const pending = readLiveTicket(currentPath);
          assertTicketIssued(entry, pending);
          if (!ticketExpired(pending)) {
            refuse(
              `an unconsumed ticket for attempt ${pending.attemptNumber} is still live; publish it or wait for ${pending.expiresAt}`,
              { failure: 'ticket-pending', ticketId: pending.ticketId, attemptNumber: pending.attemptNumber, expiresAt: pending.expiresAt }
            );
          }
          const expiredPath = join(layout.ticketsExpired, `${lineage}-${pending.attemptNumber}.json`);
          cleanupAfterIndex(transaction, () => {
            mkdirSync(layout.ticketsExpired, { recursive: true });
            renameSync(currentPath, expiredPath);
            if (currentPath !== legacyAlias) rmSync(legacyAlias, { force: true });
          });
        }

        entry.attempts += 1;
        const ticket = ticketOf({
          lineage,
          candidateId: entry.candidateId,
          receiptId: entry.receiptId,
          evidenceId: entry.evidenceId,
          attemptNumber: entry.attempts,
          ...binding,
          // Recorded, not enforced: it says which session reserved, and proves
          // nothing about which one publishes.
          sessionId: process.env.CLAUDE_SESSION_ID || null,
          issuedAt: new Date().toISOString(),
        });

        // A ticket this store cannot read back would wedge the lineage until
        // expiry; refusing here rolls the whole reservation back instead.
        const { valid, errors } = validateTicket(ticket);
        if (!valid) refuse(`the minted ticket violates its own schema: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { failure: 'invalid-ticket' });

        const ticketText = `${JSON.stringify(ticket, null, 2)}\n`;
        entry.ticketId = ticket.ticketId;
        prepareArtifact(transaction, artifactPath(layout.ticketArtifacts, ticket.ticketId), ticketText);
        // Compatibility alias only. Readers admitting a right use the exact
        // identity committed above, so alias failure cannot invalidate it.
        cleanupAfterIndex(transaction, () => writeAtomic(legacyAlias, ticketText));
        return { attemptNumber: entry.attempts, receipt, ticket, signature, lineage: { ...entry } };
      });
    },

    recordAttempt({ lineage, attempt }) {
      const { valid, errors } = validatePublication(attempt);
      if (!valid) refuse(`the attempt violates its schema: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { failure: 'invalid-attempt' });
      if (!attemptIntact(attempt)) refuse('the attempt does not match its own attemptId; it was altered', { failure: 'tampered-attempt' });

      return mutate((index) => {
        const entry = lineageOf(index, lineage);
        allow(entry, 'record-attempt');
        if (attempt.receiptId !== entry.receiptId) {
          refuse('the attempt refers to another authorization', { failure: 'receipt-mismatch', expected: entry.receiptId, found: attempt.receiptId });
        }
        if (attempt.attemptNumber > entry.attempts) {
          refuse('the attempt carries a number the store never issued', { failure: 'unissued-attempt', issued: entry.attempts, found: attempt.attemptNumber });
        }

        // An attempt records what happened under a SPENT right. The number
        // must appear in the lineage's confirmed consumptions -- the index
        // list written by consumeTicket in the same transaction that cleared
        // the live ticket -- not merely have been issued, and not merely have
        // a prepared consumed/ artifact on disk. A live ticket, or a
        // consumption whose manifest write failed, admits no record. A
        // historical consumption made before this list existed is not in it
        // and admits no new manual record either: that limitation is
        // documented, and no automatic re-publication ever recovers it,
        // because it could duplicate a real publication.
        const consumed = consumedAttemptsOf(entry);
        const consumption = consumed.find((candidate) => candidate.attemptNumber === attempt.attemptNumber);
        if (consumption === undefined) {
          refuse(
            `attempt ${attempt.attemptNumber} was reserved but this store never confirmed its ticket consumed; an attempt records what happened under a spent right, so a live or unconfirmed ticket admits no record`,
            {
              failure: 'attempt-unconsumed', lineage, attemptNumber: attempt.attemptNumber,
              consumedAttempts: consumed.map((entry) => entry.attemptNumber),
              liveTicketId: entry.ticketId ?? null,
              remediation: 'Publish through .claude/tools/audit/bin/publish.mjs, which consumes the ticket and records the attempt itself. record-attempt by hand is for an attempt whose ticket this store confirmed consumed (for example a publisher run whose own record step failed); a publication that never spent a ticket, or a consumption this store did not confirm, has no attempt to record. Never re-publish to recover a record: it could duplicate a real publication.',
            }
          );
        }

        // The attempt describes what the CONSUMED TICKET reserved: its
        // authorization, its candidate and its evidence. Comparing against the
        // lineage's current receipt or evidence was the first candidate's
        // mistake -- re-authorization moves the receipt, record-evidence moves
        // the evidence, and either let a consumption under one authorization
        // be reported under another. The ticket is immutable; the report must
        // reproduce it.
        for (const field of ['receiptId', 'candidateId', 'evidenceId']) {
          if (attempt[field] !== consumption[field]) {
            refuse(`the attempt names ${field} ${attempt[field]} and the consumed ticket ${consumption.ticketId} for attempt ${attempt.attemptNumber} was bound to ${consumption[field]}`, {
              failure: 'attempt-binding-mismatch', lineage, attemptNumber: attempt.attemptNumber, field,
              expected: consumption[field], found: attempt[field], ticketId: consumption.ticketId,
            });
          }
        }

        const directory = withinStore(layout.attempts, assertContentId(entry.receiptId));
        const path = join(directory, `${String(attempt.attemptNumber).padStart(3, '0')}.json`);
        // An attempt is history, and history is never overwritten: passing the
        // unissued check above proved nothing about this number being free.
        if (existsSync(path)) {
          refuse(`attempt ${attempt.attemptNumber} is already recorded, and an attempt record is never replaced`, {
            failure: 'attempt-already-recorded', attemptNumber: attempt.attemptNumber, path,
          });
        }
        writeAtomic(path, `${JSON.stringify(attempt, null, 2)}\n`);
        return { ...entry };
      });
    },

    /**
     * Read the lineage's live ticket without consuming it.
     *
     * An expired ticket is swept to tickets/expired/ and refused; an absent
     * one refuses too. What this returns is what the publisher verifies the
     * body against BEFORE consumption, so a wrong file never spends anything.
     */
    loadTicket({ lineage }) {
      assertLineageName(lineage);
      return mutate((index, transaction) => {
        const entry = lineageOf(index, lineage);
        // Before any ticket file is consulted: a retired lineage has no
        // spendable right, whatever file happens to exist on disk.
        assertNotRetired(entry, 'load-ticket');
        const livePath = ticketPathFor(entry);
        if (livePath === null || !existsSync(livePath)) {
          refuse(`no live ticket for lineage "${lineage}"; reserve an attempt first`, { failure: 'no-ticket', lineage });
        }
        const receipt = readReceipt(artifactPath(layout.authorizations, entry.receiptId));
        assertReceiptBinding(receipt, lineage);
        const taskBinding = boundTaskContract(layout, entry, receipt);
        boundAuditResult(layout, entry, receipt, taskBinding);
        const ticket = readLiveTicket(livePath);
        assertTicketIssued(entry, ticket);
        if (ticketExpired(ticket)) {
          const sweptTo = join(layout.ticketsExpired, `${lineage}-${ticket.attemptNumber}.json`);
          entry.ticketId = null;
          cleanupAfterIndex(transaction, () => {
            mkdirSync(layout.ticketsExpired, { recursive: true });
            renameSync(livePath, sweptTo);
            rmSync(withinStore(layout.tickets, `${lineage}.json`), { force: true });
          });
          refuseAndCommit(`the ticket for attempt ${ticket.attemptNumber} expired at ${ticket.expiresAt}; reserve again`, {
            failure: 'ticket-expired', ticketId: ticket.ticketId, expiresAt: ticket.expiresAt, sweptTo,
          });
        }
        return { ticket };
      });
    },

    /**
     * Spend the ticket. The immutable consumed record is prepared first, the
     * index clears its exact live-ticket reference second, and aliases/source
     * cleanup happens last. A cleanup failure therefore cannot resurrect or
     * invalidate the committed consumption decision.
     */
    consumeTicket({ lineage, ticketId }) {
      assertLineageName(lineage);
      return mutate((index, transaction) => {
        const entry = lineageOf(index, lineage);
        assertNotRetired(entry, 'consume-ticket');
        const livePath = ticketPathFor(entry);
        if (livePath === null || !existsSync(livePath)) {
          refuse(`no live ticket for lineage "${lineage}"; nothing to consume`, { failure: 'no-ticket', lineage });
        }
        const receipt = readReceipt(artifactPath(layout.authorizations, entry.receiptId));
        assertReceiptBinding(receipt, lineage);
        const taskBinding = boundTaskContract(layout, entry, receipt);
        boundAuditResult(layout, entry, receipt, taskBinding);
        const ticket = readLiveTicket(livePath);
        assertTicketIssued(entry, ticket);
        if (ticket.ticketId !== ticketId) {
          refuse('the live ticket is not the one presented for consumption', { failure: 'ticket-mismatch', expected: ticketId, found: ticket.ticketId });
        }
        // The last check before anything is spent, from the ticket's own list:
        // a dependency satisfied at reservation can have been retired since.
        assertDependenciesSatisfied(index, layout, lineage, [...(ticket.dependsOn ?? [])], 'consume-ticket');
        if (ticketExpired(ticket)) {
          const sweptTo = join(layout.ticketsExpired, `${lineage}-${ticket.attemptNumber}.json`);
          entry.ticketId = null;
          cleanupAfterIndex(transaction, () => {
            mkdirSync(layout.ticketsExpired, { recursive: true });
            renameSync(livePath, sweptTo);
            rmSync(withinStore(layout.tickets, `${lineage}.json`), { force: true });
          });
          refuseAndCommit(`the ticket for attempt ${ticket.attemptNumber} expired at ${ticket.expiresAt}; nothing was consumed`, {
            failure: 'ticket-expired', ticketId: ticket.ticketId, expiresAt: ticket.expiresAt, sweptTo,
          });
        }

        const consumedPath = withinStore(layout.ticketsConsumed, `${lineage}-${ticket.attemptNumber}.json`);
        let consumedAt;
        let consumedText;
        if (existsSync(consumedPath)) {
          let prepared;
          try {
            consumedText = readFileSync(consumedPath, 'utf8');
            prepared = JSON.parse(consumedText);
          } catch (error) {
            refuse(`the prepared consumption record is unreadable: ${error.message}`, { failure: 'invalid-artifact', path: consumedPath });
          }
          ({ consumedAt } = prepared);
          const { consumedAt: ignored, ...preparedTicket } = prepared;
          if (typeof consumedAt !== 'string' || digest(preparedTicket) !== digest(ticket)) {
            refuse(`the prepared consumption record does not match the committed live ticket`, {
              failure: 'consumption-collision', path: consumedPath, ticketId: ticket.ticketId,
            });
          }
        } else {
          consumedAt = new Date().toISOString();
          consumedText = `${JSON.stringify({ ...ticket, consumedAt }, null, 2)}\n`;
        }
        prepareArtifact(transaction, consumedPath, consumedText);
        entry.ticketId = null;
        // Confirmed in the same manifest write that clears the live ticket:
        // if that write fails, the prepared artifact stays inert and this
        // number never becomes recordable.
        // The consumed ticket's immutable identity, not just its number: what
        // recordAttempt compares the report against, whatever the lineage's
        // receipt or evidence say by then.
        const consumption = {
          attemptNumber: ticket.attemptNumber, ticketId: ticket.ticketId,
          receiptId: ticket.receiptId, candidateId: ticket.candidateId, evidenceId: ticket.evidenceId,
        };
        entry.consumedAttempts = [
          ...consumedAttemptsOf(entry).filter((previous) => previous.attemptNumber !== ticket.attemptNumber),
          consumption,
        ].sort((a, b) => a.attemptNumber - b.attemptNumber);
        cleanupAfterIndex(transaction, () => {
          rmSync(livePath, { force: true });
          rmSync(withinStore(layout.tickets, `${lineage}.json`), { force: true });
        });
        return { ticket, consumedAt };
      });
    },

    /**
     * Close a lineage. Reachable from every non-terminal state; refused from
     * STALE (illegal-transition) and from RETIRED (lineage-retired).
     *
     * What it does, manifest-last: the retirement record is prepared at its
     * content address, the index moves the lineage to RETIRED naming that
     * record, and only then is the receipt the lineage held archived under
     * authorizations/superseded/ exactly as re-authorization archives one --
     * never deleted, and never spendable again, because every forward path
     * now refuses the lineage before it reads a receipt. `receiptId` stays on
     * the entry for history; attempts already recorded are untouched.
     *
     * A live, unexpired ticket refuses the retirement (ticket-pending): a
     * ticket is a reserved right, and voiding one silently would hide that a
     * reservation was outstanding. Publish it, or let it expire. An expired
     * ticket is swept to tickets/expired/ on the way, as reserve-attempt does.
     *
     * The reason is mandatory and comes from a file, never from argv. The
     * optional successor must exist in this store and be another lineage.
     */
    retire({ lineage, reason, supersededBy = null }) {
      assertLineageName(lineage);
      if (typeof reason !== 'string' || normalizeBody(reason).trim() === '') {
        refuse('retire requires a non-empty reason; a retirement without one is not a record', { failure: 'retire-reason-missing', lineage });
      }
      const canonicalReason = normalizeBody(reason);
      if (supersededBy !== null && supersededBy !== undefined) assertLineageName(supersededBy);
      const successor = supersededBy ?? null;

      return mutate((index, transaction) => {
        const entry = lineageOf(index, lineage);
        const next = allow(entry, 'retire');

        if (successor !== null) {
          if (successor === lineage) {
            refuse(`lineage "${lineage}" cannot supersede itself`, { failure: 'superseded-by-self', lineage });
          }
          if (index.lineages[successor] === undefined) {
            refuse(`--superseded-by names "${successor}", which is not a lineage in this store; freeze the successor first or omit it`, {
              failure: 'superseded-by-unknown', lineage, supersededBy: successor,
            });
          }
        }

        // The ticket the index names, if any. Live refuses; expired is swept;
        // an exact ticketId whose artifact is gone blocks, as it does for
        // reserve-attempt -- a retirement does not paper over missing accounting.
        const ticketPath = ticketPathFor(entry);
        const ticketIdAtRetirement = typeof entry.ticketId === 'string' ? entry.ticketId : null;
        if (ticketIdAtRetirement !== null && !existsSync(ticketPath)) {
          refuse('the committed index names a ticket artifact that is missing', {
            failure: 'missing-ticket-artifact', lineage, ticketId: ticketIdAtRetirement, path: ticketPath,
          });
        }
        let ticketSwept = false;
        if (ticketPath !== null && existsSync(ticketPath)) {
          const pending = readLiveTicket(ticketPath);
          if (!ticketExpired(pending)) {
            refuse(
              `an unconsumed ticket for attempt ${pending.attemptNumber} is still live until ${pending.expiresAt}; retire refuses to void it silently -- publish it or wait for it to expire`,
              { failure: 'ticket-pending', lineage, ticketId: pending.ticketId, attemptNumber: pending.attemptNumber, expiresAt: pending.expiresAt }
            );
          }
          const legacyAlias = withinStore(layout.tickets, `${lineage}.json`);
          const expiredPath = join(layout.ticketsExpired, `${lineage}-${pending.attemptNumber}.json`);
          ticketSwept = true;
          cleanupAfterIndex(transaction, () => {
            mkdirSync(layout.ticketsExpired, { recursive: true });
            renameSync(ticketPath, expiredPath);
            if (ticketPath !== legacyAlias) rmSync(legacyAlias, { force: true });
          });
        }

        const retirement = retirementOf({
          lineage,
          retiredAt: new Date().toISOString(),
          reason: canonicalReason,
          supersededBy: successor,
          priorState: entry.state,
          receiptId: typeof entry.receiptId === 'string' ? entry.receiptId : null,
          ticketId: ticketIdAtRetirement,
          attempts: entry.attempts,
        });
        // A retirement this store cannot read back would leave a lineage that
        // status() refuses to describe; refusing here rolls everything back.
        const { valid, errors } = validateRetirement(retirement);
        if (!valid) refuse(`the retirement violates its own schema: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { failure: 'invalid-retirement' });

        prepareArtifact(transaction, artifactPath(layout.retirements, retirement.retirementId), `${JSON.stringify(retirement, null, 2)}\n`);

        if (retirement.receiptId !== null) {
          // Same destination and same move as re-authorization: the receipt
          // file is archived byte-identical, and the signer request for it is
          // dropped, because there is nothing left to sign for.
          const receiptId = retirement.receiptId;
          cleanupAfterIndex(transaction, () => {
            const livePath = artifactPath(layout.authorizations, receiptId);
            if (existsSync(livePath)) {
              mkdirSync(layout.authorizationsSuperseded, { recursive: true });
              renameSync(livePath, artifactPath(layout.authorizationsSuperseded, receiptId));
            }
            rmSync(artifactPath(layout.pendingSignature, receiptId), { force: true });
            rmSync(withinStore(layout.pendingSignature, `${lineage}.json`), { force: true });
          });
        }

        entry.state = next;
        if (ticketSwept) entry.ticketId = null;
        entry.retirementId = retirement.retirementId;
        entry.retiredAt = retirement.retiredAt;
        entry.supersededBy = successor;
        return { ...entry, retirement };
      });
    },

    /**
     * Read-only: refuse unless every named dependency has published and is
     * open. The publisher runs this over the ticket's own `dependsOn` before
     * it consumes anything; consumeTicket runs the same check again under
     * the lock, so a caller that skips this still cannot spend past it.
     */
    dependenciesSatisfied({ lineage, dependsOn }) {
      assertLineageName(lineage);
      return withLock(layout.lock, () => {
        const index = readIndex(layout);
        lineageOf(index, lineage);
        assertDependenciesSatisfied(index, layout, lineage, [...(dependsOn ?? [])], 'publish');
        return { lineage, dependsOn: [...(dependsOn ?? [])], satisfied: true };
      }, lockOptions);
    },

    listAttempts(lineage) {
      return withLock(layout.lock, () => {
        const entry = lineageOf(readIndex(layout), lineage);
        if (entry.receiptId === null) return [];
        const directory = withinStore(layout.attempts, assertContentId(entry.receiptId));
        if (!existsSync(directory)) return [];
        return readdirSync(directory).filter((name) => name.endsWith('.json')).sort()
          .map((name) => readArtifact(join(directory, name), { validate: validatePublication, idField: 'attemptId', recompute: () => true }));
      }, lockOptions);
    },

    /**
     * Bring a legacy ledger in.
     *
     * Idempotent, and it never mints permission. A legacy PUBLISHABLE becomes
     * AUDITED_PASS: it was granted by a machine that required neither evidence
     * nor a candidate identity, so it cannot inherit permission under rules it
     * never met. No legacy lineage gets a candidateId, which is what stops any
     * of them from being authorised before a refreeze.
     */
    migrate({ legacyPath }) {
      if (!existsSync(legacyPath)) refuse(`no legacy ledger at ${legacyPath}`, { failure: 'absent-legacy', legacyPath });

      const raw = readFileSync(legacyPath, 'utf8');
      let legacy;
      try {
        legacy = JSON.parse(raw);
      } catch (error) {
        refuse(`the legacy ledger at ${legacyPath} is unreadable`, { failure: 'corrupt-legacy', error: error.message });
      }

      return mutate((index) => {
        const imported = [];
        const skipped = [];

        for (const [name, entry] of Object.entries(legacy)) {
          if (index.lineages[name] !== undefined) { skipped.push(name); continue; }
          assertLineageName(name);

          index.lineages[name] = {
            lineage: name,
            subject_id: entry.subject_id ?? null,
            base_tree: entry.base_tree ?? null,
            candidate_tree: entry.candidate_tree ?? null,
            // Deliberately absent: a legacy lineage cannot be authorised.
            candidateId: null,
            state: entry.state === 'PUBLISHABLE' ? 'AUDITED_PASS' : entry.state,
            correction_budget: entry.correction_budget ?? 1,
            corrections_used: entry.corrections_used ?? 0,
            verdict: entry.verdict ?? null,
            frozen_at_generation: entry.frozen_at_generation ?? 1,
            decisionId: null,
            snapshotHash: null,
            evidenceId: null,
            receiptId: null,
            ticketId: null,
            attempts: 0,
            migrated: { from: legacyPath, legacyState: entry.state ?? null },
          };
          imported.push(name);
        }

        const provenance = { path: legacyPath, sha256: digest(raw), lineages: imported.sort() };
        if (!index.migratedFrom.some((record) => record.path === provenance.path && record.sha256 === provenance.sha256)) {
          index.migratedFrom.push(provenance);
        }
        return { imported: imported.sort(), skipped: skipped.sort() };
      });
    },
  };
}
