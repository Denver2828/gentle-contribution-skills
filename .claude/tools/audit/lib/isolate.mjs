// Terminable isolation for check evaluation.
//
// Why a worker and not Promise.race: a race only stops WAITING. The work keeps
// running, and if that work is a synchronous loop -- a catastrophic regular
// expression is the case this layer actually ships -- the process stays frozen
// while the race "times out". A worker is a real thread with its own isolate,
// and terminate() kills it even mid-loop. That is the difference between a
// timeout that is enforced and one that is announced.
//
// Four failure modes are distinguished, because "the check did not conclude"
// is not one situation:
//
//   timeout     the parent killed a thread that was still running
//   exception   the check threw, and the throw came back as a message
//   terminated  the thread died on its own (crash, OOM, process.exit)
//   malformed   the check returned, but not a usable outcome
//
// There are no automatic retries. A check that timed out is reported as having
// timed out; running it again is a decision for a human, not a loop.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(HERE, 'isolate-worker.mjs');

export const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

export const ISOLATION = Object.freeze({
  COMPLETED: 'completed',
  TIMEOUT: 'timeout',
  EXCEPTION: 'exception',
  TERMINATED: 'terminated',
});

/**
 * Run any worker under a terminable budget.
 *
 * Never rejects: every way this can go wrong is a described outcome, because a
 * rejection here would become an exception in the caller and lose the
 * distinction it needs.
 *
 * @returns {Promise<{kind, outcome?, detail?, durationMs}>}
 */
export function runWorker({ workerPath, workerData, timeoutMs = DEFAULT_CHECK_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let worker;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // terminate() is safe to call on an already-exited worker.
      worker?.terminate().catch(() => {});
      resolve({ ...result, durationMs: Math.max(0, Date.now() - startedAt) });
    };

    const timer = setTimeout(() => {
      finish({ kind: ISOLATION.TIMEOUT, detail: { timeoutMs, terminated: true } });
    }, timeoutMs);

    try {
      worker = new Worker(workerPath, {
        workerData,
        // Keep the worker's streams off the parent's: stdout is the machine
        // channel for the result document, and a stray console.log inside a
        // check would corrupt it.
        stdout: true,
        stderr: true,
      });
    } catch (error) {
      finish({ kind: ISOLATION.EXCEPTION, detail: { name: error?.name ?? 'Error', message: error?.message ?? String(error), duringSpawn: true } });
      return;
    }

    // The whole message travels back. Unwrapping it is the specific caller's
    // job, so this runner stays usable by any worker protocol.
    worker.on('message', (message) => {
      if (message?.ok === true) finish({ kind: ISOLATION.COMPLETED, message });
      else finish({ kind: ISOLATION.EXCEPTION, detail: message?.error ?? { name: 'Error', message: 'the worker reported a failure with no detail' } });
    });

    worker.on('error', (error) => {
      finish({ kind: ISOLATION.EXCEPTION, detail: { name: error?.name ?? 'Error', message: error?.message ?? String(error) } });
    });

    worker.on('exit', (exitCode) => {
      finish({ kind: ISOLATION.TERMINATED, detail: { exitCode } });
    });
  });
}

/** Evaluate one check inside a terminable worker. */
export async function runIsolated({ checkFile, payload, timeoutMs = DEFAULT_CHECK_TIMEOUT_MS, workerPath = WORKER_PATH }) {
  const isolation = await runWorker({ workerPath, workerData: { checkFile, payload }, timeoutMs });
  return isolation.kind === ISOLATION.COMPLETED
    ? { ...isolation, outcome: isolation.message.outcome }
    : isolation;
}

export const DISCOVERY_WORKER_PATH = join(HERE, 'discover-worker.mjs');
