// Gate orchestration: run the selected checks, aggregate, build the result.
//
// This module owns no knowledge of git, GitHub or any specific policy. It
// receives checks and a repository description, and returns a contract-shaped
// result. Keeping it ignorant is what lets deliveries 2-5 add checks without
// touching it.

import { normaliseOutcome, runCheck } from './check.mjs';
import { aggregate, summarise, exitCodeFor, STATUS } from './status.mjs';
import { digest } from './canonical.mjs';

export const SCHEMA_VERSION = '1.0.0';
export const TOOL_VERSION = '0.1.0';

/**
 * Deterministic run id derived from what was audited, not from a random
 * source. Two runs over identical state produce the same id, which is what
 * makes replay comparisons meaningful.
 */
export function deriveRunId({ gate, policy, repository, checkIds }) {
  return digest({ gate, policy, repository, checkIds }).replace('sha256:', 'run_').slice(0, 21);
}

/**
 * @param {object}   input
 * @param {string}   input.gate         gate name, e.g. "preflight"
 * @param {object}   input.policy       {id, version}
 * @param {object}   input.repository   {root, branch, head, dirty}
 * @param {Array}    input.checks       checks produced by defineCheck
 * @param {object}   [input.context]    read-only inputs handed to every check
 * @param {Map}      [input.preRun]     checkId -> already-decided result. The policy
 *                                      layer uses this to record a selected check it
 *                                      chose not to execute, so a skip is always a
 *                                      NOT_RUN with a motive and never a silent absence.
 * @param {Function} [input.now]        clock, injected for determinism in tests
 * @param {Function} [input.clock]      wall-clock ISO timestamps
 */
export async function runGate({
  gate,
  policy,
  repository,
  checks,
  context = {},
  preRun,
  binding,
  errors: seededErrors = [],
  now = () => Date.now(),
  clock = () => new Date().toISOString(),
}) {
  if (typeof gate !== 'string' || gate.trim() === '') {
    throw new TypeError('runGate: gate must be a non-empty string');
  }
  if (!Array.isArray(checks)) {
    throw new TypeError('runGate: checks must be an array');
  }

  const startedAt = clock();
  const errors = [...seededErrors];
  const results = [];

  for (const check of checks) {
    const decided = preRun?.get(check.id);
    // Policy-decided results cross the same contract boundary as executed
    // checks. A preRun map is not an escape hatch around fail-closed shaping.
    const result = decided === undefined
      ? await runCheck(check, context, { now })
      : normaliseOutcome(check, decided, decided?.durationMs ?? 0);
    results.push(result);

    // An UNKNOWN raised by the check contract itself is a tool defect, and is
    // surfaced as a structured error rather than left only inside the check.
    // A caller that already classified the failure (the preflight gate does,
    // into timeout / exception / terminated / malformed) seeds its own codes,
    // and this generic one does not duplicate them.
    if (result.status === STATUS.UNKNOWN
      && result.remediation?.startsWith('Fix the check implementation')
      && !errors.some((error) => error.checkId === result.id)) {
      errors.push({ code: 'check.contract-violation', message: result.reason, checkId: result.id });
    }
  }

  const verdict = aggregate(results);
  const finishedAt = clock();

  return {
    schemaVersion: SCHEMA_VERSION,
    toolVersion: TOOL_VERSION,
    runId: deriveRunId({ gate, policy, repository, checkIds: results.map((r) => r.id) }),
    gate,
    status: verdict.status,
    startedAt,
    finishedAt,
    repository,
    policy,
    summary: summarise(results),
    // What this decision is bound to. A result that does not name the state,
    // the policy and the tool it came from cannot authorise a later action:
    // there is nothing to compare the later state against.
    binding: binding ?? {
      snapshotHash: null,
      snapshotHashAfter: null,
      stable: null,
      policyHash: digest(policy),
      toolVersion: TOOL_VERSION,
      decisionId: digest({ gate, snapshotHash: null, policyHash: digest(policy), toolVersion: TOOL_VERSION }),
    },
    checks: results,
    errors,
  };
}

/** Convenience: the process exit code a result maps to. */
export function exitCodeForResult(result) {
  return exitCodeFor(result.status);
}
