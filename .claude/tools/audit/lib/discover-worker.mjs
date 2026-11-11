// Check discovery, performed where it is survivable.
//
// Importing a module runs its top-level code. In the parent process that is an
// unbounded grant: a module can spin forever, call process.exit, throw before
// anything is spawned, or write to disk before the authorised snapshot was
// taken. None of those are hypothetical -- the first two were reachable from a
// file dropped into lib/checks/, which is exactly the extension point this tool
// advertises.
//
// So the import happens here, inside a worker the parent can kill, and the
// parent receives only serializable metadata it then validates. It never holds
// the check's code.

import { readdirSync } from 'node:fs';
import { workerData, parentPort } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const { directory, cacheKey } = workerData;

function describe(definition) {
  // Only serializable facts travel. `evaluate` stays here; its presence is
  // reported as a boolean so the parent can refuse a module that has none
  // without ever holding the function.
  return {
    id: definition?.id,
    title: definition?.title,
    needsSnapshot: definition?.needsSnapshot,
    params: definition?.params ?? {},
    hasEvaluate: typeof definition?.evaluate === 'function',
  };
}

try {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.mjs') && !name.startsWith('_'))
    .sort();

  const checks = [];
  for (const file of files) {
    const absolute = join(directory, file);
    try {
      const module = await import(`${pathToFileURL(absolute).href}?discovered=${cacheKey}`);
      checks.push({ ...describe(module.default), origin: file, file: absolute });
    } catch (error) {
      // A module that fails to load stops discovery. A partial catalogue is a
      // catalogue that silently omits checks, which is indistinguishable from
      // checks that passed.
      parentPort.postMessage({
        ok: false,
        error: {
          name: error?.name ?? 'Error',
          message: error?.message ?? String(error),
          module: file,
          loadedBefore: checks.map((check) => check.origin),
        },
      });
      throw new Error('__reported__');
    }
  }

  parentPort.postMessage({ ok: true, checks });
} catch (error) {
  if (error?.message !== '__reported__') {
    parentPort.postMessage({
      ok: false,
      error: { name: error?.name ?? 'Error', message: error?.message ?? String(error), module: null, loadedBefore: [] },
    });
  }
}
