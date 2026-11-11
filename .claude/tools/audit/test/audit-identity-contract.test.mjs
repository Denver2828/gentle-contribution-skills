import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { openStore } from '../lib/store/store.mjs';
import { bodyDigest } from '../lib/ticket.mjs';
import { REQUIRED_SOURCES, READING, CONTRIBUTION } from '../lib/intake.mjs';
import { completeCoverage, TASK_CONTRACT } from './helpers/documents.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER = resolve(HERE, '..', '..', '..', 'skills', 'gentle-ai-aporte', 'scripts', 'ledger.mjs');
const PACKET = resolve(HERE, '..', '..', '..', 'skills', 'gentle-ai-aporte', 'references', 'audit-packet.md');
const AUDITOR = resolve(HERE, '..', '..', '..', 'agents', 'gentle-ai-auditor.md');
const scratch = mkdtempSync(join(tmpdir(), 'audit-identity-contract-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const id = (character) => `sha256:${character.repeat(64)}`;
const digestFile = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const INTAKE = {
  repository: 'Gentleman-Programming/gentle-ai',
  contributionType: CONTRIBUTION.ISSUE,
  readings: REQUIRED_SOURCES.map((source) => ({
    source, command: `${source} --repo Gentleman-Programming/gentle-ai`, result: READING.COMPLETE, matches: 0, reviewed: false, coverage: completeCoverage({ source }),
  })),
  competing: [],
};

test('REGRESSION: the documented subject-id command reproduces the identity admitted by freeze', () => {
  // paths, policy and test-manifest are structured inputs and the ledger parses
  // them before hashing, so the fixtures are JSON. The draft is the bytes to be
  // published and is deliberately not.
  const files = Object.fromEntries(['paths', 'draft', 'policy', 'test-manifest'].map((name, index) => {
    const path = join(scratch, `${name}.txt`);
    writeFileSync(path, name === 'draft' ? `fixture-${index}\n` : `{"fixture":${index}}\n`);
    return [name, path];
  }));
  const baseTree = 'base-tree';
  const candidateTree = 'candidate-tree';
  const taskContractPath = join(scratch, 'task-contract.json');
  writeFileSync(taskContractPath, `${JSON.stringify(TASK_CONTRACT)}\n`);
  const derived = spawnSync(process.execPath, [
    LEDGER, 'subject-id',
    '--base-tree', baseTree, '--candidate-tree', candidateTree,
    '--paths', files.paths, '--draft', files.draft,
    '--policy', files.policy, '--test-manifest', files['test-manifest'],
    '--task-contract', taskContractPath,
  ], { encoding: 'utf8' });
  assert.equal(derived.status, 0, derived.stderr);

  const api = openStore({ override: mkdtempSync(join(scratch, 'store-')), allowOutsideWorkspace: true });
  const frozen = api.freeze({
    lineage: 'identity-contract', candidateId: id('c'), intake: INTAKE,
    baseTree, candidateTree,
    pathsDigest: digestFile(files.paths),
    draftDigest: digestFile(files.draft),
    // Beside the identity, never inside it: subject-id prints the same value
    // whether or not this binding exists.
    draftBodySha256: bodyDigest(readFileSync(files.draft, 'utf8')),
    policyDigest: digestFile(files.policy),
    testManifestDigest: digestFile(files['test-manifest']),
    taskContract: TASK_CONTRACT,
  });

  assert.match(derived.stdout.trim(), /^sha256:[0-9a-f]{64}$/);
  assert.equal(derived.stdout.trim(), frozen.subject_id);
});

test('the canonical packet carries every field the auditor requires under one vocabulary', () => {
  const bindingFields = (path) => {
    const text = readFileSync(path, 'utf8');
    const section = /## Audit Binding\s*\r?\n([\s\S]*?)```/.exec(text)?.[1] ?? '';
    return [...section.matchAll(/^- ([a-z_]+):/gm)].map((match) => match[1]);
  };
  const packet = bindingFields(PACKET);
  const auditor = bindingFields(AUDITOR);

  assert.deepEqual([...packet].sort(), [...auditor].sort());
  assert.equal(packet.includes('subject_id'), true);
  assert.equal(packet.includes('task_contract'), true);
  assert.equal(packet.includes('task_contract_digest'), true);
  assert.equal(packet.includes('candidate_id'), false);
  assert.equal(packet.includes('base_sandbox'), true);
  assert.equal(packet.includes('candidate_sandbox'), true);
});
