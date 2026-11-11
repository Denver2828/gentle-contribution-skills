// A manifest that claims must prove.
//
// `structuredDigest` closed the 2026-08-19 hole: a manifest nothing could
// parse no longer survives a freeze. Parsing is not verifying, and the next
// hole stayed open behind it. A manifest declaring "10 subtests, 0 skips" over
// a run that skipped four parses cleanly, hashes fine, and mints a sound
// subject_id. That undisclosed-skip false green is exactly the defect
// verify-test-claim was built for (observation #830) -- and until this ratchet
// existed, the checker's only consumer was a paragraph of prose, so nothing
// ever ran it.
//
// These tests pin the properties that follow:
//   1. a declared count that the named stream refutes refuses the freeze;
//   2. counts cannot be declared without naming the stream they came from;
//   3. both claim shapes -- nested `testClaim` and the manifest root -- are
//      verified, because a ratchet only one shape trips is one the other walks
//      around;
//   4. a manifest that claims nothing is untouched;
//   5. verifying moves NO identity: the digest stays over the raw bytes.
//
// The streams here are SYNTHETIC fixtures, not preserved toolchain output.
// This workspace contains no Go module, so a directly captured stream was not
// available to build them from. They exercise the admission contract
// deterministically; they do not stand in for provenance, which the verifier
// states it cannot establish.

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
const scratch = mkdtempSync(join(tmpdir(), 'ledger-test-claim-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const digestFile = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

const INTAKE = {
  repository: 'Gentleman-Programming/gentle-ai',
  contributionType: CONTRIBUTION.ISSUE,
  readings: REQUIRED_SOURCES.map((source) => ({
    source, command: `${source} --repo Gentleman-Programming/gentle-ai`, result: READING.COMPLETE, matches: 0, reviewed: false, coverage: completeCoverage({ source }),
  })),
  competing: [],
};

const PACKAGE = 'example.com/repro830';
const event = (action, name) => JSON.stringify({
  Action: action, Package: PACKAGE, ...(name === undefined ? {} : { Test: name }),
});

// Ten subtests, four of them skipped, every top-level test passing and the
// package completing once: the shape observation #830 actually had.
const TRUTHFUL_STREAM = [
  event('pass', 'TestAlpha/one'), event('pass', 'TestAlpha/two'), event('pass', 'TestAlpha'),
  event('pass', 'TestBeta/one'), event('pass', 'TestBeta/two'), event('pass', 'TestBeta'),
  event('pass', 'TestGamma/one'), event('pass', 'TestGamma/two'), event('pass', 'TestGamma'),
  event('skip', 'TestDelta/capture-result-preflight'), event('skip', 'TestDelta/preserve-result'), event('pass', 'TestDelta'),
  event('skip', 'TestEpsilon/git-missing-repository'), event('skip', 'TestEpsilon/git-object-permission'), event('pass', 'TestEpsilon'),
  event('pass', 'TestZeta'), event('pass'),
].join('\n');

let counter = 0;

/**
 * One isolated input set. `manifest` is written verbatim as the test manifest;
 * `stream`, when given, is written next to it under the name the manifest is
 * expected to reference.
 */
function inputs({ manifest, stream = TRUTHFUL_STREAM, streamName = 'go-test.jsonl' } = {}) {
  const dir = join(scratch, `case-${counter += 1}`);
  mkdirSync(dir, { recursive: true });

  const files = { dir };
  for (const name of ['paths', 'policy']) {
    files[name] = join(dir, `${name}.json`);
    writeFileSync(files[name], `{"${name}":true}\n`);
  }
  files.draft = join(dir, 'draft.md');
  writeFileSync(files.draft, 'a draft is arbitrary bytes\n');

  files['test-manifest'] = join(dir, 'test-manifest.json');
  writeFileSync(files['test-manifest'], `${JSON.stringify(manifest)}\n`);
  files['task-contract'] = join(dir, 'task-contract.json');
  writeFileSync(files['task-contract'], `${JSON.stringify(TASK_CONTRACT)}\n`);

  if (stream !== null) {
    files.stream = join(dir, streamName);
    writeFileSync(files.stream, `${stream}\n`);
  }
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

const subjectId = (files) => spawnSync(process.execPath, argv('subject-id', files), { encoding: 'utf8' });

const freeze = (files, lineage) => {
  const intakePath = join(files.dir, 'intake.json');
  writeFileSync(intakePath, `${JSON.stringify(INTAKE)}\n`);
  return spawnSync(process.execPath, argv('freeze', files, [
    '--lineage', lineage,
    '--candidate-id', `sha256:${'c'.repeat(64)}`,
    '--intake', intakePath,
  ]), { encoding: 'utf8' });
};

test('REGRESSION: the #830 false claim is refused, naming the skip it hid', () => {
  const run = subjectId(inputs({
    manifest: { suite: 'go test ./internal/cli -json', subtests: 10, skip: 0, stream: 'go-test.jsonl' },
  }));
  assert.equal(run.status, 1, `expected a refusal, got ${run.status}\n${run.stdout}${run.stderr}`);
  assert.equal(run.stdout, '', 'a refused manifest must mint no identity');
  assert.match(run.stderr, /^REFUSED: /m);
  assert.ok(run.stderr.includes('the stream refutes it'), run.stderr);
  assert.match(run.stderr, /claimed 0 skips, -json counts 4/);
});

test('REGRESSION: freeze refuses the same false claim, so no lineage opens on it', () => {
  const run = freeze(inputs({
    manifest: { subtests: 10, skip: 0, stream: 'go-test.jsonl' },
  }), 'refuses-false-claim');
  assert.equal(run.status, 1, `expected a refusal, got ${run.status}\n${run.stdout}${run.stderr}`);
  assert.ok(run.stderr.includes('the stream refutes it'), run.stderr);
});

test('the truthful claim is admitted and freezes', () => {
  const run = subjectId(inputs({
    manifest: { subtests: 10, skip: 4, fail: 0, stream: 'go-test.jsonl' },
  }));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout.trim(), /^sha256:[0-9a-f]{64}$/);
});

test('the nested testClaim shape is verified too', () => {
  const refused = subjectId(inputs({
    manifest: { note: 'run on Windows', testClaim: { subtests: 10, skip: 0, stream: 'go-test.jsonl' } },
  }));
  assert.equal(refused.status, 1, refused.stdout);
  assert.ok(refused.stderr.includes('at testClaim'), refused.stderr);

  const admitted = subjectId(inputs({
    manifest: { note: 'run on Windows', testClaim: { subtests: 10, skip: 4, stream: 'go-test.jsonl' } },
  }));
  assert.equal(admitted.status, 0, admitted.stderr);
});

test('counts cannot be declared without naming the stream they came from', () => {
  const run = subjectId(inputs({ manifest: { subtests: 10, skip: 4 } }));
  assert.equal(run.status, 1, run.stdout);
  assert.ok(run.stderr.includes('names no `go test -json` stream'), run.stderr);
});

test('a named stream that does not exist refuses rather than passing vacuously', () => {
  const run = subjectId(inputs({
    manifest: { subtests: 10, skip: 4, stream: 'nowhere.jsonl' },
  }));
  assert.equal(run.status, 1, run.stdout);
  assert.ok(run.stderr.includes('the named stream does not exist'), run.stderr);
});

test('a stream naming only the file is resolved against the manifest, not the working directory', () => {
  // Run from a directory that holds no stream of that name. Resolving from cwd
  // would report the stream missing; resolving from the manifest finds it.
  const files = inputs({ manifest: { subtests: 10, skip: 4, stream: 'go-test.jsonl' } });
  const elsewhere = mkdtempSync(join(scratch, 'cwd-'));
  const run = spawnSync(process.execPath, argv('subject-id', files), { encoding: 'utf8', cwd: elsewhere });
  assert.equal(run.status, 0, run.stderr);
});

test('a malformed count refuses instead of being coerced', () => {
  for (const claim of [
    { subtests: '10', skip: 4, stream: 'go-test.jsonl' },
    { subtests: 10, skip: -1, stream: 'go-test.jsonl' },
    { subtests: 10, skip: 4, fail: 1.5, stream: 'go-test.jsonl' },
    { subtests: 10, stream: 'go-test.jsonl' },
  ]) {
    const run = subjectId(inputs({ manifest: claim }));
    assert.equal(run.status, 1, `${JSON.stringify(claim)} should refuse\n${run.stdout}`);
    assert.match(run.stderr, /must be a non-negative integer/);
  }
});

test('the surrounding run must pass: a failed top-level test refuses despite matching subtests', () => {
  const stream = [event('pass', 'TestAlpha/one'), event('fail', 'TestAlpha'), event('fail')].join('\n');
  const run = subjectId(inputs({ manifest: { subtests: 1, skip: 0, stream: 'go-test.jsonl' }, stream }));
  assert.equal(run.status, 1, run.stdout);
  assert.ok(run.stderr.includes('the stream refutes it'), run.stderr);
});

test('a manifest that claims nothing is untouched', () => {
  const run = subjectId(inputs({ manifest: { suite: 'go test ./...', note: 'counts not declared' }, stream: null }));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout.trim(), /^sha256:[0-9a-f]{64}$/);
});

test('a manifest that is not an object carries no claim and still freezes', () => {
  const run = subjectId(inputs({ manifest: 'a bare string is valid JSON', stream: null }));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout.trim(), /^sha256:[0-9a-f]{64}$/);
});

test('REGRESSION: verifying moves no identity -- the digest stays over the raw bytes', () => {
  const files = inputs({ manifest: { subtests: 10, skip: 4, stream: 'go-test.jsonl' } });
  const run = subjectId(files);
  assert.equal(run.status, 0, run.stderr);

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
