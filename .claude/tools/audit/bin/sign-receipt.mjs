#!/usr/bin/env node
// The receipt signer. RUN BY THE HUMAN, in the human's own terminal, never
// through an agent: the passphrase typed here must not pass through any
// agent's tools. The argv and env scans refuse a command line or environment
// that carries one, and the muted prompt refuses piped stdin.
//
// What those refusals are, honestly: they close the accidental and convenient
// leak paths. The TTY requirement on the prompt is hygiene against a
// passphrase landing in a pipeline, a CI log or an agent transcript -- it is
// NOT proof of a human, because a pseudo-TTY can be allocated by tooling and
// isTTY identifies the channel type, not who controls it. Human-only
// execution is an operational rule -- the human opens an independent terminal
// and invokes this binary themselves; isTTY cannot demonstrate it
// cryptographically. What gives the rule teeth is also operational: this
// signer displays the provenance of its own inputs (which pending-request
// file, which receipt file), and the anchor may record this file's sha256 so
// the human can spot-check, with their own command in their own terminal, the
// binary they are about to run.
//
// This file is deliberately small and linear -- it is the component the human
// must be able to audit by eye. It reads the pending request, RECOMPUTES the
// receiptId from the receipt record itself (a passed-in id is never trusted),
// shows what is about to be authorized next to the anchored fingerprint, and
// demands the last 6 hex characters of the recomputed id as confirmation --
// which cannot be typed without reading the id. Then, and only then, the
// muted passphrase prompt, the decryption, and one detached signature.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

import { digest } from '../lib/canonical.mjs';
import { writeAtomic } from '../lib/store/atomic.mjs';
import { storeLayout } from '../lib/store/store.mjs';
import { resolveStoreRoot, assertContentId, assertLineageName } from '../lib/store/paths.mjs';
import {
  SIGNATURE_VERSION, DEFAULT_KEY_PATH, DEFAULT_PUBKEY_PATH, SigningError,
  assertNoPassphraseInArgv, assertNoPassphraseInEnv, decryptPrivateKey,
  keyFingerprint, groupedFingerprint, signReceiptId, promptHidden,
} from '../lib/signing.mjs';
import { ANCHOR_PATH, anchorVerdict } from '../lib/anchor.mjs';

function readJson(path, label) {
  if (!existsSync(path)) throw new SigningError(`${label} does not exist: ${path}`, { failure: 'absent' });
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new SigningError(`${label} is not readable JSON: ${error.message}`, { failure: 'unreadable' });
  }
}

/**
 * The whole signer, with its IO injected so the logic is testable without a
 * terminal. Returns a process exit code; 0 means one signature was written.
 */
export async function runSigner({
  lineage, storeRoot = resolveStoreRoot(),
  keyPath = DEFAULT_KEY_PATH, pubkeyPath = DEFAULT_PUBKEY_PATH, anchorPath = ANCHOR_PATH,
  argv = [], env = process.env, io,
}) {
  const refuse = (message) => { io.write(`REFUSED: ${message}\n`); return 1; };

  try {
    assertNoPassphraseInArgv(argv);
    assertNoPassphraseInEnv(env);
    assertLineageName(lineage);
  } catch (error) {
    return refuse(error.message);
  }

  const layout = storeLayout(storeRoot);
  let pending; let pendingPath; let receipt; let receiptPath;
  try {
    const index = readJson(layout.index, 'the committed store index');
    const committedReceiptId = index?.lineages?.[lineage]?.receiptId;
    if (typeof committedReceiptId !== 'string') {
      throw new SigningError(`the committed index has no current receipt for "${lineage}"`, { failure: 'absent' });
    }
    const exactPendingPath = join(layout.pendingSignature, `${assertContentId(committedReceiptId)}.json`);
    const legacyPendingPath = join(layout.pendingSignature, `${lineage}.json`);
    pendingPath = existsSync(exactPendingPath) ? exactPendingPath : legacyPendingPath;
    pending = readJson(pendingPath, `the pending-signature request for "${lineage}"`);
    if (pending.receiptId !== committedReceiptId) {
      throw new SigningError('the pending request is not for the receipt selected by the committed index', { failure: 'receipt-mismatch' });
    }
    receiptPath = join(layout.authorizations, `${assertContentId(pending.receiptId)}.json`);
    receipt = readJson(receiptPath, 'the receipt record');
  } catch (error) {
    return refuse(error.message);
  }

  // The id is recomputed from the record itself. The pending file and the
  // record's own receiptId field are both just claims; the digest decides.
  const { receiptId: claimed, ...bound } = receipt;
  const receiptId = digest(bound);
  if (receiptId !== claimed) return refuse('the receipt record does not reproduce its own receiptId; it was altered and must not be signed');
  if (receiptId !== pending.receiptId) return refuse('the pending request names a different receipt than the record reproduces');
  if (bound.publication === undefined) return refuse('the receipt carries no publication binding; there is nothing exact to authorize');

  if (!existsSync(pubkeyPath)) return refuse(`no public key at ${pubkeyPath}; run keygen first`);
  let fingerprint;
  try {
    fingerprint = keyFingerprint(readFileSync(pubkeyPath, 'utf8'));
  } catch (error) {
    return refuse(`the public key is unusable: ${error.message}`);
  }
  const anchored = anchorVerdict({ fingerprint, path: anchorPath });

  const p = bound.publication;
  const lines = [
    '',
    'You are about to sign ONE authorization. Read every line.',
    '',
    '  inputs read (verify these are the files you expect):',
    `    pending request:      ${pendingPath}`,
    `    receipt record:       ${receiptPath}`,
    '',
    `  receiptId (recomputed): ${receiptId}`,
    `  candidateId:            ${bound.candidateId}`,
    `  evidenceId:             ${bound.evidenceId}`,
    `  decisionId:             ${bound.decisionId}`,
    `  operation:              ${p.operation}`,
    `  targetRepo:             ${p.targetRepo}`,
    `  targetNumber:           ${p.targetNumber ?? '(created by the operation)'}`,
    `  bodySha256:             ${p.bodySha256}`,
    `  titleSha256:            ${p.titleSha256 ?? '(none bound)'}`,
    '',
    `  local key fingerprint:  ${groupedFingerprint(fingerprint)}`,
    `  anchored fingerprint:   ${anchored.anchored === null ? '(no anchor found)' : groupedFingerprint(anchored.anchored)}`,
    `  verdict:                ${anchored.status === 'match' ? 'MATCH' : 'MISMATCH'}`,
    '',
  ];
  // The anchored signer hash is printed for the HUMAN to check with their own
  // command. This signer never hashes itself and prints MATCH: a modified
  // signer would lie about itself, so the comparison must be the human's act.
  if (anchored.anchor?.signerSha256) {
    lines.push(
      `  anchored signer sha256: ${anchored.anchor.signerSha256}`,
      '  compare it yourself, in your own terminal:',
      `    Get-FileHash '${process.argv[1] ?? 'bin/sign-receipt.mjs'}' -Algorithm SHA256`,
      ''
    );
  }
  io.write(lines.join('\n'));

  if (anchored.status !== 'match') {
    return refuse(anchored.status === 'missing'
      ? `no anchor at ${anchorPath}; install it from an elevated shell (keygen printed the exact commands) before signing`
      : 'the local public key is NOT the anchored one; signing with it would bless a substituted key');
  }

  const confirmation = await io.ask('To confirm, type the LAST 6 characters of the recomputed receiptId above: ');
  if (confirmation.trim().toLowerCase() !== receiptId.slice(-6)) {
    return refuse('the confirmation does not match the receiptId; nothing was signed');
  }

  let material;
  try {
    material = decryptPrivateKey(readJson(keyPath, 'the encrypted signing key'), await io.askHidden('passphrase: '));
  } catch (error) {
    return refuse(error.message);
  }

  const signature = {
    signatureVersion: SIGNATURE_VERSION,
    receiptId,
    signature: signReceiptId(receiptId, material.privateKey),
    keyFingerprint: fingerprint,
    signedAt: new Date().toISOString(),
  };
  // Zero our copy of the key material before anything touches the disk.
  material.wipe();

  const signaturePath = join(layout.signatures, `${assertContentId(receiptId)}.sig.json`);
  writeAtomic(signaturePath, `${JSON.stringify(signature, null, 2)}\n`);
  io.write(`\nsigned: ${signaturePath}\nnext: node .claude/skills/gentle-ai-aporte/scripts/ledger.mjs attach-signature --lineage ${lineage}\n`);
  return 0;
}

// -- process boundary -------------------------------------------------------------

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();

if (invokedDirectly) {
  // The scans run before anything else: a passphrase on the command line or
  // in the environment has already leaked into history, process listings or
  // child processes, and refusing loudly is the only honest response left.
  try {
    assertNoPassphraseInArgv(process.argv);
    assertNoPassphraseInEnv(process.env);
  } catch (error) {
    process.stderr.write(`REFUSED: ${error.message}\n`);
    process.exit(1);
  }

  const args = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    if (!process.argv[index].startsWith('--')) continue;
    const next = process.argv[index + 1];
    args[process.argv[index].slice(2)] = next && !next.startsWith('--') ? next : 'true';
  }
  if (!args.lineage || args.lineage === 'true') {
    process.stderr.write('usage: sign-receipt.mjs --lineage <lineage>\n');
    process.exit(3);
  }

  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const io = {
    write: (text) => process.stderr.write(text),
    ask: (question) => new Promise((resolveAnswer) => readline.question(question, resolveAnswer)),
    askHidden: (question) => { readline.pause(); return promptHidden(question); },
  };

  const code = await runSigner({ lineage: args.lineage, argv: process.argv, io });
  readline.close();
  process.exit(code);
}
