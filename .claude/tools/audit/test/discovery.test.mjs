// The discovery perimeter.
//
// Importing a module runs its top-level code. These tests exist because that
// grant used to be handed to the parent process: a file dropped into the
// checks directory could freeze it, exit it, or write to the repository before
// the authorised snapshot existed. Every case below must end as a blocking
// result, and none of them may kill or freeze the test process itself -- which
// is the same process the gate runs in.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverChecks, RegistryError, CHECKS_DIRECTORY } from '../lib/registry.mjs';
import { runPreflight, FAILURE_CODE, effectiveTimeout, resolveBudgets } from '../lib/preflight.mjs';
import { DEFAULT_CHECK_TIMEOUT_MS } from '../lib/isolate.mjs';
import { DEFAULT_DISCOVERY_TIMEOUT_MS } from '../lib/registry.mjs';
import { validateResult } from '../lib/validate.mjs';
import { STATUS } from '../lib/status.mjs';
import { git, write, repoWithCommit, FIXTURE_REPOSITORY, cleanupAll } from './helpers/repo.mjs';

after(cleanupAll);

const scratch = mkdtempSync(join(tmpdir(), 'audit-discovery-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;

function checkDirectory(files) {
  const directory = mkdtempSync(join(scratch, 'checks-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(directory, name), body);
  return directory;
}

function policyFile(checks, extra = {}) {
  const path = join(scratch, `policy-${sequence += 1}.json`);
  writeFileSync(path, JSON.stringify({
    policyVersion: '1.0.0', id: 'discovery-test', version: '1',
    repository: FIXTURE_REPOSITORY,
    gates: { preflight: { checks, ...extra } },
  }));
  return path;
}

const WELL_FORMED = (id) => `
  export default { id: '${id}', title: 'Well formed', needsSnapshot: false, params: {},
    evaluate: () => ({ status: 'PASS', reason: 'fine', evidence: [{ type:'computed', source:'s', observed:{}, hash:'sha256:${'0'.repeat(64)}' }] }) };
`;

// -- the parent never imports a check ------------------------------------------

test('no check module is imported in the main thread', async () => {
  // The module records the thread it was loaded on. Thread 0 is the main one.
  const witness = join(scratch, `thread-${sequence += 1}.log`);
  const directory = checkDirectory({
    'witness.mjs': `
      import { appendFileSync } from 'node:fs';
      import { threadId } from 'node:worker_threads';
      appendFileSync(${JSON.stringify(witness)}, threadId + '\\n');
      ${WELL_FORMED('probe.witness')}
    `,
  });

  const { root } = repoWithCommit({ 'a.txt': 'x\n' }, `discovery-witness-${sequence}`);
  await runPreflight({
    cwd: root,
    policy: policyFile([{ id: 'probe.witness', required: true }]),
    gate: 'preflight',
    checksDirectory: directory,
  });

  const threads = readFileSync(witness, 'utf8').trim().split('\n').filter(Boolean).map(Number);
  assert.ok(threads.length >= 1, 'the module must have been loaded at least once');
  assert.equal(threads.includes(0), false, `the module was loaded on the main thread: ${threads.join(', ')}`);
});

test('the registry module does not import from the checks directory', () => {
  const source = readFileSync(join(CHECKS_DIRECTORY, '..', 'registry.mjs'), 'utf8');
  assert.equal(/await import\(/.test(source), false, 'registry.mjs must not import anything dynamically');
  assert.equal(source.includes('pathToFileURL'), false, 'and must not build module URLs to load');
});

// -- the six hostile modules ----------------------------------------------------

async function discoveryOf(files, timeoutMs = 1500) {
  return discoverChecks({ directory: checkDirectory(files), timeoutMs });
}

test('REGRESSION: a module that loops before its export is killed, not awaited', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    () => discoveryOf({ 'spin.mjs': "for(;;){}\nexport default { id:'probe.spin', title:'t', needsSnapshot:false, params:{}, evaluate: () => ({}) };" }, 600),
    (error) => error instanceof RegistryError && error.detail.failure === 'timeout' && error.detail.terminated === true
  );
  assert.ok(Date.now() - startedAt < 8000, 'discovery must not hang on a top-level loop');
});

test('REGRESSION: a module that calls process.exit before its export does not take the process with it', async () => {
  // If this ran in the parent, the test process would exit(3) here and the
  // whole file would be reported as failed with no assertions at all.
  await assert.rejects(
    () => discoveryOf({ 'exit.mjs': "process.exit(3);\nexport default { id:'probe.exit', title:'t', needsSnapshot:false, params:{}, evaluate: () => ({}) };" }),
    (error) => error instanceof RegistryError && error.detail.failure === 'terminated' && error.detail.exitCode === 3
  );
});

test('REGRESSION: a module that throws during import blocks discovery, naming the module', async () => {
  await assert.rejects(
    () => discoveryOf({ 'boom.mjs': "throw new Error('exploding on import');\nexport default {};" }),
    (error) => error instanceof RegistryError
      && error.detail.failure === 'load'
      && error.detail.module === 'boom.mjs'
      && /exploding on import/.test(error.message)
  );
});

test('REGRESSION: a malformed export is refused by the parent, which never held the module', async () => {
  const malformed = {
    'no-default.mjs': 'export const something = 1;',
    'bad-id.mjs': "export default { id:'BadID', title:'t', needsSnapshot:false, params:{}, evaluate: () => ({}) };",
    'no-evaluate.mjs': "export default { id:'x.y', title:'t', needsSnapshot:false, params:{} };",
    'implicit-snapshot.mjs': "export default { id:'x.y', title:'t', params:{}, evaluate: () => ({}) };",
    'bad-param.mjs': "export default { id:'x.y', title:'t', needsSnapshot:false, params:{ n:{ type:'float', required:true } }, evaluate: () => ({}) };",
  };

  for (const [file, body] of Object.entries(malformed)) {
    await assert.rejects(() => discoveryOf({ [file]: body }), RegistryError, `${file} must be refused`);
  }
});

test('REGRESSION: partial discovery is refused, and reports what had loaded before the failure', async () => {
  await assert.rejects(
    () => discoveryOf({
      'a-first.mjs': WELL_FORMED('probe.first'),
      'b-broken.mjs': "throw new Error('the second one fails');\nexport default {};",
      'c-third.mjs': WELL_FORMED('probe.third'),
    }),
    (error) => error instanceof RegistryError
      && error.detail.module === 'b-broken.mjs'
      && error.detail.loadedBefore.length === 1
      && error.detail.loadedBefore[0] === 'a-first.mjs'
  );
});

test('REGRESSION: a repository mutated during import diverges the second reading and blocks', async () => {
  const { root } = repoWithCommit({ 'a.txt': 'x\n' }, `discovery-mutation-${sequence += 1}`);
  const directory = checkDirectory({
    'mutating.mjs': `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(root, 'written-during-import.txt').replaceAll('\\', '/'))}, 'x');
      ${WELL_FORMED('probe.mutating')}
    `,
  });

  const { result } = await runPreflight({
    cwd: root,
    policy: policyFile([{ id: 'probe.mutating', required: true }]),
    gate: 'preflight',
    checksDirectory: directory,
  });

  assert.equal(existsSync(join(root, 'written-during-import.txt')), true, 'the module really did write');
  assert.equal(result.checks.find((c) => c.id === 'probe.mutating')?.status, STATUS.PASS, 'the check itself passed');
  assert.equal(result.status, STATUS.UNKNOWN, 'and the gate refuses, because the snapshot predates the import');
  assert.equal(result.binding.stable, false);
  assert.ok(result.errors.some((error) => error.code === FAILURE_CODE.UNSTABLE));
});

// -- discovery failure is a blocking result, not an exception ---------------------

test('a catalogue that cannot be built produces a blocking result bound to the snapshot', async () => {
  const { root } = repoWithCommit({ 'a.txt': 'x\n' }, `discovery-blocked-${sequence += 1}`);
  const directory = checkDirectory({ 'boom.mjs': "throw new Error('cannot load');\nexport default {};" });

  const { result, snapshot } = await runPreflight({
    cwd: root,
    policy: policyFile([{ id: 'probe.anything', required: true }]),
    gate: 'preflight',
    checksDirectory: directory,
  });

  assert.equal(result.status, STATUS.UNKNOWN);
  assert.equal(result.errors[0].code, FAILURE_CODE.DISCOVERY);
  assert.equal(result.checks[0].id, 'gate.catalogue-loadable');
  assert.equal(result.checks[0].required, true);
  assert.equal(result.checks[0].evidence[0].observed.snapshotTakenBeforeLoading, true);
  assert.equal(result.binding.snapshotHash, snapshot.hash, 'the reading taken before loading is still bound');
  assert.equal(validateResult(result).valid, true);
});

test('a discovery that had to be killed also blocks, rather than running a partial catalogue', async () => {
  const { root } = repoWithCommit({ 'a.txt': 'x\n' }, `discovery-killed-${sequence += 1}`);
  const directory = checkDirectory({
    'a-fine.mjs': WELL_FORMED('probe.fine'),
    'b-spin.mjs': "for(;;){}\nexport default { id:'probe.spin', title:'t', needsSnapshot:false, params:{}, evaluate: () => ({}) };",
  });

  const { result } = await runPreflight({
    cwd: root,
    policy: policyFile([{ id: 'probe.fine', required: true }], { checkTimeoutMs: 600 }),
    gate: 'preflight',
    checksDirectory: directory,
  });

  assert.equal(result.status, STATUS.UNKNOWN);
  assert.equal(result.errors[0].code, FAILURE_CODE.DISCOVERY);
  assert.equal(result.checks.some((check) => check.status === STATUS.PASS), false, 'nothing may pass on a catalogue that never built');
});

// -- the budget can only be hardened ------------------------------------------------

test('REGRESSION: an override may lower the budget, never raise it', () => {
  assert.equal(effectiveTimeout(1000, 500), 500, 'a lower override wins');
  assert.equal(effectiveTimeout(1000, 1000), 1000, 'an equal override changes nothing');
  assert.equal(effectiveTimeout(1000, 5000), 1000, 'a higher override must not widen the policy');
  assert.equal(effectiveTimeout(1000, undefined), 1000, 'no override keeps the policy value');
  // With no policy value the default stands in for it, and the same rule applies:
  // an override below the default hardens, one above it is ignored.
  assert.equal(effectiveTimeout(undefined, 5000), 5000, 'below the default is a hardening');
  assert.equal(effectiveTimeout(undefined, DEFAULT_CHECK_TIMEOUT_MS + 1), DEFAULT_CHECK_TIMEOUT_MS, 'above the default is refused');
  assert.equal(effectiveTimeout(undefined, 250), 250);
  assert.equal(effectiveTimeout(1000, Number.NaN), 1000, 'a nonsense override is ignored, not obeyed');
  assert.equal(effectiveTimeout(1000, 0), 1, 'a non-positive override hardens to the minimum');
});

test('REGRESSION: the two budgets are independent, and each may only be hardened', () => {
  const gate = { checkTimeoutMs: 1000, discoveryTimeoutMs: 4000 };

  assert.deepEqual(resolveBudgets(gate), { checkTimeoutMs: 1000, discoveryTimeoutMs: 4000 });

  // Overriding one leaves the other exactly where the policy put it.
  assert.deepEqual(resolveBudgets(gate, { checkTimeoutMs: 200 }), { checkTimeoutMs: 200, discoveryTimeoutMs: 4000 });
  assert.deepEqual(resolveBudgets(gate, { discoveryTimeoutMs: 900 }), { checkTimeoutMs: 1000, discoveryTimeoutMs: 900 });

  // Neither can be widened, and widening one does not leak into the other.
  assert.deepEqual(resolveBudgets(gate, { checkTimeoutMs: 9999, discoveryTimeoutMs: 9999 }), { checkTimeoutMs: 1000, discoveryTimeoutMs: 4000 });

  // Each falls back to its own default, not to the other's.
  assert.deepEqual(resolveBudgets({}), {
    checkTimeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
    discoveryTimeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS,
  });
});

test('REGRESSION: a larger catalogue does not eat the budget designed for one check', async () => {
  // Twelve modules, each slow to import. Discovery is generous; the per-check
  // budget is tight. Under a shared budget the imports would have consumed it
  // and the check would have timed out through no fault of its own.
  const slowImport = (id) => `
    const until = Date.now() + 120;
    while (Date.now() < until) {}
    ${WELL_FORMED(id)}
  `;
  const files = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [`m${index}.mjs`, slowImport(`probe.slow${index}`)])
  );
  const directory = checkDirectory(files);
  const { root } = repoWithCommit({ 'a.txt': 'x\n' }, `discovery-budgets-${sequence += 1}`);

  const { result, budgets } = await runPreflight({
    cwd: root,
    policy: policyFile([{ id: 'probe.slow0', required: true }], { checkTimeoutMs: 900, discoveryTimeoutMs: 8000 }),
    gate: 'preflight',
    checksDirectory: directory,
  });

  assert.deepEqual(budgets, { checkTimeoutMs: 900, discoveryTimeoutMs: 8000 });
  assert.equal(result.checks.find((check) => check.id === 'probe.slow0').status, STATUS.PASS,
    'the check must receive its own full budget regardless of how long the catalogue took');
  assert.equal(result.status, STATUS.PASS);
});

test('REGRESSION: a tight discovery budget blocks discovery without blaming a check', async () => {
  const directory = checkDirectory({
    'slow.mjs': `
      const until = Date.now() + 1500;
      while (Date.now() < until) {}
      ${WELL_FORMED('probe.slow')}
    `,
  });
  const { root } = repoWithCommit({ 'a.txt': 'x\n' }, `discovery-tight-${sequence += 1}`);

  const { result } = await runPreflight({
    cwd: root,
    policy: policyFile([{ id: 'probe.slow', required: true }], { checkTimeoutMs: 9000, discoveryTimeoutMs: 400 }),
    gate: 'preflight',
    checksDirectory: directory,
  });

  assert.equal(result.status, STATUS.UNKNOWN);
  assert.equal(result.errors[0].code, FAILURE_CODE.DISCOVERY);
  assert.equal(result.checks[0].id, 'gate.catalogue-loadable');
  assert.equal(result.checks[0].evidence[0].observed.timeoutMs, 400, 'the discovery budget is the one reported');
  assert.equal(result.checks.some((check) => check.id === 'probe.slow'), false, 'no check is blamed for a catalogue that never built');
});

test('REGRESSION: the hardening is real end to end, in both directions', async () => {
  const { root } = repoWithCommit({ 'a.txt': 'x\n' }, `discovery-budget-${sequence += 1}`);
  const directory = checkDirectory({
    'spin.mjs': "export default { id:'probe.spin', title:'t', needsSnapshot:false, params:{}, evaluate: () => { for(;;){} } };",
  });
  const policy = policyFile([{ id: 'probe.spin', required: true }], { checkTimeoutMs: 700 });

  const raised = await runPreflight({ cwd: root, policy, gate: 'preflight', checksDirectory: directory, checkTimeoutMs: 9000 });
  assert.equal(raised.result.checks[0].evidence[0].observed.timeoutMs, 700, 'the policy budget stands');

  const lowered = await runPreflight({ cwd: root, policy, gate: 'preflight', checksDirectory: directory, checkTimeoutMs: 300 });
  assert.equal(lowered.result.checks[0].evidence[0].observed.timeoutMs, 300, 'a stricter run is allowed');
});
