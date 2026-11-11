// Fast operational canary for the audit harness.
//
// This deliberately exercises the engine's failure paths. Inner FAIL and
// UNKNOWN outcomes are expected observations; only a mismatch between expected
// and observed behavior fails the canary itself. No repository or network input
// participates, and the timeout probe uses the existing terminable worker.

import { defineCheck, notRun } from './check.mjs';
import { makeEvidence, EVIDENCE_TYPE } from './evidence.mjs';
import { runGate } from './gate.mjs';
import { runWorker, ISOLATION } from './isolate.mjs';
import { STATUS } from './status.mjs';
import { validateResult } from './validate.mjs';

export const HEALTH_CANARY_VERSION = '1.0.0';
export const HEALTH_TIMEOUT_MS = 75;
export const HEALTH_CANARY_SCENARIOS = Object.freeze([
  'pass', 'fail', 'unknown', 'not-run', 'throw', 'malformed',
  'missing-remediation', 'empty', 'timeout',
]);

const BLOCKING_REMEDIATION = 'Resolve this synthetic blocking condition, then run the canary again.';
const TIMEOUT_WORKER = new URL('data:text/javascript,for%20%28%3B%3B%29%20%7B%7D');

const evidence = (scenario) => [makeEvidence({
  type: EVIDENCE_TYPE.COMPUTED,
  source: `selftest:${scenario}`,
  observed: { scenario },
})];

function scenarioChecks(scenario) {
  const optional = defineCheck({
    id: 'selftest.optional-observer',
    title: 'Optional check never blocks the gate',
    required: false,
    run: async () => ({
      status: STATUS.FAIL,
      reason: 'declared optional; recorded but not blocking',
      evidence: evidence(scenario),
    }),
  });

  if (scenario === 'empty') return { checks: [optional], preRun: undefined };

  if (scenario === 'not-run') {
    const required = defineCheck({
      id: 'selftest.required-observer',
      title: 'Required check that was selected but not executed',
      required: true,
      run: async () => ({ status: STATUS.PASS, reason: 'not reached', evidence: evidence(scenario) }),
    });
    return {
      checks: [required],
      preRun: new Map([[required.id, notRun(required, 'deliberately skipped by the synthetic policy', BLOCKING_REMEDIATION)]]),
    };
  }

  const required = defineCheck({
    id: 'selftest.required-observer',
    title: `Required ${scenario} observer`,
    required: true,
    run: async () => {
      switch (scenario) {
        case 'pass':
          return { status: STATUS.PASS, reason: 'synthetic pass', evidence: evidence(scenario) };
        case 'fail':
          return { status: STATUS.FAIL, reason: 'synthetic fail', evidence: evidence(scenario), remediation: BLOCKING_REMEDIATION };
        case 'unknown':
          return { status: STATUS.UNKNOWN, reason: 'synthetic unknown', evidence: evidence(scenario), remediation: BLOCKING_REMEDIATION };
        case 'throw':
          throw new Error('simulated internal failure');
        case 'malformed':
          return 'PASS';
        case 'missing-remediation':
          return { status: STATUS.FAIL, reason: 'synthetic ambiguous failure', evidence: evidence(scenario) };
        default:
          throw new Error(`unknown selftest scenario: ${scenario}`);
      }
    },
  });

  return { checks: [required, optional], preRun: undefined };
}

export async function runSelftestScenario(scenario) {
  const { checks, preRun } = scenarioChecks(scenario);
  return runGate({
    gate: 'selftest',
    policy: { id: 'selftest', version: '1' },
    repository: { root: '(selftest)', branch: null, head: null, dirty: null },
    checks,
    preRun,
  });
}

const EXPECTATIONS = Object.freeze([
  { scenario: 'pass', status: STATUS.PASS, error: null },
  { scenario: 'fail', status: STATUS.FAIL, error: null },
  { scenario: 'unknown', status: STATUS.UNKNOWN, error: null },
  { scenario: 'not-run', status: STATUS.NOT_RUN, error: null },
  { scenario: 'throw', status: STATUS.UNKNOWN, error: 'check.contract-violation' },
  { scenario: 'malformed', status: STATUS.UNKNOWN, error: 'check.contract-violation' },
  { scenario: 'missing-remediation', status: STATUS.UNKNOWN, error: 'check.contract-violation' },
  { scenario: 'empty', status: STATUS.UNKNOWN, error: null },
]);

export async function runHarnessHealthCanary({ timeoutMs = HEALTH_TIMEOUT_MS, now = () => Date.now() } = {}) {
  const startedAt = now();
  const cases = [];

  for (const expected of EXPECTATIONS) {
    try {
      const result = await runSelftestScenario(expected.scenario);
      const contract = validateResult(result);
      const observedError = result.errors[0]?.code ?? null;
      const blockingChecksHaveRemediation = result.checks
        .filter((check) => check.required && check.status !== STATUS.PASS)
        .every((check) => typeof check.remediation === 'string' && check.remediation.trim() !== '');
      const passed = result.status === expected.status
        && observedError === expected.error
        && contract.valid
        && blockingChecksHaveRemediation;
      cases.push({
        scenario: expected.scenario,
        expected: { status: expected.status, error: expected.error },
        observed: {
          status: result.status,
          error: observedError,
          contractValid: contract.valid,
          blockingChecksHaveRemediation,
        },
        passed,
      });
    } catch (error) {
      cases.push({
        scenario: expected.scenario,
        expected: { status: expected.status, error: expected.error },
        observed: { exception: error?.message ?? String(error) },
        passed: false,
      });
    }
  }

  const timeout = await runWorker({ workerPath: TIMEOUT_WORKER, workerData: null, timeoutMs });
  const timeoutPassed = timeout.kind === ISOLATION.TIMEOUT
    && timeout.detail?.terminated === true
    && timeout.detail?.timeoutMs === timeoutMs;
  cases.push({
    scenario: 'timeout',
    expected: { kind: ISOLATION.TIMEOUT, terminated: true, timeoutMs },
    observed: { kind: timeout.kind, terminated: timeout.detail?.terminated ?? false, timeoutMs: timeout.detail?.timeoutMs ?? null },
    passed: timeoutPassed,
  });

  return {
    canaryVersion: HEALTH_CANARY_VERSION,
    status: cases.every((entry) => entry.passed) ? STATUS.PASS : STATUS.FAIL,
    durationMs: Math.max(0, now() - startedAt),
    cases,
  };
}
