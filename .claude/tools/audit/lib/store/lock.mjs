// An advisory lock with an owner.
//
// The nonce is the point. A pid and a timestamp identify a process, and pids
// are reused; a nonce identifies THIS acquisition. Only the holder of the
// nonce may release the lock, so a process that lost its lock to a stale-lock
// recovery cannot later delete the lock someone else now holds.
//
// Recovering an orphan takes three independent signals, all required:
//
//   1. the lock is older than the staleness threshold
//   2. its pid is gone            (process.kill(pid, 0) -> ESRCH)
//   3. its content did not change between two observations
//
// And then the file is MOVED to a quarantine name, never unlinked blindly. If
// the move loses a race, the winner is whoever moved it, and the loser retries
// against whatever is there now. Quarantined locks are left on disk: they are
// the only trace that a recovery happened.
//
// Stated honestly: pid reuse makes signal 2 a heuristic. This resists crashes
// and accidents; it does not resist a process that wants the lock.

import { openSync, writeSync, fsyncSync, closeSync, readFileSync, renameSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

export const DEFAULT_STALE_MS = 60_000;
export const DEFAULT_WAIT_MS = 10_000;

export class LockError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LockError';
    this.detail = detail;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLock(path) {
  try {
    return { raw: readFileSync(path, 'utf8') };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function parseLock(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.nonce === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** ESRCH means the process is gone. Anything else means it is not. */
function processGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

/**
 * Acquire the lock, waiting for it.
 *
 * @returns {{path: string, nonce: string, acquiredAt: number, recovered: string|null}}
 */
export function acquire(path, { waitMs = DEFAULT_WAIT_MS, staleMs = DEFAULT_STALE_MS, now = () => Date.now() } = {}) {
  mkdirSync(dirname(path), { recursive: true });

  const deadline = now() + waitMs;
  const nonce = randomBytes(16).toString('hex');
  let firstObservation = null;
  let recovered = null;

  for (;;) {
    try {
      const handle = openSync(path, 'wx');
      try {
        const body = `${JSON.stringify({ pid: process.pid, nonce, host: hostname(), acquiredAt: new Date(now()).toISOString() }, null, 2)}\n`;
        writeSync(handle, body);
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      return { path, nonce, acquiredAt: now(), recovered };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const held = readLock(path);
    if (held !== null) {
      const parsed = parseLock(held.raw);
      let age = Number.POSITIVE_INFINITY;
      try { age = now() - statSync(path).mtimeMs; } catch { /* it vanished; retry */ }

      const orphanCandidate = age > staleMs && (parsed === null || processGone(parsed.pid));

      if (orphanCandidate) {
        if (firstObservation === null) {
          // Observe once, wait, observe again. A lock whose content moved is
          // being renewed by something alive.
          firstObservation = held.raw;
          sleep(Math.min(250, Math.max(50, staleMs / 20)));
        } else if (firstObservation === held.raw) {
          const quarantine = `${path}.quarantine-${randomBytes(8).toString('hex')}`;
          try {
            renameSync(path, quarantine);
            recovered = quarantine;
          } catch {
            // Someone else quarantined it first. Fine: retry against reality.
          }
          firstObservation = null;
        } else {
          firstObservation = held.raw;
        }
      }
    }

    if (now() >= deadline) {
      throw new LockError(`the store lock at ${path} was held for longer than ${waitMs}ms`, {
        failure: 'timeout', path, waitMs, holder: parseLock(readLock(path)?.raw ?? '') ?? null,
      });
    }
    sleep(30);
  }
}

/** Release a lock this holder owns. A nonce mismatch refuses. */
export function release(handle) {
  const held = readLock(handle.path);
  if (held === null) {
    throw new LockError('the lock is already gone; this holder did not release it', { failure: 'absent', path: handle.path });
  }

  const parsed = parseLock(held.raw);
  if (parsed === null || parsed.nonce !== handle.nonce) {
    throw new LockError(
      'refusing to release a lock this holder does not own; it was recovered and is held by someone else',
      { failure: 'not-owner', path: handle.path, expected: handle.nonce, found: parsed?.nonce ?? null }
    );
  }

  unlinkSync(handle.path);
}

/** Run `work` while holding the lock, releasing it whatever happens. */
export function withLock(path, work, options = {}) {
  const handle = acquire(path, options);
  try {
    return work(handle);
  } finally {
    try {
      release(handle);
    } catch (error) {
      // A release that refuses is worth surfacing, but never at the cost of
      // masking the error the work itself threw.
      if (error instanceof LockError && error.detail.failure === 'not-owner') throw error;
    }
  }
}
