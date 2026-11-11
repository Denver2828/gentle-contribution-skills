// Public edition: private incident history omitted. See the operational contract.

import { STATUS } from './status.mjs';
import { makeEvidence, EVIDENCE_TYPE } from './evidence.mjs';
import { evaluateCoverage } from './coverage.mjs';

export const SOURCE = Object.freeze({
  TEXT_SEARCH: 'gh-search-issues',
  OPEN_ISSUES: 'gh-issue-list',
  OPEN_PRS: 'gh-pr-list',
  ISSUE_COMMENTS: 'gh-issue-comments',
});

export const REQUIRED_SOURCES = Object.freeze([SOURCE.TEXT_SEARCH, SOURCE.OPEN_ISSUES, SOURCE.OPEN_PRS]);

/** The reading that proves CONTRIBUTING step 3 was performed. */
export const CLAIM_SOURCE = SOURCE.ISSUE_COMMENTS;

/** Recorded sources the evaluator will accept at all. */
export const ALLOWED_SOURCES = Object.freeze([...REQUIRED_SOURCES, CLAIM_SOURCE]);

/**
 * Which route the candidate is on. The record must say, because the claim rule
 * applies to exactly one of them and a record that does not declare its route
 * leaves that undeterminable -- which fails closed, like every other
 * undeterminable fact in this harness.
 */
export const CONTRIBUTION = Object.freeze({
  PULL_REQUEST: 'pull-request',
  ISSUE: 'issue',
  ISSUE_COMMENT: 'issue-comment',
});

export const READING = Object.freeze({ COMPLETE: 'COMPLETE', PARTIAL: 'PARTIAL', FAILED: 'FAILED' });

export const REFUSAL = Object.freeze({
  NOT_A_RECORD: 'not-a-record',
  UNKNOWN_CONTRIBUTION_TYPE: 'unknown-contribution-type',
  MISSING_SOURCE: 'missing-source',
  DUPLICATE_SOURCE: 'duplicate-source',
  UNKNOWN_SOURCE: 'unknown-source',
  READING_INCOMPLETE: 'reading-incomplete',
  COVERAGE_INCOMPLETE: 'coverage-incomplete',
  MALFORMED_READING: 'malformed-reading',
  UNREVIEWED_MATCHES: 'unreviewed-matches',
  CLAIM_NOT_RECORDED: 'claim-not-recorded',
  CLAIM_ABSENT: 'claim-absent',
  CLAIM_UNVERIFIED: 'claim-unverified',
  COMPETING_WORK: 'competing-work',
});

const REQUIRED = new Set(REQUIRED_SOURCES);
const ALLOWED = new Set(ALLOWED_SOURCES);
const CONTRIBUTIONS = new Set(Object.values(CONTRIBUTION));
const RESULTS = new Set(Object.values(READING));

/** Recorded in place of a result when the source produced no reading at all. */
const ABSENT = 'MISSING';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

// A deliberately narrow, explicit claim, not natural-language sentiment detection.
// Read it from GitHub; this validates supplied observations, not remote authenticity.
export const implementationClaimBody = (issueNumber, scope) => `I am implementing #${issueNumber}.\nScope: ${scope}`;

function claimProblem(record, claim) {
  if (!Number.isSafeInteger(record.linkedIssue) || record.linkedIssue < 1
    || !isNonEmptyString(record.contributor) || !isNonEmptyString(record.scope) || /[\r\n]/.test(record.scope)) {
    return 'the PR intake needs linkedIssue (positive integer), contributor and a one-line scope';
  }
  if (!isPlainObject(claim) || !Number.isSafeInteger(claim.id) || claim.id < 1) return 'the exact claim comment and its numeric id are missing';
  const expectedUrl = `https://github.com/${record.repository}/issues/${record.linkedIssue}#issuecomment-${claim.id}`;
  if (claim.url !== expectedUrl || claim.author !== record.contributor) return 'the claim must belong to the linked issue, repository and contributor';
  if (typeof claim.body !== 'string' || claim.body.replaceAll('\r\n', '\n').trim() !== implementationClaimBody(record.linkedIssue, record.scope)) {
    return 'the complete comment body is not the explicit implementation claim for this issue and scope';
  }
  const timestamps = ['createdAt', 'updatedAt', 'observedAt'].map(key => {
    const value = claim[key];
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return NaN;
    const parsed = Date.parse(value);
    const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical ? parsed : NaN;
  });
  if (timestamps.some(value => !Number.isFinite(value)) || timestamps[0] > timestamps[1] || timestamps[1] > timestamps[2]) {
    return 'the claim needs ordered UTC createdAt, updatedAt and observedAt timestamps';
  }
  return null;
}

// Coercions used only to build evidence. A malformed field is recorded as null
// rather than dropped, so the refusal that names it stays auditable and the
// record still serializes.
const asString = (value) => (typeof value === 'string' ? value : null);
const asCount = (value) => (Number.isInteger(value) ? value : null);
const asBoolean = (value) => (typeof value === 'boolean' ? value : null);

const describe = (reading) => ({
  command: asString(reading?.command),
  result: asString(reading?.result),
  matches: asCount(reading?.matches),
  reviewed: asBoolean(reading?.reviewed),
  coverage: reading?.coverage === undefined ? null : evaluateCoverage(reading.coverage),
  ...(reading?.source === CLAIM_SOURCE ? { claim: isPlainObject(reading.claim) ? {
    id: asCount(reading.claim.id), url: asString(reading.claim.url), author: asString(reading.claim.author),
    body: asString(reading.claim.body), createdAt: asString(reading.claim.createdAt),
    updatedAt: asString(reading.claim.updatedAt), observedAt: asString(reading.claim.observedAt),
  } : null } : {}),
});

const observation = (source, observed) =>
  makeEvidence({ type: EVIDENCE_TYPE.GITHUB, source: `intake:${source}`, observed });

/**
 * One entry per required source, always, whatever the outcome.
 *
 * A source with no reading is recorded as missing rather than omitted: a
 * refusal that does not say which reading was never taken cannot be audited.
 * Readings naming something outside the expected set are recorded too, at the
 * end, so an unknown source is visible instead of silently ignored.
 *
 * On the pull-request route the claim reading gets a slot of its own, so an
 * intake that never took it says so in the evidence rather than only in the
 * refusal. The route is read raw and matched exactly: a garbled contributionType
 * simply does not open that slot, and the refusal for it fires first anyway.
 */
function observe(readings, contributionType) {
  const list = Array.isArray(readings) ? readings : [];
  const evidence = [];

  const expected = contributionType === CONTRIBUTION.PULL_REQUEST
    ? [...REQUIRED_SOURCES, CLAIM_SOURCE]
    : REQUIRED_SOURCES;

  for (const source of expected) {
    const found = list.filter((reading) => isPlainObject(reading) && reading.source === source);
    if (found.length === 0) {
      evidence.push(observation(source, { source, present: false, command: null, result: ABSENT, matches: null, reviewed: null }));
      continue;
    }
    for (const reading of found) evidence.push(observation(source, { source, present: true, ...describe(reading) }));
  }

  const seen = new Set(expected);
  for (const reading of list) {
    const declared = isPlainObject(reading) ? asString(reading.source) : null;
    if (declared !== null && seen.has(declared)) continue;
    evidence.push(observation('unrecognised', { source: declared, present: true, ...describe(reading) }));
  }

  return evidence;
}

const inconclusive = (refusal, reason, evidence) => ({ status: STATUS.UNKNOWN, reason, refusal, evidence });

/**
 * Decide one intake record.
 *
 * @returns {{status: string, reason: string, refusal: string|null, evidence: object[]}}
 */
export function evaluateIntake(record) {
  const evidence = observe(record?.readings, record?.contributionType);

  if (!isPlainObject(record)
    || !isNonEmptyString(record.repository)
    || !Array.isArray(record.readings)
    || !Array.isArray(record.competing)) {
    return inconclusive(
      REFUSAL.NOT_A_RECORD,
      'the intake record must be an object carrying a non-empty repository, a readings array and a competing array',
      evidence
    );
  }

  const { repository, readings, competing, contributionType } = record;

  for (const [index, reading] of readings.entries()) {
    if (!isPlainObject(reading)) {
      return inconclusive(REFUSAL.MALFORMED_READING, `reading ${index} is not an object`, evidence);
    }
    if (!isNonEmptyString(reading.command)) {
      return inconclusive(REFUSAL.MALFORMED_READING, `reading ${index} carries no command; a reading nobody can reproduce is not a reading`, evidence);
    }
    if (!Number.isInteger(reading.matches) || reading.matches < 0) {
      return inconclusive(REFUSAL.MALFORMED_READING, `reading ${index} reports ${JSON.stringify(reading.matches)} matches, which is not an integer of zero or more`, evidence);
    }
    if (typeof reading.reviewed !== 'boolean') {
      return inconclusive(REFUSAL.MALFORMED_READING, `reading ${index} reports ${JSON.stringify(reading.reviewed)} for reviewed, which is not a boolean`, evidence);
    }
    if (!RESULTS.has(reading.result)) {
      return inconclusive(REFUSAL.MALFORMED_READING, `reading ${index} reports result ${JSON.stringify(reading.result)}, which is not one of ${Object.values(READING).join(', ')}`, evidence);
    }
  }

  const unknownSources = readings.filter((reading) => !ALLOWED.has(reading.source));
  if (unknownSources.length > 0) {
    const named = unknownSources.map((reading) => JSON.stringify(reading.source)).join(', ');
    return inconclusive(
      REFUSAL.UNKNOWN_SOURCE,
      `reading(s) name source ${named}, which is not one of ${ALLOWED_SOURCES.join(', ')}`,
      evidence
    );
  }

  const duplicated = ALLOWED_SOURCES.filter((source) => readings.filter((reading) => reading.source === source).length > 1);
  if (duplicated.length > 0) {
    return inconclusive(
      REFUSAL.DUPLICATE_SOURCE,
      `source(s) read more than once: ${duplicated.join(', ')}; one reading per source, or the record does not say which one holds`,
      evidence
    );
  }

  const missing = REQUIRED_SOURCES.filter((source) => !readings.some((reading) => reading.source === source));
  if (missing.length > 0) {
    return inconclusive(
      REFUSAL.MISSING_SOURCE,
      `intake requires all ${REQUIRED_SOURCES.length} readings and ${missing.length} were never taken: ${missing.join(', ')}. `
      + `A zero from ${SOURCE.TEXT_SEARCH} alone is not evidence of absence -- the search index lags behind the repository`,
      evidence
    );
  }

  const incomplete = readings.filter((reading) => reading.result !== READING.COMPLETE);
  if (incomplete.length > 0) {
    const named = incomplete.map((reading) => `${reading.source} reported ${reading.result}`).join(', ');
    return inconclusive(
      REFUSAL.READING_INCOMPLETE,
      `reading(s) did not complete: ${named}; a reading that did not finish says nothing about what it did not reach`,
      evidence
    );
  }

  for (const reading of readings) {
    const coverage = evaluateCoverage(reading.coverage);
    if (!coverage.complete) {
      return inconclusive(
        REFUSAL.COVERAGE_INCOMPLETE,
        `${reading.source} declared COMPLETE without proof of coverage: ${coverage.reason}`,
        evidence
      );
    }
    if (reading.coverage.source !== reading.source
      || reading.coverage.scope !== repository
      || reading.coverage.query !== reading.command) {
      return inconclusive(
        REFUSAL.COVERAGE_INCOMPLETE,
        `${reading.source} coverage is not bound to its reading source, repository scope, and exact query`,
        evidence
      );
    }
    if (reading.coverage.returnedCount !== reading.matches) {
      return inconclusive(
        REFUSAL.COVERAGE_INCOMPLETE,
        `${reading.source} reports ${reading.matches} match(es), but its coverage receipt accounts for ${reading.coverage.returnedCount}`,
        evidence
      );
    }
  }

  const unreviewed = readings.filter((reading) => reading.matches > 0 && reading.reviewed !== true);
  if (unreviewed.length > 0) {
    const named = unreviewed.map((reading) => `${reading.source} (${reading.matches} match(es))`).join(', ');
    return inconclusive(
      REFUSAL.UNREVIEWED_MATCHES,
      `reading(s) returned matches nobody read: ${named}; hits you did not read are not hits you cleared`,
      evidence
    );
  }

  if (competing.length > 0) {
    return {
      status: STATUS.FAIL,
      reason: `competing work is already in flight on ${repository}: ${competing.join(', ')}`,
      refusal: REFUSAL.COMPETING_WORK,
      evidence,
      remediation: 'Claim the existing item, coordinate with whoever holds it, or withdraw. Do not draft a second contribution for the same mechanism.',
    };
  }

  // Rules 1-7 above are route-independent, which is why the route is only
  // demanded here: reporting "your gh-pr-list reading never completed" is more
  // actionable than "you did not declare a route" when both are true, and
  // observed competing work is decisive whatever the route.
  //
  // From here on the route decides, so a record that does not declare one
  // cannot be decided. Nothing is inferred from the readings present: an intake
  // that omits BOTH its route and its claim reading would otherwise pass by
  // looking exactly like an issue, which is the shape of the very mistake this
  // rule exists to catch.
  if (!CONTRIBUTIONS.has(contributionType)) {
    return inconclusive(
      REFUSAL.UNKNOWN_CONTRIBUTION_TYPE,
      `the intake record declares contributionType ${JSON.stringify(contributionType ?? null)}, which is not one of `
      + `${Object.values(CONTRIBUTION).join(', ')}. The claim rule applies to ${CONTRIBUTION.PULL_REQUEST} only, so a record `
      + 'that does not say which route it is on leaves that undeterminable, and undeterminable fails closed',
      evidence
    );
  }

  // Rule 8. The three readings above prove what upstream already published.
  // None of them proves what this contributor announced, and on the
  // pull-request route that announcement is what stops the work being done
  // twice. CONTRIBUTING's step 3 comes before step 4 for that reason.
  const claim = readings.find((reading) => reading.source === CLAIM_SOURCE);
  if (contributionType === CONTRIBUTION.PULL_REQUEST) {
    if (claim === undefined) {
      return inconclusive(
        REFUSAL.CLAIM_NOT_RECORDED,
        `a ${CONTRIBUTION.PULL_REQUEST} intake requires a ${CLAIM_SOURCE} reading and none was taken. `
        + "CONTRIBUTING defines one Issue-First Workflow for every issue: step 3 is \"Comment on the issue to let others "
        + 'know you\'re working on it\", step 4 opens the pull request. An intake that never read the linked issue\'s '
        + 'comments cannot show step 3 was performed',
        evidence
      );
    }
    if (claim.matches < 1) {
      return {
        status: STATUS.FAIL,
        reason: `the ${CLAIM_SOURCE} reading of ${repository} found ${claim.matches} claim comment(s) on the linked issue: `
          + 'step 3 was not performed, so nothing upstream says this work is already being done',
        refusal: REFUSAL.CLAIM_ABSENT,
        evidence,
        remediation: 'Comment on the linked issue that you are implementing it, then re-take this reading. Do this BEFORE '
          + 'implementation starts, not before publication: the comment is what stops a second implementer -- the maintainer '
          + 'included -- from starting the same work while you verify yours.',
      };
    }
    const problem = claimProblem(record, claim.claim);
    if (problem !== null) {
      return inconclusive(REFUSAL.CLAIM_UNVERIFIED, `${problem}. Read the full comment; a comment count cannot establish intent. Next action: record an explicit claim before assigning the author and re-take intake.`, evidence);
    }
  }

  // Counted over the three competing-work readings only. The claim reading
  // answers a different question, and folding its comments into "matches
  // reviewed" would misreport how much upstream work was actually swept.
  const matches = readings
    .filter((reading) => REQUIRED.has(reading.source))
    .reduce((total, reading) => total + reading.matches, 0);
  const claimed = contributionType === CONTRIBUTION.PULL_REQUEST ? `, implementation claim verified: ${claim.claim.url}` : '';
  return {
    status: STATUS.PASS,
    reason: `all ${REQUIRED_SOURCES.length} readings of ${repository} completed, ${matches} match(es) reviewed, no competing work${claimed}`,
    refusal: null,
    evidence,
  };
}

/** True only when every rule above held. */
export const intakeSatisfied = (record) => evaluateIntake(record).status === STATUS.PASS;
