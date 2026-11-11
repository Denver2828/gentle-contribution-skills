// Policy loading and resolution.
//
// Everything that can go wrong with a policy is a configuration error, and
// every configuration error blocks. There is no "best effort" reading of a
// policy: a document that does not mean what it says must not decide whether
// something gets published.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { validate as validateAgainst } from './jsonschema.mjs';
import { discoverChecks, resolveParams, RegistryError } from './registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const POLICY_SCHEMA_PATH = join(HERE, '..', 'schema', 'policy.v1.json');
export const POLICY_DIRECTORY = join(HERE, '..', 'policies');

export const SUPPORTED_POLICY_VERSION = '1.0.0';

export class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyError';
  }
}

let schemaCache = null;
export function policySchema() {
  if (schemaCache === null) schemaCache = JSON.parse(readFileSync(POLICY_SCHEMA_PATH, 'utf8'));
  return schemaCache;
}

/** Read and validate a policy document. Throws PolicyError on anything wrong. */
export function loadPolicy(path) {
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new PolicyError(`policy ${path} could not be read or parsed: ${error.message}`);
  }

  // Version first, and with its own message: a future policy read against this
  // schema would produce a pile of confusing field errors instead of the one
  // fact that matters.
  if (document?.policyVersion !== SUPPORTED_POLICY_VERSION) {
    throw new PolicyError(
      `policy ${path} declares policyVersion ${JSON.stringify(document?.policyVersion)}, and this engine only supports ${SUPPORTED_POLICY_VERSION}`
    );
  }

  const { valid, errors } = validateAgainst(policySchema(), document);
  if (!valid) {
    throw new PolicyError(`policy ${path} violates policy.v1.json:\n${errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  }

  return document;
}

/** Resolve a policy name against the bundled policies directory. */
export function policyPath(nameOrPath) {
  return nameOrPath.includes('/') || nameOrPath.includes('\\') || nameOrPath.endsWith('.json')
    ? nameOrPath
    : join(POLICY_DIRECTORY, `${nameOrPath}.json`);
}

/**
 * Resolve one gate of a policy into an execution plan.
 *
 * The plan covers the WHOLE catalogue, not only what the policy selected:
 * checks the policy did not select appear as NOT_RUN with that reason. A check
 * silently absent from a report is indistinguishable from a check that passed.
 *
 * @returns {{selected: Array, notRun: Array, tooling: object}}
 */
export async function resolveGate(policy, gateName, { checks } = {}) {
  const catalogue = checks ?? await discoverChecks();

  const gate = policy.gates[gateName];
  if (gate === undefined) {
    throw new PolicyError(
      `policy "${policy.id}" defines no gate "${gateName}"; it defines ${Object.keys(policy.gates).join(', ') || '(none)'}`
    );
  }

  const seen = new Set();
  const selected = [];
  const notRun = [];

  for (const selection of gate.checks) {
    if (seen.has(selection.id)) {
      throw new PolicyError(`policy "${policy.id}" selects check "${selection.id}" more than once in gate "${gateName}"`);
    }
    seen.add(selection.id);

    const definition = catalogue.get(selection.id);
    if (definition === undefined) {
      throw new PolicyError(
        `policy "${policy.id}" selects unknown check "${selection.id}"; the catalogue holds ${[...catalogue.keys()].sort().join(', ')}`
      );
    }

    let params;
    try {
      params = resolveParams(definition, selection.with ?? {});
    } catch (error) {
      if (error instanceof RegistryError) throw new PolicyError(`policy "${policy.id}": ${error.message}`);
      throw error;
    }

    const entry = { definition, required: selection.required, params, skip: selection.skip ?? null };
    if (entry.skip !== null) notRun.push(entry);
    else selected.push(entry);
  }

  // The rest of the catalogue, recorded as deliberately unselected.
  for (const [id, definition] of catalogue) {
    if (seen.has(id)) continue;
    notRun.push({
      definition,
      required: false,
      params: {},
      skip: `not selected by policy ${policy.id}@${policy.version} for gate ${gateName}`,
    });
  }

  return {
    selected,
    notRun,
    tooling: policy.tooling ?? { commands: [] },
  };
}
