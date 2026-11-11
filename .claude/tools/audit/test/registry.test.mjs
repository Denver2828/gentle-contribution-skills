// Discovery and the parameter contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { discoverChecks, resolveParams, RegistryError, CHECKS_DIRECTORY } from '../lib/registry.mjs';

const LIB = dirname(fileURLToPath(new URL('../lib/registry.mjs', import.meta.url)));

test('discovery finds every check file and nothing else', async () => {
  const catalogue = await discoverChecks();
  const files = readdirSync(CHECKS_DIRECTORY).filter((name) => name.endsWith('.mjs') && !name.startsWith('_'));

  assert.equal(catalogue.size, files.length, 'one check per file, no more and no fewer');
  assert.ok(catalogue.size > 0);
  assert.equal(catalogue.has('diff.within-review-budget'), true);
});

test('shared helpers prefixed with _ are not mistaken for checks', async () => {
  const catalogue = await discoverChecks();
  for (const definition of catalogue.values()) {
    assert.equal(definition.origin.startsWith('_'), false);
  }
});

test('every discovered check declares a complete definition', async () => {
  for (const definition of (await discoverChecks()).values()) {
    assert.match(definition.id, /^[a-z0-9]+(\.[a-z0-9]+(-[a-z0-9]+)*)+$/);
    assert.equal(typeof definition.title, 'string');
    assert.equal(typeof definition.needsSnapshot, 'boolean');
    assert.equal(typeof definition.file, 'string');
    assert.equal(Object.hasOwn(definition, 'evaluate'), false, 'the catalogue carries a description, not executable code');
  }
});

test('adding a check is adding a file: no existing file is edited', async () => {
  // The property under test is the one that matters for maintenance -- a new
  // check must not require touching the registry, the orchestrator or the gate.
  //
  // Run in an isolated directory rather than in lib/checks/: writing a probe
  // into the real one races with any other test file that discovers checks
  // concurrently, which is exactly how this test first failed.
  const directory = mkdtempSync(join(tmpdir(), 'audit-drop-in-'));
  try {
    assert.equal((await discoverChecks({ directory })).size, 0);

    const probe = join(directory, 'probe.mjs');
    writeFileSync(probe, `
      export default {
        id: 'probe.temporary',
        title: 'A check added by dropping a file',
        needsSnapshot: false,
        params: {},
        evaluate: () => ({ status: 'PASS', reason: 'probe', evidence: [] }),
      };
    `);

    const withProbe = await discoverChecks({ directory });
    assert.equal(withProbe.has('probe.temporary'), true, 'a new file must register itself');
    assert.equal(withProbe.size, 1);

    rmSync(probe, { force: true });
    assert.equal((await discoverChecks({ directory })).size, 0, 'and removing the file must unregister it');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('gate.mjs names no check, so the orchestrator cannot drift from the catalogue', async () => {
  const source = readFileSync(join(LIB, 'gate.mjs'), 'utf8');
  for (const id of (await discoverChecks()).keys()) {
    assert.equal(source.includes(id), false, `gate.mjs must not mention "${id}"`);
  }
  assert.equal(source.includes('checks/'), false, 'gate.mjs must not reach into the checks directory');
});

test('two files claiming the same id is a refused configuration, not a last-one-wins', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'audit-registry-'));
  try {
    const body = (title) => `export default { id: 'clash.same', title: '${title}', needsSnapshot: false, params: {}, evaluate: () => ({}) };`;
    writeFileSync(join(directory, 'a-first.mjs'), body('First'));
    writeFileSync(join(directory, 'b-second.mjs'), body('Second'));

    await assert.rejects(() => discoverChecks({ directory }), RegistryError);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a malformed check definition is refused at discovery, not at run time', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'audit-registry-'));
  const cases = {
    'no-default.mjs': 'export const something = 1;',
    'bad-id.mjs': "export default { id: 'BadID', title: 't', needsSnapshot: false, params: {}, evaluate: () => ({}) };",
    'no-title.mjs': "export default { id: 'x.y', title: '', needsSnapshot: false, params: {}, evaluate: () => ({}) };",
    'implicit-snapshot.mjs': "export default { id: 'x.y', title: 't', params: {}, evaluate: () => ({}) };",
    'no-evaluate.mjs': "export default { id: 'x.y', title: 't', needsSnapshot: false, params: {} };",
    'bad-param-type.mjs': "export default { id: 'x.y', title: 't', needsSnapshot: false, params: { n: { type: 'float', required: true } }, evaluate: () => ({}) };",
    'implicit-required.mjs': "export default { id: 'x.y', title: 't', needsSnapshot: false, params: { n: { type: 'integer' } }, evaluate: () => ({}) };",
  };

  try {
    for (const [file, body] of Object.entries(cases)) {
      const single = mkdtempSync(join(directory, 'case-'));
      writeFileSync(join(single, file), body);
      await assert.rejects(() => discoverChecks({ directory: single }), RegistryError, `${file} must be refused`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// -- parameters ---------------------------------------------------------------

const definition = Object.freeze({
  id: 'test.subject',
  params: {
    limit: { type: 'integer', required: true, minimum: 1 },
    label: { type: 'string', required: false, default: 'default-label' },
    flag: { type: 'boolean', required: false, default: false },
    list: { type: 'string[]', required: false, default: [] },
  },
});

test('declared defaults are applied when a parameter is absent', () => {
  assert.deepEqual(resolveParams(definition, { limit: 5 }), {
    limit: 5, label: 'default-label', flag: false, list: [],
  });
});

test('a missing required parameter blocks', () => {
  assert.throws(() => resolveParams(definition, {}), RegistryError);
});

test('an unknown parameter blocks instead of being ignored', () => {
  assert.throws(() => resolveParams(definition, { limit: 1, typo: true }), /has no parameter "typo"/);
});

test('a parameter of the wrong type blocks', () => {
  assert.throws(() => resolveParams(definition, { limit: '400' }), /must be integer/);
  assert.throws(() => resolveParams(definition, { limit: 1.5 }), /must be integer/);
  assert.throws(() => resolveParams(definition, { limit: 1, flag: 'yes' }), /must be boolean/);
  assert.throws(() => resolveParams(definition, { limit: 1, list: [1, 2] }), /must be string\[\]/);
});

test('a numeric bound declared by the check is enforced', () => {
  assert.throws(() => resolveParams(definition, { limit: 0 }), /must be >= 1/);
});

test('a check with no parameters refuses any', () => {
  assert.throws(() => resolveParams({ id: 'x.y', params: {} }, { anything: 1 }), /accepts \(none\)/);
});
