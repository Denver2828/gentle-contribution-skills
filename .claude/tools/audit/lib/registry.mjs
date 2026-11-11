// Check discovery and the parameter contract.
//
// Adding a check means dropping one file into lib/checks/. Nothing else is
// edited -- not this file, not gate.mjs, not the preflight gate. Discovery
// reads the directory; there is no central list to forget to update, which is
// the usual way a check ends up written but never run.
//
// Files whose name starts with "_" are shared helpers, not checks.
//
// IMPORTANT: this module never imports a check. Importing runs top-level code,
// and a check file is exactly the extension point an author is invited to drop
// something into. The import happens in a terminable worker
// (discover-worker.mjs); this module receives serializable metadata and
// validates it. What comes back is a description of a check, not a check.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runWorker, ISOLATION, DISCOVERY_WORKER_PATH } from './isolate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CHECKS_DIRECTORY = join(HERE, 'checks');
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

const ID_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
const PARAM_TYPES = new Set(['string', 'integer', 'boolean', 'string[]']);

export class RegistryError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'RegistryError';
    this.detail = detail;
  }
}

/** Validate the metadata a discovery worker reported. Nothing here is trusted. */
function assertMetadata(metadata) {
  const origin = typeof metadata?.origin === 'string' ? metadata.origin : '(unknown module)';
  const where = `check module ${origin}`;

  if (metadata === null || typeof metadata !== 'object') {
    throw new RegistryError(`${where}: discovery returned no description`);
  }
  if (typeof metadata.id !== 'string' || !ID_PATTERN.test(metadata.id)) {
    throw new RegistryError(`${where}: id must match ${ID_PATTERN}, received ${JSON.stringify(metadata.id)}`);
  }
  if (typeof metadata.title !== 'string' || metadata.title.trim() === '') {
    throw new RegistryError(`${where}: title must be a non-empty string`);
  }
  if (typeof metadata.needsSnapshot !== 'boolean') {
    throw new RegistryError(`${where}: needsSnapshot must be an explicit boolean`);
  }
  if (metadata.hasEvaluate !== true) {
    throw new RegistryError(`${where}: the module exports no evaluate function`);
  }
  if (typeof metadata.file !== 'string' || metadata.file.trim() === '') {
    throw new RegistryError(`${where}: discovery reported no module path`);
  }

  const params = metadata.params ?? {};
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new RegistryError(`${where}: params must be an object`);
  }
  for (const [name, spec] of Object.entries(params)) {
    if (spec === null || typeof spec !== 'object') {
      throw new RegistryError(`${where}: parameter "${name}" must declare a spec object`);
    }
    if (!PARAM_TYPES.has(spec.type)) {
      throw new RegistryError(`${where}: parameter "${name}" has unsupported type ${JSON.stringify(spec.type)}`);
    }
    if (typeof spec.required !== 'boolean') {
      throw new RegistryError(`${where}: parameter "${name}" must state required explicitly`);
    }
    if (Object.hasOwn(spec, 'enum') && (!Array.isArray(spec.enum) || spec.enum.length === 0)) {
      throw new RegistryError(`${where}: parameter "${name}" declares an empty or malformed enum`);
    }
    if (Object.hasOwn(spec, 'format') && spec.format !== 'regexp') {
      throw new RegistryError(`${where}: parameter "${name}" declares unsupported format ${JSON.stringify(spec.format)}`);
    }
  }

  return Object.freeze({
    id: metadata.id,
    title: metadata.title,
    needsSnapshot: metadata.needsSnapshot,
    params: Object.freeze(params),
    origin,
    file: metadata.file,
  });
}

/**
 * Discover every check in a directory, without importing any of them here.
 *
 * Returns a fresh Map each call: there is no module-level registry to
 * accumulate state between runs or between tests.
 *
 * @throws {RegistryError} on a module that will not load, a description that
 *         does not validate, a duplicate id, or a discovery that had to be
 *         killed. There is no partial catalogue: a catalogue that silently
 *         omits a check is indistinguishable from one whose checks passed.
 */
export async function discoverChecks({ directory = CHECKS_DIRECTORY, timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS } = {}) {
  const isolation = await runWorker({
    workerPath: DISCOVERY_WORKER_PATH,
    // Defeats the module cache inside the worker, so a test that changes a
    // file observes it without needing a fresh process.
    workerData: { directory, cacheKey: `${directory}:${timeoutMs}` },
    timeoutMs,
  });

  if (isolation.kind === ISOLATION.TIMEOUT) {
    throw new RegistryError(
      `discovering checks in ${directory} did not finish within ${timeoutMs}ms; the loading worker was terminated`,
      { failure: 'timeout', directory, timeoutMs, terminated: true }
    );
  }
  if (isolation.kind === ISOLATION.TERMINATED) {
    throw new RegistryError(
      `the check-loading worker exited before reporting a catalogue (exit code ${isolation.detail?.exitCode})`,
      { failure: 'terminated', directory, exitCode: isolation.detail?.exitCode }
    );
  }
  if (isolation.kind === ISOLATION.EXCEPTION) {
    const detail = isolation.detail ?? {};
    throw new RegistryError(
      detail.module
        ? `check module ${detail.module} could not be loaded: ${detail.message ?? 'no detail'}`
        : `checks in ${directory} could not be loaded: ${detail.message ?? 'no detail'}`,
      { failure: detail.module ? 'load' : 'exception', directory, ...detail }
    );
  }

  const reported = isolation.message?.checks;
  if (!Array.isArray(reported)) {
    throw new RegistryError(
      `discovery of ${directory} returned no catalogue`,
      { failure: 'malformed', directory }
    );
  }

  const checks = new Map();
  for (const metadata of reported) {
    const definition = assertMetadata(metadata);
    if (checks.has(definition.id)) {
      throw new RegistryError(
        `duplicate check id "${definition.id}": declared by both ${checks.get(definition.id).origin} and ${definition.origin}`,
        { failure: 'duplicate', id: definition.id }
      );
    }
    checks.set(definition.id, definition);
  }

  return checks;
}

/**
 * Validate the `with` block of a policy selection against a check's declared
 * parameter contract, and fill in declared defaults.
 *
 * Every failure here is a configuration error. None of them degrades into a
 * default value: a policy that asks for something the check does not offer is
 * a policy that does not mean what it says.
 */
export function resolveParams(definition, provided = {}) {
  const specs = definition.params ?? {};
  const resolved = {};

  for (const name of Object.keys(provided)) {
    if (!Object.hasOwn(specs, name)) {
      throw new RegistryError(
        `check "${definition.id}" has no parameter "${name}"; it accepts ${Object.keys(specs).join(', ') || '(none)'}`
      );
    }
  }

  for (const [name, spec] of Object.entries(specs)) {
    if (!Object.hasOwn(provided, name)) {
      if (spec.required) {
        throw new RegistryError(`check "${definition.id}" requires parameter "${name}"`);
      }
      if (Object.hasOwn(spec, 'default')) resolved[name] = spec.default;
      continue;
    }

    const value = provided[name];
    const ok =
      spec.type === 'string' ? typeof value === 'string'
        : spec.type === 'integer' ? Number.isInteger(value)
          : spec.type === 'boolean' ? typeof value === 'boolean'
            : Array.isArray(value) && value.every((item) => typeof item === 'string');

    if (!ok) {
      throw new RegistryError(`check "${definition.id}": parameter "${name}" must be ${spec.type}, received ${JSON.stringify(value)}`);
    }
    if (spec.type === 'integer' && Object.hasOwn(spec, 'minimum') && value < spec.minimum) {
      throw new RegistryError(`check "${definition.id}": parameter "${name}" must be >= ${spec.minimum}`);
    }
    if (Object.hasOwn(spec, 'enum') && !spec.enum.includes(value)) {
      throw new RegistryError(
        `check "${definition.id}": parameter "${name}" must be one of ${spec.enum.map((v) => JSON.stringify(v)).join(', ')}, received ${JSON.stringify(value)}`
      );
    }
    // A pattern that cannot compile is a configuration error, caught here
    // rather than surfacing later as an inconclusive check.
    if (spec.format === 'regexp') {
      try {
        new RegExp(value);
      } catch (error) {
        throw new RegistryError(`check "${definition.id}": parameter "${name}" is not a valid regular expression: ${error.message}`);
      }
    }
    resolved[name] = value;
  }

  return resolved;
}
