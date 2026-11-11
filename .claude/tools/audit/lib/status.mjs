// The four-state contract and its aggregation rules.
//
// Aggregation is fail-closed by construction: PASS is the only state that
// authorises a transition, and it is reachable only when every required check
// reached PASS with evidence. There is no path here that turns absence of
// information into permission.

export const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  UNKNOWN: 'UNKNOWN',
  NOT_RUN: 'NOT_RUN',
});

export const ALL_STATUSES = Object.freeze(Object.values(STATUS));

/**
 * Severity order used to aggregate many checks into one gate verdict. The
 * worst required state wins.
 *
 * NOT_RUN outranks PASS because an unexecuted required check is missing
 * information, never a silent success. FAIL outranks UNKNOWN because an
 * observed violation is a stronger statement than an inconclusive read.
 */
const SEVERITY = Object.freeze({
  [STATUS.PASS]: 0,
  [STATUS.NOT_RUN]: 1,
  [STATUS.UNKNOWN]: 2,
  [STATUS.FAIL]: 3,
});

/**
 * Process exit codes.
 *
 * 2 covers both UNKNOWN and NOT_RUN: they are distinct in the JSON, and the
 * JSON is the machine-readable authority. At the process boundary they mean
 * the same actionable thing -- the gate did not conclude, so nothing may
 * proceed.
 */
export const EXIT = Object.freeze({
  PASS: 0,
  FAIL: 1,
  INCONCLUSIVE: 2,
  USAGE: 3,
  CONTRACT: 4,
});

export function isStatus(value) {
  return typeof value === 'string' && Object.hasOwn(SEVERITY, value);
}

export function assertStatus(value, context) {
  if (!isStatus(value)) {
    throw new TypeError(`${context}: expected one of ${ALL_STATUSES.join(', ')}, received ${JSON.stringify(value)}`);
  }
  return value;
}

export function exitCodeFor(status) {
  switch (assertStatus(status, 'exitCodeFor')) {
    case STATUS.PASS:
      return EXIT.PASS;
    case STATUS.FAIL:
      return EXIT.FAIL;
    default:
      return EXIT.INCONCLUSIVE;
  }
}

/** True only for PASS. Every other state blocks. */
export function authorises(status) {
  return assertStatus(status, 'authorises') === STATUS.PASS;
}

/**
 * Aggregate check results into a gate verdict.
 *
 * Only required checks decide the verdict; optional ones are recorded and
 * reported but never block. A gate with no required checks is UNKNOWN, not
 * PASS: a gate that verifies nothing must not authorise anything.
 */
export function aggregate(checks) {
  const required = checks.filter((check) => check.required === true);

  if (required.length === 0) {
    return {
      status: STATUS.UNKNOWN,
      reason: 'no required checks were selected, so nothing was verified',
    };
  }

  let verdict = STATUS.PASS;
  for (const check of required) {
    assertStatus(check.status, `check "${check.id}"`);
    if (SEVERITY[check.status] > SEVERITY[verdict]) verdict = check.status;
  }

  if (verdict === STATUS.PASS) {
    return {
      status: STATUS.PASS,
      reason: `all ${required.length} required check(s) passed with evidence`,
    };
  }

  const offenders = required.filter((check) => check.status === verdict).map((check) => check.id);
  return {
    status: verdict,
    reason: `required check(s) reported ${verdict}: ${offenders.join(', ')}`,
  };
}

/** Counts for the summary block, over every check, required or not. */
export function summarise(checks) {
  const summary = { pass: 0, fail: 0, unknown: 0, notRun: 0 };
  for (const check of checks) {
    switch (assertStatus(check.status, `check "${check.id}"`)) {
      case STATUS.PASS:
        summary.pass += 1;
        break;
      case STATUS.FAIL:
        summary.fail += 1;
        break;
      case STATUS.UNKNOWN:
        summary.unknown += 1;
        break;
      default:
        summary.notRun += 1;
        break;
    }
  }
  return summary;
}
