// The signing layer: Ed25519 over receiptIds, the encrypted key, the leak-path
// refusals, and the admin-only anchor.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  generateEncryptedKeyPair, decryptPrivateKey, signReceiptId, verifySignedReceiptId,
  keyFingerprint, groupedFingerprint, assertNoPassphraseInArgv, assertNoPassphraseInEnv,
  promptHidden, SigningError,
} from '../lib/signing.mjs';
import { readAnchor, anchorVerdict, assertAnchoredFingerprint, AnchorError } from '../lib/anchor.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'audit-signing-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const PASSPHRASE = 'una frase larga que nadie adivina';
const RECEIPT_ID = `sha256:${'a'.repeat(64)}`;

// One pair for the whole file: scrypt is deliberately slow.
const PAIR = generateEncryptedKeyPair(PASSPHRASE);

let sequence = 0;
function anchorFile(document) {
  const path = join(scratch, `anchor-${sequence += 1}.json`);
  writeFileSync(path, typeof document === 'string' ? document : JSON.stringify(document));
  return path;
}

const anchorFor = (fingerprint) => anchorFile({ pubkeyFingerprint: fingerprint, signerSha256: null, anchoredAt: new Date().toISOString() });

// -- keygen roundtrip ---------------------------------------------------------------

test('keygen roundtrip: generate, decrypt with the passphrase, sign, verify', () => {
  const { privateKey, wipe } = decryptPrivateKey(PAIR.encrypted, PASSPHRASE);
  const signature = signReceiptId(RECEIPT_ID, privateKey);
  wipe();

  assert.equal(verifySignedReceiptId({ receiptId: RECEIPT_ID, signature, publicKeyPem: PAIR.publicKeyPem }), true);
  assert.equal(PAIR.encrypted.keyFingerprint, PAIR.fingerprint, 'the key file names its own public fingerprint');
  assert.equal(keyFingerprint(PAIR.publicKeyPem), PAIR.fingerprint, 'the PEM reproduces the same fingerprint');
});

test('the encrypted key file never carries the private material in the clear', () => {
  const text = JSON.stringify(PAIR.encrypted);
  assert.equal(PAIR.encrypted.kdf.algorithm, 'scrypt');
  assert.equal(PAIR.encrypted.cipher.algorithm, 'aes-256-gcm');
  assert.doesNotMatch(text, /PRIVATE KEY/, 'no PEM private block');
  assert.equal(typeof PAIR.encrypted.ciphertext, 'string');
});

test('REGRESSION: a wrong passphrase fails decryption instead of yielding a key', () => {
  assert.throws(() => decryptPrivateKey(PAIR.encrypted, 'la frase equivocada'), (error) =>
    error instanceof SigningError && error.detail.failure === 'wrong-passphrase');
});

test('a signature over a different receiptId does not verify', () => {
  const { privateKey, wipe } = decryptPrivateKey(PAIR.encrypted, PASSPHRASE);
  const signature = signReceiptId(RECEIPT_ID, privateKey);
  wipe();

  assert.equal(verifySignedReceiptId({ receiptId: `sha256:${'b'.repeat(64)}`, signature, publicKeyPem: PAIR.publicKeyPem }), false);
  assert.equal(verifySignedReceiptId({ receiptId: RECEIPT_ID, signature: 'no es base64 de nada util', publicKeyPem: PAIR.publicKeyPem }), false, 'garbage is false, never a throw');
});

test('a signature from another key does not verify against this public key', () => {
  const other = generateEncryptedKeyPair(PASSPHRASE);
  const { privateKey, wipe } = decryptPrivateKey(other.encrypted, PASSPHRASE);
  const signature = signReceiptId(RECEIPT_ID, privateKey);
  wipe();

  assert.equal(verifySignedReceiptId({ receiptId: RECEIPT_ID, signature, publicKeyPem: PAIR.publicKeyPem }), false);
});

test('the fingerprint displays grouped, xxxx-xxxx-…', () => {
  const grouped = groupedFingerprint(PAIR.fingerprint);
  assert.match(grouped, /^([0-9a-f]{4}-){15}[0-9a-f]{4}$/);
  assert.equal(grouped.replaceAll('-', ''), PAIR.fingerprint);
  assert.throws(() => groupedFingerprint('short'), SigningError);
});

// -- the leak paths refuse, each on its own -----------------------------------------

test('REGRESSION: a passphrase-shaped argv token refuses, in every spelling', () => {
  for (const argv of [
    ['node', 'sign-receipt.mjs', '--passphrase', 'hunter2'],
    ['node', 'sign-receipt.mjs', '--passphrase=hunter2'],
    ['node', 'sign-receipt.mjs', '--password', 'hunter2'],
    ['node', 'sign-receipt.mjs', '--pass=hunter2'],
    ['node', 'sign-receipt.mjs', 'passphrase=hunter2'],
  ]) {
    assert.throws(() => assertNoPassphraseInArgv(argv), (error) =>
      error instanceof SigningError && error.detail.failure === 'passphrase-in-argv', argv.join(' '));
  }
  assert.doesNotThrow(() => assertNoPassphraseInArgv(['node', 'sign-receipt.mjs', '--lineage', 'x']));
});

test('REGRESSION: a passphrase-shaped environment variable refuses, naming the variable and never its value', () => {
  for (const name of ['PASSPHRASE', 'GENTLE_APORTE_PASSPHRASE', 'SIGNING_PASSWORD', 'password']) {
    try {
      assertNoPassphraseInEnv({ PATH: 'x', [name]: 'hunter2' });
      assert.fail(`${name} must refuse`);
    } catch (error) {
      assert.equal(error instanceof SigningError, true);
      assert.equal(error.detail.failure, 'passphrase-in-env');
      assert.equal(error.detail.variable, name);
      assert.doesNotMatch(error.message, /hunter2/, 'the value never appears anywhere');
    }
  }
  assert.doesNotThrow(() => assertNoPassphraseInEnv({ PATH: 'x', PSModulePath: 'y', HOME: 'z' }));
});

test('REGRESSION: the muted prompt refuses piped or redirected stdin', async () => {
  await assert.rejects(
    promptHidden('passphrase: ', { input: { isTTY: false }, output: { write() {} } }),
    (error) => error instanceof SigningError && error.detail.failure === 'non-interactive-stdin'
  );
});

test('the muted prompt echoes nothing of what is typed', async () => {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  const output = { text: '', write(chunk) { this.text += chunk; } };

  const pending = promptHidden('passphrase: ', { input, output });
  input.emit('data', Buffer.from('secreto'));
  input.emit('data', Buffer.from('\r'));

  assert.equal(await pending, 'secreto');
  assert.equal(output.text.includes('secreto'), false, 'the passphrase never reaches the output stream');
});

// -- the anchor ---------------------------------------------------------------------

test('a matching anchored fingerprint passes', () => {
  const path = anchorFor(PAIR.fingerprint);
  assert.equal(anchorVerdict({ fingerprint: PAIR.fingerprint, path }).status, 'match');
  assert.doesNotThrow(() => assertAnchoredFingerprint({ fingerprint: PAIR.fingerprint, path }));
});

test('REGRESSION: a fingerprint mismatch refuses whether or not signing is required', () => {
  const path = anchorFor('f'.repeat(64));
  for (const required of [true, false]) {
    assert.throws(() => assertAnchoredFingerprint({ fingerprint: PAIR.fingerprint, path, required }), (error) =>
      error instanceof AnchorError && error.detail.failure === 'anchor-mismatch', `required=${required}`);
  }
});

test('REGRESSION: a missing anchor refuses when required, passes when not', () => {
  const absent = join(scratch, 'no-such-anchor.json');
  assert.throws(() => assertAnchoredFingerprint({ fingerprint: PAIR.fingerprint, path: absent, required: true }), (error) =>
    error instanceof AnchorError && error.detail.failure === 'missing-anchor');
  assert.equal(assertAnchoredFingerprint({ fingerprint: PAIR.fingerprint, path: absent, required: false }).status, 'missing');
});

test('a present-but-broken anchor always refuses; it is never read as absent', () => {
  const cases = {
    'not JSON': anchorFile('{ not json'),
    'no fingerprint': anchorFile({ anchoredAt: 'now' }),
    'malformed fingerprint': anchorFile({ pubkeyFingerprint: 'XYZ', anchoredAt: 'now' }),
    'no anchoredAt': anchorFile({ pubkeyFingerprint: 'a'.repeat(64) }),
    'malformed signerSha256': anchorFile({ pubkeyFingerprint: 'a'.repeat(64), signerSha256: 'nope', anchoredAt: 'now' }),
  };
  for (const [label, path] of Object.entries(cases)) {
    assert.throws(() => readAnchor({ path }), AnchorError, label);
  }
});

test('a PowerShell-written anchor with a BOM reads fine', () => {
  const path = anchorFile(`﻿${JSON.stringify({ pubkeyFingerprint: PAIR.fingerprint, signerSha256: null, anchoredAt: '2026-08-16T00:00:00.000Z' })}`);
  assert.equal(readAnchor({ path }).anchor.pubkeyFingerprint, PAIR.fingerprint);
});
