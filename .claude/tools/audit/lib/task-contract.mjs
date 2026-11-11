import { digest } from './canonical.mjs';
import { validateTaskContract } from './validate.mjs';

export const TASK_CONTRACT_VERSION = 'task-contract/v1';
export const ACCEPTANCE_STATUSES = Object.freeze(['PASS', 'FAIL', 'NOT_RUN', 'N/A']);

const blank = (value) => typeof value !== 'string' || value.trim() === '';

function semanticErrors(contract) {
  const errors = [];
  if (blank(contract.goal)) errors.push({ path: '$/goal', message: 'goal must contain non-whitespace text' });

  for (const [field, values] of [['constraints', contract.constraints], ['escalate_when', contract.escalate_when]]) {
    if (Array.isArray(values) && values.length > 64) {
      errors.push({ path: `$/${field}`, message: `${field} may contain at most 64 entries` });
    }
    for (const [index, value] of (values ?? []).entries()) {
      if (blank(value)) errors.push({ path: `$/${field}[${index}]`, message: `${field} entries must contain non-whitespace text` });
    }
  }

  if (Array.isArray(contract.done_when) && contract.done_when.length > 100) {
    errors.push({ path: '$/done_when', message: 'done_when may contain at most 100 acceptance conditions' });
  }
  const seen = new Set();
  for (const [index, acceptance] of (contract.done_when ?? []).entries()) {
    if (blank(acceptance?.condition)) {
      errors.push({ path: `$/done_when[${index}]/condition`, message: 'acceptance condition must contain non-whitespace text' });
    }
    if (typeof acceptance?.id === 'string') {
      if (seen.has(acceptance.id)) {
        errors.push({ path: `$/done_when[${index}]/id`, message: `duplicate acceptance id ${JSON.stringify(acceptance.id)}` });
      }
      seen.add(acceptance.id);
    }
  }
  return errors;
}

export function validateTaskContractDocument(contract) {
  const structural = validateTaskContract(contract);
  if (!structural.valid) return structural;
  const errors = semanticErrors(contract);
  return { valid: errors.length === 0, errors };
}

function contentOf(contract) {
  const { taskContractDigest: ignored, ...content } = contract;
  return content;
}

export function taskContractDigest(contract) {
  return digest(contentOf(contract));
}

export function admitTaskContract(submitted) {
  if (submitted !== null && typeof submitted === 'object' && Object.hasOwn(submitted, 'taskContractDigest')) {
    throw new Error('task-contract input must omit taskContractDigest; the native store derives it');
  }
  const checked = validateTaskContractDocument(submitted);
  if (!checked.valid) {
    throw new Error(`task contract violates task-contract.v1.json: ${checked.errors.map((error) => `${error.path}: ${error.message}`).join('; ')}`);
  }
  const content = {
    schemaVersion: submitted.schemaVersion,
    goal: submitted.goal,
    constraints: [...submitted.constraints],
    done_when: submitted.done_when.map(({ id, condition }) => ({ id, condition })),
    escalate_when: [...submitted.escalate_when],
  };
  return Object.freeze({ ...content, taskContractDigest: digest(content) });
}

export function taskContractIntact(contract) {
  if (contract === null || typeof contract !== 'object' || Array.isArray(contract)) return false;
  const checked = validateTaskContractDocument(contract);
  return checked.valid && typeof contract.taskContractDigest === 'string'
    && contract.taskContractDigest === taskContractDigest(contract);
}

const sample = (values) => values.slice(0, 8).join(', ');

export function acceptanceCoverageDigest(coverage) {
  return digest(coverage);
}

/**
 * Exact, deterministic coverage arithmetic over one admitted task contract.
 * Structural validity belongs to the auditor-result schemas (v2 to v4); this function decides
 * whether the submitted rows cover every required acceptance exactly once and
 * all reached a decisive PASS or FAIL. Completeness is not satisfaction:
 * an evidenced FAIL is complete coverage, but must still block approval.
 */
export function assessAcceptanceCoverage(taskContract, coverage) {
  const expected = taskContract.done_when.map((entry) => entry.id);
  const expectedSet = new Set(expected);
  const counts = new Map();
  const unexpected = [];
  const unresolved = [];
  const failed = [];

  for (const entry of coverage) {
    counts.set(entry.acceptanceId, (counts.get(entry.acceptanceId) ?? 0) + 1);
    if (!expectedSet.has(entry.acceptanceId)) unexpected.push(entry.acceptanceId);
    else if (entry.status === 'FAIL') failed.push(entry.acceptanceId);
    else if (entry.status !== 'PASS') unresolved.push(`${entry.acceptanceId}=${entry.status}`);
  }

  const missing = expected.filter((id) => !counts.has(id));
  const duplicate = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
  unexpected.sort();
  unresolved.sort();
  failed.sort();

  const problems = [];
  if (missing.length > 0) problems.push(`missing ${missing.length} (${sample(missing)})`);
  if (duplicate.length > 0) problems.push(`duplicate ${duplicate.length} (${sample(duplicate)})`);
  if (unexpected.length > 0) problems.push(`unexpected ${unexpected.length} (${sample(unexpected)})`);
  if (unresolved.length > 0) problems.push(`unresolved ${unresolved.length} (${sample(unresolved)})`);

  if (problems.length === 0) {
    return {
      complete: true,
      satisfied: failed.length === 0,
      reason: failed.length === 0
        ? `all ${expected.length} done_when acceptance conditions are covered exactly once and PASS`
        : `all ${expected.length} done_when acceptance conditions are covered exactly once; failed ${failed.length} (${sample(failed)})`,
      remediation: null,
    };
  }
  return {
    complete: false,
    satisfied: false,
    reason: `acceptance coverage is incomplete: ${problems.join('; ')}`,
    remediation: 'Submit exactly one coverage row for every task-contract done_when id, remove duplicate or unexpected rows, and assess every required condition as PASS or FAIL with bounded evidence before claiming complete coverage. Approval still requires every condition to PASS.',
  };
}
