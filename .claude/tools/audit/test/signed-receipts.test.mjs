// requireSignedReceipts: verification always runs, the flag only decides
// whether a non-valid state blocks. Three states -- ABSENT, INVALID, VALID --
// each exercised under the flag off (verified and recorded, never blocking)
// and on (absent and invalid refuse with distinct codes; valid passes).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore, StoreError } from '../lib/store/store.mjs';
import { publishWithTicket } from '../bin/publish.mjs';
import { generateEncryptedKeyPair, decryptPrivateKey, signReceiptId, verifySignedReceiptId, SIGNATURE_VERSION } from '../lib/signing.mjs';
import { receiptIntact } from '../lib/authorization.mjs';
import { digest } from '../lib/canonical.mjs';
import { bodyDigest } from '../lib/ticket.mjs';
import { buildEvidence } from '../lib/evidence-record.mjs';
import { REQUIRED_SOURCES, READING, CONTRIBUTION } from '../lib/intake.mjs';
import { STATUS } from '../lib/status.mjs';
import { completeCoverage, auditorResult, TASK_CONTRACT } from './helpers/documents.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'audit-sigreq-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const PASSPHRASE = 'una frase suficientemente larga';
const PAIR = generateEncryptedKeyPair(PASSPHRASE);
const PRIVATE = decryptPrivateKey(PAIR.encrypted, PASSPHRASE);

let sequence = 0;
const id = (character) => `sha256:${character.repeat(64)}`;
const CANDIDATE = id('c');
const REPO = 'Gentleman-Programming/gentle-ai';

const INTAKE = {
  repository: REPO,
  contributionType: CONTRIBUTION.ISSUE,
  readings: REQUIRED_SOURCES.map((source) => ({
    source, command: `${source} --repo ${REPO}`, result: READING.COMPLETE, matches: 0, reviewed: false, coverage: completeCoverage({ source }),
  })),
  competing: [],
};

const FREEZE = {
  baseTree: 'ab933c1c', candidateTree: '4daf0098',
  pathsDigest: id('1'), draftDigest: id('2'), policyDigest: id('3'), testManifestDigest: id('4'),
  taskContract: TASK_CONTRACT,
  intake: INTAKE,
};

function evidenceFor() {
  return buildEvidence({
    result: {
      gate: 'preflight',
      status: STATUS.PASS,
      binding: { snapshotHash: id('5'), snapshotHashAfter: id('5'), stable: true, policyHash: id('7'), toolVersion: '0.1.0', decisionId: id('9') },
      summary: { pass: 1, fail: 0, unknown: 0, notRun: 0 },
      checks: [{ id: 'a.one', status: STATUS.PASS, required: true, reason: 'ok' }],
    },
    candidate: { status: STATUS.PASS, candidateId: CANDIDATE, reason: 'identified' },
  });
}

const BODY = 'el cuerpo firmado\n';
const BINDING = { operation: 'issue-comment', targetRepo: REPO, targetNumber: 3297, bodySha256: bodyDigest(BODY), titleSha256: null };

/** An enforcement declaration with the signing flag set as asked. */
function enforcementFile(requireSignedReceipts) {
  const path = join(scratch, `enforcement-${sequence += 1}.json`);
  writeFileSync(path, JSON.stringify({
    enforcementVersion: '1.0.0',
    stage: 2,
    killSwitch: 'set stage to 1',
    requireSignedReceipts,
    requireSignedReceiptsKillSwitch: 'set requireSignedReceipts to false; the verification code stays',
    stages: { 2: { name: 'preflight required', means: 'a PASS preflight is required' } },
  }));
  return path;
}

/**
 * A store wired to a controllable enforcement file and to test key material,
 * with a lineage authorized (unsigned) and its signature state settable.
 */
function fixture({ required, binding = BINDING }) {
  const root = mkdtempSync(join(scratch, 'store-'));
  const materials = mkdtempSync(join(scratch, 'materials-'));
  const pubkeyPath = join(materials, 'receipt-signing.pub');
  writeFileSync(pubkeyPath, PAIR.publicKeyPem);
  const anchorPath = join(materials, 'receipt-signing.anchor.json');
  writeFileSync(anchorPath, JSON.stringify({ pubkeyFingerprint: PAIR.fingerprint, signerSha256: null, anchoredAt: new Date().toISOString() }));

  const enforcementPath = enforcementFile(required);
  const api = openStore({
    override: root, allowOutsideWorkspace: true, lockOptions: { waitMs: 4000 },
    enforcementPath, signing: { pubkeyPath, anchorPath },
  });

  const lineage = `r-${sequence += 1}`;
  const frozen = api.freeze({ lineage, candidateId: CANDIDATE, ...FREEZE, draftBodySha256: BINDING.bodySha256, draftTitleSha256: binding.titleSha256 ?? null });
  api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'PASS') });
  api.recordEvidence({ lineage, evidence: evidenceFor() });
  const { receipt } = api.authorize({ lineage, publication: binding });

  const signaturePath = join(api.layout.signatures, `${receipt.receiptId.slice(7)}.sig.json`);
  const sign = () => {
    mkdirSync(api.layout.signatures, { recursive: true });
    writeFileSync(signaturePath, JSON.stringify({
      signatureVersion: SIGNATURE_VERSION,
      receiptId: receipt.receiptId,
      signature: signReceiptId(receipt.receiptId, PRIVATE.privateKey),
      keyFingerprint: PAIR.fingerprint,
      signedAt: new Date().toISOString(),
    }, null, 2));
  };
  const corrupt = () => {
    sign();
    const document = JSON.parse(readFileSync(signaturePath, 'utf8'));
    // A syntactically perfect signature over a DIFFERENT receipt: the
    // verification, not the schema, is what must catch it.
    document.signature = signReceiptId(id('d'), PRIVATE.privateKey);
    writeFileSync(signaturePath, JSON.stringify(document, null, 2));
  };

  const bodyFile = join(materials, 'body.md');
  writeFileSync(bodyFile, BODY);
  return { api, lineage, receipt, enforcementPath, signaturePath, pubkeyPath, anchorPath, sign, corrupt, bodyFile };
}

const ghOk = () => {
  const calls = [];
  return {
    calls,
    runGh: (argv, { stdin = null } = {}) => {
      calls.push({ argv, stdin });
      return argv[0] === 'api'
        ? { status: 0, stdout: BODY, stderr: '' }
        : { status: 0, stdout: `https://github.com/${REPO}/issues/3297#issuecomment-1\n`, stderr: '' };
    },
  };
};
const neverReached = () => { throw new Error('gh must not be reached'); };

// -- the title sits inside the heart of the promise ---------------------------------

test('REGRESSION: mutating the title hash kills the receiptId and the signature (issue-create, the one titled operation)', () => {
  const binding = { operation: 'issue-create', targetRepo: REPO, targetNumber: null, bodySha256: bodyDigest(BODY), titleSha256: bodyDigest('el titulo autorizado\n') };
  const { api, lineage, receipt, signaturePath, sign } = fixture({ required: false, binding });
  sign();
  assert.equal(api.verifySignature({ lineage }).verified, true, 'the honest receipt verifies');

  // The holder of a valid signed receipt swaps the title. If this survived,
  // "I authorize publishing these exact bytes" would exclude the title.
  // (pr-create is retired outright, so issue-create is the whole titled surface.)
  const mutated = { ...receipt, publication: { ...receipt.publication, titleSha256: bodyDigest('otro titulo\n') } };
  assert.equal(receiptIntact(mutated), false, 'the mutation breaks the receipt\'s own id');

  const { receiptId: recorded, ...bound } = mutated;
  const recomputed = digest(bound);
  assert.notEqual(recomputed, receipt.receiptId, 'the mutated record has a different identity');

  const signature = JSON.parse(readFileSync(signaturePath, 'utf8'));
  assert.equal(
    verifySignedReceiptId({ receiptId: recomputed, signature: signature.signature, publicKeyPem: PAIR.publicKeyPem }),
    false,
    'the signature is dead over the recomputed id -- the title change costs a new authorization and a new signature'
  );
});

// -- attach-signature ---------------------------------------------------------------

test('attach-signature verifies and records; the pending request is spent', () => {
  const { api, lineage, sign } = fixture({ required: false });
  sign();

  const attached = api.attachSignature({ lineage });
  assert.equal(attached.signatureAttached, true);
  assert.equal(existsSync(join(api.layout.pendingSignature, `${lineage}.json`)), false, 'the request is answered');
  assert.equal(api.verifySignature({ lineage }).verified, true);
});

test('REGRESSION: attach-signature refuses an absent signature and a signature that does not verify', () => {
  const absent = fixture({ required: false });
  assert.throws(() => absent.api.attachSignature({ lineage: absent.lineage }), (error) =>
    error instanceof StoreError && error.detail.failure === 'no-signature');

  const wrong = fixture({ required: false });
  wrong.corrupt();
  assert.throws(() => wrong.api.attachSignature({ lineage: wrong.lineage }), (error) =>
    error instanceof StoreError && error.detail.failure === 'signature-unverifiable');
  assert.equal(wrong.api.status(wrong.lineage).signatureAttached, false, 'nothing was recorded');
});

test('REGRESSION: a substituted repository public key is caught by the anchor, not blessed', () => {
  const substituted = fixture({ required: false });
  substituted.sign();

  // The attacker replaces the committed PEM with their own pair's public key.
  // The signature they can produce verifies against THAT key -- and the
  // anchored fingerprint, which they cannot write unelevated, does not match.
  const other = generateEncryptedKeyPair(PASSPHRASE);
  writeFileSync(substituted.pubkeyPath, other.publicKeyPem);

  assert.throws(() => substituted.api.attachSignature({ lineage: substituted.lineage }), (error) =>
    error instanceof StoreError && error.detail.failure === 'anchor-mismatch');
});

test('a signature claiming a different key fingerprint refuses as a key mismatch', () => {
  const { api, lineage, sign, signaturePath } = fixture({ required: false });
  sign();
  const document = JSON.parse(readFileSync(signaturePath, 'utf8'));
  document.keyFingerprint = 'f'.repeat(64);
  writeFileSync(signaturePath, JSON.stringify(document, null, 2));

  assert.throws(() => api.attachSignature({ lineage }), (error) =>
    error instanceof StoreError && error.detail.failure === 'signature-key-mismatch');
});

// -- flag OFF: all three states verify and record, none blocks ----------------------

test('flag off: an ABSENT signature is verified, recorded as absent, and blocks nothing', () => {
  const { api, lineage, bodyFile, enforcementPath } = fixture({ required: false });

  const gate = api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  assert.deepEqual({ required: gate.signature.required, state: gate.signature.state }, { required: false, state: 'absent' });

  const reserved = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
  assert.equal(reserved.signature.state, 'absent');

  const { runGh } = ghOk();
  const outcome = publishWithTicket({ store: api, lineage, bodyFile, runGh, enforcementPath });
  assert.equal(outcome.code, 0, 'the flag is off; nothing blocks');
  assert.deepEqual(outcome.attempt.detail.signature, { required: false, state: 'absent', failure: 'no-signature' },
    'the recorded outcome names which case it was');
});

test('flag off: an INVALID signature is verified, recorded as invalid, and blocks nothing', () => {
  const { api, lineage, bodyFile, enforcementPath, corrupt } = fixture({ required: false });
  corrupt();

  const gate = api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  assert.equal(gate.signature.state, 'invalid');
  assert.equal(gate.signature.failure, 'signature-unverifiable');

  api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
  const { runGh } = ghOk();
  const outcome = publishWithTicket({ store: api, lineage, bodyFile, runGh, enforcementPath });
  assert.equal(outcome.code, 0);
  assert.deepEqual(outcome.attempt.detail.signature, { required: false, state: 'invalid', failure: 'signature-unverifiable' });
});

test('flag off: a VALID signature is verified and recorded as valid', () => {
  const { api, lineage, bodyFile, enforcementPath, sign } = fixture({ required: false });
  sign();
  api.attachSignature({ lineage });

  const gate = api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  assert.equal(gate.signature.state, 'valid');

  api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
  const { runGh } = ghOk();
  const outcome = publishWithTicket({ store: api, lineage, bodyFile, runGh, enforcementPath });
  assert.equal(outcome.code, 0);
  assert.deepEqual(outcome.attempt.detail.signature, { required: false, state: 'valid', failure: null });
});

// -- flag ON: absent and invalid refuse with distinct codes; valid passes -----------

test('flag on: an ABSENT signature refuses gate-publish, reserve-attempt and the publisher with signature-absent', () => {
  const { api, lineage, bodyFile, enforcementPath } = fixture({ required: true });

  assert.throws(() => api.gatePublish({ lineage, currentCandidateId: CANDIDATE }), (error) =>
    error instanceof StoreError && error.detail.failure === 'signature-absent'
    && /sign-receipt\.mjs/.test(error.message), 'the refusal names the human signer');
  assert.equal(api.status(lineage).state, 'AUTHORIZED', 'the lineage is intact, waiting for its signature');

  // Force the later stages to prove each layer refuses on its own: flip the
  // flag off, walk forward, flip it back on.
  writeFileSync(enforcementPath, readFileSync(enforcementFile(false), 'utf8'));
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  writeFileSync(enforcementPath, readFileSync(enforcementFile(true), 'utf8'));

  assert.throws(() => api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE }), (error) =>
    error instanceof StoreError && error.detail.failure === 'signature-absent');
  assert.equal(api.status(lineage).attempts, 0, 'no attempt number was burned');

  writeFileSync(enforcementPath, readFileSync(enforcementFile(false), 'utf8'));
  api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
  writeFileSync(enforcementPath, readFileSync(enforcementFile(true), 'utf8'));

  const outcome = publishWithTicket({ store: api, lineage, bodyFile, runGh: neverReached, enforcementPath });
  assert.equal(outcome.outcome, 'refused');
  assert.equal(outcome.refusal.failure, 'signature-absent');
  assert.equal(existsSync(join(api.layout.tickets, `${lineage}.json`)), true, 'the ticket was NOT consumed');
});

test('flag on: an INVALID signature refuses with signature-invalid, distinct from absent', () => {
  const { api, lineage, bodyFile, enforcementPath, corrupt } = fixture({ required: true });
  corrupt();

  assert.throws(() => api.gatePublish({ lineage, currentCandidateId: CANDIDATE }), (error) =>
    error instanceof StoreError && error.detail.failure === 'signature-invalid' && error.detail.cause === 'signature-unverifiable');

  writeFileSync(enforcementPath, readFileSync(enforcementFile(false), 'utf8'));
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
  writeFileSync(enforcementPath, readFileSync(enforcementFile(true), 'utf8'));

  const outcome = publishWithTicket({ store: api, lineage, bodyFile, runGh: neverReached, enforcementPath });
  assert.equal(outcome.refusal.failure, 'signature-invalid');
  assert.equal(existsSync(join(api.layout.tickets, `${lineage}.json`)), true, 'nothing was consumed');
});

test('flag on: a VALID signature passes gate-publish, reserve-attempt and the publisher end to end', () => {
  const { api, lineage, bodyFile, enforcementPath, sign } = fixture({ required: true });
  sign();
  api.attachSignature({ lineage });

  const gate = api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  assert.deepEqual({ required: gate.signature.required, state: gate.signature.state }, { required: true, state: 'valid' });
  api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });

  const { runGh, calls } = ghOk();
  const outcome = publishWithTicket({ store: api, lineage, bodyFile, runGh, enforcementPath });
  assert.equal(outcome.code, 0);
  assert.equal(outcome.bodyIdentical, true);
  assert.equal(calls.length, 2, 'publish and read-back both ran');
  assert.deepEqual(outcome.attempt.detail.signature, { required: true, state: 'valid', failure: null });
});

test('REGRESSION: the publisher re-verifies for itself -- a signature tampered AFTER attach refuses before consuming', () => {
  const { api, lineage, bodyFile, enforcementPath, sign, corrupt } = fixture({ required: true });
  sign();
  api.attachSignature({ lineage });

  writeFileSync(enforcementPath, readFileSync(enforcementFile(false), 'utf8'));
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
  writeFileSync(enforcementPath, readFileSync(enforcementFile(true), 'utf8'));

  // The store still says attached; the bytes on disk no longer verify.
  corrupt();
  assert.equal(api.status(lineage).signatureAttached, true, 'the recorded flag is a record, not the verification');

  const outcome = publishWithTicket({ store: api, lineage, bodyFile, runGh: neverReached, enforcementPath });
  assert.equal(outcome.refusal.failure, 'signature-invalid');
  assert.equal(existsSync(join(api.layout.tickets, `${lineage}.json`)), true, 'the attempt was not spent');
});

test('an unreadable enforcement declaration blocks the publisher instead of defaulting open', () => {
  const { api, lineage, bodyFile, sign } = fixture({ required: true });
  sign();
  api.attachSignature({ lineage });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });

  const outcome = publishWithTicket({
    store: api, lineage, bodyFile, runGh: neverReached,
    enforcementPath: join(scratch, 'no-such-enforcement.json'),
  });
  assert.equal(outcome.outcome, 'refused');
  assert.equal(outcome.refusal.failure, 'enforcement-unreadable');
  assert.equal(existsSync(join(api.layout.tickets, `${lineage}.json`)), true, 'nothing was consumed');
});
