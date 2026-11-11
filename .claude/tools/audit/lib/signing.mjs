// Receipt signing: Node-native Ed25519, nothing else.
//
// WHAT THIS ADDS that the content-addressed receipt cannot: a receipt id can
// be recomputed by anyone, so anyone who can write into the store can write a
// consistent receipt. A detached Ed25519 signature over the receiptId can only
// be produced by whoever holds the passphrase to the encrypted private key,
// which lives OUTSIDE the repository. That closes offline forgery of receipts
// by a writer without the passphrase -- and closes exactly that, nothing more.
// Public-key substitution, verifier modification, store rollback and session
// compromise are named in the README as the residue, not resolved here.
//
// THE PASSPHRASE NEVER TRAVELS THROUGH ARGV OR ENV. A command line is visible
// to every process lister and lands in shell history; an environment variable
// is inherited by every child. The only accepted path is an interactive muted
// prompt: `assertNoPassphraseInArgv` and `assertNoPassphraseInEnv` refuse
// anything that even looks like it is carrying one, and the prompt itself
// refuses piped or redirected stdin. Those three refusals are real: they close
// the accidental and convenient leak paths.
//
// What the TTY check is NOT: proof of a human. Agent tooling can allocate a
// pseudo-TTY (ConPTY, node-pty, script(1)) and write to its input; isTTY
// identifies the channel type, not who controls it. The check is hygiene
// against a passphrase landing in a pipeline, a CI log or an agent transcript
// -- nothing more, and no comment or doc in this layer claims more.

import {
  createHash, createPublicKey, createPrivateKey, randomBytes, scryptSync,
  createCipheriv, createDecipheriv, generateKeyPairSync,
  sign as edSign, verify as edVerify,
} from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SIGNATURE_VERSION = '1.0.0';
export const KEY_FILE_VERSION = '1.0.0';

/** The encrypted private key lives in the HOME directory, never in the repo. */
export const DEFAULT_KEY_PATH = join(homedir(), '.gentle-aporte', 'receipt-signing-key.enc');

/** The public key is committed: verification must work from a clean checkout. */
export const DEFAULT_PUBKEY_PATH = join(HERE, '..', 'keys', 'receipt-signing.pub');

/**
 * scrypt parameters, written into the key file so decryption never guesses.
 * N=2^15 is deliberate: slow enough to hurt an offline guesser, fast enough
 * that the human signs without noticing.
 */
const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, keyLength: 32, maxmem: 128 * 1024 * 1024 });

export class SigningError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'SigningError';
    this.detail = detail;
  }
}

const refuse = (message, detail) => { throw new SigningError(message, detail); };

/**
 * Refuse a command line that carries a passphrase-shaped argument.
 *
 * Broad on purpose, exactly like the publish guard: `--passphrase`,
 * `--password`, `--pass`, their `=value` forms, and any token embedding
 * `passphrase=` or `password=`. A false positive costs a rephrase; a false
 * negative puts the passphrase into process listings and shell history.
 */
export function assertNoPassphraseInArgv(argv) {
  for (const token of argv) {
    if (typeof token !== 'string') continue;
    if (/^--?pass(word|phrase)?(=|$)/i.test(token) || /pass(word|phrase)=/i.test(token)) {
      refuse(
        'a passphrase-shaped argument was found on the command line; the passphrase is accepted only at the interactive muted prompt, never via argv or env',
        { failure: 'passphrase-in-argv' }
      );
    }
  }
  return argv;
}

/**
 * Refuse an environment that carries a passphrase-shaped variable.
 *
 * Same breadth, same reason: an environment variable is inherited by every
 * child process and routinely dumped by diagnostics. The refusal names the
 * VARIABLE, never its value.
 */
export function assertNoPassphraseInEnv(env = process.env) {
  for (const name of Object.keys(env)) {
    if (/pass(word|phrase)/i.test(name)) {
      refuse(
        `the environment variable ${name} is passphrase-shaped; unset it before running this tool. The passphrase is accepted only at the interactive muted prompt, never via argv or env`,
        { failure: 'passphrase-in-env', variable: name }
      );
    }
  }
  return env;
}

/** The raw 32 public-key bytes, from a PEM string or a KeyObject. */
function rawPublicKey(publicKey) {
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  if (key.asymmetricKeyType !== 'ed25519') {
    refuse(`the key is ${key.asymmetricKeyType}, and this layer signs with ed25519 only`, { failure: 'wrong-key-type' });
  }
  return Buffer.from(key.export({ format: 'jwk' }).x, 'base64url');
}

/** sha256 of the RAW public key bytes -- 64 lowercase hex characters. */
export function keyFingerprint(publicKey) {
  return createHash('sha256').update(rawPublicKey(publicKey)).digest('hex');
}

/** The display form the human records externally: xxxx-xxxx-... */
export function groupedFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    refuse('a fingerprint is 64 lowercase hex characters; refusing to group anything else', { failure: 'malformed-fingerprint' });
  }
  return fingerprint.match(/.{4}/g).join('-');
}

/**
 * Generate an Ed25519 pair and encrypt the private half under the passphrase.
 *
 * Returns the encrypted key document, the public key PEM, and the fingerprint.
 * The caller decides where each lands; this function touches no filesystem.
 */
export function generateEncryptedKeyPair(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    refuse('an empty passphrase encrypts nothing worth trusting', { failure: 'empty-passphrase' });
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, SCRYPT.keyLength, SCRYPT);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(der), cipher.final()]);
  const authTag = cipher.getAuthTag();
  key.fill(0);
  der.fill(0);

  const fingerprint = keyFingerprint(publicKey);
  return {
    encrypted: {
      keyVersion: KEY_FILE_VERSION,
      kdf: { algorithm: 'scrypt', salt: salt.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keyLength: SCRYPT.keyLength },
      cipher: { algorithm: 'aes-256-gcm', iv: iv.toString('base64'), authTag: authTag.toString('base64') },
      ciphertext: ciphertext.toString('base64'),
      keyFingerprint: fingerprint,
      createdAt: new Date().toISOString(),
    },
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    fingerprint,
  };
}

/**
 * Decrypt the private key under its passphrase.
 *
 * A wrong passphrase fails the GCM authentication tag and refuses; it never
 * yields garbage bytes that would sign something. Returns the KeyObject plus a
 * `wipe()` that zeroes the decrypted DER buffer this function held. Stated
 * honestly: Node's KeyObject keeps its own internal copy of the material, and
 * that copy is out of this code's reach -- wipe() removes OUR buffer, not all
 * memory traces.
 */
export function decryptPrivateKey(encrypted, passphrase) {
  if (encrypted?.keyVersion !== KEY_FILE_VERSION) {
    refuse(`the key file declares version ${JSON.stringify(encrypted?.keyVersion)} and this engine supports ${KEY_FILE_VERSION}`, { failure: 'incompatible-key-version' });
  }
  if (encrypted.kdf?.algorithm !== 'scrypt' || encrypted.cipher?.algorithm !== 'aes-256-gcm') {
    refuse('the key file names an algorithm this engine does not run; refusing to guess', { failure: 'unknown-algorithm' });
  }

  const { salt, N, r, p, keyLength } = encrypted.kdf;
  const key = scryptSync(passphrase, Buffer.from(salt, 'base64'), keyLength, { N, r, p, maxmem: SCRYPT.maxmem });

  let der;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.cipher.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(encrypted.cipher.authTag, 'base64'));
    der = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]);
  } catch {
    refuse('the passphrase does not decrypt this key', { failure: 'wrong-passphrase' });
  } finally {
    key.fill(0);
  }

  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return { privateKey, wipe: () => der.fill(0) };
}

/** Detached Ed25519 signature over the receiptId string, base64. */
export function signReceiptId(receiptId, privateKey) {
  return edSign(null, Buffer.from(receiptId, 'utf8'), privateKey).toString('base64');
}

/** Verify a detached signature over a receiptId. Anything malformed is false, never a throw. */
export function verifySignedReceiptId({ receiptId, signature, publicKeyPem }) {
  try {
    return edVerify(null, Buffer.from(receiptId, 'utf8'), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/**
 * A muted interactive prompt. The characters are read raw and never echoed;
 * only the question and the closing newline reach the output stream.
 *
 * This is the ONLY way a passphrase enters this layer, and it demands an
 * interactive terminal: piped or redirected stdin refuses, because a
 * passphrase travelling through a pipeline is a passphrase in a script, a CI
 * log or a transcript. Stated plainly: the TTY requirement is HYGIENE against
 * that accidental leakage, not proof of a human -- a pseudo-TTY can be
 * allocated by tooling, and isTTY identifies the channel type, not who
 * controls it.
 */
export function promptHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (input.isTTY !== true) {
      rejectPromise(new SigningError(
        'the passphrase prompt requires an interactive terminal; piped or redirected stdin is refused so a passphrase never travels through a pipeline',
        { failure: 'non-interactive-stdin' }
      ));
      return;
    }
    output.write(question);
    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    input.resume();

    let value = '';
    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
    };
    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') {
          cleanup();
          output.write('\n');
          resolvePromise(value);
          return;
        }
        if (character === '\u0003') {
          cleanup();
          output.write('\n');
          rejectPromise(new SigningError('interrupted at the passphrase prompt; nothing was signed', { failure: 'interrupted' }));
          return;
        }
        if (character === '\u0008' || character === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    input.on('data', onData);
  });
}
