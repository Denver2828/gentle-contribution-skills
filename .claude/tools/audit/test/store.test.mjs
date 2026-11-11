// The store: binding, locking, atomicity, migration, idempotence.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore, StoreError, STORE_VERSION, NO_SIGNATURE_WARNING } from '../lib/store/store.mjs';
import { acquire, release, withLock, LockError } from '../lib/store/lock.mjs';
import { writeAtomic, sweepTemporaries } from '../lib/store/atomic.mjs';
import { resolveStoreRoot, withinStore, assertContentId, assertLineageName, UnsafeIdentifierError, StoreLocationError, WORKSPACE_ROOT } from '../lib/store/paths.mjs';
import { buildEvidence } from '../lib/evidence-record.mjs';
import { REQUIRED_SOURCES, READING, CONTRIBUTION } from '../lib/intake.mjs';
import { STATUS } from '../lib/status.mjs';
import { digest } from '../lib/canonical.mjs';
import { completeCoverage, auditorResult, auditorResultV2, historicalAuditorResult, TASK_CONTRACT } from './helpers/documents.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'audit-store-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;
const newRoot = () => mkdtempSync(join(scratch, 'store-'));
const store = (root = newRoot()) => ({ root, api: openStore({ override: root, allowOutsideWorkspace: true, lockOptions: { waitMs: 4000 } }) });

const id = (character) => `sha256:${character.repeat(64)}`;
const CANDIDATE = id('c');

/** A satisfied intake: all three readings complete, nothing competing. */
const INTAKE = {
  repository: 'Gentleman-Programming/gentle-ai',
  contributionType: CONTRIBUTION.ISSUE,
  readings: REQUIRED_SOURCES.map((source) => ({
    source, command: `${source} --repo Gentleman-Programming/gentle-ai`, result: READING.COMPLETE, matches: 0, reviewed: false, coverage: completeCoverage({ source }),
  })),
  competing: [],
};

const FREEZE = {
  baseTree: 'ab933c1c', candidateTree: '4daf0098',
  pathsDigest: id('1'), draftDigest: id('2'), policyDigest: id('3'), testManifestDigest: id('4'),
  // The normalized draft digest authorize binds the body to: BINDING below publishes it.
  draftBodySha256: id('b'),
  taskContract: TASK_CONTRACT,
  intake: INTAKE,
};

function evidenceFor({ candidateId = CANDIDATE, gateStatus = STATUS.PASS, decisionId = id('9'), snapshotHash = id('5'), checks } = {}) {
  return buildEvidence({
    result: {
      gate: 'preflight',
      status: gateStatus,
      binding: { snapshotHash, snapshotHashAfter: snapshotHash, stable: true, policyHash: id('7'), toolVersion: '0.1.0', decisionId },
      summary: { pass: 1, fail: 0, unknown: 0, notRun: 0 },
      checks: checks ?? [{ id: 'a.one', status: STATUS.PASS, required: true, reason: 'ok' }],
    },
    candidate: { status: candidateId === null ? STATUS.UNKNOWN : STATUS.PASS, candidateId, reason: 'identified' },
  });
}

/** The publication binding reserve-attempt requires since tickets exist. */
const BINDING = { operation: 'issue-comment', targetRepo: 'Gentleman-Programming/gentle-ai', targetNumber: 42, bodySha256: id('b') };

/** An attempt built the way lib/publication.mjs builds one: the id is the digest of the rest. */
function attemptFor({ attemptNumber, receiptId, evidenceId, outcome = 'published' }) {
  const record = {
    attemptVersion: '1.0.0', attemptNumber, receiptId, evidenceId, candidateId: CANDIDATE,
    outcome, reason: `attempt ${attemptNumber}`, detail: {}, publisher: { module: 'fake' },
  };
  return { ...record, attemptId: digest(record) };
}

/** A lineage frozen, audited PASS, with evidence recorded. */
function readyLineage(api, lineage = `pr-${sequence += 1}`, options = {}) {
  const frozen = api.freeze({ lineage, candidateId: options.candidateId ?? CANDIDATE, ...FREEZE });
  api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'PASS') });
  const evidence = options.evidence ?? evidenceFor({ candidateId: options.candidateId ?? CANDIDATE });
  api.recordEvidence({ lineage, evidence });
  return { lineage, evidence, frozen };
}

// -- location and path safety -----------------------------------------------------

test('the store is anchored to the workspace, not to the working directory', () => {
  assert.equal(resolveStoreRoot(), join(WORKSPACE_ROOT, '.claude', 'state', 'audit'));
  assert.equal(resolveStoreRoot().startsWith(WORKSPACE_ROOT), true);
});

test('a store outside the workspace is refused unless a test explicitly allows it', () => {
  const outside = mkdtempSync(join(tmpdir(), 'elsewhere-'));
  try {
    assert.throws(() => resolveStoreRoot({ override: outside }), StoreLocationError);
    assert.equal(resolveStoreRoot({ override: outside, allowOutsideWorkspace: true }), outside);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('REGRESSION: no external value can become a traversing path', () => {
  for (const bad of ['..', '../escape', 'a/b', 'a\\b', '/abs', 'C:/abs', '', '.']) {
    assert.throws(() => assertLineageName(bad), UnsafeIdentifierError, `lineage ${JSON.stringify(bad)}`);
    assert.throws(() => withinStore(scratch, bad), UnsafeIdentifierError, `segment ${JSON.stringify(bad)}`);
  }
  for (const value of ['not-a-hash', 'sha256:zz', `sha1:${'a'.repeat(40)}`, `sha256:${'a'.repeat(63)}`, `sha256:${'A'.repeat(64)}`]) {
    assert.throws(() => assertContentId(value), UnsafeIdentifierError, `content id ${JSON.stringify(value)}`);
  }
  assert.equal(assertContentId(CANDIDATE), 'c'.repeat(64));
});

// -- atomicity ----------------------------------------------------------------------

test('an atomic write replaces the file and leaves no temporary behind', () => {
  const directory = newRoot();
  const target = join(directory, 'thing.json');

  writeAtomic(target, '{"v":1}\n');
  writeAtomic(target, '{"v":2}\n');

  assert.equal(readFileSync(target, 'utf8'), '{"v":2}\n');
  assert.deepEqual(readdirSync(directory), ['thing.json']);
});

test('interrupted temporaries are swept, and only temporaries', () => {
  const directory = newRoot();
  writeFileSync(join(directory, 'store.json'), '{}');
  writeFileSync(join(directory, 'store.json.tmp-999-abcdef'), 'partial');

  const swept = sweepTemporaries(directory);
  assert.deepEqual(swept, ['store.json.tmp-999-abcdef']);
  assert.deepEqual(readdirSync(directory), ['store.json']);
});

// -- the lock ------------------------------------------------------------------------

test('the lock carries a pid, a timestamp and a nonce', () => {
  const directory = newRoot();
  const path = join(directory, 'store.lock');
  const handle = acquire(path);

  try {
    const held = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(held.pid, process.pid);
    assert.match(held.nonce, /^[0-9a-f]{32}$/);
    assert.match(held.acquiredAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(held.nonce, handle.nonce);
  } finally {
    release(handle);
  }
  assert.equal(existsSync(path), false);
});

test('REGRESSION: only the nonce holder may release the lock', () => {
  const path = join(newRoot(), 'store.lock');
  const handle = acquire(path);

  try {
    assert.throws(() => release({ path, nonce: 'f'.repeat(32) }), (error) =>
      error instanceof LockError && error.detail.failure === 'not-owner');
  } finally {
    release(handle);
  }
});

test('REGRESSION: a live lock is not stolen, and the waiter times out saying who holds it', () => {
  const path = join(newRoot(), 'store.lock');
  const handle = acquire(path);

  try {
    assert.throws(() => acquire(path, { waitMs: 200, staleMs: 0 }), (error) =>
      error instanceof LockError && error.detail.failure === 'timeout' && error.detail.holder.pid === process.pid);
  } finally {
    release(handle);
  }
});

test('REGRESSION: an orphaned lock is quarantined, never unlinked blindly', () => {
  const directory = newRoot();
  const path = join(directory, 'store.lock');

  // A lock from a process that no longer exists, old enough to be stale.
  writeFileSync(path, JSON.stringify({ pid: 999_999, nonce: 'a'.repeat(32), host: 'gone', acquiredAt: '2020-01-01T00:00:00.000Z' }));

  const handle = acquire(path, { waitMs: 4000, staleMs: 1 });
  try {
    assert.notEqual(handle.recovered, null, 'the recovery must be recorded');
    assert.equal(existsSync(handle.recovered), true, 'the orphan is quarantined on disk, not deleted');
    assert.match(JSON.parse(readFileSync(handle.recovered, 'utf8')).nonce, /^a+$/);
  } finally {
    release(handle);
  }
});

test('a lock whose content keeps changing is treated as alive', () => {
  // The renewer must be another PROCESS: acquire() is synchronous and blocks
  // this event loop, so a setInterval here would never fire -- which is
  // exactly how the first version of this test passed for the wrong reason.
  const directory = newRoot();
  const path = join(directory, 'store.lock');
  const renewerScript = join(scratch, `renewer-${sequence += 1}.mjs`);
  writeFileSync(renewerScript, `
    import { writeFileSync } from 'node:fs';
    const path = process.argv[2];
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      writeFileSync(path, JSON.stringify({ pid: 999999, nonce: 'b'.repeat(32), renewed: Date.now() }));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  `);

  const initial = JSON.stringify({ pid: 999_999, nonce: 'b'.repeat(32), acquiredAt: '2020-01-01T00:00:00.000Z' });
  writeFileSync(path, initial);
  const renewer = spawn(process.execPath, [renewerScript, path], { stdio: 'ignore' });

  try {
    // Wait for the renewer's first write. With staleMs: 1 the two observations
    // are 50ms apart, less than a slow runner needs to start a process: the
    // lock then looked still and was recovered (macOS CI, 2026-10-02).
    const started = Date.now() + 10_000;
    while (readFileSync(path, 'utf8') === initial && Date.now() < started) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    assert.notEqual(readFileSync(path, 'utf8'), initial, 'the renewer never started writing');

    assert.throws(() => acquire(path, { waitMs: 700, staleMs: 1 }), LockError,
      'a lock whose content keeps moving must not be recovered as an orphan');
  } finally {
    renewer.kill();
    rmSync(path, { force: true });
  }
});

test('REGRESSION: two real processes contending never both win', () => {
  const directory = newRoot();
  const script = join(scratch, `contend-${sequence += 1}.mjs`);
  writeFileSync(script, `
    import { withLock } from ${JSON.stringify(pathToFileURL(join(HERE, '..', 'lib', 'store', 'lock.mjs')).href)};
    import { readFileSync, writeFileSync, existsSync } from 'node:fs';
    const counter = process.argv[2], lock = process.argv[3];
    withLock(lock, () => {
      const value = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
      // A window a second process would race into if the lock did not hold.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
      writeFileSync(counter, String(value + 1));
    }, { waitMs: 8000 });
  `);

  const counter = join(directory, 'counter');
  const lock = join(directory, 'store.lock');
  const spawnOne = () => spawnSync(process.execPath, [script, counter, lock], { encoding: 'utf8' });

  const [first, second] = [spawnOne(), spawnOne()];
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(counter, 'utf8'), '2', 'both increments must be observed, so neither ran inside the other');
});

// -- lineage binding -------------------------------------------------------------------

test('a frozen lineage stores its candidateId', () => {
  const { api } = store();
  const frozen = api.freeze({ lineage: 'pr-1', candidateId: CANDIDATE, ...FREEZE });

  assert.equal(frozen.candidateId, CANDIDATE);
  assert.equal(frozen.state, 'FROZEN');
  assert.match(frozen.subject_id, /^sha256:/);
  assert.match(frozen.taskContractDigest, /^sha256:/);
  assert.match(frozen.taskContractSha256, /^sha256:/);
});

test('forward freeze refuses omission of the task contract', () => {
  const { api } = store();
  const { taskContract: omitted, ...withoutTask } = FREEZE;
  assert.throws(
    () => api.freeze({ lineage: 'missing-task', candidateId: CANDIDATE, ...withoutTask }),
    (error) => error instanceof StoreError
      && error.detail.failure === 'missing-task-contract'
      && /valid task-contract\/v1/.test(error.detail.remediation)
  );
  assert.equal(api.read().lineages['missing-task'], undefined);
});

test('changing only the task contract changes the frozen subject identity', () => {
  const first = store().api.freeze({ lineage: 'task-a', candidateId: CANDIDATE, ...FREEZE });
  const changedTask = { ...TASK_CONTRACT, goal: `${TASK_CONTRACT.goal} Verify the revised objective.` };
  const second = store().api.freeze({
    lineage: 'task-b', candidateId: CANDIDATE, ...FREEZE, taskContract: changedTask,
  });
  assert.notEqual(first.taskContractDigest, second.taskContractDigest);
  assert.notEqual(first.subject_id, second.subject_id);
});

test('canonically equivalent task contracts share one immutable artifact', () => {
  const { api } = store();
  const reordered = {
    escalate_when: [...TASK_CONTRACT.escalate_when],
    done_when: TASK_CONTRACT.done_when.map(({ condition, id }) => ({ condition, id })),
    constraints: [...TASK_CONTRACT.constraints],
    goal: TASK_CONTRACT.goal,
    schemaVersion: TASK_CONTRACT.schemaVersion,
  };
  const first = api.freeze({ lineage: 'canonical-a', candidateId: CANDIDATE, ...FREEZE });
  const second = api.freeze({ lineage: 'canonical-b', candidateId: CANDIDATE, ...FREEZE, taskContract: reordered });
  assert.equal(first.subject_id, second.subject_id);
  assert.equal(first.taskContractSha256, second.taskContractSha256);
  assert.equal(readdirSync(api.layout.taskContracts).length, 1);
});

test('REGRESSION: evidence for another candidate cannot be recorded against this lineage', () => {
  const { api } = store();
  api.freeze({ lineage: 'pr-1', candidateId: CANDIDATE, ...FREEZE });

  assert.throws(
    () => api.recordEvidence({ lineage: 'pr-1', evidence: evidenceFor({ candidateId: id('d') }) }),
    (error) => error instanceof StoreError && error.detail.failure === 'candidate-mismatch'
  );
});

test('REGRESSION: evidence from another lineage cannot authorise this one', () => {
  const { api } = store();

  // Two lineages, each with its own candidate. The second one's evidence is
  // perfectly valid -- and says nothing about the first.
  const other = readyLineage(api, 'pr-other', { candidateId: id('e') });
  api.freeze({ lineage: 'pr-mine', candidateId: CANDIDATE, ...FREEZE });

  assert.throws(
    () => api.recordEvidence({ lineage: 'pr-mine', evidence: other.evidence }),
    (error) => error instanceof StoreError && error.detail.failure === 'candidate-mismatch'
  );
});

test('REGRESSION: evidence from another decision or snapshot is refused', () => {
  const { api } = store();
  const { lineage } = readyLineage(api);

  for (const [label, evidence] of Object.entries({
    'another decision': evidenceFor({ decisionId: id('8') }),
    'another snapshot': evidenceFor({ snapshotHash: id('6') }),
  })) {
    assert.throws(() => api.recordEvidence({ lineage, evidence }), (error) =>
      error instanceof StoreError && ['decision-mismatch', 'snapshot-mismatch'].includes(error.detail.failure), label);
  }
});

test('REGRESSION: a legacy lineage without a candidateId cannot be authorised', () => {
  const { root, api } = store();
  const legacy = join(root, 'legacy.json');
  writeFileSync(legacy, JSON.stringify({
    'pr-2074': { lineage: 'pr-2074', subject_id: id('f'), base_tree: 'ab', candidate_tree: 'cd', state: 'AUDITED_PASS', correction_budget: 1, corrections_used: 0, verdict: 'PASS', frozen_at_generation: 1 },
  }));
  api.migrate({ legacyPath: legacy });

  assert.equal(api.status('pr-2074').candidateId, null);
  assert.throws(() => api.recordEvidence({ lineage: 'pr-2074', evidence: evidenceFor() }), (error) =>
    error instanceof StoreError && error.detail.failure === 'legacy-lineage');
  assert.throws(() => api.authorize({ lineage: 'pr-2074' }), (error) =>
    error instanceof StoreError && ['no-evidence', 'legacy-lineage'].includes(error.detail.failure));
});

// -- authorization ------------------------------------------------------------------------

test('a clean lineage authorises, and the receipt is stored as its own artifact', () => {
  const { api } = store();
  const { lineage } = readyLineage(api);
  const { receipt, state } = api.authorize({ lineage, publication: BINDING });

  assert.equal(state, 'AUTHORIZED');
  assert.equal(receipt.candidateId, CANDIDATE);
  const auditArtifact = receipt.artifacts.find((artifact) => artifact.path.startsWith('audit-results/'));
  assert.ok(auditArtifact, 'authorization auto-binds the native auditor result');
  const taskArtifact = receipt.artifacts.find((artifact) => artifact.path.startsWith('task-contracts/'));
  assert.ok(taskArtifact, 'authorization auto-binds the accepted task contract');
  const taskBytes = readFileSync(join(api.layout.root ?? dirname(api.layout.taskContracts), taskArtifact.path));
  assert.equal(taskArtifact.sha256, `sha256:${createHash('sha256').update(taskBytes).digest('hex')}`);
  assert.equal(taskArtifact.sha256, api.status(lineage).taskContractSha256);
  const resultBytes = readFileSync(join(api.layout.root ?? dirname(api.layout.auditResults), auditArtifact.path));
  assert.equal(auditArtifact.sha256, `sha256:${createHash('sha256').update(resultBytes).digest('hex')}`);
  assert.equal(auditArtifact.sha256, api.status(lineage).auditResultSha256);
  assert.notEqual(auditArtifact.sha256, api.status(lineage).auditResultId, 'canonical result identity remains distinct from the persisted-byte digest');
  const storedAudit = JSON.parse(resultBytes.toString('utf8'));
  assert.equal(storedAudit.taskContractDigest, api.status(lineage).taskContractDigest);
  assert.match(storedAudit.acceptanceCoverageDigest, /^sha256:/);
  assert.equal(existsSync(join(api.layout.authorizations, `${'c'.repeat(64)}.json`)), false, 'the file is named by receiptId, not by candidate');
  assert.equal(existsSync(join(api.layout.authorizations, `${receipt.receiptId.slice(7)}.json`)), true);
});

/**
 * Replace a lineage's durable auditor result with `document`, written with
 * its own consistent content identity and byte digest, as a store written by
 * an earlier version (or a forger with write access) would hold it.
 */
function plantAuditResult(api, lineage, document) {
  const { auditResultId: ignored, ...hashed } = document;
  const planted = { ...document, auditResultId: digest(hashed) };
  const bytes = `${JSON.stringify(planted, null, 2)}\n`;
  writeFileSync(join(api.layout.auditResults, `${planted.auditResultId.slice(7)}.json`), bytes);
  const index = JSON.parse(readFileSync(api.layout.index, 'utf8'));
  index.lineages[lineage].auditResultId = planted.auditResultId;
  index.lineages[lineage].auditResultSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  writeFileSync(api.layout.index, `${JSON.stringify(index, null, 2)}\n`);
  return planted;
}

/**
 * The same stored result in the shape an earlier contract would have written
 * it: v3 rows carry no verification and no limit, and v2 additionally carries
 * no design coverage and no maintainer decisions. The coverage digest is the
 * one that shape derives.
 */
function asHistorical(stored, schemaVersion) {
  const acceptanceCoverage = stored.acceptanceCoverage.map(({ verification: v, limit: l, ...row }) => row);
  const historical = { ...stored, schemaVersion, acceptanceCoverage, acceptanceCoverageDigest: digest(acceptanceCoverage) };
  if (schemaVersion === 'auditor-result/v2') {
    delete historical.designCoverage;
    delete historical.maintainerDecisions;
  }
  return historical;
}

test('historical v2 and v3 results still authorise, unchanged and without a retrospective limit', () => {
  for (const schemaVersion of ['auditor-result/v2', 'auditor-result/v3']) {
    const { api } = store();
    const { lineage, frozen } = readyLineage(api);
    const stored = JSON.parse(readFileSync(join(api.layout.auditResults, `${api.status(lineage).auditResultId.slice(7)}.json`), 'utf8'));
    const planted = plantAuditResult(api, lineage, asHistorical(stored, schemaVersion));
    assert.equal(planted.subject_id, frozen.subject_id);

    const { state, receipt } = api.authorize({ lineage, publication: BINDING });
    assert.equal(state, 'AUTHORIZED', schemaVersion);
    const bound = receipt.artifacts.find((artifact) => artifact.path.startsWith('audit-results/'));
    assert.equal(bound.path, `audit-results/${planted.auditResultId.slice(7)}.json`);
    const after = JSON.parse(readFileSync(join(api.layout.auditResults, `${planted.auditResultId.slice(7)}.json`), 'utf8'));
    assert.deepEqual(after, planted, `${schemaVersion}: the historical result is not rewritten`);
    assert.equal(after.acceptanceCoverage.some((row) => Object.hasOwn(row, 'limit') || Object.hasOwn(row, 'verification')), false);
  }
});

test('acceptance FAIL routes through one correction and fresh audit before authorization', () => {
  for (const corrected of [true, false]) {
    const { api } = store();
    const lineage = 'decisive-failure';
    const frozen = api.freeze({ lineage, candidateId: CANDIDATE, ...FREEZE });
    const failure = (subject) => {
      const result = auditorResult(subject, 'NEEDS_CHANGES');
      result.acceptanceCoverage[0] = { ...result.acceptanceCoverage[0], status: 'FAIL', reason: 'Public claim disproved by reproduction.', remediation: 'Correct the public claim.' };
      return result;
    };
    api.recordAudit({ lineage, result: failure(frozen.subject_id) });
    assert.equal(api.status(lineage).state, 'NEEDS_CHANGES');
    assert.throws(() => api.authorize({ lineage, publication: BINDING }), StoreError);
    assert.equal(api.reserveCorrection({ lineage }).corrections_used, 1);
    const refrozen = api.refreeze({ lineage, candidateId: CANDIDATE, ...FREEZE, draftDigest: id('a') });
    assert.notEqual(refrozen.subject_id, frozen.subject_id);
    api.recordAudit({ lineage, result: corrected ? auditorResult(refrozen.subject_id) : failure(refrozen.subject_id) });
    if (corrected) {
      assert.equal(api.status(lineage).state, 'REAUDITED');
      api.recordEvidence({ lineage, evidence: evidenceFor() });
      assert.equal(api.authorize({ lineage, publication: BINDING }).state, 'AUTHORIZED');
    } else {
      assert.equal(api.status(lineage).state, 'NEEDS_MAINTAINER');
      assert.throws(() => api.reserveCorrection({ lineage }), StoreError);
      assert.throws(() => api.authorize({ lineage, publication: BINDING }), StoreError);
    }
  }
});

test('durable PASS with failed acceptance is refused for v2, v3 and v4 even with intact digests', () => {
  for (const schemaVersion of ['auditor-result/v2', 'auditor-result/v3', 'auditor-result/v4']) {
    const { api } = store();
    const { lineage } = readyLineage(api);
    const stored = JSON.parse(readFileSync(join(api.layout.auditResults, `${api.status(lineage).auditResultId.slice(7)}.json`), 'utf8'));
    stored.acceptanceCoverage[0] = { ...stored.acceptanceCoverage[0], status: 'FAIL', reason: 'Required condition failed.', remediation: 'Resolve it.' };
    stored.acceptanceCoverageDigest = digest(stored.acceptanceCoverage);
    plantAuditResult(api, lineage, schemaVersion === 'auditor-result/v4' ? stored : asHistorical(stored, schemaVersion));
    assert.throws(() => api.authorize({ lineage, publication: BINDING }), (error) =>
      error instanceof StoreError && error.detail.failure === 'audit-coverage-mismatch', schemaVersion);
  }
});

test('auditor-result/v3 and v4: a stored PASS that its own pending decision or design gap contradicts is refused', () => {
  const cases = {
    'pending decision': (doc) => ({ ...doc, maintainerDecisions: [{ decision: 'd', options: ['a', 'b'], evidence: 'e', causalDisposition: 'introduced' }] }),
    'material design gap': (doc) => ({
      ...doc,
      designCoverage: doc.designCoverage.map((row, index) => (index === 0 ? { ...row, status: 'not_assessed', justification: 'skipped', material: true } : row)),
    }),
  };
  for (const schemaVersion of ['auditor-result/v3', 'auditor-result/v4']) {
    for (const [label, forge] of Object.entries(cases)) {
      const { api } = store();
      const { lineage } = readyLineage(api);
      const stored = JSON.parse(readFileSync(join(api.layout.auditResults, `${api.status(lineage).auditResultId.slice(7)}.json`), 'utf8'));
      assert.equal(stored.schemaVersion, 'auditor-result/v4');
      assert.equal(stored.verdict, 'PASS');
      plantAuditResult(api, lineage, forge(schemaVersion === 'auditor-result/v4' ? stored : asHistorical(stored, schemaVersion)));
      assert.throws(() => api.authorize({ lineage, publication: BINDING }), (error) =>
        error instanceof StoreError && error.detail.failure === 'audit-verdict-mismatch', `${schemaVersion}: ${label}`);
    }
  }
});

test('auditor-result/v4: a recorded pending decision moves the lineage to NEEDS_MAINTAINER, with no correction', () => {
  const { api } = store();
  const frozen = api.freeze({ lineage: 'decision', candidateId: CANDIDATE, ...FREEZE });
  const result = auditorResult(frozen.subject_id, 'PASS', {
    maintainerDecisions: [{ decision: 'new default?', options: ['keep', 'revert'], evidence: 'e', causalDisposition: 'introduced' }],
  });
  result.findings = Array.from({ length: 5 }, () => ({
    severity: 'MAJOR', evidenceClass: 'deterministic', causalDisposition: 'introduced',
    claim: 'defect', evidence: 'evidence', why: 'why', smallestCorrection: 'fix',
  }));
  api.recordAudit({ lineage: 'decision', result });
  const status = api.status('decision');
  assert.equal(status.state, 'NEEDS_MAINTAINER');
  const stored = JSON.parse(readFileSync(join(api.layout.auditResults, `${status.auditResultId.slice(7)}.json`), 'utf8'));
  assert.equal(stored.verdict, 'NEEDS_MAINTAINER');
  assert.equal(stored.correctionEligible, false);
  assert.equal(stored.maintainerDecisions[0].causalDisposition, 'introduced');
  assert.throws(() => api.reserveCorrection({ lineage: 'decision' }), StoreError);
});

test('auditor-result/v4: a contradicted stored verdict is refused before a correction is reserved', () => {
  const { api } = store();
  const frozen = api.freeze({ lineage: 'forged-changes', candidateId: CANDIDATE, ...FREEZE });
  api.recordAudit({ lineage: 'forged-changes', result: auditorResult(frozen.subject_id, 'NEEDS_CHANGES') });
  const stored = JSON.parse(readFileSync(join(api.layout.auditResults, `${api.status('forged-changes').auditResultId.slice(7)}.json`), 'utf8'));
  assert.equal(stored.verdict, 'NEEDS_CHANGES');
  plantAuditResult(api, 'forged-changes', {
    ...stored, maintainerDecisions: [{ decision: 'd', options: ['a', 'b'], evidence: 'e', causalDisposition: 'introduced' }],
  });
  assert.throws(() => api.reserveCorrection({ lineage: 'forged-changes' }), (error) =>
    error instanceof StoreError && error.detail.failure === 'audit-verdict-mismatch');
});

test('record-audit refuses a v2 submission for a new task-bound audit', () => {
  const { api } = store();
  const frozen = api.freeze({ lineage: 'v2-submission', candidateId: CANDIDATE, ...FREEZE });
  assert.throws(() => api.recordAudit({ lineage: 'v2-submission', result: auditorResultV2(frozen.subject_id, 'PASS') }), (error) =>
    error instanceof StoreError && error.detail.failure === 'invalid-auditor-result' && /requires auditor-result\/v4/.test(error.message));
  assert.equal(api.status('v2-submission').auditResultId ?? null, null);
});

test('REGRESSION: duplicate artifact paths refuse before receipt issuance and leave the lineage unchanged', () => {
  const { api } = store();
  const { lineage } = readyLineage(api);
  const before = api.status(lineage);
  const taskPath = `task-contracts/${before.taskContractDigest.slice(7)}.json`;

  assert.throws(
    () => api.authorize({
      lineage,
      publication: BINDING,
      artifacts: [
        { path: taskPath, sha256: before.taskContractSha256 },
        { path: taskPath, sha256: id('d') },
      ],
    }),
    (error) => error instanceof StoreError
      && error.detail.failure === 'refused'
      && error.detail.refusals.some((refusal) => refusal.includes('artifact paths must be unique'))
  );

  assert.deepEqual(api.status(lineage), before);
  assert.equal(before.state, 'AUDITED_PASS');
  assert.equal(before.receiptId, null);
  assert.equal(existsSync(api.layout.authorizations), false);
});

test('missing or tampered durable auditor results block authorization', () => {
  for (const mode of ['missing', 'tampered']) {
    const { api } = store();
    const { lineage } = readyLineage(api);
    const resultPath = join(api.layout.auditResults, `${api.status(lineage).auditResultId.slice(7)}.json`);
    if (mode === 'missing') rmSync(resultPath);
    else {
      const changed = JSON.parse(readFileSync(resultPath, 'utf8'));
      changed.recommendation = 'tampered';
      writeFileSync(resultPath, JSON.stringify(changed));
    }
    assert.throws(() => api.authorize({ lineage, publication: BINDING }), (error) =>
      error instanceof StoreError && error.detail.failure === (mode === 'missing' ? 'missing-artifact' : 'artifact-bytes-mismatch'));
  }
});

test('historical AUDITED_PASS can restore its v1 audit record but cannot mint new taskless authority', () => {
  const root = newRoot();
  const api = openStore({ override: root, allowOutsideWorkspace: true });
  const frozen = api.freeze({ lineage: 'legacy-forward', candidateId: CANDIDATE, ...FREEZE });
  api.recordEvidence({ lineage: 'legacy-forward', evidence: evidenceFor() });
  const index = api.read();
  index.lineages['legacy-forward'].state = 'AUDITED_PASS';
  index.lineages['legacy-forward'].verdict = 'PASS';
  delete index.lineages['legacy-forward'].auditResultId;
  delete index.lineages['legacy-forward'].auditResultSha256;
  delete index.lineages['legacy-forward'].taskContractDigest;
  delete index.lineages['legacy-forward'].taskContractSha256;
  writeFileSync(api.layout.index, `${JSON.stringify(index, null, 2)}\n`);
  assert.equal(api.status('legacy-forward').subject_id, frozen.subject_id);
  assert.throws(() => api.authorize({ lineage: 'legacy-forward', publication: BINDING }), (error) =>
    error instanceof StoreError && error.detail.failure === 'missing-auditor-result' && /record-audit/.test(error.message));
  const recovered = api.recordAudit({ lineage: 'legacy-forward', result: historicalAuditorResult(frozen.subject_id, 'PASS') });
  assert.equal(recovered.state, 'AUDITED_PASS');
  assert.equal(typeof recovered.auditResultSha256, 'string');
  assert.throws(() => api.authorize({ lineage: 'legacy-forward', publication: BINDING }), (error) =>
    error instanceof StoreError
      && error.detail.failure === 'missing-task-contract'
      && /Freeze a new lineage/.test(error.detail.remediation));
});

test('tampering with the accepted task contract blocks the publication forward path', () => {
  const { api } = store();
  const { lineage } = readyLineage(api);
  api.authorize({ lineage, publication: BINDING });
  const entry = api.status(lineage);
  const taskPath = join(api.layout.taskContracts, `${entry.taskContractDigest.slice(7)}.json`);
  const task = JSON.parse(readFileSync(taskPath, 'utf8'));
  writeFileSync(taskPath, `${JSON.stringify({ ...task, goal: 'tampered after authorization' })}\n`);

  assert.throws(() => api.gatePublish({ lineage, currentCandidateId: CANDIDATE }), (error) =>
    error instanceof StoreError && error.detail.failure === 'artifact-bytes-mismatch');
});

test('durable auditor-result bytes are revalidated across every publication forward path', () => {
  for (const point of ['gate-publish', 'reserve-attempt', 'load-ticket', 'consume-ticket']) {
    const { api } = store();
    const { lineage } = readyLineage(api);
    api.authorize({ lineage, publication: BINDING });
    const resultPath = join(api.layout.auditResults, `${api.status(lineage).auditResultId.slice(7)}.json`);
    let ticket = null;
    if (point !== 'gate-publish') api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
    if (point === 'load-ticket' || point === 'consume-ticket') {
      ({ ticket } = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE }));
    }
    if (point === 'gate-publish' || point === 'load-ticket') rmSync(resultPath);
    else writeFileSync(resultPath, `${readFileSync(resultPath, 'utf8')} `);

    const action = point === 'gate-publish'
      ? () => api.gatePublish({ lineage, currentCandidateId: CANDIDATE })
      : point === 'reserve-attempt'
        ? () => api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE })
        : point === 'load-ticket'
          ? () => api.loadTicket({ lineage })
          : () => api.consumeTicket({ lineage, ticketId: ticket.ticketId });
    assert.throws(action, (error) => error instanceof StoreError
      && ['missing-artifact', 'artifact-bytes-mismatch'].includes(error.detail.failure), point);
  }
});

test('a failing gate never authorises, whatever the lineage state says', () => {
  const { api } = store();
  const lineage = 'pr-failing';
  const frozen = api.freeze({ lineage, candidateId: CANDIDATE, ...FREEZE });
  api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'PASS') });
  api.recordEvidence({
    lineage,
    evidence: evidenceFor({ gateStatus: STATUS.FAIL, checks: [{ id: 'a.one', status: STATUS.FAIL, required: true, reason: 'violated' }] }),
  });

  assert.throws(() => api.authorize({ lineage, publication: BINDING }), (error) =>
    error instanceof StoreError && error.detail.failure === 'refused' && /only PASS authorises/.test(error.detail.refusals.join(' ')));
});

// -- PUBLISHABLE is not a durable token ----------------------------------------------------

test('REGRESSION: a candidate that changes after gate-publish makes the lineage STALE', () => {
  const { api } = store();
  const { lineage } = readyLineage(api);
  api.authorize({ lineage, publication: BINDING });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  assert.equal(api.status(lineage).state, 'PUBLISHABLE');

  // The index still reads PUBLISHABLE. It is not permission.
  assert.throws(() => api.reserveAttempt({ lineage, currentCandidateId: id('a') }), (error) =>
    error instanceof StoreError && error.detail.failure === 'stale-candidate');

  assert.equal(api.status(lineage).state, 'STALE');
  assert.throws(() => api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE }), (error) =>
    error instanceof StoreError && error.detail.failure === 'illegal-transition', 'and it does not come back');
});

test('gate-publish itself refuses a moved candidate and marks the lineage STALE', () => {
  const { api } = store();
  const { lineage } = readyLineage(api);
  api.authorize({ lineage, publication: BINDING });

  assert.throws(() => api.gatePublish({ lineage, currentCandidateId: id('b') }), (error) =>
    error instanceof StoreError && error.detail.failure === 'stale-candidate');
  assert.equal(api.status(lineage).state, 'STALE');
});

// -- attempt numbering ------------------------------------------------------------------------

test('REGRESSION: attempt numbers come from the store, monotonically per receipt', () => {
  const { api } = store();
  const { lineage } = readyLineage(api);
  api.authorize({ lineage, publication: BINDING });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });

  // One live ticket per lineage: each reservation is consumed before the next
  // may exist, which is exactly how the publisher spends them.
  const first = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
  api.consumeTicket({ lineage, ticketId: first.ticket.ticketId });
  const second = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
  api.consumeTicket({ lineage, ticketId: second.ticket.ticketId });
  const third = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });

  assert.deepEqual([first.attemptNumber, second.attemptNumber, third.attemptNumber], [1, 2, 3]);
  assert.equal(first.receipt.receiptId, second.receipt.receiptId);
});

test('an attempt carrying a number the store never issued is refused', () => {
  const { api } = store();
  const { lineage } = readyLineage(api);
  const { receipt } = api.authorize({ lineage, publication: BINDING });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });
  api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });

  // Internally consistent -- the id really is the digest of the rest -- so the
  // refusal below is about the number, not about tampering.
  const attempt = attemptFor({ attemptNumber: 99, receiptId: receipt.receiptId, evidenceId: api.status(lineage).evidenceId });
  assert.throws(() => api.recordAttempt({ lineage, attempt }), (error) =>
    error instanceof StoreError && error.detail.failure === 'unissued-attempt');
});

test('attempts are stored separately, one file per attempt', () => {
  const { api } = store();
  const { lineage } = readyLineage(api);
  const { receipt } = api.authorize({ lineage, publication: BINDING });
  api.gatePublish({ lineage, currentCandidateId: CANDIDATE });

  for (const outcome of ['failed', 'published']) {
    const { attemptNumber, ticket } = api.reserveAttempt({ lineage, currentCandidateId: CANDIDATE });
    api.consumeTicket({ lineage, ticketId: ticket.ticketId });
    api.recordAttempt({
      lineage,
      attempt: attemptFor({ attemptNumber, receiptId: receipt.receiptId, evidenceId: api.status(lineage).evidenceId, outcome }),
    });
  }

  const attempts = api.listAttempts(lineage);
  assert.deepEqual(attempts.map((attempt) => [attempt.attemptNumber, attempt.outcome]), [[1, 'failed'], [2, 'published']]);
});

// -- corruption blocks ---------------------------------------------------------------------------

test('an unreadable index, an unknown version and a tampered artifact all block', () => {
  const { root, api } = store();
  const { lineage } = readyLineage(api);
  api.authorize({ lineage, publication: BINDING });

  // Tamper the evidence of a lineage that has NOT been authorised yet, and
  // then try to authorise exactly that one.
  const pending = readyLineage(api, 'pr-tampered');
  const evidencePath = join(api.layout.evidence, `${api.status(pending.lineage).evidenceId.slice(7)}.json`);
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  writeFileSync(evidencePath, JSON.stringify({ ...evidence, summary: { ...evidence.summary, fail: 9 } }));

  assert.throws(() => api.authorize({ lineage: pending.lineage }), (error) =>
    error instanceof StoreError && error.detail.failure === 'tampered-artifact');

  const index = JSON.parse(readFileSync(api.layout.index, 'utf8'));
  writeFileSync(api.layout.index, JSON.stringify({ ...index, storeVersion: '9.9.9' }));
  assert.throws(() => api.read(), (error) => error instanceof StoreError && error.detail.failure === 'incompatible-version');

  writeFileSync(api.layout.index, '{ not json');
  assert.throws(() => api.read(), (error) => error instanceof StoreError && error.detail.failure === 'unreadable-index');
  assert.equal(existsSync(root), true);
});

test('an artifact the index references but that is absent blocks', () => {
  const { api } = store();
  const { lineage } = readyLineage(api);
  rmSync(join(api.layout.evidence, `${api.status(lineage).evidenceId.slice(7)}.json`), { force: true });

  assert.throws(() => api.authorize({ lineage, publication: BINDING }), (error) =>
    error instanceof StoreError && error.detail.failure === 'missing-artifact');
});

// -- crash between artifact and index -----------------------------------------------------------------

test('REGRESSION: a crash between artifact and index leaves an orphan, not corruption', () => {
  const { api } = store();
  const { lineage } = readyLineage(api);

  // Simulate the crash: the artifact reached disk, the index never referenced it.
  const orphan = evidenceFor({ checks: [{ id: 'z.orphan', status: STATUS.PASS, required: true, reason: 'a different document entirely' }] });
  assert.notEqual(orphan.evidenceId, api.status(lineage).evidenceId, 'the orphan must really be another artifact');
  writeAtomic(join(api.layout.evidence, `${orphan.evidenceId.slice(7)}.json`), `${JSON.stringify(orphan, null, 2)}\n`);

  // The store still works, and the index does not mention the orphan.
  const index = api.read();
  assert.equal(index.lineages[lineage].evidenceId !== orphan.evidenceId, true);
  assert.doesNotThrow(() => api.authorize({ lineage, publication: BINDING }), 'an orphaned artifact is not corruption');
  assert.equal(readdirSync(api.layout.evidence).length, 2, 'both files exist; one is simply unreferenced');
});

// -- idempotence -----------------------------------------------------------------------------------

test('REGRESSION: recording the same evidence twice writes one artifact and changes nothing', () => {
  const { api } = store();
  const { lineage, evidence } = readyLineage(api);

  const before = readFileSync(api.layout.index, 'utf8');
  api.recordEvidence({ lineage, evidence });

  assert.equal(readdirSync(api.layout.evidence).length, 1);
  assert.equal(readFileSync(api.layout.index, 'utf8'), before, 'the index is byte-identical');
});

test('REGRESSION: authorising the identical publication twice is refused, and the first receipt stands', () => {
  const { api } = store();
  const { lineage } = readyLineage(api);
  const first = api.authorize({ lineage, publication: BINDING });

  // Re-authorization exists for a DIFFERENT publication. The exact same
  // binding reproduces the exact same receiptId, and replacing a receipt with
  // itself would only churn the archive.
  assert.throws(() => api.authorize({ lineage, publication: BINDING }), (error) =>
    error instanceof StoreError && error.detail.failure === 'identical-authorization');
  assert.equal(api.status(lineage).receiptId, first.receipt.receiptId);
  assert.equal(readdirSync(api.layout.authorizations).filter((name) => name.endsWith('.json')).length, 1);
});

// -- migration ----------------------------------------------------------------------------------------

test('REGRESSION: migration preserves candidates and budgets, and mints no permission', () => {
  const { root, api } = store();
  const legacy = join(root, 'contribution-ledger.json');
  writeFileSync(legacy, JSON.stringify({
    'pr-2074': { lineage: 'pr-2074', subject_id: id('f'), base_tree: 'ab933c1c', candidate_tree: '4daf0098', state: 'NEEDS_CHANGES', correction_budget: 1, corrections_used: 0, verdict: 'NEEDS_CHANGES', frozen_at_generation: 1 },
    'pr-old': { lineage: 'pr-old', subject_id: id('e'), base_tree: 'aa', candidate_tree: 'bb', state: 'PUBLISHABLE', correction_budget: 1, corrections_used: 1, verdict: 'PASS', frozen_at_generation: 2 },
  }));

  const outcome = api.migrate({ legacyPath: legacy });
  assert.deepEqual(outcome.imported, ['pr-2074', 'pr-old']);

  const kept = api.status('pr-2074');
  assert.equal(kept.state, 'NEEDS_CHANGES');
  assert.equal(kept.correction_budget, 1);
  assert.equal(kept.corrections_used, 0);
  assert.equal(kept.subject_id, id('f'));
  assert.equal(kept.candidateId, null);

  const degraded = api.status('pr-old');
  assert.equal(degraded.state, 'AUDITED_PASS', 'a legacy PUBLISHABLE is not durable permission');
  assert.equal(degraded.migrated.legacyState, 'PUBLISHABLE');
  assert.equal(degraded.corrections_used, 1, 'the spent budget is preserved');
  assert.equal(degraded.receiptId, null, 'and it carries no authorization');

  // Even in AUDITED_PASS it cannot authorise: there is no candidateId to bind to.
  assert.throws(() => api.authorize({ lineage: 'pr-old' }), StoreError);
});

test('REGRESSION: migrating twice produces the same store and duplicates nothing', () => {
  const { root, api } = store();
  const legacy = join(root, 'legacy.json');
  writeFileSync(legacy, JSON.stringify({ 'pr-1': { lineage: 'pr-1', state: 'FROZEN', correction_budget: 1, corrections_used: 0 } }));

  api.migrate({ legacyPath: legacy });
  const after = readFileSync(api.layout.index, 'utf8');

  const second = api.migrate({ legacyPath: legacy });
  assert.deepEqual(second.imported, []);
  assert.deepEqual(second.skipped, ['pr-1']);
  assert.equal(readFileSync(api.layout.index, 'utf8'), after, 'the index is byte-identical');
});

test('the store says in writing that it uses no signature', () => {
  const { api } = store();
  api.freeze({ lineage: 'pr-1', candidateId: CANDIDATE, ...FREEZE });

  const index = JSON.parse(readFileSync(api.layout.index, 'utf8'));
  assert.equal(index.storeVersion, STORE_VERSION);
  assert.equal(index.notASignature, NO_SIGNATURE_WARNING);
  assert.match(index.notASignature, /no cryptographic signature and establishes no issuer identity/);
});
