import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTestEvents, countResults, judgeClaim } from '../bin/verify-test-claim.mjs';

// Synthetic fixture modeled after observation #830: six top-level functions,
// ten subtests, and four skipped subtests. This is not a preserved historical
// toolchain stream; it exercises the admission contract deterministically.
const packageName = 'example.com/repro830';
const event = (action, name) => JSON.stringify({
  Action: action,
  Package: packageName,
  ...(name === undefined ? {} : { Test: name }),
});
const incidentEvents = [
  event('pass', 'TestAlpha/one'), event('pass', 'TestAlpha/two'), event('pass', 'TestAlpha'),
  event('pass', 'TestBeta/one'), event('pass', 'TestBeta/two'), event('pass', 'TestBeta'),
  event('pass', 'TestGamma/one'), event('pass', 'TestGamma/two'), event('pass', 'TestGamma'),
  event('skip', 'TestDelta/capture-result-preflight'), event('skip', 'TestDelta/preserve-result'), event('pass', 'TestDelta'),
  event('skip', 'TestEpsilon/git-missing-repository'), event('skip', 'TestEpsilon/git-object-permission'), event('pass', 'TestEpsilon'),
  event('pass', 'TestZeta'),
];
const completePassingStream = [...incidentEvents, event('pass')].join('\n');
const counts = (stream) => countResults(parseTestEvents(stream));
const incidentCounts = () => counts(completePassingStream);

test('REGRESSION: the historical false claim shape is refused with both count defects named', () => {
  const verdict = judgeClaim(incidentCounts(), { subtests: 12, skip: 0 });
  assert.equal(verdict.decision, 'refuse');
  assert.equal(verdict.reasons.length, 2);
  assert.match(verdict.reasons[0], /claimed 12 subtests, -json counts 10/);
  assert.match(verdict.reasons[1], /claimed 0 skips, -json counts 4/);
});

test('the truthful synthetic fixture claim is admitted', () => {
  const verdict = judgeClaim(incidentCounts(), { subtests: 10, skip: 4 });
  assert.equal(verdict.decision, 'admit');
  assert.deepEqual(verdict.reasons, []);
});

test('an undisclosed subtest failure refuses even when totals match', () => {
  const stream = [...incidentEvents, event('fail', 'TestZeta/broken'), event('fail')].join('\n');
  const verdict = judgeClaim(counts(stream), { subtests: 11, skip: 4 });
  assert.equal(verdict.decision, 'refuse');
  assert.ok(verdict.reasons.some((reason) => /package completion.*failed/.test(reason)));
  assert.ok(verdict.reasons.some((reason) => /claimed 0 failures, -json counts 1/.test(reason)));
});

test('a disclosed subtest failure still refuses because the surrounding package failed', () => {
  const stream = [...incidentEvents, event('fail', 'TestZeta/broken'), event('fail')].join('\n');
  const verdict = judgeClaim(counts(stream), { subtests: 11, skip: 4, fail: 1 });
  assert.equal(verdict.decision, 'refuse');
  assert.ok(verdict.reasons.some((reason) => /package completion.*failed/.test(reason)));
});

test('REGRESSION: a failing top-level test refuses despite matching subtest counts', () => {
  const stream = [
    event('pass', 'TestAlpha/one'),
    event('fail', 'TestAlpha'),
    event('fail'),
  ].join('\n');
  const verdict = judgeClaim(counts(stream), { subtests: 1, skip: 0 });
  assert.equal(verdict.decision, 'refuse');
  assert.ok(verdict.reasons.some((reason) => /top-level test.*failed/.test(reason)));
});

test('REGRESSION: a skipped top-level test refuses despite matching subtest counts', () => {
  const stream = [
    event('pass', 'TestAlpha/one'),
    event('skip', 'TestAlpha'),
    event('pass'),
  ].join('\n');
  const verdict = judgeClaim(counts(stream), { subtests: 1, skip: 0 });
  assert.equal(verdict.decision, 'refuse');
  assert.ok(verdict.reasons.some((reason) => /top-level test.*skipped/.test(reason)));
});

test('REGRESSION: a failing package refuses despite passing tests and matching counts', () => {
  const stream = [event('pass', 'TestAlpha/one'), event('pass', 'TestAlpha'), event('fail')].join('\n');
  const verdict = judgeClaim(counts(stream), { subtests: 1, skip: 0 });
  assert.equal(verdict.decision, 'refuse');
  assert.ok(verdict.reasons.some((reason) => /package completion.*failed/.test(reason)));
});

test('REGRESSION: a mixed valid and malformed stream refuses instead of dropping evidence', () => {
  const stream = `${completePassingStream}\nthis is not JSON`;
  const verdict = judgeClaim(counts(stream), { subtests: 10, skip: 4 });
  assert.equal(verdict.decision, 'refuse');
  assert.ok(verdict.reasons.some((reason) => /malformed nonblank JSON line/.test(reason)));
});

test('REGRESSION: a truncated stream without package completion refuses', () => {
  const verdict = judgeClaim(counts(incidentEvents.join('\n')), { subtests: 10, skip: 4 });
  assert.equal(verdict.decision, 'refuse');
  assert.ok(verdict.reasons.some((reason) => /missing package completion/.test(reason)));
});

test('an empty stream refuses: no events, no claim', () => {
  const verdict = judgeClaim(counts(''), { subtests: 0, skip: 0 });
  assert.equal(verdict.decision, 'refuse');
  assert.ok(verdict.reasons.some((reason) => /no test results/));
  assert.ok(verdict.reasons.some((reason) => /no package identity or completion/));
});

test('a stream of non-JSON build noise refuses as malformed evidence', () => {
  const verdict = judgeClaim(counts('# build failed\nsyntax error\n'), { subtests: 0, skip: 0 });
  assert.equal(verdict.decision, 'refuse');
  assert.ok(verdict.reasons.some((reason) => /2 malformed nonblank JSON line/.test(reason)));
});

test('subtests are counted separately; top-level counts are observed but not claimed', () => {
  const measured = incidentCounts();
  assert.equal(measured.subtests.total, 10);
  assert.equal(measured.subtests.skip, 4);
  assert.equal(measured.toplevel.total, 6);
  assert.equal(measured.toplevel.pass, 6);
  assert.equal(measured.packages.pass, 1);
});
