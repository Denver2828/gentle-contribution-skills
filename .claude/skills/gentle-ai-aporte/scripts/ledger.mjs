#!/usr/bin/env node
// Contribution ledger. Records the candidate state machine, the correction
// budget, and the three artifacts of a decision: evidence, authorization and
// publication attempts.
//
// SCOPE: this is declared evidence, not authority. It refuses the transitions
// it is asked to make, which is what stops the second correction from being
// taken by accident or convenience. It cannot stop anyone from editing the
// store, from reaching a state it would never grant, or from publishing
// without ever calling it. There is NO CRYPTOGRAPHIC SIGNATURE here and no
// issuer identity: anyone able to write into the store can write a consistent
// receipt. The authority is whoever decides to believe it.
//
// WHERE THE STORE LIVES: derived from this file's own location, never from the
// working directory. Resolving from cwd is exactly how an earlier version of
// this ledger ended up inside the upstream clone, one `git add -A` away from
// being published in someone else's pull request.
//
// The controller calls this; the author and the auditor never do.
//
// Usage:
//   ledger.mjs freeze            --lineage L --candidate-id sha256:... --base-tree T --candidate-tree T --paths F --draft F [--title-file F] --policy F --test-manifest F --task-contract F --intake F
//   ledger.mjs record-audit      --lineage L --result auditor-result.json
//   ledger.mjs reserve-correction --lineage L
//   ledger.mjs refreeze          --lineage L --candidate-id sha256:... --base-tree T --candidate-tree T --paths F --draft F [--title-file F] --policy F --test-manifest F --task-contract F --intake F
//   ledger.mjs intake            --intake F
//   ledger.mjs record-evidence   --lineage L --evidence F
//   ledger.mjs authorize         --lineage L --operation issue-create|issue-comment
//                                --target-repo owner/name [--target-number N] --body-file F
//                                [--title-file F: required for issue-create] [--artifacts F]
//                                [--depends-on L2[,L3...]: lineages that must have published first;
//                                 bound in the receipt and the ticket, enforced at gate-publish,
//                                 reserve-attempt and by the publisher]
//                                (pr-create is retired: it cannot be fully bound under the current contract)
//   ledger.mjs attach-signature  --lineage L
//   ledger.mjs gate-publish      --lineage L --current-candidate-id sha256:...
//   ledger.mjs reserve-attempt   --lineage L --current-candidate-id sha256:...
//   ledger.mjs record-attempt    --lineage L --attempt F
//   ledger.mjs retire            --lineage L --reason-file F [--superseded-by L2]
//                                (closes the lineage: RETIRED is terminal, the receipt is archived,
//                                 a live ticket refuses; the reason comes from a file, never argv)
//   ledger.mjs migrate           --legacy F
//   ledger.mjs status            --lineage L
//   ledger.mjs decision-package  --lineage L [--format text]
//                                (read-only: per acceptance condition, claim -> check -> result -> limit,
//                                 from the lineage's verified durable artifacts; a result older than
//                                 auditor-result/v4 reports check and limit as not recorded)
//   ledger.mjs subject-id       --base-tree T --candidate-tree T --paths F --draft F [--title-file F] --policy F --test-manifest F --task-contract F

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts -> gentle-ai-aporte -> skills -> .claude -> <workspace>
const WORKSPACE = resolve(HERE, '..', '..', '..', '..');
const STORE_MODULE = resolve(WORKSPACE, '.claude', 'tools', 'audit', 'lib', 'store', 'store.mjs');
const INTAKE_MODULE = resolve(WORKSPACE, '.claude', 'tools', 'audit', 'lib', 'intake.mjs');
const TICKET_MODULE = resolve(WORKSPACE, '.claude', 'tools', 'audit', 'lib', 'ticket.mjs');
const TASK_CONTRACT_MODULE = resolve(WORKSPACE, '.claude', 'tools', 'audit', 'lib', 'task-contract.mjs');

const AUTHORIZATION_MODULE = resolve(WORKSPACE, '.claude', 'tools', 'audit', 'lib', 'authorization.mjs');
const TEST_CLAIM_MODULE = resolve(WORKSPACE, '.claude', 'tools', 'audit', 'bin', 'verify-test-claim.mjs');

const { openStore, StoreError, deriveSubjectId } = await import(`file:///${STORE_MODULE.replaceAll('\\', '/')}`);
const { evaluateIntake, intakeSatisfied } = await import(`file:///${INTAKE_MODULE.replaceAll('\\', '/')}`);
const { bodyDigest } = await import(`file:///${TICKET_MODULE.replaceAll('\\', '/')}`);
const { admitTaskContract } = await import(`file:///${TASK_CONTRACT_MODULE.replaceAll('\\', '/')}`);
const { PR_CREATE_UNSUPPORTED_REASON } = await import(`file:///${AUTHORIZATION_MODULE.replaceAll('\\', '/')}`);
const { parseTestEvents, countResults, judgeClaim } = await import(`file:///${TEST_CLAIM_MODULE.replaceAll('\\', '/')}`);
const { renderAcceptanceTrace, terminalJson, inline } = await import(`file:///${resolve(WORKSPACE, '.claude', 'tools', 'audit', 'lib', 'decision-package.mjs').replaceAll('\\', '/')}`);

// Everything this script prints may carry text taken from an artifact, and it
// is printed to a terminal. Controls, bidirectional marks and hidden-text
// characters are shown, never sent: as visible marks in plain text, and as
// JSON escapes in JSON, which still parses back to the recorded data.
const safeLines = (value) => String(value).split('\n').map(inline).join('\n');

function die(message, detail) {
  process.stderr.write(`REFUSED: ${safeLines(message)}\n`);
  if (detail) process.stderr.write(`${safeLines(detail)}\n`);
  process.exit(1);
}

function args(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const next = argv[index + 1];
    out[argv[index].slice(2)] = next && !next.startsWith('--') ? next : 'true';
  }
  return out;
}

function digestFile(path, label) {
  if (!path || path === 'true') die(`missing --${label}`);
  if (!existsSync(path)) die(`${label} file does not exist`, path);
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function readText(path, label) {
  if (!path || path === 'true') die(`missing --${label}`);
  if (!existsSync(path)) die(`${label} file does not exist`, path);
  return readFileSync(path, 'utf8');
}

function readJson(path, label) {
  if (!path || path === 'true') die(`missing --${label}`);
  if (!existsSync(path)) die(`${label} file does not exist`, path);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    die(`${label} is not readable JSON`, error.message);
  }
}

// Public edition: private incident history omitted. See the operational contract.
function parseStructured(path, label) {
  const bytes = readText(path, label);
  try {
    return JSON.parse(bytes);
  } catch (error) {
    die(
      `${label} is not valid JSON, so nothing can read it back`,
      `${path}\n${error.message}\n\n`
      + `The freeze would hash these bytes happily and the candidate identity would be sound, `
      + `which is exactly why this has to refuse here: the defect otherwise surfaces rounds later, `
      + `after the record it damages has already been audited. Fix the file, not the digest.`
    );
  }
  return undefined;
}

function structuredDigest(path, label) {
  parseStructured(path, label);
  return digestFile(path, label);
}

// Public edition: private incident history omitted. See the operational contract.
const CLAIM_FIELDS = ['subtests', 'skip', 'fail', 'stream'];

function claimIn(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  if (Object.hasOwn(manifest, 'testClaim')) return { claim: manifest.testClaim, where: 'testClaim' };
  if (CLAIM_FIELDS.some((field) => Object.hasOwn(manifest, field))) return { claim: manifest, where: 'the manifest root' };
  return null;
}

function testManifestDigest(path, label) {
  const manifest = parseStructured(path, label);
  const found = claimIn(manifest);

  if (found !== null) {
    const { claim, where } = found;
    const refuse = (reason, detail = '') => die(
      `${label} declares a test claim at ${where} that this freeze cannot verify: ${reason}`,
      `${path}\n${detail}\n`
      + `A manifest is the artifact an auditor is handed and asked to falsify. Declaring counts `
      + `it cannot prove makes it the opposite. Either name the stream the counts came from and `
      + `correct them, or state no counts at all.`
    );

    if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) {
      refuse('the claim is not an object');
    }
    for (const field of ['subtests', 'skip']) {
      if (!Number.isInteger(claim[field]) || claim[field] < 0) {
        refuse(`"${field}" must be a non-negative integer, received ${JSON.stringify(claim[field])}`);
      }
    }
    if (Object.hasOwn(claim, 'fail') && (!Number.isInteger(claim.fail) || claim.fail < 0)) {
      refuse(`"fail" must be a non-negative integer, received ${JSON.stringify(claim.fail)}`);
    }
    if (typeof claim.stream !== 'string' || claim.stream.trim() === '') {
      refuse('it names no `go test -json` stream, so the counts rest on nobody having checked');
    }

    // Against the manifest's own directory, never cwd: resolving from the
    // working directory is how this ledger once ended up inside the upstream
    // clone. A record has to mean the same thing wherever it is read from.
    const streamPath = resolve(dirname(resolve(path)), claim.stream);
    if (!existsSync(streamPath)) {
      refuse(`the named stream does not exist`, `stream: ${claim.stream}\nresolved: ${streamPath}`);
    }

    let raw;
    try {
      raw = readFileSync(streamPath, 'utf8');
    } catch (error) {
      refuse(`the named stream could not be read: ${error.message}`, `resolved: ${streamPath}`);
    }

    const verdict = judgeClaim(countResults(parseTestEvents(raw)), claim);
    if (verdict.decision !== 'admit') {
      refuse(
        `the stream refutes it`,
        `resolved: ${streamPath}\n${verdict.reasons.map((reason) => `  - ${reason}`).join('\n')}`
      );
    }
  }

  return digestFile(path, label);
}

const freezeInput = (a) => ({
  baseTree: a['base-tree'],
  candidateTree: a['candidate-tree'],
  pathsDigest: structuredDigest(a.paths, 'paths'),
  // The draft is the bytes to be published -- markdown, a comment, an issue
  // body. It is never parsed and must never be constrained to a format.
  draftDigest: digestFile(a.draft, 'draft'),
  // The SAME file, hashed the way `authorize` hashes --body-file and the
  // publisher hashes what it sends: after normalization. The store keeps it
  // beside subject_id and refuses an authorization whose body is not this
  // draft. Until this existed, --draft and --body-file were two unrelated
  // reads, and a body nobody audited could be authorized under the audit of
  // the draft (ASTRA-02).
  draftBodySha256: bodyDigest(readText(a.draft, 'draft')),
  draftTitleSha256: a['title-file'] === undefined ? null : bodyDigest(readText(a['title-file'], 'title-file')),
  policyDigest: structuredDigest(a.policy, 'policy'),
  testManifestDigest: testManifestDigest(a['test-manifest'], 'test-manifest'),
  taskContract: readJson(a['task-contract'], 'task-contract'),
});

// The identity never includes draftBodySha256: a normalized digest inside
// subject_id would move every identity ever minted.
const subjectInput = ({ taskContract, draftBodySha256, ...input }) => ({
  ...input,
  taskContractDigest: admitTaskContract(taskContract).taskContractDigest,
});

const emit = (value) => process.stdout.write(terminalJson(value));

const [, , operation, ...rest] = process.argv;
const a = args(rest);
const store = operation === 'subject-id' ? null : openStore();

try {
  switch (operation) {
    case 'freeze':
      emit(store.freeze({
        lineage: a.lineage,
        candidateId: a['candidate-id'],
        intake: readJson(a.intake, 'intake'),
        ...freezeInput(a),
      }));
      break;

    case 'record-audit':
      emit(store.recordAudit({ lineage: a.lineage, result: readJson(a.result, 'result') }));
      break;

    case 'reserve-correction':
      emit(store.reserveCorrection({ lineage: a.lineage }));
      break;

    case 'refreeze':
      emit(store.refreeze({
        lineage: a.lineage,
        candidateId: a['candidate-id'],
        intake: readJson(a.intake, 'intake'),
        ...freezeInput(a),
      }));
      break;

    case 'intake': {
      // Reports the intake verdict and touches no lineage: it is how the
      // controller learns the readings are insufficient BEFORE a freeze
      // refuses. Exit 1 on anything that is not PASS.
      const record = readJson(a.intake, 'intake');
      emit(evaluateIntake(record));
      process.exit(intakeSatisfied(record) ? 0 : 1);
      break;
    }

    case 'record-evidence':
      emit(store.recordEvidence({ lineage: a.lineage, evidence: readJson(a.evidence, 'evidence') }));
      break;

    case 'authorize': {
      // The publication binding now lives in the RECEIPT, computed here from
      // the exact files with the same normalization the publisher applies to
      // the body it fetches back after publishing. An authorization without a
      // complete binding is refused by the store: a receipt that does not say
      // what it authorizes publishing is a blank check.
      // pr-create is refused at parse, with the reason, before the store is
      // touched: the retirement is a contract statement, not a missing enum.
      if (a.operation === 'pr-create') die(PR_CREATE_UNSUPPORTED_REASON);
      const titleText = a['title-file'] && a['title-file'] !== 'true' ? readText(a['title-file'], 'title-file') : null;
      if (a.operation === 'issue-create' && titleText === null) {
        die('--title-file is required: issue-create publishes a title, and its hash is part of the binding; issue-comment publishes without one');
      }
      // Publication dependencies: comma-separated lineage names. The store
      // refuses unknown, self, duplicate, closed and cyclic ones before the
      // receipt exists; satisfaction is enforced at every forward step.
      const dependsOn = a['depends-on'] && a['depends-on'] !== 'true'
        ? a['depends-on'].split(',').map((name) => name.trim()).filter((name) => name !== '')
        : [];
      if (a['depends-on'] === 'true' || (a['depends-on'] && dependsOn.length === 0)) {
        die('--depends-on needs at least one lineage name (comma-separated)');
      }
      const outcome = store.authorize({
        lineage: a.lineage,
        artifacts: a.artifacts && a.artifacts !== 'true' ? readJson(a.artifacts, 'artifacts') : [],
        publication: {
          operation: a.operation,
          targetRepo: a['target-repo'],
          targetNumber: a['target-number'] && a['target-number'] !== 'true' ? Number(a['target-number']) : null,
          bodySha256: bodyDigest(readText(a['body-file'], 'body-file')),
          titleSha256: titleText === null ? null : bodyDigest(titleText),
          dependsOn,
        },
      });
      emit({
        ...outcome,
        note: 'Two-phase authorization: the receipt exists and is UNSIGNED. The signer below is run BY THE HUMAN in their own terminal, never through an agent -- the passphrase must never pass through any agent tool.',
      });
      process.stderr.write(`next (human, own terminal): node .claude/tools/audit/bin/sign-receipt.mjs --lineage ${a.lineage}\n`);
      process.stderr.write(`then: node .claude/skills/gentle-ai-aporte/scripts/ledger.mjs attach-signature --lineage ${a.lineage}\n`);
      break;
    }

    case 'attach-signature':
      // Loads the signature the human signer produced for this lineage's
      // receipt, verifies it against the anchored public key, and records the
      // attachment. Any mismatch refuses and records nothing.
      emit(store.attachSignature({ lineage: a.lineage }));
      break;

    case 'gate-publish':
      emit({
        ...store.gatePublish({ lineage: a.lineage, currentCandidateId: a['current-candidate-id'] }),
        note: 'PUBLISHABLE is informative, not a durable permission. Every attempt revalidates the receipt and the candidate before a publisher is reached, and human approval is still required for these exact bytes.',
      });
      break;

    case 'reserve-attempt':
      // No binding arguments: the ticket is DERIVED from the receipt's
      // publication binding, field for field. Letting the reserver restate
      // the target would be letting the reserver change it; publishing to a
      // different target is a new authorization, never a new reservation.
      emit({
        ...store.reserveAttempt({
          lineage: a.lineage,
          currentCandidateId: a['current-candidate-id'],
        }),
        note: 'PUBLISHABLE is informative, not a durable permission. The ticket above was derived from the receipt\'s publication binding, is one-shot and expires; publish through .claude/tools/audit/bin/publish.mjs, which consumes it, runs the exact operation it names, and records the attempt. Human approval of these exact bytes is still required.',
      });
      break;

    case 'record-attempt':
      emit(store.recordAttempt({ lineage: a.lineage, attempt: readJson(a.attempt, 'attempt') }));
      break;

    case 'retire': {
      // The reason is read from a file, never from argv: argv is shell
      // history and process listings, and a retirement reason is a record.
      // Both refusals below happen before the store is touched.
      const reason = readText(a['reason-file'], 'reason-file');
      if (reason.replace(/^\uFEFF+/, '').trim() === '') {
        die('--reason-file is empty: a retirement without a reason is not a record', a['reason-file']);
      }
      const supersededBy = a['superseded-by'] && a['superseded-by'] !== 'true' ? a['superseded-by'] : null;
      emit({
        ...store.retire({ lineage: a.lineage, reason, supersededBy }),
        note: 'RETIRED is terminal. The receipt this lineage held is archived under authorizations/superseded/ and is no longer spendable; every forward path refuses the lineage from here. Attempts already recorded are untouched.',
      });
      break;
    }

    case 'migrate':
      emit(store.migrate({ legacyPath: a.legacy }));
      break;

    case 'status':
      emit(store.status(a.lineage));
      break;

    case 'decision-package': {
      // Read-only. The trace is projected from the persisted auditor result
      // and task contract after the store verified them; nothing is assessed
      // here and no missing field is filled. It shows what the auditor
      // recorded, which is not the same as showing that it is true.
      const trace = store.acceptanceTrace(a.lineage);
      if (a.format === 'text') process.stdout.write(renderAcceptanceTrace(trace));
      else if (a.format === undefined || a.format === 'json') emit(trace);
      else die('--format must be json (default) or text');
      break;
    }

    case 'subject-id': {
      // Kept for continuity with the previous interface: it computes the
      // identity without touching the store.
      const input = subjectInput(freezeInput(a));
      process.stdout.write(`${deriveSubjectId(input)}\n`);
      break;
    }

    default:
      process.stderr.write('unknown operation. See the header of this file.\n');
      process.exit(2);
  }
} catch (error) {
  if (error instanceof StoreError) die(error.message, terminalJson(error.detail).trimEnd());
  die(error.message);
}
