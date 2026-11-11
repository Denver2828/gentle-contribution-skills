// `freeze` hashes its structured inputs. Hashing is not reading.
//
// On 2026-08-19 a test manifest written through a bash heredoc that consumed
// one backslash level -- leaving `"grep -c '^\*\*[0-9]\+\.'"`, where `\*` is
// not a valid JSON escape -- was frozen, audited in full, and only rejected
// two rounds later when a script finally called JSON.parse on it. The
// candidate identity was never wrong: the bytes hash the same either way.
// The damage was to the manifest's purpose, which is to be the artifact an
// auditor can mechanically falsify.
//
// These tests pin the three properties that follow:
//   1. paths, policy and test-manifest must parse, or the freeze refuses;
//   2. the draft must NOT be constrained -- it is the bytes to be published;
//   3. validating changes NO identity. The digest stays over the raw bytes,
//      so every subject_id minted before this check still reproduces.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
const scratch = mkdtempSync(join(tmpdir(), 'ledger-structured-inputs-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const STRUCTURED = ['paths', 'policy', 'test-manifest'];
const digestFile = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

// The exact shape that survived a freeze and an audit: a lone backslash escape
// that JSON does not define.
const INVALID_JSON = '{"command": "grep -c \'^\\*\\*[0-9]\\+\\.\'"}\n';

const INTAKE = {
  repository: 'Gentleman-Programming/gentle-ai',
  contributionType: CONTRIBUTION.ISSUE,
  readings: REQUIRED_SOURCES.map((source) => ({
    source, command: `${source} --repo Gentleman-Programming/gentle-ai`, result: READING.COMPLETE, matches: 0, reviewed: false, coverage: completeCoverage({ source }),
  })),
  competing: [],
};

let counter = 0;

/** One isolated set of inputs. `broken` names the file that gets invalid JSON. */
function inputs({ broken = null, draft = 'a draft is arbitrary bytes\n' } = {}) {
  const dir = join(scratch, `case-${counter += 1}`);
  mkdirSync(dir, { recursive: true });

  const files = { dir };
  for (const name of STRUCTURED) {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, name === broken ? INVALID_JSON : `{"${name}":true}\n`);
    files[name] = path;
  }
  files.draft = join(dir, 'draft.md');
  writeFileSync(files.draft, draft);
  files['task-contract'] = join(dir, 'task-contract.json');
  writeFileSync(files['task-contract'], `${JSON.stringify(TASK_CONTRACT)}\n`);
  return files;
}

const argv = (operation, files, extra = []) => [
  LEDGER, operation,
  '--base-tree', 'base-tree', '--candidate-tree', 'candidate-tree',
  '--paths', files.paths, '--draft', files.draft,
  '--policy', files.policy, '--test-manifest', files['test-manifest'],
  '--task-contract', files['task-contract'],
  ...extra,
];

for (const broken of STRUCTURED) {
  test(`freeze refuses when ${broken} is not valid JSON`, () => {
    const files = inputs({ broken });
    const intakePath = join(files.dir, 'intake.json');
    writeFileSync(intakePath, `${JSON.stringify(INTAKE)}\n`);

    const run = spawnSync(process.execPath, argv('freeze', files, [
      '--lineage', `refuses-${broken}`,
      '--candidate-id', `sha256:${'c'.repeat(64)}`,
      '--intake', intakePath,
    ]), { encoding: 'utf8' });

    assert.equal(run.status, 1, `expected a refusal, got ${run.status}\n${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /^REFUSED: /m);
    assert.ok(run.stderr.includes(`${broken} is not valid JSON`), run.stderr);
    // The refusal has to say why hashing was not enough, or the next person
    // reaches for the digest instead of the file.
    assert.ok(run.stderr.includes('Fix the file, not the digest.'), run.stderr);
  });

  test(`subject-id refuses the same ${broken}, so no identity exists that freeze would reject`, () => {
    const files = inputs({ broken });
    const run = spawnSync(process.execPath, argv('subject-id', files), { encoding: 'utf8' });
    assert.equal(run.status, 1, `expected a refusal, got ${run.status}\n${run.stdout}${run.stderr}`);
    assert.equal(run.stdout, '');
  });
}

test('the draft is never parsed: bytes that are not JSON still freeze', () => {
  const files = inputs({ draft: '## An issue body\n\nNot JSON, and never will be. {[<\n' });
  const run = spawnSync(process.execPath, argv('subject-id', files), { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout.trim(), /^sha256:[0-9a-f]{64}$/);
});

test('forward subject-id refuses omission of the task contract', () => {
  const files = inputs();
  const command = argv('subject-id', files);
  const at = command.indexOf('--task-contract');
  command.splice(at, 2);
  const run = spawnSync(process.execPath, command, { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /missing --task-contract/);
  assert.equal(run.stdout, '');
});

test('a structured input whose JSON is merely surprising is still accepted', () => {
  // The check is parseability, not schema. `freeze` is not the place to decide
  // what a policy may contain; a stricter rule here would refuse valid records
  // for reasons the store never agreed to.
  const files = inputs();
  writeFileSync(files.policy, '[]\n');
  writeFileSync(files['test-manifest'], '"a bare string is valid JSON"\n');
  const run = spawnSync(process.execPath, argv('subject-id', files), { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout.trim(), /^sha256:[0-9a-f]{64}$/);
});

test('REGRESSION: validating moves no identity -- the digest stays over the raw bytes', () => {
  const files = inputs();
  const run = spawnSync(process.execPath, argv('subject-id', files), { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);

  // Derived independently from the file bytes, exactly as every previously
  // minted subject_id was. If structuredDigest ever hashed a re-serialization
  // instead, this is the assertion that fails.
  const api = openStore({ override: mkdtempSync(join(scratch, 'store-')), allowOutsideWorkspace: true });
  const frozen = api.freeze({
    lineage: 'identity-unmoved', candidateId: `sha256:${'c'.repeat(64)}`, intake: INTAKE,
    baseTree: 'base-tree', candidateTree: 'candidate-tree',
    pathsDigest: digestFile(files.paths),
    draftDigest: digestFile(files.draft),
    draftBodySha256: bodyDigest(readFileSync(files.draft, 'utf8')),
    policyDigest: digestFile(files.policy),
    testManifestDigest: digestFile(files['test-manifest']),
    taskContract: TASK_CONTRACT,
  });

  assert.equal(run.stdout.trim(), frozen.subject_id);
});
