// The human-run binaries: the signer that produces one detached signature,
// and the keygen that mints the encrypted pair. All IO here is injected -- the
// logic runs without a terminal, and every displayed field is asserted to
// derive from the record on disk, never from anything passed in.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSigner } from '../bin/sign-receipt.mjs';
import { runKeygen, MIN_PASSPHRASE_LENGTH } from '../bin/keygen.mjs';
import { openStore } from '../lib/store/store.mjs';
import { generateEncryptedKeyPair, verifySignedReceiptId, keyFingerprint, groupedFingerprint } from '../lib/signing.mjs';
import { validateSignature } from '../lib/validate.mjs';
import { bodyDigest } from '../lib/ticket.mjs';
import { buildEvidence } from '../lib/evidence-record.mjs';
import { REQUIRED_SOURCES, READING, CONTRIBUTION } from '../lib/intake.mjs';
import { STATUS } from '../lib/status.mjs';
import { completeCoverage, auditorResult, TASK_CONTRACT } from './helpers/documents.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'audit-signer-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const PASSPHRASE = 'doce caracteres al menos';
const PAIR = generateEncryptedKeyPair(PASSPHRASE);

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

const BINDING = { operation: 'issue-comment', targetRepo: REPO, targetNumber: 3297, bodySha256: bodyDigest('el cuerpo\n'), titleSha256: null };

/** A store with an authorized (unsigned) lineage, plus key and anchor fixtures. */
function signingFixture({ anchorFingerprint = PAIR.fingerprint, signerSha256 = null } = {}) {
  const root = mkdtempSync(join(scratch, 'store-'));
  const api = openStore({ override: root, allowOutsideWorkspace: true, lockOptions: { waitMs: 4000 } });
  const lineage = `s-${sequence += 1}`;
  const frozen = api.freeze({ lineage, candidateId: CANDIDATE, ...FREEZE, draftBodySha256: BINDING.bodySha256 });
  api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'PASS') });
  api.recordEvidence({ lineage, evidence: evidenceFor() });
  const { receipt } = api.authorize({ lineage, publication: BINDING });

  const fixtures = mkdtempSync(join(scratch, 'fixtures-'));
  const keyPath = join(fixtures, 'receipt-signing-key.enc');
  writeFileSync(keyPath, JSON.stringify(PAIR.encrypted));
  const pubkeyPath = join(fixtures, 'receipt-signing.pub');
  writeFileSync(pubkeyPath, PAIR.publicKeyPem);
  const anchorPath = join(fixtures, 'receipt-signing.anchor.json');
  writeFileSync(anchorPath, JSON.stringify({ pubkeyFingerprint: anchorFingerprint, signerSha256, anchoredAt: new Date().toISOString() }));

  return { root, api, lineage, receipt, keyPath, pubkeyPath, anchorPath };
}

/** Scripted IO: canned answers in, everything written captured for assertion. */
function scriptedIo({ confirmation, passphrase = PASSPHRASE, hidden = [] } = {}) {
  const hiddenQueue = [...hidden];
  const io = {
    text: '',
    write(chunk) { this.text += chunk; },
    ask: async () => confirmation,
    askHidden: async () => (hiddenQueue.length > 0 ? hiddenQueue.shift() : passphrase),
  };
  return io;
}

const signerArgs = (fixture, io, overrides = {}) => ({
  lineage: fixture.lineage, storeRoot: fixture.root,
  keyPath: fixture.keyPath, pubkeyPath: fixture.pubkeyPath, anchorPath: fixture.anchorPath,
  env: { PATH: 'x' }, io, ...overrides,
});

// -- the signer ---------------------------------------------------------------------

test('the signer displays every bound field from the record itself, with its inputs named', async () => {
  const fixture = signingFixture();
  const io = scriptedIo({ confirmation: fixture.receipt.receiptId.slice(-6) });

  const code = await runSigner(signerArgs(fixture, io));
  assert.equal(code, 0);

  for (const shown of [
    fixture.receipt.receiptId, fixture.receipt.candidateId, fixture.receipt.evidenceId, fixture.receipt.decisionId,
    BINDING.operation, BINDING.targetRepo, String(BINDING.targetNumber), BINDING.bodySha256,
    groupedFingerprint(PAIR.fingerprint),
    'MATCH',
    // Provenance: the human sees WHICH files fed the decision.
    join(fixture.api.layout.pendingSignature, `${fixture.receipt.receiptId.slice('sha256:'.length)}.json`),
  ]) {
    assert.equal(io.text.includes(shown), true, `the display must carry ${shown}`);
  }

  const signaturePath = join(fixture.api.layout.signatures, `${fixture.receipt.receiptId.slice(7)}.sig.json`);
  const signature = JSON.parse(readFileSync(signaturePath, 'utf8'));
  assert.equal(validateSignature(signature).valid, true);
  assert.equal(signature.receiptId, fixture.receipt.receiptId);
  assert.equal(signature.keyFingerprint, keyFingerprint(PAIR.publicKeyPem));
  assert.equal(verifySignedReceiptId({ receiptId: signature.receiptId, signature: signature.signature, publicKeyPem: PAIR.publicKeyPem }), true);
});

test('REGRESSION: a bare "y" -- or any wrong confirmation -- refuses; only the last 6 hex of the id sign', async () => {
  const fixture = signingFixture();
  for (const confirmation of ['y', 'yes', 'si', fixture.receipt.receiptId.slice(-7, -1)]) {
    const io = scriptedIo({ confirmation });
    assert.equal(await runSigner(signerArgs(fixture, io)), 1, `"${confirmation}" must refuse`);
    assert.match(io.text, /does not match the receiptId/);
  }
  assert.equal(existsSync(join(fixture.api.layout.signatures, `${fixture.receipt.receiptId.slice(7)}.sig.json`)), false, 'nothing was signed');
});

test('REGRESSION: a tampered receipt fails its recomputed id and is never signed', async () => {
  const fixture = signingFixture();
  const receiptPath = join(fixture.api.layout.authorizations, `${fixture.receipt.receiptId.slice(7)}.json`);
  const tampered = { ...JSON.parse(readFileSync(receiptPath, 'utf8')) };
  tampered.publication = { ...tampered.publication, targetNumber: 9999 };
  writeFileSync(receiptPath, JSON.stringify(tampered, null, 2));

  const io = scriptedIo({ confirmation: fixture.receipt.receiptId.slice(-6) });
  assert.equal(await runSigner(signerArgs(fixture, io)), 1);
  assert.match(io.text, /does not reproduce its own receiptId/);
  assert.equal(existsSync(join(fixture.api.layout.signatures, `${fixture.receipt.receiptId.slice(7)}.sig.json`)), false);
});

test('REGRESSION: a passphrase in argv or env refuses before anything is read', async () => {
  const fixture = signingFixture();

  const viaArgv = scriptedIo({ confirmation: fixture.receipt.receiptId.slice(-6) });
  assert.equal(await runSigner(signerArgs(fixture, viaArgv, { argv: ['node', 'sign-receipt.mjs', '--passphrase', 'x'] })), 1);
  assert.match(viaArgv.text, /never via argv or env/);

  const viaEnv = scriptedIo({ confirmation: fixture.receipt.receiptId.slice(-6) });
  assert.equal(await runSigner(signerArgs(fixture, viaEnv, { env: { RECEIPT_PASSPHRASE: 'x' } })), 1);
  assert.match(viaEnv.text, /passphrase-shaped/);
});

test('an anchor mismatch refuses to sign, and says whose key is not anchored', async () => {
  const fixture = signingFixture({ anchorFingerprint: 'f'.repeat(64) });
  const io = scriptedIo({ confirmation: fixture.receipt.receiptId.slice(-6) });

  assert.equal(await runSigner(signerArgs(fixture, io)), 1);
  assert.match(io.text, /MISMATCH/);
  assert.match(io.text, /NOT the anchored one/);
});

test('a missing anchor refuses to sign and points at the elevated install', async () => {
  const fixture = signingFixture();
  const io = scriptedIo({ confirmation: fixture.receipt.receiptId.slice(-6) });

  assert.equal(await runSigner(signerArgs(fixture, io, { anchorPath: join(scratch, 'no-anchor.json') })), 1);
  assert.match(io.text, /no anchor at/);
});

test('a wrong passphrase at the prompt refuses after the confirmation, signing nothing', async () => {
  const fixture = signingFixture();
  const io = scriptedIo({ confirmation: fixture.receipt.receiptId.slice(-6), passphrase: 'la equivocada' });

  assert.equal(await runSigner(signerArgs(fixture, io)), 1);
  assert.match(io.text, /does not decrypt/);
  assert.equal(existsSync(join(fixture.api.layout.signatures, `${fixture.receipt.receiptId.slice(7)}.sig.json`)), false);
});

test('when the anchor records the signer sha256, the signer prints it and the human-run hash command, never a self-judged MATCH', async () => {
  const signerHash = '1'.repeat(64);
  const fixture = signingFixture({ signerSha256: signerHash });
  const io = scriptedIo({ confirmation: fixture.receipt.receiptId.slice(-6) });

  assert.equal(await runSigner(signerArgs(fixture, io)), 0);
  assert.equal(io.text.includes(signerHash), true, 'the anchored hash is displayed');
  assert.match(io.text, /Get-FileHash/, 'with the exact command for the human to run themselves');
  assert.match(io.text, /compare it yourself/i, 'the comparison is the human\'s act, not the signer\'s');
});

// -- the keygen ---------------------------------------------------------------------

function keygenPaths() {
  const directory = mkdtempSync(join(scratch, 'keygen-'));
  return { keyPath: join(directory, 'key.enc'), pubkeyPath: join(directory, 'repo.pub') };
}

test('keygen writes the encrypted key and the pubkey, and prints the grouped fingerprint with the anchor commands', async () => {
  const { keyPath, pubkeyPath } = keygenPaths();
  const io = scriptedIo({ hidden: [PASSPHRASE, PASSPHRASE] });

  const code = await runKeygen({ keyPath, pubkeyPath, rotate: false, env: { PATH: 'x' }, io });
  assert.equal(code, 0);

  const written = JSON.parse(readFileSync(keyPath, 'utf8'));
  const fingerprint = keyFingerprint(readFileSync(pubkeyPath, 'utf8'));
  assert.equal(written.keyFingerprint, fingerprint, 'key file and pubkey describe one pair');

  assert.equal(io.text.includes(groupedFingerprint(fingerprint).slice(0, 39)), true, 'the fingerprint prints LARGE, grouped');
  assert.match(io.text, /record this somewhere OUTSIDE this machine/i);
  assert.match(io.text, /New-Item -ItemType Directory -Path 'C:\\Program Files\\GentleAporte'/);
  assert.match(io.text, /Set-Content -Path/);
  assert.equal(io.text.includes(fingerprint), true, 'the anchor command embeds the real fingerprint');
  assert.match(io.text, /Get-FileHash/, 'and the spot-check command for the signer');
  assert.match(io.text, /isTTY cannot demonstrate it cryptographically/, 'the honest scope is printed, not implied');
});

test('REGRESSION: keygen refuses to overwrite an existing key without --rotate, and --rotate replaces it', async () => {
  const { keyPath, pubkeyPath } = keygenPaths();
  const first = scriptedIo({ hidden: [PASSPHRASE, PASSPHRASE] });
  assert.equal(await runKeygen({ keyPath, pubkeyPath, env: {}, io: first }), 0);
  const before = readFileSync(keyPath, 'utf8');

  const refused = scriptedIo({ hidden: [PASSPHRASE, PASSPHRASE] });
  assert.equal(await runKeygen({ keyPath, pubkeyPath, env: {}, io: refused }), 1);
  assert.match(refused.text, /--rotate/);
  assert.equal(readFileSync(keyPath, 'utf8'), before, 'nothing changed');

  const rotated = scriptedIo({ hidden: [PASSPHRASE, PASSPHRASE] });
  assert.equal(await runKeygen({ keyPath, pubkeyPath, rotate: true, env: {}, io: rotated }), 0);
  assert.notEqual(readFileSync(keyPath, 'utf8'), before, 'a deliberate rotation replaces the pair');
});

test('keygen refuses a short passphrase and a mismatched confirmation, writing nothing', async () => {
  const { keyPath, pubkeyPath } = keygenPaths();

  const short = scriptedIo({ hidden: ['corta', 'corta'] });
  assert.equal(await runKeygen({ keyPath, pubkeyPath, env: {}, io: short }), 1);
  assert.match(short.text, new RegExp(String(MIN_PASSPHRASE_LENGTH)));

  const mismatched = scriptedIo({ hidden: [PASSPHRASE, `${PASSPHRASE} distinta`] });
  assert.equal(await runKeygen({ keyPath, pubkeyPath, env: {}, io: mismatched }), 1);
  assert.match(mismatched.text, /differ/);

  assert.equal(existsSync(keyPath), false);
  assert.equal(existsSync(pubkeyPath), false);
});

test('keygen refuses a passphrase-shaped argv or env exactly like the signer', async () => {
  const { keyPath, pubkeyPath } = keygenPaths();

  const viaArgv = scriptedIo({});
  assert.equal(await runKeygen({ keyPath, pubkeyPath, argv: ['node', 'keygen.mjs', '--passphrase=x'], env: {}, io: viaArgv }), 1);
  const viaEnv = scriptedIo({});
  assert.equal(await runKeygen({ keyPath, pubkeyPath, env: { KEYGEN_PASSWORD: 'x' }, io: viaEnv }), 1);
  assert.equal(existsSync(keyPath), false);
});
