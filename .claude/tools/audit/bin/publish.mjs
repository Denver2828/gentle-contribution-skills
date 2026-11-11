#!/usr/bin/env node
// The controlled publisher: the only sanctioned path that writes upstream.
//
// It never takes free-form arguments for what to publish. The ticket minted by
// reserve-attempt IS the command: operation, target repository, target number
// and body hash were all fixed when the attempt was reserved, and this process
// refuses anything that does not reproduce them exactly.
//
// The order is the contract:
//   0. run the fast, offline harness-health canary; a broken control plane
//      refuses before the store, ticket or network is touched
//   1. load the lineage's live ticket   (absent, expired or invalid refuses)
//      and, while requireSignedReceipts is on, re-verify the receipt's human
//      signature cryptographically -- a record that says "attached" is not the
//      verification, running the verification is
//   2. read the body file ONCE, canonicalize IMMEDIATELY (BOM stripped, line
//      endings folded to LF, trailing newlines dropped), and verify the hash
//      over that CANONICAL value -- and the title, when bound -- BEFORE
//      consuming, so a wrong file never spends the attempt. One representation
//      flows from there: the signature authorizes the canonical content, that
//      exact value travels to gh over stdin (--body-file -), and the read-back
//      compares canonical to canonical. Neither the path (a second boundary
//      crossing a swapped file could win) nor the raw file bytes (a second
//      representation byte-variant files could exploit) ever cross. Detectar
//      no equivale a impedir
//   3. consume the ticket atomically under the store lock; from here the
//      attempt is spent whatever the network does, which is the honest
//      accounting, by design
//   4. run the exact gh operation the ticket names, handing it the canonical
//      content
//   5. fetch the published body back, compare digests, and record the attempt
//      -- the independent post-publication confirmation, and a mismatch is
//      recorded loudly, never hidden
//
// Exit 0 only when the publish happened AND the read-back matched. Everything
// else is non-zero, including a publish this process could not verify.
//
// The gh execution is injectable so tests can exercise every branch without a
// network; the real runner spawns `gh` and nothing else.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { openStore, StoreError } from '../lib/store/store.mjs';
import { PR_CREATE_UNSUPPORTED_REASON } from '../lib/authorization.mjs';
import { bodyDigest, normalizeBody } from '../lib/ticket.mjs';
import { ATTEMPT_VERSION, OUTCOME } from '../lib/publication.mjs';
import { readEnforcement, signedReceiptsRequired, EnforcementError } from '../lib/enforcement.mjs';
import { digest } from '../lib/canonical.mjs';
import { redact } from '../lib/redact.mjs';
import {
  HEALTH_CANARY_SCENARIOS, HEALTH_CANARY_VERSION, runHarnessHealthCanary,
} from '../lib/harness-health.mjs';
import { STATUS } from '../lib/status.mjs';

/** How every attempt this publisher records names itself. */
export const PUBLISHER_MODULE = '.claude/tools/audit/bin/publish.mjs';

/** Bound excerpt of a failed gh call, redacted before it is stored anywhere. */
const boundedStderr = (text) => redact(String(text ?? '').slice(0, 500));

/**
 * Spawn one process with its stdin handed by value. Argv only -- no shell, so
 * nothing is reinterpreted -- and `input` is what makes the by-value contract
 * real: spawnSync writes the whole buffer to the child's stdin and closes it,
 * so the child reads exactly these bytes and then EOF, never a path.
 */
export function runProcess(command, argv, { stdin = null } = {}) {
  const outcome = spawnSync(command, argv, { encoding: 'utf8', ...(stdin === null ? {} : { input: stdin }) });
  return {
    status: outcome.status ?? 1,
    stdout: outcome.stdout ?? '',
    stderr: outcome.error ? String(outcome.error.message) : (outcome.stderr ?? ''),
  };
}

/** The real gh runner. Same injectable contract the tests double: (argv, {stdin}). */
export const runGhReal = (argv, options = {}) => runProcess('gh', argv, options);

/**
 * Narrow pre-publication health boundary. It reads no lineage and consumes no
 * ticket, so a harness defect cannot spend publication authority.
 */
export async function publicationHealthGate({ runCanary = runHarnessHealthCanary } = {}) {
  try {
    const report = await runCanary();
    const cases = Array.isArray(report?.cases) ? report.cases : null;
    const expected = new Set(HEALTH_CANARY_SCENARIOS);
    const observed = new Set(cases?.map((entry) => entry?.scenario));
    const identityValid = cases !== null
      && cases.length === HEALTH_CANARY_SCENARIOS.length
      && observed.size === HEALTH_CANARY_SCENARIOS.length
      && cases.every((entry) => expected.has(entry?.scenario) && typeof entry?.passed === 'boolean');
    const versionValid = report?.canaryVersion === HEALTH_CANARY_VERSION;
    const failedScenarios = !versionValid
      ? ['canary-version']
      : !identityValid
        ? ['canary-contract']
        : cases.filter((entry) => !entry.passed).map((entry) => entry.scenario);
    if (identityValid && failedScenarios.length === 0 && report.status !== STATUS.PASS) {
      failedScenarios.push('canary-status');
    }
    return {
      ok: versionValid && identityValid && report.status === STATUS.PASS && failedScenarios.length === 0,
      status: report?.status ?? STATUS.FAIL,
      failedScenarios,
      durationMs: report?.durationMs ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      status: STATUS.FAIL,
      failedScenarios: ['canary-exception'],
      durationMs: null,
      error: error?.message ?? String(error),
    };
  }
}

/**
 * The exact gh invocation a ticket authorises. Nothing else is constructible:
 * every value comes from the ticket, except the two verified texts.
 *
 * THE INVARIANT: every content byte crosses to gh by value (argv or stdin),
 * never as a path gh re-reads, and always in its CANONICAL form -- the exact
 * value the signed hash covered. The title travels as --title in argv,
 * already canonicalized; the body travels as `--body-file -`, which gh reads
 * from stdin -- the canonical content this process verified, handed over by
 * runProcess. No argv here carries a filesystem path, so there is no second
 * read for a swapped file to win, and no raw representation for a
 * byte-variant file to smuggle.
 *
 * pr-create is RETIRED, not merely absent from the switch: its argv carried
 * no --base/--head, so gh resolved the head from the CWD's checked-out branch
 * and the base from the repository default -- the proposed commits and target
 * branch sat entirely outside the signed binding.
 */
export function ghCommandFor(ticket, { title }) {
  switch (ticket.operation) {
    case 'issue-comment':
      return ['issue', 'comment', String(ticket.targetNumber), '--repo', ticket.targetRepo, '--body-file', '-'];
    case 'issue-create':
      return ['issue', 'create', '--repo', ticket.targetRepo, '--title', title, '--body-file', '-'];
    case 'pr-create':
      throw new StoreError(PR_CREATE_UNSUPPORTED_REASON, { failure: 'operation-unsupported' });
    default:
      throw new StoreError(`the ticket names an operation this publisher does not run: ${ticket.operation}`, { failure: 'unknown-operation' });
  }
}

/** Where to read the published body back from, given what gh printed. */
export function verificationFetchFor(ticket, url) {
  if (ticket.operation === 'issue-comment') {
    const match = /#issuecomment-(\d+)/.exec(url ?? '');
    return match ? ['api', `repos/${ticket.targetRepo}/issues/comments/${match[1]}`, '--jq', '.body'] : null;
  }
  if (ticket.operation === 'issue-create') {
    const match = /\/issues\/(\d+)/.exec(url ?? '');
    return match ? ['api', `repos/${ticket.targetRepo}/issues/${match[1]}`, '--jq', '.body'] : null;
  }
  // No other operation publishes, so no other operation has a read-back.
  return null;
}

/** The attemptOf idiom from lib/publication.mjs: the id is the digest of the rest. */
function attemptOf({ ticket, outcome, reason, detail }) {
  const record = {
    attemptVersion: ATTEMPT_VERSION,
    attemptNumber: ticket.attemptNumber,
    receiptId: ticket.receiptId,
    evidenceId: ticket.evidenceId,
    candidateId: ticket.candidateId,
    outcome,
    reason,
    detail,
    publisher: { module: PUBLISHER_MODULE },
  };
  return Object.freeze({ ...record, attemptId: digest(record) });
}

/**
 * Publish under a ticket.
 *
 * @param {object}   input.store    an open store
 * @param {string}   input.lineage  whose live ticket to act on
 * @param {string}   input.bodyFile read once, canonicalized, verified; gh receives the canonical content over stdin, never this path
 * @param {string}   [input.titleFile]
 * @param {Function} [input.runGh]  injectable for tests; production uses gh
 * @param {string}   [input.enforcementPath]  injectable for tests; production
 *        reads the shipped declaration
 * @returns {{code: number, outcome: string, refusal?: object, attempt?: object,
 *            url?: string|null, bodyIdentical?: boolean|null, recorded?: boolean, cleanupWarnings?: object[]}}
 */
export function publishWithTicket({ store, lineage, bodyFile, titleFile = null, runGh = runGhReal, enforcementPath }) {
  const refusal = (failure, message, detail = {}) => ({ code: 1, outcome: 'refused', refusal: { failure, message, ...detail } });

  // 0. The lineage itself. A retired lineage is closed from every direction,
  //    and this publisher refuses it BEFORE any ticket file is consulted:
  //    the store's loadTicket refuses too, but a ticket that "somehow exists"
  //    on disk must never be the thing that decides whether a closed lineage
  //    reaches gh. Nothing is consumed.
  let current;
  try {
    current = store.status(lineage);
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    return refusal(error.detail?.failure ?? 'store-refused', error.message, error.detail ?? {});
  }
  if (current.state === 'RETIRED') {
    return refusal(
      'lineage-retired',
      `lineage "${lineage}" is RETIRED (retirement ${current.retirementId}, retired at ${current.retiredAt}); nothing publishes from a retired lineage, and nothing was consumed`,
      { retirementId: current.retirementId, retiredAt: current.retiredAt, supersededBy: current.supersededBy ?? null }
    );
  }

  // 1. The ticket. StoreError already distinguishes absent, expired (swept on
  //    the way), tampered and schema-invalid; none of them consumed anything.
  //
  //    A ticket minted before the pr-create retirement now fails the ticket
  //    schema, which is the right refusal but the wrong explanation: the
  //    holder deserves WHY, not a generic enum violation. So a schema-invalid
  //    live ticket is peeked at -- read-only, consuming nothing -- and one
  //    that names pr-create refuses with the retirement reason instead.
  let ticket;
  try {
    ({ ticket } = store.loadTicket({ lineage }));
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    if (error.detail?.failure === 'invalid-artifact') {
      try {
        const current = store.status(lineage);
        const ticketPath = typeof current.ticketId === 'string'
          ? join(store.layout.ticketArtifacts, `${current.ticketId.slice('sha256:'.length)}.json`)
          : join(store.layout.tickets, `${lineage}.json`);
        const raw = JSON.parse(readFileSync(ticketPath, 'utf8'));
        if (raw?.operation === 'pr-create') {
          return refusal('operation-unsupported', `${PR_CREATE_UNSUPPORTED_REASON} This ticket predates the retirement; nothing was consumed.`);
        }
      } catch { /* the peek is best-effort; the schema refusal below stands */ }
    }
    return refusal(error.detail?.failure ?? 'store-refused', error.message, error.detail ?? {});
  }
  if (ticket.operation === 'pr-create') {
    // Unreachable while the ticket schema excludes it; kept so a future schema
    // slip still fails closed with the reason rather than reaching gh.
    return refusal('operation-unsupported', `${PR_CREATE_UNSUPPORTED_REASON} Nothing was consumed.`);
  }

  // 1a. Publication dependencies, from the ticket's own list: every lineage
  //     this body assumes has already published must have a recorded attempt
  //     with outcome published and bodyIdentical true, and must not be
  //     retired. Checked BEFORE anything is consumed, and again by the store
  //     at consumption. "I left a note on #4078" is refused until it is true.
  try {
    store.dependenciesSatisfied({ lineage, dependsOn: ticket.dependsOn ?? [] });
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    return refusal(error.detail?.failure ?? 'store-refused', `${error.message}; nothing was consumed`, error.detail ?? {});
  }

  // 1b. The signature is re-verified HERE, cryptographically, immediately
  //     before anything is spent -- the store's `signatureAttached` flag is a
  //     record, and records get edited. Verification ALWAYS runs and its state
  //     (valid / absent / invalid) is recorded in the attempt; whether a
  //     non-valid state blocks depends on the live requireSignedReceipts flag,
  //     with distinct refusal codes for absent and invalid. An unreadable
  //     enforcement declaration blocks rather than defaulting open.
  let signatureOutcome;
  try {
    const required = signedReceiptsRequired(readEnforcement(enforcementPath === undefined ? {} : { path: enforcementPath }));
    const { state, failure, reason } = store.signatureState({ lineage });
    signatureOutcome = { required, state, failure, reason };
  } catch (error) {
    if (error instanceof StoreError) return refusal(error.detail?.failure ?? 'store-refused', error.message, error.detail ?? {});
    if (error instanceof EnforcementError) return refusal('enforcement-unreadable', error.message, { cause: error.detail?.failure ?? null });
    throw error;
  }
  if (signatureOutcome.required && signatureOutcome.state !== 'valid') {
    return refusal(
      signatureOutcome.state === 'absent' ? 'signature-absent' : 'signature-invalid',
      `requireSignedReceipts is on and the receipt signature is ${signatureOutcome.state}: ${signatureOutcome.reason}; nothing was consumed`,
      { signatureFailure: signatureOutcome.failure }
    );
  }

  // 2. Read the body ONCE and canonicalize IMMEDIATELY: the raw text dies on
  //    that line. One representation flows from here -- hash, stdin and the
  //    read-back comparison all see `canonicalBody` -- because hashing one
  //    form and sending another is how byte-variant files (CRLF vs LF, BOM vs
  //    none, one vs many trailing newlines) share a signed hash while putting
  //    different bytes on the wire. The signature authorizes the CANONICAL
  //    content, and exactly that value crosses. bodyDigest normalizes again
  //    internally, which changes nothing: normalizeBody is idempotent, and a
  //    test pins that. The path is dead too, so no later change to the file
  //    can put a byte on the wire this digest did not cover. Verify BEFORE
  //    consuming: a wrong file must not burn the attempt.
  if (!existsSync(bodyFile)) return refusal('body-unreadable', `the body file does not exist: ${bodyFile}`);
  const canonicalBody = normalizeBody(readFileSync(bodyFile, 'utf8'));
  const observedBody = bodyDigest(canonicalBody);
  if (observedBody !== ticket.bodySha256) {
    return refusal('body-mismatch', 'the body file does not hash to what the ticket binds; nothing was consumed', {
      expected: ticket.bodySha256, observed: observedBody,
    });
  }

  let title = null;
  if (ticket.operation !== 'issue-comment') {
    if (titleFile === null || !existsSync(titleFile)) {
      return refusal('missing-title', `${ticket.operation} needs --title-file; nothing was consumed`);
    }
    // A titled operation without a title hash predates the closed binding and
    // fails closed -- a title nothing verifies is a title anyone could have
    // swapped.
    if (ticket.titleSha256 === null) {
      return refusal('title-unbound', `the ticket carries no titleSha256 for ${ticket.operation}; re-authorize under the current binding rules; nothing was consumed`);
    }
    title = normalizeBody(readFileSync(titleFile, 'utf8'));
    if (bodyDigest(title) !== ticket.titleSha256) {
      return refusal('title-mismatch', 'the title file does not hash to what the ticket binds; nothing was consumed', {
        expected: ticket.titleSha256, observed: bodyDigest(title),
      });
    }
  }

  // 3. Spend the ticket. Everything after this line is accounted for. Cleanup
  //    happens after the authoritative index commit; failures there are warning
  //    evidence, never a claim that the already-committed spend failed.
  let cleanupWarnings = [];
  try {
    const consumption = store.consumeTicket({ lineage, ticketId: ticket.ticketId });
    cleanupWarnings = consumption.cleanupWarnings ?? [];
  } catch (error) {
    if (error instanceof StoreError) return refusal(error.detail?.failure ?? 'store-refused', error.message, error.detail ?? {});
    throw error;
  }

  const cleanupEvidence = cleanupWarnings.length === 0 ? {} : { cleanupWarnings };

  const record = (attempt) => {
    try {
      store.recordAttempt({ lineage, attempt });
      return true;
    } catch (error) {
      if (error instanceof StoreError) return false;
      throw error;
    }
  };

  // 4. The one operation the ticket names, fed the canonical content itself:
  //    the value the hash covered is the value delivered.
  const executed = runGh(ghCommandFor(ticket, { title }), { stdin: canonicalBody });
  if (executed.status !== 0) {
    const attempt = attemptOf({
      ticket,
      outcome: OUTCOME.FAILED,
      reason: `gh exited ${executed.status}; the ticket is consumed and the attempt is spent`,
      detail: {
        ticketId: ticket.ticketId, operation: ticket.operation, targetRepo: ticket.targetRepo,
        targetNumber: ticket.targetNumber, url: null, bodyIdentical: null,
        signature: { required: signatureOutcome.required, state: signatureOutcome.state, failure: signatureOutcome.failure },
        ...cleanupEvidence,
        failure: 'gh-failed', exitCode: executed.status, stderr: boundedStderr(executed.stderr),
      },
    });
    return { code: 1, outcome: OUTCOME.FAILED, attempt, recorded: record(attempt), url: null, bodyIdentical: null, ...cleanupEvidence };
  }

  // 5. Read back what actually landed. A publish this process cannot verify is
  //    still a publish -- recorded as one, and exited non-zero.
  const url = (executed.stdout.match(/https:\/\/\S+/g) ?? []).pop() ?? null;
  let bodyIdentical = null;
  let verification = 'unverified';
  const fetchArgv = verificationFetchFor(ticket, url);
  if (fetchArgv === null) {
    verification = 'no-url';
  } else {
    const fetched = runGh(fetchArgv);
    if (fetched.status !== 0) {
      verification = 'unfetchable';
    } else {
      bodyIdentical = bodyDigest(fetched.stdout) === ticket.bodySha256;
      verification = bodyIdentical ? 'body-identical' : 'body-mismatch-after-publish';
    }
  }

  const attempt = attemptOf({
    ticket,
    outcome: OUTCOME.PUBLISHED,
    reason: bodyIdentical === true
      ? `published and verified: the fetched body reproduces ${ticket.bodySha256}`
      : `published, and the read-back did NOT confirm the bytes (${verification})`,
    detail: {
      ticketId: ticket.ticketId, operation: ticket.operation, targetRepo: ticket.targetRepo,
      targetNumber: ticket.targetNumber, url, bodyIdentical, verification,
      signature: { required: signatureOutcome.required, state: signatureOutcome.state, failure: signatureOutcome.failure },
      ...cleanupEvidence,
    },
  });
  return { code: bodyIdentical === true ? 0 : 1, outcome: OUTCOME.PUBLISHED, attempt, recorded: record(attempt), url, bodyIdentical, ...cleanupEvidence };
}

// -- process boundary -------------------------------------------------------------
//
// The module is importable so tests can drive every branch with a stubbed gh;
// only a direct invocation reads argv and touches the real store and network.

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();

if (invokedDirectly) {
  const args = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    if (!process.argv[index].startsWith('--')) continue;
    const next = process.argv[index + 1];
    args[process.argv[index].slice(2)] = next && !next.startsWith('--') ? next : 'true';
  }

  if (!args.lineage || args.lineage === 'true' || !args['body-file'] || args['body-file'] === 'true') {
    process.stderr.write('usage: publish.mjs --lineage <lineage> --body-file <file> [--title-file <file>]\n');
    process.stderr.write('Everything else -- operation, repository, target -- comes from the lineage ticket, never from arguments.\n');
    process.exit(3);
  }

  const health = await publicationHealthGate();
  if (!health.ok) {
    const result = {
      code: 1,
      outcome: 'refused',
      refusal: {
        failure: 'harness-health-failed',
        message: `the harness health canary failed (${health.failedScenarios.join(', ') || 'unknown scenario'}); no store, ticket or network operation was attempted`,
        health,
      },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`REFUSED: ${result.refusal.message}\n`);
    process.exit(1);
  }

  let result;
  try {
    result = publishWithTicket({
      store: openStore(),
      lineage: args.lineage,
      bodyFile: args['body-file'],
      titleFile: args['title-file'] && args['title-file'] !== 'true' ? args['title-file'] : null,
    });
  } catch (error) {
    process.stderr.write(`REFUSED: ${error.message}\n`);
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.outcome === 'refused') {
    process.stderr.write(`REFUSED: ${result.refusal.message}\n`);
  } else {
    process.stderr.write(`outcome: ${result.outcome}\n`);
    process.stderr.write(`url: ${result.url ?? '(none reported)'}\n`);
    process.stderr.write(`read-back verification: ${result.attempt.detail.verification ?? 'n/a'} (bodyIdentical: ${String(result.bodyIdentical)})\n`);
    if (result.recorded === false) {
      process.stderr.write('WARNING: the store refused to record this attempt; the JSON above is the only record. Keep it.\n');
    }
  }
  process.exit(result.code);
}
