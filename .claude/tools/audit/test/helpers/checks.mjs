// Loading check modules for direct evaluation, in the TEST process.
//
// The gate never does this: `discoverChecks` returns metadata only, and the
// modules are imported inside terminable workers. A test evaluating a check
// directly is testing the check's logic, not the gate's perimeter, and it is
// explicit about crossing that line here rather than hiding it behind a
// catalogue that quietly carries executable code.

import { pathToFileURL } from 'node:url';
import { discoverChecks } from '../../lib/registry.mjs';

/**
 * Discover checks and additionally import each module, returning definitions
 * that carry `evaluate`.
 */
export async function loadCheckModules(options = {}) {
  const catalogue = await discoverChecks(options);
  const loaded = new Map();

  for (const [id, metadata] of catalogue) {
    const module = await import(pathToFileURL(metadata.file).href);
    loaded.set(id, { ...metadata, evaluate: module.default.evaluate });
  }

  return loaded;
}
