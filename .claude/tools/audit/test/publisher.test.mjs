// The controlled publisher: ticket in, one exact gh operation out, attempt
// recorded whatever happened. Every gh execution here is a stub -- no network.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from '../lib/store/store.mjs';
import { ticketOf, bodyDigest, normalizeBody, TICKET_TTL_MS } from '../lib/ticket.mjs';
import { attemptIntact } from '../lib/publication.mjs';
import {
  publishWithTicket, ghCommandFor, verificationFetchFor, runProcess,
  publicationHealthGate, PUBLISHER_MODULE,
} from '../bin/publish.mjs';
import { buildEvidence } from '../lib/evidence-record.mjs';
import { REQUIRED_SOURCES, READING, CONTRIBUTION } from '../lib/intake.mjs';
import { STATUS } from '../lib/status.mjs';
import { completeCoverage, auditorResult, TASK_CONTRACT } from './helpers/documents.mjs';
import { HEALTH_CANARY_SCENARIOS, HEALTH_CANARY_VERSION } from '../lib/harness-health.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'audit-publisher-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;
const store = (options = {}) => {
  const root = mkdtempSync(join(scratch, 'store-'));
  return { root, api: openStore({ override: root, allowOutsideWorkspace: true, lockOptions: { waitMs: 4000 }, ...options }) };
};

function replaceCommittedTicket(api, lineage, ticket) {
  const text = `${JSON.stringify(ticket, null, 2)}\n`;
  writeFileSync(join(api.layout.ticketArtifacts, `${ticket.ticketId.slice('sha256:'.length)}.json`), text);
  writeFileSync(join(api.layout.tickets, `${lineage}.json`), text);
  const index = JSON.parse(readFileSync(api.layout.index, 'utf8'));
  index.lineages[lineage].ticketId = ticket.ticketId;
  index.lineages[lineage].attempts = ticket.attemptNumber;
  writeFileSync(api.layout.index, `${JSON.stringify(index, null, 2)}\n`);
}

const id = (character) => `sha256:${character.repeat(64)}`;
const CANDIDATE = id('c');
const REPO = 'Gentleman-Programming/gentle-ai';

const INTAKE = {
  repository: REPO,
  contributionType: CONTRIBUTION.ISSUE,
  readings: REQUIRED_SOURCES.map((source) => ({
    source, command: `${source} --repo ${REPO}`, result: READING.COMPLETE, matches: 0, reviewed: false, coverage: completeCoverage({ source }),
  })),
  competing: [],
};

const FREEZE = {
  baseTree: 'ab933c1c', candidateTree: '4daf0098',
  pathsDigest: id('1'), draftDigest: id('2'), policyDigest: id('3'), testManifestDigest: id('4'),
  taskContract: TASK_CONTRACT,
  intake: INTAKE,
};

function evidenceFor() {
  return buildEvidence({
    result: {
      gate: 'preflight',
      status: STATUS.PASS,
      binding: { snapshotHash: id('5'), snapshotHashAfter: id('5'), stable: true, policyHash: id('7'), toolVersion: '0.1.0', decisionId: id('9') },
      summary: { pass: 1, fail: 0, unknown: 0, notRun: 0 },
      checks: [{ id: 'a.one', status: STATUS.PASS, required: true, reason: 'ok' }],
    },
    candidate: { status: STATUS.PASS, candidateId: CANDIDATE, reason: 'identified' },
  });
}

const BODY = 'primera linea\nsegunda linea\n';
// What actually crosses to gh: the canonical form the signed hash covers.
const CANONICAL_BODY = normalizeBody(BODY);
const healthReport = (overrides = {}) => ({
  canaryVersion: HEALTH_CANARY_VERSION,
  status: STATUS.PASS,
  durationMs: 3,
  cases: HEALTH_CANARY_SCENARIOS.map((scenario) => ({ scenario, passed: true })),
  ...overrides,
});

test('pre-publication health refuses before publication state is touched', async () => {
  const failedCases = healthReport().cases.map((entry) => (
    entry.scenario === 'timeout' ? { ...entry, passed: false } : entry
  ));
  const failed = await publicationHealthGate({
    runCanary: async () => healthReport({ status: STATUS.FAIL, durationMs: 4, cases: failedCases }),
  });
  assert.deepEqual(failed, {
    ok: false,
    status: STATUS.FAIL,
    failedScenarios: ['timeout'],
    durationMs: 4,
  });

  const healthy = await publicationHealthGate({
    runCanary: async () => healthReport(),
  });
  assert.equal(healthy.ok, true);

  const oneCase = await publicationHealthGate({
    runCanary: async () => healthReport({ cases: [{ scenario: 'pass', passed: true }] }),
  });
  assert.equal(oneCase.ok, false);
  assert.deepEqual(oneCase.failedScenarios, ['canary-contract']);
});

test('pre-publication health requires the exact versioned scenario identity', async () => {
  const base = healthReport();
  const variants = [
    healthReport({ cases: base.cases.slice(1) }),
    healthReport({ cases: [...base.cases.slice(0, -1), base.cases[0]] }),
    healthReport({ cases: [...base.cases.slice(0, -1), { scenario: 'extra', passed: true }] }),
    healthReport({ canaryVersion: '9.9.9' }),
  ];

  for (const report of variants) {
    const outcome = await publicationHealthGate({ runCanary: async () => report });
    assert.equal(outcome.ok, false);
  }
  assert.deepEqual(
    (await publicationHealthGate({ runCanary: async () => variants.at(-1) })).failedScenarios,
    ['canary-version']
  );
});

/** A lineage at PUBLISHABLE with an attempt reserved and a body file on disk. */
function reservedLineage({ operation = 'issue-comment', targetNumber = 3297, title = null, body = BODY, storeOptions = {} } = {}) {
  const { api } = store(storeOptions);
  const lineage = `pub-${sequence += 1}`;
  const frozen = api.freeze({ lineage, candidateId: CANDIDATE, ...FREEZE, draftBodySha256: bodyDigest(body), draftTitleSha256: title === null ? null : bodyDigest(title) });
  api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'PASS') });
  api.recordEvidence({ lineage, evidence: evidenceFor() });
  api.authorize({
    lineage,
    publication: {
      operation, targetRepo: REPO,
      targetNumber: operation === 'issue-comment' ? targetNumber : null,
      bodySha256: bodyDigest(body),
      // issue-create publishes a title and binds its hash.
      titleSha256: operation === 'issue-comment' ? null : bodyDigest(title),
    },
  });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  const { ticket } = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });

  const bodyFile = join(scratch, `body-${sequence}.md`);
  writeFileSync(bodyFile, body);
  let titleFile = null;
  if (title !== null) {
    titleFile = join(scratch, `title-${sequence}.txt`);
    writeFileSync(titleFile, `${title}\n`);
  }
  return { api, lineage, ticket, bodyFile, titleFile };
}

/** A gh stub that records every argv AND the stdin it was handed, answering from a queue. */
function ghStub(...responses) {
  const calls = [];
  const runGh = (argv, { stdin = null } = {}) => {
    calls.push({ argv, stdin });
    return responses.shift() ?? { status: 1, stdout: '', stderr: 'stub exhausted' };
  };
  return { calls, runGh };
}

const neverReached = () => { throw new Error('gh must not be reached'); };

// -- refusals that consume nothing ---------------------------------------------------

test('the publisher refuses an absent ticket, and gh is never reached', () => {
  const { api } = store();
  const lineage = 'no-reservation';
  api.freeze({ lineage, candidateId: CANDIDATE, ...FREEZE, draftBodySha256: bodyDigest(BODY) });

  const result = publishWithTicket({ store: api, lineage, bodyFile: join(scratch, 'irrelevant.md'), runGh: neverReached });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.refusal.failure, 'no-ticket');
  assert.notEqual(result.code, 0);
});

test('the publisher refuses an expired ticket, sweeps it, and consumes nothing', () => {
  const { api, lineage, ticket, bodyFile } = reservedLineage();
  const livePath = join(api.layout.tickets, `${lineage}.json`);
  const { ticketId, issuedAt, expiresAt, ...rest } = ticket;
  replaceCommittedTicket(api, lineage, ticketOf({ ...rest, issuedAt: new Date(Date.now() - TICKET_TTL_MS - 60_000).toISOString() }));

  const result = publishWithTicket({ store: api, lineage, bodyFile, runGh: neverReached });
  assert.equal(result.refusal.failure, 'ticket-expired');
  assert.notEqual(result.code, 0);
  assert.equal(existsSync(livePath), false);
  assert.equal(existsSync(join(api.layout.ticketsExpired, `${lineage}-1.json`)), true);
  assert.deepEqual(api.listAttempts(lineage), [], 'nothing was recorded for a publish that never started');
});

test('REGRESSION: a body that does not hash to the ticket refuses WITHOUT consuming', () => {
  const { api, lineage, ticket, bodyFile } = reservedLineage();
  const wrongFile = join(scratch, `wrong-${sequence}.md`);
  writeFileSync(wrongFile, 'otro contenido\n');

  const result = publishWithTicket({ store: api, lineage, bodyFile: wrongFile, runGh: neverReached });
  assert.equal(result.refusal.failure, 'body-mismatch');
  assert.notEqual(result.code, 0);
  assert.equal(existsSync(join(api.layout.tickets, `${lineage}.json`)), true, 'the ticket is still live');

  // The proof that nothing was spent: the right file still publishes.
  const { calls, runGh } = ghStub(
    { status: 0, stdout: `https://github.com/${REPO}/issues/3297#issuecomment-777\n`, stderr: '' },
    { status: 0, stdout: BODY, stderr: '' },
  );
  const retried = publishWithTicket({ store: api, lineage, bodyFile, runGh });
  assert.equal(retried.code, 0);
  assert.equal(retried.bodyIdentical, true);
  assert.equal(calls.length, 2);
  assert.equal(retried.attempt.detail.ticketId, ticket.ticketId);
});

// -- consume-then-fail is honest accounting -------------------------------------------

test('REGRESSION: a gh failure after consumption records outcome failed and stays non-zero', () => {
  const { api, lineage, bodyFile } = reservedLineage();
  const { calls, runGh } = ghStub({ status: 4, stdout: '', stderr: 'HTTP 502: bad gateway' });

  const result = publishWithTicket({ store: api, lineage, bodyFile, runGh });
  assert.equal(result.outcome, 'failed');
  assert.notEqual(result.code, 0);
  assert.equal(result.recorded, true);
  assert.equal(calls.length, 1, 'no retry: the attempt is spent');
  assert.equal(existsSync(join(api.layout.tickets, `${lineage}.json`)), false, 'the ticket is consumed regardless of the network');
  assert.equal(existsSync(join(api.layout.ticketsConsumed, `${lineage}-1.json`)), true);

  const [attempt] = api.listAttempts(lineage);
  assert.equal(attempt.outcome, 'failed');
  assert.equal(attempt.attemptNumber, 1);
  assert.equal(attempt.detail.exitCode, 4);
  assert.equal(attemptIntact(attempt), true);
});

test('REGRESSION: consume cleanup failure is a warning, so publication proceeds and records the spent attempt', () => {
  const cleanup = () => { throw new Error('injected consume cleanup failure'); };
  const { api, lineage, ticket, bodyFile } = reservedLineage({ storeOptions: { cleanup } });
  const { calls, runGh } = ghStub(
    { status: 0, stdout: `https://github.com/${REPO}/issues/3297#issuecomment-778\n`, stderr: '' },
    { status: 0, stdout: BODY, stderr: '' },
  );

  const result = publishWithTicket({ store: api, lineage, bodyFile, runGh });

  assert.equal(result.code, 0);
  assert.equal(result.outcome, 'published');
  assert.equal(result.recorded, true);
  assert.equal(calls.length, 2, 'cleanup debris does not prevent gh execution or verification');
  assert.deepEqual(result.cleanupWarnings, [{
    failure: 'artifact-cleanup',
    indexPersisted: true,
    message: 'injected consume cleanup failure',
  }]);
  assert.deepEqual(result.attempt.detail.cleanupWarnings, result.cleanupWarnings, 'the durable attempt records the warning');
  assert.equal(api.status(lineage).ticketId, null, 'the authoritative index spent the ticket');
  assert.equal(existsSync(join(api.layout.ticketArtifacts, `${ticket.ticketId.slice('sha256:'.length)}.json`)), true, 'failed cleanup leaves inert debris');
  assert.equal(api.listAttempts(lineage).length, 1, 'the spent attempt is durably recorded');
});

// -- bytes verified are bytes delivered ------------------------------------------------

test('REGRESSION: bytes verified are bytes delivered — swapping the body file after verification publishes the verified buffer, not the swapped file', () => {
  const { api, lineage, bodyFile } = reservedLineage();
  const SWAPPED = 'bytes que nadie autorizo\n';

  const captured = [];
  const runGh = (argv, { stdin = null } = {}) => {
    captured.push({ argv, stdin });
    if (captured.length === 1) {
      // The TOCTOU window: the file changes on disk AFTER the publisher read
      // and verified it, at the exact moment gh runs. Under the old contract
      // gh re-opened the path here and published these bytes unverified --
      // detectar no equivale a impedir.
      writeFileSync(bodyFile, SWAPPED);
      return { status: 0, stdout: `https://github.com/${REPO}/issues/3297#issuecomment-9\n`, stderr: '' };
    }
    return { status: 0, stdout: BODY, stderr: '' };
  };

  const result = publishWithTicket({ store: api, lineage, bodyFile, runGh });
  assert.equal(result.code, 0);
  assert.equal(result.bodyIdentical, true);
  assert.equal(captured[0].stdin, CANONICAL_BODY, 'gh received the ORIGINAL verified canonical content over stdin');
  assert.equal(readFileSync(bodyFile, 'utf8'), SWAPPED, 'the disk really did change mid-publish');
  assert.equal(captured.some((call) => String(call.stdin ?? '').includes('nadie autorizo')), false, 'the swapped content reached no gh call');
  assert.equal(
    captured.every((call) => call.argv.every((token) => !String(token).includes(bodyFile))),
    true,
    'no call carried the path, so there was nothing for gh to re-read'
  );
});

test('REGRESSION: byte-variant files share one hash and deliver one canonical content -- BOM+CRLF+trailing newlines cross as canonical LF', () => {
  const RAW_BODY = '\uFEFFprimera linea\r\nsegunda linea\r\n\n\n';
  const RAW_TITLE = '\uFEFFel titulo exacto\r\n';
  const CANONICAL = 'primera linea\nsegunda linea';
  assert.equal(normalizeBody(RAW_BODY), CANONICAL, 'the fixture really is a byte variant of the canonical content');
  assert.equal(bodyDigest(RAW_BODY), bodyDigest(CANONICAL), 'the variants share one signed hash -- which is exactly why the raw form must never cross');

  const { api, lineage, ticket, bodyFile, titleFile } = reservedLineage({ operation: 'issue-create', title: RAW_TITLE, body: RAW_BODY });
  const { calls, runGh } = ghStub(
    { status: 0, stdout: `https://github.com/${REPO}/issues/3300\n`, stderr: '' },
    // The API echoes CRLF; canonical-to-canonical comparison absorbs it.
    { status: 0, stdout: `${CANONICAL.replace(/\n/g, '\r\n')}\r\n`, stderr: '' },
  );

  const result = publishWithTicket({ store: api, lineage, bodyFile, titleFile, runGh });
  assert.equal(result.code, 0);
  assert.equal(calls[0].stdin, CANONICAL, 'stdin carries the canonical LF form byte-for-byte, never the raw file bytes');
  assert.notEqual(calls[0].stdin, RAW_BODY, 'the raw representation crossed nowhere');
  assert.equal(calls[0].stdin.includes('\uFEFF'), false, 'no BOM on the wire');
  assert.equal(calls[0].stdin.includes('\r'), false, 'no CR on the wire');
  assert.equal(bodyDigest(calls[0].stdin), ticket.bodySha256, 'what crossed is exactly the value the signature covered');
  assert.equal(result.bodyIdentical, true, 'and the read-back canonicalizes to that same value');

  // The title had the same gap to lose and was already canonical-in/
  // canonical-out; this PROVES it instead of asserting it: the file carries
  // BOM+CRLF, the argv carries the canonical text, and the ticket hash is
  // over that same canonical text.
  assert.equal(calls[0].argv.includes('el titulo exacto'), true, 'the title crosses canonical in argv');
  assert.equal(calls[0].argv.includes(RAW_TITLE), false);
  assert.equal(ticket.titleSha256, bodyDigest('el titulo exacto'));
});

test('runProcess hands stdin by value: the whole buffer is written and stdin is closed after', () => {
  // readFileSync(0) returns only at EOF, so an unclosed stdin would hang the
  // child past the runner's patience and an unwritten one would echo nothing.
  const echo = runProcess(
    process.execPath,
    ['-e', 'process.stdout.write(require("fs").readFileSync(0, "utf8"))'],
    { stdin: 'linea uno\nlinea dos\n' }
  );
  assert.equal(echo.status, 0);
  assert.equal(echo.stdout, 'linea uno\nlinea dos\n', 'the child read exactly the buffer, then EOF');
});

// -- the ticket is the command ---------------------------------------------------------

test('an issue comment runs exactly the argv the ticket authorises, and verifies the read-back', () => {
  const { api, lineage, ticket, bodyFile } = reservedLineage();
  const { calls, runGh } = ghStub(
    { status: 0, stdout: `https://github.com/${REPO}/issues/3297#issuecomment-4242\n`, stderr: '' },
    // The API echoes CRLF; normalization is what makes the digests comparable.
    { status: 0, stdout: BODY.replace(/\n/g, '\r\n'), stderr: '' },
  );

  const result = publishWithTicket({ store: api, lineage, bodyFile, runGh });
  assert.deepEqual(calls[0].argv, ['issue', 'comment', '3297', '--repo', REPO, '--body-file', '-']);
  assert.equal(calls[0].stdin, CANONICAL_BODY, 'the canonical content travels by value over stdin');
  assert.equal(calls[0].argv.includes(bodyFile), false, 'no argv carries the path; gh never re-reads it');
  assert.deepEqual(calls[1].argv, ['api', `repos/${REPO}/issues/comments/4242`, '--jq', '.body']);
  assert.equal(result.code, 0);
  assert.equal(result.outcome, 'published');
  assert.equal(result.bodyIdentical, true);
  assert.equal(result.url, `https://github.com/${REPO}/issues/3297#issuecomment-4242`);

  const [attempt] = api.listAttempts(lineage);
  assert.equal(attempt.outcome, 'published');
  assert.equal(attempt.detail.bodyIdentical, true);
  assert.equal(attempt.detail.ticketId, ticket.ticketId);
  assert.equal(attempt.publisher.module, PUBLISHER_MODULE);
  assert.equal(attemptIntact(attempt), true);
});


test('an issue-create verifies the title hash, passes --title, and reads the new issue back', () => {
  const { api, lineage, bodyFile, titleFile } = reservedLineage({ operation: 'issue-create', title: 'el titulo exacto' });
  const { calls, runGh } = ghStub(
    { status: 0, stdout: `https://github.com/${REPO}/issues/3300\n`, stderr: '' },
    { status: 0, stdout: BODY, stderr: '' },
  );

  const result = publishWithTicket({ store: api, lineage, bodyFile, titleFile, runGh });
  assert.deepEqual(calls[0].argv, ['issue', 'create', '--repo', REPO, '--title', 'el titulo exacto', '--body-file', '-']);
  assert.equal(calls[0].stdin, CANONICAL_BODY, 'the canonical content travels by value over stdin');
  assert.equal(calls[0].argv.includes(bodyFile), false, 'no argv carries the path');
  assert.deepEqual(calls[1].argv, ['api', `repos/${REPO}/issues/3300`, '--jq', '.body']);
  assert.equal(result.code, 0);
});

test('REGRESSION: a pre-retirement pr-create ticket fails closed with the retirement reason, consuming nothing', () => {
  const { api, lineage, ticket, bodyFile, titleFile } = reservedLineage({ operation: 'issue-create', title: 'el titulo exacto' });
  // Rewrite the live ticket the way the pre-retirement contract minted a
  // pr-create one. Self-consistent id, so only the retirement refuses it --
  // and the refusal must carry WHY, not a generic enum violation.
  const { ticketId, issuedAt, expiresAt, ...rest } = ticket;
  const preRetirement = ticketOf({ ...rest, operation: 'pr-create', issuedAt });
  replaceCommittedTicket(api, lineage, preRetirement);

  const result = publishWithTicket({ store: api, lineage, bodyFile, titleFile, runGh: neverReached });
  assert.equal(result.refusal.failure, 'operation-unsupported');
  assert.match(result.refusal.message, /cannot be fully bound/);
  assert.match(result.refusal.message, /commits and target branch/);
  assert.match(result.refusal.message, /predates the retirement/);
  assert.equal(existsSync(join(api.layout.tickets, `${lineage}.json`)), true, 'nothing was consumed');
});

test('a legacy issue-create ticket without a title hash fails closed as title-unbound, consuming nothing', () => {
  const { api, lineage, ticket, bodyFile, titleFile } = reservedLineage({ operation: 'issue-create', title: 'el titulo exacto' });
  // Rewrite the live ticket with titleSha256 null, the shape an unbound title
  // once had. Self-consistent, so only the binding rule refuses it.
  const { ticketId, issuedAt, expiresAt, ...rest } = ticket;
  const legacy = ticketOf({ ...rest, titleSha256: null, issuedAt });
  replaceCommittedTicket(api, lineage, legacy);

  const result = publishWithTicket({ store: api, lineage, bodyFile, titleFile, runGh: neverReached });
  assert.equal(result.refusal.failure, 'title-unbound');
  assert.match(result.refusal.message, /re-authorize/);
  assert.equal(existsSync(join(api.layout.tickets, `${lineage}.json`)), true, 'nothing was consumed');
});

test('REGRESSION: an issue-create title mismatch refuses WITHOUT consuming, and the authorized title still publishes', () => {
  const { api, lineage, bodyFile, titleFile } = reservedLineage({ operation: 'issue-create', title: 'el titulo exacto' });
  const wrongTitle = join(scratch, `wrong-title-${sequence}.txt`);
  writeFileSync(wrongTitle, 'otro titulo\n');

  const mismatch = publishWithTicket({ store: api, lineage, bodyFile, titleFile: wrongTitle, runGh: neverReached });
  assert.equal(mismatch.refusal.failure, 'title-mismatch');
  assert.equal(existsSync(join(api.layout.tickets, `${lineage}.json`)), true, 'a swapped title spends nothing');

  // The proof that nothing was consumed: the authorized title still publishes.
  const { calls, runGh } = ghStub(
    { status: 0, stdout: `https://github.com/${REPO}/issues/3300\n`, stderr: '' },
    { status: 0, stdout: BODY, stderr: '' },
  );
  const result = publishWithTicket({ store: api, lineage, bodyFile, titleFile, runGh });
  assert.deepEqual(calls[0].argv, ['issue', 'create', '--repo', REPO, '--title', 'el titulo exacto', '--body-file', '-']);
  assert.equal(result.code, 0);
  assert.equal(result.bodyIdentical, true);
});

// -- a mismatch after publishing is loud, never hidden ---------------------------------

test('REGRESSION: a published body that reads back different is recorded as published with bodyIdentical false, exit non-zero', () => {
  const { api, lineage, bodyFile } = reservedLineage();
  const { runGh } = ghStub(
    { status: 0, stdout: `https://github.com/${REPO}/issues/3297#issuecomment-1\n`, stderr: '' },
    { status: 0, stdout: 'algo que no es el draft\n', stderr: '' },
  );

  const result = publishWithTicket({ store: api, lineage, bodyFile, runGh });
  assert.equal(result.outcome, 'published', 'it DID publish; hiding that would be the lie');
  assert.equal(result.bodyIdentical, false);
  assert.notEqual(result.code, 0);

  const [attempt] = api.listAttempts(lineage);
  assert.equal(attempt.detail.bodyIdentical, false);
  assert.equal(attempt.detail.verification, 'body-mismatch-after-publish');
});

test('a consumed ticket cannot publish twice', () => {
  const { api, lineage, bodyFile } = reservedLineage();
  const { runGh } = ghStub(
    { status: 0, stdout: `https://github.com/${REPO}/issues/3297#issuecomment-1\n`, stderr: '' },
    { status: 0, stdout: BODY, stderr: '' },
  );
  assert.equal(publishWithTicket({ store: api, lineage, bodyFile, runGh }).code, 0);

  const again = publishWithTicket({ store: api, lineage, bodyFile, runGh: neverReached });
  assert.equal(again.refusal.failure, 'no-ticket');
});

// -- command construction is total over the enum ---------------------------------------

test('every supported operation maps to exactly one gh command and one read-back; the retired one throws its reason', () => {
  const base = {
    lineage: 'x', candidateId: CANDIDATE, receiptId: id('a'), evidenceId: id('b'), attemptNumber: 1,
    targetRepo: REPO, bodySha256: id('d'), sessionId: null, issuedAt: new Date().toISOString(),
  };
  const comment = ticketOf({ ...base, operation: 'issue-comment', targetNumber: 7, titleSha256: null });
  const issue = ticketOf({ ...base, operation: 'issue-create', targetNumber: null, titleSha256: id('e') });
  const pr = ticketOf({ ...base, operation: 'pr-create', targetNumber: null, titleSha256: id('e') });

  // Every content byte crosses to gh by value (argv or stdin), never as a
  // path gh re-reads: both supported argvs end in `--body-file -`.
  assert.deepEqual(ghCommandFor(comment, { title: null }), ['issue', 'comment', '7', '--repo', REPO, '--body-file', '-']);
  assert.deepEqual(ghCommandFor(issue, { title: 't' }), ['issue', 'create', '--repo', REPO, '--title', 't', '--body-file', '-']);
  assert.throws(() => ghCommandFor(pr, { title: 't' }), (error) =>
    error.detail?.failure === 'operation-unsupported' && /cannot be fully bound/.test(error.message),
    'pr-create constructs no command; it names the retirement reason');

  assert.equal(verificationFetchFor(pr, `https://github.com/${REPO}/pull/91`), null, 'nothing retired has a read-back');
  assert.equal(verificationFetchFor(comment, 'no url here'), null, 'an unparseable url yields no fetch, never a guessed one');
});
