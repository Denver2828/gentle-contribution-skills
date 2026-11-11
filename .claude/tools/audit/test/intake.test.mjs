// Intake: three readings, or nothing advances.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateIntake, intakeSatisfied, implementationClaimBody, SOURCE, REQUIRED_SOURCES, READING, REFUSAL, CONTRIBUTION, CLAIM_SOURCE } from '../lib/intake.mjs';
import { openStore, assertIndexShape, StoreError, STORE_VERSION, NO_SIGNATURE_WARNING } from '../lib/store/store.mjs';
import { STATUS } from '../lib/status.mjs';
import { completeCoverage, auditorResult, TASK_CONTRACT } from './helpers/documents.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'audit-intake-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const newRoot = () => mkdtempSync(join(scratch, 'store-'));
const store = () => openStore({ override: newRoot(), allowOutsideWorkspace: true, lockOptions: { waitMs: 4000 } });

const id = (character) => `sha256:${character.repeat(64)}`;
const CANDIDATE = id('c');

const FREEZE = {
  baseTree: 'aa', candidateTree: 'bb',
  pathsDigest: id('1'), draftDigest: id('2'), policyDigest: id('3'), testManifestDigest: id('4'),
  draftBodySha256: id('b'),
  taskContract: TASK_CONTRACT,
};

const COMMAND = Object.freeze({
  [SOURCE.TEXT_SEARCH]: 'gh search issues --repo Gentleman-Programming/gentle-ai --state all "review receipt"',
  [SOURCE.OPEN_ISSUES]: 'gh issue list --repo Gentleman-Programming/gentle-ai --state open --limit 60',
  [SOURCE.OPEN_PRS]: 'gh pr list --repo Gentleman-Programming/gentle-ai --state open --limit 60',
});

const reading = (source, overrides = {}) => {
  const value = { source, command: COMMAND[source], result: READING.COMPLETE, matches: 0, reviewed: false, ...overrides };
  return { ...value, coverage: overrides.coverage ?? completeCoverage({ source, scope: 'Gentleman-Programming/gentle-ai', query: value.command, count: value.matches }) };
};

// Defaults to the issue route, where rule 8 does not apply, so the tests below
// keep asserting rules 1-7 on their own. The pull-request route has its own
// section at the end of this file.
const record = (overrides = {}) => ({
  repository: 'Gentleman-Programming/gentle-ai',
  contributionType: CONTRIBUTION.ISSUE,
  readings: REQUIRED_SOURCES.map((source) => reading(source)),
  competing: [],
  ...overrides,
});

const sourcesNamed = (evidence) => evidence.map((item) => item.observed.source);

// -- the production failure -------------------------------------------------------------

test('THE FAILURE: a zero from gh-search-issues alone is UNKNOWN, and names both readings never taken', () => {
  const outcome = evaluateIntake({
    repository: 'Gentleman-Programming/gentle-ai',
    readings: [reading(SOURCE.TEXT_SEARCH, { matches: 0 })],
    competing: [],
  });

  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.refusal, REFUSAL.MISSING_SOURCE);
  assert.match(outcome.reason, /gh-issue-list/);
  assert.match(outcome.reason, /gh-pr-list/);
  assert.equal(intakeSatisfied({ repository: 'x', readings: [reading(SOURCE.TEXT_SEARCH)], competing: [] }), false);
});

// -- the only path to PASS ----------------------------------------------------------------

test('three complete readings, no matches and no competing work is the only clean PASS', () => {
  const outcome = evaluateIntake(record());

  assert.equal(outcome.status, STATUS.PASS);
  assert.equal(outcome.refusal, null);
  assert.equal(intakeSatisfied(record()), true);
});

// -- one source at a time ------------------------------------------------------------------

for (const absent of REQUIRED_SOURCES) {
  test(`a missing ${absent} is UNKNOWN and names it`, () => {
    const outcome = evaluateIntake(record({
      readings: REQUIRED_SOURCES.filter((source) => source !== absent).map((source) => reading(source)),
    }));

    assert.equal(outcome.status, STATUS.UNKNOWN);
    assert.equal(outcome.refusal, REFUSAL.MISSING_SOURCE);
    assert.match(outcome.reason, new RegExp(absent));
  });

  for (const result of [READING.FAILED, READING.PARTIAL]) {
    test(`a ${result} ${absent} is UNKNOWN, whatever the other two say`, () => {
      const outcome = evaluateIntake(record({
        readings: REQUIRED_SOURCES.map((source) => reading(source, source === absent ? { result } : {})),
      }));

      assert.equal(outcome.status, STATUS.UNKNOWN);
      assert.equal(outcome.refusal, REFUSAL.READING_INCOMPLETE);
      assert.match(outcome.reason, new RegExp(`${absent} reported ${result}`));
    });
  }
}

test('a source read twice is UNKNOWN: the record does not say which reading holds', () => {
  const outcome = evaluateIntake(record({
    readings: [...REQUIRED_SOURCES.map((source) => reading(source)), reading(SOURCE.OPEN_ISSUES, { matches: 4, reviewed: true })],
  }));

  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.refusal, REFUSAL.DUPLICATE_SOURCE);
  assert.match(outcome.reason, /gh-issue-list/);
});

test('a source nobody declared is UNKNOWN, not silently ignored', () => {
  const outcome = evaluateIntake(record({
    readings: [...REQUIRED_SOURCES.map((source) => reading(source)), { source: 'gh-discussion-list', command: 'gh api …', result: READING.COMPLETE, matches: 0, reviewed: false, coverage: completeCoverage({ source: 'gh-discussion-list' }) }],
  }));

  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.refusal, REFUSAL.UNKNOWN_SOURCE);
  assert.match(outcome.reason, /gh-discussion-list/);
});

// -- matches ---------------------------------------------------------------------------------

test('matches nobody reviewed are UNKNOWN: hits you did not read are not hits you cleared', () => {
  const outcome = evaluateIntake(record({
    readings: REQUIRED_SOURCES.map((source) => reading(source, source === SOURCE.OPEN_ISSUES ? { matches: 7, reviewed: false } : {})),
  }));

  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.refusal, REFUSAL.UNREVIEWED_MATCHES);
  assert.match(outcome.reason, /gh-issue-list \(7 match/);
});

test('COMPLETE without termination evidence is coverage-incomplete', () => {
  const outcome = evaluateIntake(record({
    readings: REQUIRED_SOURCES.map((source) => reading(source, source === SOURCE.OPEN_PRS
      ? { coverage: { ...completeCoverage({ source }), authoritativeTotal: null, termination: 'unknown' } }
      : {})),
  }));
  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.refusal, REFUSAL.COVERAGE_INCOMPLETE);
  assert.match(outcome.reason, /termination/);
});

test('coverage must bind the reading source, repository scope, and exact query', () => {
  for (const coverage of [
    completeCoverage({ source: SOURCE.OPEN_ISSUES, query: COMMAND[SOURCE.TEXT_SEARCH] }),
    completeCoverage({ source: SOURCE.TEXT_SEARCH, scope: 'someone/else', query: COMMAND[SOURCE.TEXT_SEARCH] }),
    completeCoverage({ source: SOURCE.TEXT_SEARCH, query: 'gh search issues --repo someone/else' }),
  ]) {
    const outcome = evaluateIntake(record({
      readings: REQUIRED_SOURCES.map((source) => reading(source, source === SOURCE.TEXT_SEARCH ? { coverage } : {})),
    }));
    assert.equal(outcome.status, STATUS.UNKNOWN);
    assert.equal(outcome.refusal, REFUSAL.COVERAGE_INCOMPLETE);
    assert.match(outcome.reason, /bound/);
  }
});

test('coverage cannot start at page-99 and claim completeness from a terminal cursor', () => {
  const coverage = completeCoverage({ source: SOURCE.TEXT_SEARCH, query: COMMAND[SOURCE.TEXT_SEARCH] });
  coverage.pages[0].cursor = 'page-99';
  coverage.pages[0].nextCursor = null;
  coverage.termination = 'cursor-exhausted';
  coverage.authoritativeTotal = null;
  const outcome = evaluateIntake(record({
    readings: REQUIRED_SOURCES.map((source) => reading(source, source === SOURCE.TEXT_SEARCH ? { coverage } : {})),
  }));
  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.refusal, REFUSAL.COVERAGE_INCOMPLETE);
  assert.match(outcome.reason, /origin/);
});

test('matches that were reviewed and judged unrelated reach PASS', () => {
  const outcome = evaluateIntake(record({
    readings: REQUIRED_SOURCES.map((source) => reading(source, { matches: 3, reviewed: true })),
  }));

  assert.equal(outcome.status, STATUS.PASS);
  assert.match(outcome.reason, /9 match\(es\) reviewed/);
});

test('competing work is FAIL, not UNKNOWN, and the numbers are named with a remediation', () => {
  const outcome = evaluateIntake(record({
    readings: REQUIRED_SOURCES.map((source) => reading(source, { matches: 2, reviewed: true })),
    competing: [2213, 2214],
  }));

  assert.equal(outcome.status, STATUS.FAIL);
  assert.equal(outcome.refusal, REFUSAL.COMPETING_WORK);
  assert.match(outcome.reason, /2213/);
  assert.match(outcome.reason, /2214/);
  assert.match(outcome.remediation, /[Cc]laim|coordinate|withdraw/);
});

// -- malformed input ----------------------------------------------------------------------------

test('a malformed reading is UNKNOWN and names the offending index', () => {
  const malformed = {
    'non-integer matches': { matches: 1.5 },
    'negative matches': { matches: -1 },
    'a matches that is not a number': { matches: '3' },
    'an empty command': { command: '   ' },
    'a missing command': { command: undefined },
    'a non-boolean reviewed': { reviewed: 'yes' },
    'an invented result': { result: 'DONE' },
  };

  for (const [label, overrides] of Object.entries(malformed)) {
    const outcome = evaluateIntake(record({
      readings: [reading(SOURCE.TEXT_SEARCH), reading(SOURCE.OPEN_ISSUES, overrides), reading(SOURCE.OPEN_PRS)],
    }));

    assert.equal(outcome.status, STATUS.UNKNOWN, label);
    assert.equal(outcome.refusal, REFUSAL.MALFORMED_READING, label);
    assert.match(outcome.reason, /reading 1/, label);
  }
});

test('a reading that is not an object at all is UNKNOWN', () => {
  for (const bad of [null, 'gh issue list', 42, []]) {
    const outcome = evaluateIntake(record({ readings: [bad, reading(SOURCE.OPEN_ISSUES), reading(SOURCE.OPEN_PRS)] }));
    assert.equal(outcome.refusal, REFUSAL.MALFORMED_READING, JSON.stringify(bad));
    assert.match(outcome.reason, /reading 0/);
  }
});

test('anything that is not a record is UNKNOWN, never an empty PASS', () => {
  for (const bad of [null, undefined, [], 'intake done', 7, {}, { repository: '', readings: [], competing: [] }, { repository: 'o/n', readings: {}, competing: [] }, { repository: 'o/n', readings: [], competing: null }]) {
    const outcome = evaluateIntake(bad);
    assert.equal(outcome.status, STATUS.UNKNOWN, JSON.stringify(bad ?? null));
    assert.equal(outcome.refusal, REFUSAL.NOT_A_RECORD, JSON.stringify(bad ?? null));
  }
});

// -- evidence -----------------------------------------------------------------------------------

test('every required source is recorded, refusal or not, with its command, result and count', () => {
  const passing = evaluateIntake(record());
  assert.deepEqual(sourcesNamed(passing.evidence), [...REQUIRED_SOURCES]);
  for (const item of passing.evidence) {
    assert.equal(item.observed.command, COMMAND[item.observed.source]);
    assert.equal(item.observed.result, READING.COMPLETE);
    assert.equal(item.observed.matches, 0);
  }

  // The exact production failure: the two readings never taken are recorded as
  // missing, not omitted, so the refusal can be audited.
  const refused = evaluateIntake({ repository: 'o/n', readings: [reading(SOURCE.TEXT_SEARCH)], competing: [] });
  assert.deepEqual(sourcesNamed(refused.evidence), [...REQUIRED_SOURCES]);
  const missing = refused.evidence.filter((item) => item.observed.present === false);
  assert.deepEqual(missing.map((item) => item.observed.source), [SOURCE.OPEN_ISSUES, SOURCE.OPEN_PRS]);
  for (const item of missing) assert.equal(item.observed.result, 'MISSING');

  // And a record that is not a record at all still names all three.
  assert.deepEqual(sourcesNamed(evaluateIntake(null).evidence), [...REQUIRED_SOURCES]);
});

// -- through the store ------------------------------------------------------------------------------

test('freeze refuses an unsatisfied intake, and creates no lineage doing so', () => {
  const api = store();
  const unsatisfied = { repository: 'Gentleman-Programming/gentle-ai', readings: [reading(SOURCE.TEXT_SEARCH)], competing: [] };

  assert.throws(() => api.freeze({ lineage: 'pr-1', candidateId: CANDIDATE, intake: unsatisfied, ...FREEZE }), (error) =>
    error instanceof StoreError
    && error.detail.failure === 'intake-not-satisfied'
    && error.detail.refusal === REFUSAL.MISSING_SOURCE
    && error.detail.intakeStatus === STATUS.UNKNOWN);

  // The refusal created nothing: the lineage does not exist.
  assert.throws(() => api.status('pr-1'), (error) => error instanceof StoreError && error.detail.failure === 'unknown-lineage');
  assert.deepEqual(Object.keys(api.read().lineages), []);
});

test('freeze refuses observed competing work, and that refusal is a FAIL, not a gap', () => {
  const api = store();
  const contested = record({ competing: [2213] });

  assert.throws(() => api.freeze({ lineage: 'pr-2', candidateId: CANDIDATE, intake: contested, ...FREEZE }), (error) =>
    error instanceof StoreError && error.detail.refusal === REFUSAL.COMPETING_WORK && error.detail.intakeStatus === STATUS.FAIL);
  assert.throws(() => api.status('pr-2'), StoreError);
});

test('a satisfied intake is recorded on the lineage, digest included', () => {
  const api = store();
  const frozen = api.freeze({ lineage: 'pr-3', candidateId: CANDIDATE, intake: record(), ...FREEZE });

  assert.equal(frozen.intake_status, STATUS.PASS);
  assert.equal(frozen.intake_refusal, null);
  assert.match(frozen.intake_digest, /^sha256:[0-9a-f]{64}$/);
});

test('intake_status is validated when present, and a store written before it still reads', () => {
  const index = (entry) => ({
    storeVersion: STORE_VERSION, notASignature: NO_SIGNATURE_WARNING, migratedFrom: [],
    lineages: { 'pr-1': { lineage: 'pr-1', state: 'FROZEN', correction_budget: 1, corrections_used: 0, attempts: 0, ...entry } },
  });

  assert.doesNotThrow(() => assertIndexShape(index({})), 'a lineage frozen before intake existed is history, not corruption');
  assert.doesNotThrow(() => assertIndexShape(index({ intake_status: STATUS.PASS })));
  assert.throws(() => assertIndexShape(index({ intake_status: 1 })), (error) =>
    error instanceof StoreError && error.detail.failure === 'invalid-draft' && error.detail.field === 'intake_status');
});

test('refreeze re-evaluates the intake; the PASS of the first freeze does not carry over', () => {
  const api = store();
  const lineage = 'pr-4';
  const frozen = api.freeze({ lineage, candidateId: CANDIDATE, intake: record(), ...FREEZE });
  api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'NEEDS_CHANGES') });
  api.reserveCorrection({ lineage });
  assert.equal(api.status(lineage).state, 'CORRECTION_RESERVED', 'refreeze must be reachable, so the refusal below is about intake');

  const stale = { repository: 'Gentleman-Programming/gentle-ai', readings: [reading(SOURCE.TEXT_SEARCH)], competing: [] };
  assert.throws(() => api.refreeze({ lineage, candidateId: id('d'), intake: stale, ...FREEZE }), (error) =>
    error instanceof StoreError && error.detail.failure === 'intake-not-satisfied' && error.detail.refusal === REFUSAL.MISSING_SOURCE);

  // Refused, and the lineage did not move.
  const after = api.status(lineage);
  assert.equal(after.state, 'CORRECTION_RESERVED');
  assert.equal(after.candidateId, CANDIDATE);
  assert.equal(after.frozen_at_generation, 1);

  // A fresh, complete intake is what unblocks it.
  const refrozen = api.refreeze({ lineage, candidateId: id('d'), intake: record(), ...FREEZE });
  assert.equal(refrozen.state, 'REFROZEN');
  assert.equal(refrozen.intake_status, STATUS.PASS);
});

// -- rule 8: the claim reading, on the pull-request route only ----------------------------------
//
// The second production failure, 26/8/2026. Issue #3761 was opened, approved 34
// minutes later, and never commented on. An intake with all three readings
// COMPLETE and an exact-path sweep of every open pull request reached PASS.
// Thirteen minutes later the maintainer authored the identical change and
// merged it; the candidate's own commit landed 16 seconds after his. Every
// reading was correct when taken. What was never read was the linked issue's
// own comments.

const prCommand = Object.freeze({
  [CLAIM_SOURCE]: 'gh issue view 3761 --repo Gentleman-Programming/gentle-ai --json comments',
});

const claimReading = (overrides = {}) => {
  const value = {
    source: CLAIM_SOURCE, command: prCommand[CLAIM_SOURCE], result: READING.COMPLETE,
    claim: {
      id: 123, url: 'https://github.com/Gentleman-Programming/gentle-ai/issues/3761#issuecomment-123',
      author: 'contributor', body: implementationClaimBody(3761, 'Fix the scoped defect'),
      createdAt: '2026-11-11T10:00:00Z', updatedAt: '2026-11-11T10:00:00Z', observedAt: '2026-11-11T10:01:00Z',
    },
    matches: 1, reviewed: true, ...overrides,
  };
  return { ...value, coverage: overrides.coverage ?? completeCoverage({ source: CLAIM_SOURCE, query: value.command, count: value.matches }) };
};

const pullRequest = (overrides = {}) => record({ contributionType: CONTRIBUTION.PULL_REQUEST, linkedIssue: 3761, contributor: 'contributor', scope: 'Fix the scoped defect', ...overrides });

const withClaim = (overrides = {}) => pullRequest({
  readings: [...REQUIRED_SOURCES.map((source) => reading(source)), claimReading(overrides)],
});

test('a positive own-comment count alone is not a claim of implementation', () => {
  const outcome = evaluateIntake(withClaim({ claim: undefined }));
  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.refusal, 'claim-unverified');
});

test('THE SECOND FAILURE: three complete readings and no claim reading is UNKNOWN on the pull-request route', () => {
  // This is the exact shape of the record that passed on 26/8/2026: rules 1-7
  // all hold, and that was never the problem.
  const shipped = pullRequest();
  const asIssue = record();
  assert.equal(evaluateIntake(asIssue).status, STATUS.PASS, 'rules 1-7 hold; only the route changes the outcome');

  const outcome = evaluateIntake(shipped);
  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.refusal, REFUSAL.CLAIM_NOT_RECORDED);
  assert.match(outcome.reason, /gh-issue-comments/);
  assert.match(outcome.reason, /step 3/);
  assert.equal(intakeSatisfied(shipped), false);
});

test('a claim reading that found nothing is FAIL, not UNKNOWN: it observed the repository', () => {
  const outcome = evaluateIntake(withClaim({ matches: 0 }));
  assert.equal(outcome.status, STATUS.FAIL);
  assert.equal(outcome.refusal, REFUSAL.CLAIM_ABSENT);
  assert.match(outcome.reason, /0 claim comment\(s\)/);
  assert.match(outcome.remediation, /BEFORE/);
  assert.match(outcome.remediation, /implementation starts/);
});

test('a recorded claim comment reaches PASS, and the reason says so', () => {
  const outcome = evaluateIntake(withClaim({ matches: 2 }));
  assert.equal(outcome.status, STATUS.PASS);
  assert.equal(outcome.refusal, null);
  assert.match(outcome.reason, /implementation claim verified:.*issuecomment-123/);
  // The claim's own comments are not folded into the competing-work sweep count.
  assert.match(outcome.reason, /0 match\(es\) reviewed/);
});

test('claim evidence refuses unrelated, declining, wrong-target and edited-after-observation comments', () => {
  const good = claimReading().claim;
  for (const patch of [
    { body: 'Thanks for the explanation; I will not implement this.' },
    { body: `I decline.\n${good.body}` },
    { body: implementationClaimBody(3762, 'Fix the scoped defect') },
    { author: 'someone-else' }, { id: 124 },
    { url: good.url.replace('/issues/3761', '/issues/3762') },
    { url: good.url.replace('gentle-ai/', 'engram/') },
    { updatedAt: '2026-11-11T10:02:00Z' }, { createdAt: 'not-a-date' },
    { createdAt: '2026-02-30T10:00:00Z' },
  ]) {
    const outcome = evaluateIntake(withClaim({ claim: { ...good, ...patch } }));
    assert.equal(outcome.status, STATUS.UNKNOWN, JSON.stringify(patch));
    assert.equal(outcome.refusal, REFUSAL.CLAIM_UNVERIFIED);
  }
  assert.equal(evaluateIntake(withClaim({ claim: { ...good, body: good.body.replaceAll('\n', '\r\n') + '\r\n' } })).status, STATUS.PASS);
  for (const patch of [{ linkedIssue: 3762 }, { contributor: 'other' }, { scope: 'Different scope' }]) {
    assert.equal(evaluateIntake({ ...withClaim(), ...patch }).status, STATUS.UNKNOWN);
  }
});

test('rule 8 applies to the pull-request route and to no other', () => {
  for (const route of [CONTRIBUTION.ISSUE, CONTRIBUTION.ISSUE_COMMENT]) {
    const outcome = evaluateIntake(record({ contributionType: route }));
    assert.equal(outcome.status, STATUS.PASS, route);
    assert.doesNotMatch(outcome.reason, /claim/, route);
  }
});

test('a record that does not declare its route is UNKNOWN: undeterminable fails closed', () => {
  for (const declared of [undefined, null, '', 'pr', 'PULL-REQUEST', 7, {}]) {
    const outcome = evaluateIntake(record({ contributionType: declared }));
    assert.equal(outcome.status, STATUS.UNKNOWN, JSON.stringify(declared ?? null));
    assert.equal(outcome.refusal, REFUSAL.UNKNOWN_CONTRIBUTION_TYPE, JSON.stringify(declared ?? null));
    assert.match(outcome.reason, /pull-request, issue, issue-comment/);
  }
});

test('the route is demanded after rules 1-7, so a more specific gap is still named first', () => {
  // A missing reading outranks a missing route: the reading is the actionable gap.
  const noRoute = { repository: 'o/n', readings: [reading(SOURCE.TEXT_SEARCH)], competing: [] };
  assert.equal(evaluateIntake(noRoute).refusal, REFUSAL.MISSING_SOURCE);

  // And observed competing work outranks both: it is decisive whatever the route.
  const competing = { ...record({ competing: ['#3765'] }), contributionType: undefined };
  const outcome = evaluateIntake(competing);
  assert.equal(outcome.status, STATUS.FAIL);
  assert.equal(outcome.refusal, REFUSAL.COMPETING_WORK);
});

test('the claim reading obeys every generic rule: unreviewed, incomplete and duplicated all still refuse', () => {
  assert.equal(evaluateIntake(withClaim({ matches: 3, reviewed: false })).refusal, REFUSAL.UNREVIEWED_MATCHES);
  assert.equal(evaluateIntake(withClaim({ result: READING.PARTIAL })).refusal, REFUSAL.READING_INCOMPLETE);
  assert.equal(evaluateIntake(withClaim({ command: '' })).refusal, REFUSAL.MALFORMED_READING);

  const twice = pullRequest({
    readings: [...REQUIRED_SOURCES.map((source) => reading(source)), claimReading(), claimReading()],
  });
  assert.equal(evaluateIntake(twice).refusal, REFUSAL.DUPLICATE_SOURCE);
});

test('the claim reading gets an evidence slot on the pull-request route, missing or not', () => {
  const never = evaluateIntake(pullRequest());
  assert.deepEqual(sourcesNamed(never.evidence), [...REQUIRED_SOURCES, CLAIM_SOURCE]);
  const slot = never.evidence.find((item) => item.observed.source === CLAIM_SOURCE);
  assert.equal(slot.observed.present, false);
  assert.equal(slot.observed.result, 'MISSING');

  // On the other routes it is not expected, so it is not invented.
  assert.deepEqual(sourcesNamed(evaluateIntake(record()).evidence), [...REQUIRED_SOURCES]);
});

test('freeze refuses a pull-request candidate whose issue was never claimed', () => {
  const api = store();

  assert.throws(() => api.freeze({ lineage: 'pr-8', candidateId: CANDIDATE, intake: pullRequest(), ...FREEZE }), (error) =>
    error instanceof StoreError
    && error.detail.failure === 'intake-not-satisfied'
    && error.detail.refusal === REFUSAL.CLAIM_NOT_RECORDED
    && error.detail.intakeStatus === STATUS.UNKNOWN);

  // Nothing was created by the refusal.
  assert.deepEqual(Object.keys(api.read().lineages), []);

  // The claim comment is what unblocks it.
  const frozen = api.freeze({ lineage: 'pr-8', candidateId: CANDIDATE, intake: withClaim(), ...FREEZE });
  assert.equal(frozen.state, 'FROZEN');
  assert.equal(frozen.intake_status, STATUS.PASS);
});

test('REGRESSION (ASTRA-05): a reading whose coverage claims cursor exhaustion against a contradictory authoritative total is coverage-incomplete', () => {
  const outcome = evaluateIntake(record({
    readings: REQUIRED_SOURCES.map((source) => reading(source, source === SOURCE.OPEN_ISSUES
      ? { coverage: { ...completeCoverage({ source, count: 0 }), termination: 'cursor-exhausted', authoritativeTotal: 100 } }
      : {})),
  }));
  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.equal(outcome.refusal, REFUSAL.COVERAGE_INCOMPLETE);
  assert.match(outcome.reason, /authoritativeTotal 100 contradicts returnedCount 0/);
});
