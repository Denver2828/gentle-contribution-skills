#!/usr/bin/env node
// Key generation for receipt signing. RUN BY THE HUMAN, in the human's own
// terminal, once -- and again only with an explicit --rotate.
//
// What it writes:
//   ~/.gentle-aporte/receipt-signing-key.enc   the Ed25519 private key,
//       encrypted under the passphrase (scrypt + AES-256-GCM). OUTSIDE the
//       repository, on purpose: a repo writer never touches it.
//   .claude/tools/audit/keys/receipt-signing.pub   the public key PEM, in the
//       repository and committed: verification must work from a clean checkout.
//
// What it prints and NEVER executes: the elevated PowerShell commands that
// install the anchor under C:\Program Files\GentleAporte\. Elevation is the
// human's act in the human's shell -- a tool that elevates itself would erase
// the exact boundary the anchor exists to draw.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

import { writeAtomic } from '../lib/store/atomic.mjs';
import {
  DEFAULT_KEY_PATH, DEFAULT_PUBKEY_PATH, SigningError,
  assertNoPassphraseInArgv, assertNoPassphraseInEnv, generateEncryptedKeyPair,
  groupedFingerprint, promptHidden,
} from '../lib/signing.mjs';
import { ANCHOR_PATH } from '../lib/anchor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNER_PATH = join(HERE, 'sign-receipt.mjs');

/** The passphrase floor. scrypt stretches, it does not perform miracles on "abc". */
export const MIN_PASSPHRASE_LENGTH = 12;

/**
 * The keygen, IO injected so the logic is testable without a terminal.
 * Returns a process exit code; 0 means both key files were written.
 */
export async function runKeygen({
  keyPath = DEFAULT_KEY_PATH, pubkeyPath = DEFAULT_PUBKEY_PATH,
  signerPath = SIGNER_PATH, anchorPath = ANCHOR_PATH,
  rotate = false, argv = [], env = process.env, io,
}) {
  const refuse = (message) => { io.write(`REFUSED: ${message}\n`); return 1; };

  try {
    assertNoPassphraseInArgv(argv);
    assertNoPassphraseInEnv(env);
  } catch (error) {
    return refuse(error.message);
  }

  // An existing key is never silently replaced: every signature already made
  // verifies against the OLD public key, and rotation is a decision with
  // consequences (re-anchor, re-record the fingerprint), not a default.
  if (!rotate && (existsSync(keyPath) || existsSync(pubkeyPath))) {
    const found = [existsSync(keyPath) ? keyPath : null, existsSync(pubkeyPath) ? pubkeyPath : null].filter(Boolean).join(' and ');
    return refuse(`a signing key already exists (${found}); pass --rotate to replace it deliberately`);
  }

  const first = await io.askHidden('choose a passphrase (12+ characters, never typed anywhere an agent can see): ');
  if (first.length < MIN_PASSPHRASE_LENGTH) {
    return refuse(`the passphrase is shorter than ${MIN_PASSPHRASE_LENGTH} characters; nothing was written`);
  }
  const second = await io.askHidden('type it again: ');
  if (first !== second) return refuse('the two passphrases differ; nothing was written');

  let material;
  try {
    material = generateEncryptedKeyPair(first);
  } catch (error) {
    if (error instanceof SigningError) return refuse(error.message);
    throw error;
  }

  writeAtomic(keyPath, `${JSON.stringify(material.encrypted, null, 2)}\n`);
  writeAtomic(pubkeyPath, material.publicKeyPem);

  // sha256 of the signer file, offered for the anchor's optional signerSha256:
  // it lets the human spot-check that the small readable signer is still the
  // signer that was anchored.
  const signerSha256 = existsSync(signerPath)
    ? createHash('sha256').update(readFileSync(signerPath)).digest('hex')
    : null;
  const grouped = groupedFingerprint(material.fingerprint);
  const anchor = JSON.stringify({
    pubkeyFingerprint: material.fingerprint,
    signerSha256,
    anchoredAt: new Date().toISOString(),
  });

  io.write([
    '',
    'written:',
    `  encrypted private key  ${keyPath}   (outside the repository; the passphrase is the only way in)`,
    `  public key PEM         ${pubkeyPath}   (commit this)`,
    '',
    '='.repeat(74),
    '',
    '   KEY FINGERPRINT -- record this somewhere OUTSIDE this machine',
    '   (a note on paper, a password manager). It is what you compare',
    '   against when anything ever looks wrong:',
    '',
    `   ${grouped.slice(0, 39)}`,
    `   ${grouped.slice(40)}`,
    '',
    '='.repeat(74),
    '',
    'Now install the anchor. Open an ELEVATED PowerShell (Run as administrator)',
    'and run exactly these two commands -- this tool prints them and never runs',
    'them, because the elevation is yours, not an agent\'s:',
    '',
    `  New-Item -ItemType Directory -Path 'C:\\Program Files\\GentleAporte' -Force | Out-Null`,
    `  Set-Content -Path '${anchorPath}' -Encoding utf8 -Value '${anchor}'`,
    '',
    'The directory is admin-write-only by Windows default ACLs; that is the',
    'point. Verification refuses any pubkey whose fingerprint is not the',
    'anchored one.',
    '',
    'The anchor also records the signer\'s sha256. Before any signing session,',
    'you can spot-check that the signer is still the anchored one -- your own',
    'command, your own terminal, never the signer hashing itself:',
    '',
    `  Get-FileHash '${signerPath}' -Algorithm SHA256   # compare to signerSha256 in the anchor`,
    '',
    'Honest scope: human-only execution of keygen and the signer is an',
    'operational rule -- the human opens an independent terminal and invokes',
    'these binaries themselves; isTTY cannot demonstrate it cryptographically.',
    'The argv, env and piped-stdin refusals close the accidental leak paths;',
    'the anchor and this recorded fingerprint are what you compare against',
    'when anything looks wrong.',
    '',
  ].join('\n'));
  return 0;
}

// -- process boundary -------------------------------------------------------------

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();

if (invokedDirectly) {
  try {
    assertNoPassphraseInArgv(process.argv);
    assertNoPassphraseInEnv(process.env);
  } catch (error) {
    process.stderr.write(`REFUSED: ${error.message}\n`);
    process.exit(1);
  }

  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const io = {
    write: (text) => process.stderr.write(text),
    askHidden: (question) => { readline.pause(); return promptHidden(question); },
  };

  const code = await runKeygen({ rotate: process.argv.includes('--rotate'), argv: process.argv, io });
  readline.close();
  process.exit(code);
}
