// Atomic-enough writes, with the "enough" stated.
//
// Measured on this platform, not assumed:
//
//   renameSync over an existing file          works (MoveFileEx, replace)
//   fsyncSync on a file                       works
//   fsyncSync on a DIRECTORY                  EPERM -- not supported
//   renameSync while a reader holds the target EPERM
//
// So: the file's own bytes are flushed before the rename, and the rename is
// retried, because a concurrent reader -- even a human running `type` on the
// store -- makes it fail. What cannot be done here is fsync of the directory
// entry, so durability of the entry itself after a power loss rests on NTFS
// metadata journalling rather than on anything this code does. That is a
// limitation, and it is written down instead of being quietly assumed.

import { writeFileSync, openSync, fsyncSync, closeSync, renameSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, basename } from 'node:path';

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOENT']);
const TEMPORARY_MARK = '.tmp-';

export class AtomicWriteError extends Error {
  constructor(path, attempts, cause) {
    super(`could not replace ${path} after ${attempts} attempt(s): ${cause}`);
    this.name = 'AtomicWriteError';
  }
}

function sleep(ms) {
  // Deliberately synchronous: the whole store path is synchronous, and an
  // await here would let a second operation interleave inside the lock.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write `text` to `path` so a reader sees either the old file or the new one.
 *
 * @param {object} [options]
 * @param {number} [options.attempts]  rename retries before failing closed
 */
export function writeAtomic(path, text, { attempts = 12, backoffMs = 25 } = {}) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });

  const temporary = join(directory, `${basename(path)}${TEMPORARY_MARK}${process.pid}-${randomBytes(6).toString('hex')}`);
  writeFileSync(temporary, text);

  const handle = openSync(temporary, 'r+');
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      renameSync(temporary, path);
      return path;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE.has(error.code)) break;
      sleep(backoffMs * attempt);
    }
  }

  // Fail closed: remove the temporary rather than leave a half-applied write.
  rmSync(temporary, { force: true });
  throw new AtomicWriteError(path, attempts, lastError?.code ?? String(lastError));
}

/**
 * Remove temporaries left behind by an interrupted write.
 *
 * A temporary was never referenced by anything, so deleting one loses nothing.
 * This is the only sweeping that happens automatically; orphaned ARTIFACTS are
 * a different matter and are never removed on the way past.
 */
export function sweepTemporaries(directory) {
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }

  const swept = [];
  for (const name of names) {
    if (!name.includes(TEMPORARY_MARK)) continue;
    const path = join(directory, name);
    try {
      if (statSync(path).isFile()) { rmSync(path, { force: true }); swept.push(name); }
    } catch { /* someone else got there first, which is fine */ }
  }
  return swept;
}
