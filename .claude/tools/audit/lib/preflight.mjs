// The preflight gate.
//
// Three properties define it, and each one exists because its absence is a way
// to authorise something that was never true:
//
//   One snapshot. Every check reads the same reading of the repository. Checks
//   that each look at the world separately can agree about a repository that
//   never existed in that combination.
//
//   Terminable isolation. Each check runs in a worker with a timeout that
//   kills it. A timeout that only stops waiting is not a timeout.
//
//   A second reading. After the checks finish, the repository is read again.
//   If it moved, the result is UNKNOWN even when every check passed -- those
//   passes describe a repository that is no longer there.

import { takeSnapshot } from './snapshot.mjs';
import { loadPolicy, resolveGate, policyPath, PolicyError } from './policy.mjs';
import { discoverChecks, RegistryError } from './registry.mjs';
import { runGate, TOOL_VERSION } from './gate.mjs';
import { defineCheck, notRun, normaliseOutcome, inconclusive } from './check.mjs';
import { runIsolated, ISOLATION, DEFAULT_CHECK_TIMEOUT_MS } from './isolate.mjs';
import { DEFAULT_DISCOVERY_TIMEOUT_MS } from './registry.mjs';
import { STATUS } from './status.mjs';
import { digest } from './canonical.mjs';
import { makeEvidence, EVIDENCE_TYPE } from './evidence.mjs';
import { checkRepositoryIdentity } from './repository-identity.mjs';

/**
 * Fields that may legitimately differ between two runs over identical state.
 * Everything else -- statuses, reasons, evidence, decisionId, runId -- must be
 * identical, and a test asserts it.
 */
export const VOLATILE_DECISION_FIELDS = Object.freeze([
  'startedAt', 'finishedAt', 'checks[].durationMs',
]);

/** Error codes attached to errors[] so the failure modes stay distinguishable. */
export const FAILURE_CODE = Object.freeze({
  TIMEOUT: 'check.timeout',
  EXCEPTION: 'check.exception',
  TERMINATED: 'check.worker-terminated',
  MALFORMED: 'check.malformed-result',
  UNSTABLE: 'repository.changed-during-gate',
  DISCOVERY: 'catalogue.discovery-failed',
  IDENTITY: 'gate.repository-identity-failed',
});

function isToolDefect(result) {
  return result.remediation?.startsWith('Fix the check implementation') === true;
}

/**
 * The effective value of one budget.
 *
 * An override may only HARDEN it. A caller on a command line -- a person in a
 * hurry, or an agent acting for one -- must not be able to widen a limit the
 * versioned policy authorised. Lowering it is always allowed: a stricter run
 * that blocks is never the dangerous direction.
 */
export function effectiveTimeout(policyValue, overrideValue, fallback = DEFAULT_CHECK_TIMEOUT_MS) {
  const fromPolicy = policyValue ?? fallback;
  if (overrideValue === undefined || overrideValue === null || !Number.isFinite(overrideValue)) return fromPolicy;
  return Math.min(fromPolicy, Math.max(1, Math.trunc(overrideValue)));
}

/**
 * The two budgets, resolved independently.
 *
 * They are separate because they bound different things. Building the
 * catalogue is ONE operation whose cost grows with the number of modules;
 * evaluating a check is one operation per check. Sharing a single budget
 * meant a larger catalogue quietly consumed the allowance designed for a
 * single check, so adding a check made every other check stricter -- a
 * coupling nobody declared and nobody could see.
 */
export function resolveBudgets(gateConfig, overrides = {}) {
  return {
    discoveryTimeoutMs: effectiveTimeout(gateConfig.discoveryTimeoutMs, overrides.discoveryTimeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS),
    checkTimeoutMs: effectiveTimeout(gateConfig.checkTimeoutMs, overrides.checkTimeoutMs, DEFAULT_CHECK_TIMEOUT_MS),
  };
}

/** A blocking result for a catalogue that could not be built. */
async function blockedOnDiscovery({ cwd, gateName, policyDocument, snapshot, snapshotOutcome, error }) {
  const policyHash = digest(policyDocument);
  const binding = {
    snapshotHash: snapshot?.hash ?? null,
    snapshotHashAfter: null,
    stable: null,
    policyHash,
    toolVersion: TOOL_VERSION,
    decisionId: digest({ gate: gateName, snapshotHash: snapshot?.hash ?? null, policyHash, toolVersion: TOOL_VERSION }),
  };

  const declaration = defineCheck({
    id: 'gate.catalogue-loadable',
    title: 'The check catalogue could be loaded',
    required: true,
    run: async () => ({ status: STATUS.PASS, reason: 'never executed', evidence: [] }),
  });

  const result = await runGate({
    gate: gateName,
    policy: { id: policyDocument.id, version: policyDocument.version },
    repository: {
      root: snapshot?.root ?? cwd,
      branch: snapshot?.identity.branch ?? null,
      head: snapshot?.identity.head ?? null,
      dirty: snapshot === null ? null : !snapshot.worktree.clean,
    },
    checks: [declaration],
    preRun: new Map([[declaration.id, {
      id: declaration.id,
      title: declaration.title,
      status: STATUS.UNKNOWN,
      required: true,
      durationMs: 0,
      reason: error.message,
      evidence: [makeEvidence({
        type: EVIDENCE_TYPE.COMPUTED,
        source: 'registry.discoverChecks',
        observed: { ...error.detail, snapshotTakenBeforeLoading: snapshot !== null },
      })],
      remediation: 'Fix or remove the offending check module. The gate will not run a partial catalogue.',
    }]]),
    binding,
    errors: [{ code: FAILURE_CODE.DISCOVERY, message: error.message, checkId: null }],
  });

  return { result, snapshot, snapshotAfter: null, plan: null, snapshotOutcome };
}

/**
 * A blocking result for a repository that is not the one the policy declares.
 *
 * Shaped exactly like `blockedOnDiscovery`, and for the same reason: the run
 * ends here, so the one row it emits has to carry the whole story -- what was
 * expected, what was observed, and the reading it was bound to.
 */
async function blockedOnIdentity({ cwd, gateName, policyDocument, snapshot, snapshotOutcome, identity }) {
  const policyHash = digest(policyDocument);
  const binding = {
    snapshotHash: snapshot?.hash ?? null,
    snapshotHashAfter: null,
    stable: null,
    policyHash,
    toolVersion: TOOL_VERSION,
    decisionId: digest({ gate: gateName, snapshotHash: snapshot?.hash ?? null, policyHash, toolVersion: TOOL_VERSION }),
  };

  const declaration = defineCheck({
    id: 'gate.repository-identity',
    title: 'The repository matches the identity the policy declares',
    required: true,
    run: async () => ({ status: STATUS.PASS, reason: 'never executed', evidence: [] }),
  });

  const result = await runGate({
    gate: gateName,
    policy: { id: policyDocument.id, version: policyDocument.version },
    repository: {
      root: snapshot?.root ?? cwd,
      branch: snapshot?.identity.branch ?? null,
      head: snapshot?.identity.head ?? null,
      dirty: snapshot === null ? null : !snapshot.worktree.clean,
    },
    checks: [declaration],
    preRun: new Map([[declaration.id, {
      id: declaration.id,
      title: declaration.title,
      status: identity.status,
      required: true,
      durationMs: 0,
      reason: identity.reason,
      evidence: identity.evidence,
      remediation: identity.remediation
        ?? 'Run this policy from the repository it declares. Nothing is reported about a repository this policy was not written for.',
    }]]),
    binding,
    errors: [{ code: FAILURE_CODE.IDENTITY, message: identity.reason, checkId: declaration.id }],
  });

  return { result, snapshot, snapshotAfter: null, plan: null, snapshotOutcome };
}

/** Turn one isolation outcome into a contract-shaped check result plus an error code. */
function interpret(declaration, isolation) {
  switch (isolation.kind) {
    case ISOLATION.COMPLETED: {
      const normalised = normaliseOutcome(declaration, isolation.outcome, isolation.durationMs);
      return { result: normalised, code: isToolDefect(normalised) ? FAILURE_CODE.MALFORMED : null };
    }

    case ISOLATION.TIMEOUT:
      return {
        result: {
          ...inconclusive(
            declaration,
            `the check did not finish within ${isolation.detail.timeoutMs}ms and its worker was terminated`,
            { failure: 'timeout', ...isolation.detail },
            'Raise the timeout deliberately, or fix the check. It is not retried automatically.'
          ),
          durationMs: isolation.durationMs,
        },
        code: FAILURE_CODE.TIMEOUT,
      };

    case ISOLATION.EXCEPTION:
      return {
        result: {
          ...inconclusive(
            declaration,
            `the check threw and cannot conclude: ${isolation.detail?.message ?? 'no detail'}`,
            { failure: 'exception', ...isolation.detail }
          ),
          durationMs: isolation.durationMs,
        },
        code: FAILURE_CODE.EXCEPTION,
      };

    default:
      return {
        result: {
          ...inconclusive(
            declaration,
            `the check's worker exited before reporting a result (exit code ${isolation.detail?.exitCode})`,
            { failure: 'terminated', ...isolation.detail }
          ),
          durationMs: isolation.durationMs,
        },
        code: FAILURE_CODE.TERMINATED,
      };
  }
}

/**
 * Run one gate of one policy against the repository containing `cwd`.
 *
 * @returns {{result, snapshot, snapshotAfter, plan}}
 */
export async function runPreflight({
  cwd = process.cwd(), policy: policyRef, gate: gateName,
  checkTimeoutMs: checkOverride, discoveryTimeoutMs: discoveryOverride,
  catalogue, checksDirectory, afterChecks,
}) {
  // Reading the policy runs no third-party code: it is JSON.
  const policyDocument = loadPolicy(policyPath(policyRef));
  const gateConfig = policyDocument.gates[gateName];
  if (gateConfig === undefined) {
    throw new PolicyError(
      `policy "${policyDocument.id}" defines no gate "${gateName}"; it defines ${Object.keys(policyDocument.gates).join(', ') || '(none)'}`
    );
  }
  const budgets = resolveBudgets(gateConfig, { checkTimeoutMs: checkOverride, discoveryTimeoutMs: discoveryOverride });

  // ONE reading, taken BEFORE any check module is loaded. Discovery imports
  // those modules, and importing runs their top-level code; anything they do
  // to the repository therefore lands after this reading and diverges the
  // second one.
  const snapshotOutcome = takeSnapshot({ cwd });
  const snapshot = snapshotOutcome.snapshot;

  // Is this even the repository the policy is about?
  //
  // Decided here, between the reading and discovery, because everything after
  // this line produces rows: discovery imports check modules, and each check
  // emits a statement about the repository. A policy pointed at the wrong
  // repository produces statements that are individually correct and
  // collectively meaningless -- FAIL rows about a CONTRIBUTING.md that was
  // never meant to exist here. So nothing runs at all.
  //
  // It is a PRECONDITION, not a check: when it passes it adds no row to the
  // report. A precondition that shows up as a passing check invites being
  // marked optional, and an optional identity is no identity.
  const identity = checkRepositoryIdentity({
    root: snapshot?.root ?? cwd,
    expected: policyDocument.repository.expected,
    remote: policyDocument.repository.remote,
  });
  if (identity.status !== STATUS.PASS) {
    return blockedOnIdentity({ cwd, gateName, policyDocument, snapshot, snapshotOutcome, identity });
  }

  // Only now: load the checks, in a worker, under a budget.
  let plan;
  try {
    plan = await resolveGate(policyDocument, gateName, {
      checks: catalogue ?? await discoverChecks({
        ...(checksDirectory ? { directory: checksDirectory } : {}),
        timeoutMs: budgets.discoveryTimeoutMs,
      }),
    });
  } catch (error) {
    if (error instanceof RegistryError) {
      // A catalogue that could not be built is not a gate that found nothing
      // wrong. It blocks, with the reading it already holds bound to it.
      return blockedOnDiscovery({ cwd, gateName, policyDocument, snapshot, snapshotOutcome, error });
    }
    throw error;
  }

  const declarations = [];
  const results = [];
  const errors = [];

  for (const entry of plan.selected) {
    const declaration = defineCheck({
      id: entry.definition.id,
      title: entry.definition.title,
      required: entry.required,
      run: async () => ({ status: STATUS.PASS, reason: 'evaluated in isolation', evidence: [] }),
    });
    declarations.push(declaration);

    // A check that needs a snapshot never sees a missing one, and no worker is
    // spawned to discover that.
    if (entry.definition.needsSnapshot && snapshot === null) {
      results.push(normaliseOutcome(declaration, {
        status: STATUS.UNKNOWN,
        reason: `the repository state could not be read, so this check has nothing to evaluate: ${snapshotOutcome.reason}`,
        evidence: snapshotOutcome.evidence,
        remediation: 'Restore readable repository state, then run the gate again. A snapshot-dependent check cannot run without that state.',
      }, 0));
      continue;
    }

    const isolation = await runIsolated({
      checkFile: entry.definition.file,
      timeoutMs: budgets.checkTimeoutMs,
      payload: {
        snapshot,
        snapshotOutcome,
        params: entry.params,
        tooling: plan.tooling,
      },
    });

    const { result, code } = interpret(declaration, isolation);
    results.push(result);
    if (code !== null) errors.push({ code, message: result.reason, checkId: result.id });
  }

  // Checks the policy skipped or never selected, recorded with their motive.
  const skipped = plan.notRun.map((entry) => {
    const declaration = defineCheck({
      id: entry.definition.id,
      title: entry.definition.title,
      required: entry.required,
      run: async () => ({ status: STATUS.PASS, reason: 'never executed', evidence: [] }),
    });
    return [declaration, notRun(
      declaration,
      entry.skip,
      entry.required
        ? 'Remove the policy skip and run this required check, or explicitly make it optional if it must not block this gate.'
        : null
    )];
  });

  // Test seam: lets the concurrent-change path be exercised deterministically
  // instead of raced against. Nothing in production passes it.
  await afterChecks?.();

  // SECOND reading. Taken after the checks, over the same repository.
  const afterOutcome = takeSnapshot({ cwd });
  const snapshotAfter = afterOutcome.snapshot;
  const stable = snapshot === null && snapshotAfter === null
    ? null
    : snapshot !== null && snapshotAfter !== null && snapshot.hash === snapshotAfter.hash;

  const binding = {
    snapshotHash: snapshot?.hash ?? null,
    snapshotHashAfter: snapshotAfter?.hash ?? null,
    stable,
    policyHash: digest(policyDocument),
    toolVersion: TOOL_VERSION,
    decisionId: digest({
      gate: gateName,
      snapshotHash: snapshot?.hash ?? null,
      policyHash: digest(policyDocument),
      toolVersion: TOOL_VERSION,
    }),
  };

  if (stable === false) {
    errors.push({
      code: FAILURE_CODE.UNSTABLE,
      message: `the repository changed while the gate ran: ${binding.snapshotHash ?? '(unreadable)'} -> ${binding.snapshotHashAfter ?? '(unreadable)'}`,
      checkId: null,
    });
  }

  const result = await runGate({
    gate: gateName,
    policy: { id: policyDocument.id, version: policyDocument.version },
    repository: {
      root: snapshot?.root ?? cwd,
      branch: snapshot?.identity.branch ?? null,
      head: snapshot?.identity.head ?? null,
      dirty: snapshot === null ? null : !snapshot.worktree.clean,
    },
    checks: [...declarations, ...skipped.map(([declaration]) => declaration)],
    preRun: new Map([
      ...results.map((result) => [result.id, result]),
      ...skipped.map(([declaration, outcome]) => [declaration.id, outcome]),
    ]),
    binding,
    errors,
  });

  // The overriding rule: a repository that moved invalidates every pass taken
  // against the reading that no longer describes it.
  if (stable === false) {
    result.status = STATUS.UNKNOWN;
    result.checks.push(unstableMarker(binding, afterOutcome));
    result.summary.unknown += 1;
  }

  return { result, snapshot, snapshotAfter, plan, budgets };
}

/**
 * A first-class check result recording the instability, so the reason a PASS
 * did not authorise anything is visible in the report rather than only in the
 * aggregate status.
 */
function unstableMarker(binding, afterOutcome) {
  return {
    id: 'gate.repository-stable',
    title: 'The repository did not change while the gate ran',
    status: STATUS.UNKNOWN,
    required: true,
    durationMs: 0,
    reason: binding.snapshotHashAfter === null
      ? `the repository could not be read again after the checks ran: ${afterOutcome.reason}`
      : 'the repository changed between the reading the checks used and the reading taken after them, so their conclusions describe a state that is no longer present',
    evidence: [
      makeEvidence({
        type: EVIDENCE_TYPE.COMPUTED,
        source: 'preflight.second-reading',
        observed: { before: binding.snapshotHash, after: binding.snapshotHashAfter },
      }),
    ],
    remediation: 'Re-run the gate over a settled repository. Nothing here changes the repository on your behalf.',
  };
}
