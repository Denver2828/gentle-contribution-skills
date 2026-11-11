// The body of an isolated check run.
//
// One worker per check, holding exactly one check module and the read-only
// adapters. It never routes, never aggregates and never decides: it evaluates
// and reports back. Everything it can do wrong is observable from the parent
// as a message, an error, or a thread that had to be killed.

import { workerData, parentPort } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

import { readTrackedPaths, readTrackedCount } from './adapters/git.mjs';

const ADAPTERS = Object.freeze({ readTrackedPaths, readTrackedCount });

try {
  const module = await import(pathToFileURL(workerData.checkFile).href);
  const definition = module.default;

  if (definition === undefined || typeof definition.evaluate !== 'function') {
    parentPort.postMessage({ ok: false, error: { name: 'RegistryError', message: `${workerData.checkFile} exports no evaluable check` } });
  } else {
    const outcome = await definition.evaluate({ ...workerData.payload, adapters: ADAPTERS });
    parentPort.postMessage({ ok: true, outcome });
  }
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) },
  });
}
