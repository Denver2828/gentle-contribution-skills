// Parity: does the cited location really hold what was declared, and does a
// manifest really require the lockfile someone expects beside it.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseSourceRef, verifyCitation, MalformedReferenceError } from '../lib/parity.mjs';
import { parseGoMod, unresolvedRequirements, isLocalReplacement } from '../lib/checks/parity-go-module-lockfile.mjs';
import { readFileText, assertRepositoryRelative, PathOutsideRepositoryError, FileUndecodableError } from '../lib/adapters/files.mjs';
import { loadCheckModules } from './helpers/checks.mjs';
import { takeSnapshot } from '../lib/snapshot.mjs';
import { readTrackedPaths, readTrackedCount } from '../lib/adapters/git.mjs';
import { STATUS } from '../lib/status.mjs';
import { git, write, repoWithCommit, cleanupAll } from './helpers/repo.mjs';

after(cleanupAll);

const ADAPTERS = { readTrackedPaths, readTrackedCount };

let catalogue;
before(async () => { catalogue = await loadCheckModules(); });

const evaluateCheck = (id, { root, tooling = { commands: [] }, params = {} }) => {
  const outcome = takeSnapshot({ cwd: root });
  assert.equal(outcome.status, STATUS.PASS, outcome.reason);
  return catalogue.get(id).evaluate({
    snapshot: outcome.snapshot, snapshotOutcome: outcome, params, tooling, adapters: ADAPTERS,
  });
};

// -- strict reference parsing ---------------------------------------------------

test('parseSourceRef accepts exactly the three documented shapes', () => {
  assert.deepEqual(parseSourceRef('CONTRIBUTING.md'), { path: 'CONTRIBUTING.md', from: null, to: null });
  assert.deepEqual(parseSourceRef('CONTRIBUTING.md#L245'), { path: 'CONTRIBUTING.md', from: 245, to: 245 });
  assert.deepEqual(parseSourceRef('a/b/c.yml#L10-L20'), { path: 'a/b/c.yml', from: 10, to: 20 });
  assert.deepEqual(parseSourceRef('x#L7-L7'), { path: 'x', from: 7, to: 7 });
});

test('parseSourceRef refuses every other shape rather than coercing it', () => {
  const malformed = [
    'file.md#245', 'file.md#Labc', 'file.md#L0', 'file.md#L01x', 'file.md#L10-L5',
    'file.md#L10-', 'file.md#L-5', 'file.md#', 'file.md#L1#L2', '#L1', '', '   ',
  ];
  for (const reference of malformed) {
    assert.throws(() => parseSourceRef(reference), MalformedReferenceError, `${JSON.stringify(reference)} must be refused`);
  }
});

// -- the file adapter ------------------------------------------------------------

test('the file adapter refuses to read outside the repository', () => {
  for (const path of ['/etc/passwd', 'C:/Windows/win.ini', '../outside.txt', 'a/../../b.txt', '']) {
    assert.throws(() => assertRepositoryRelative(path), PathOutsideRepositoryError, `${path} must be refused`);
  }
});

test('the file adapter normalises CRLF so line endings cannot fake a divergence', () => {
  const { root } = repoWithCommit({ 'a.txt': 'x\n' }, 'crlf-adapter');
  writeFileSync(join(root, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
  writeFileSync(join(root, 'lf.txt'), 'one\ntwo\nthree\n');

  assert.equal(readFileText(root, 'crlf.txt'), readFileText(root, 'lf.txt'));
});

test('the file adapter refuses a file that is not valid UTF-8', () => {
  const { root } = repoWithCommit({ 'a.txt': 'x\n' }, 'binary-adapter');
  writeFileSync(join(root, 'latin1.txt'), Buffer.from([0x6f, 0x6b, 0x0a, 0x66, 0xe9, 0x0a]));

  assert.throws(() => readFileText(root, 'latin1.txt'), FileUndecodableError);
});

// -- citation verification, the fixture matrix -------------------------------------

/** A repository holding one cited document. */
function citedRepo(label, contents) {
  const { root } = repoWithCommit({ 'a.txt': 'x\n', ...contents }, label);
  return root;
}

const RULE = '^(feat|fix)\\/[a-z0-9._-]+$';
const DOC = `# Contributing\n\n## Branch Naming\n\n${RULE}\n\nmore text\n`;

const verify = (root, reference, expected) => verifyCitation({
  root, reference, expected, label: 'the rule', tracked: new Set(readTrackedPaths(root)),
});

test('fixture MATCH: the cited line holds the declared value', () => {
  const root = citedRepo('parity-match', { 'CONTRIBUTING.md': DOC });
  const verdict = verify(root, 'CONTRIBUTING.md#L5', RULE);

  assert.equal(verdict.status, STATUS.PASS);
  assert.equal(verdict.observed.lines.from, 5);
  assert.match(verdict.observed.expectedHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(verdict.observed.observedHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(verdict.observed.expectedHash, verdict.observed.observedHash, 'line 5 is exactly the rule');
});

test('fixture MATCH: a cited range holds a multi-line value exactly', () => {
  const root = citedRepo('parity-range', { 'CONTRIBUTING.md': DOC });
  assert.equal(verify(root, 'CONTRIBUTING.md#L3-L5', `## Branch Naming\n\n${RULE}`).status, STATUS.PASS);
});

test('fixture MATCH: a range wider than the value is a divergence, not a pass', () => {
  // Under containment this passed, because the value was somewhere inside the
  // range. Exact comparison says the citation names more than the value.
  const root = citedRepo('parity-range-wide', { 'CONTRIBUTING.md': DOC });
  assert.equal(verify(root, 'CONTRIBUTING.md#L3-L6', RULE).status, STATUS.FAIL);
});

test('fixture DIVERGENCE: the cited line holds something else entirely', () => {
  const root = citedRepo('parity-diverge', { 'CONTRIBUTING.md': DOC });
  const verdict = verify(root, 'CONTRIBUTING.md#L5', '^(release|hotfix)\\/.+$');

  assert.equal(verdict.status, STATUS.FAIL);
  assert.match(verdict.reason, /does not hold the declared value/);
  assert.deepEqual(verdict.observed.foundAtLines, [], 'and it is nowhere in the file');
  assert.notEqual(verdict.observed.expectedHash, verdict.observed.observedHash);
});

test('fixture SHIFTED LINE: a match elsewhere does not validate a wrong citation', () => {
  // The rule moved from line 5 to line 8. The citation still says 5.
  const shifted = `# Contributing\n\n## Branch Naming\n\ninserted\ninserted\ninserted\n${RULE}\n`;
  const root = citedRepo('parity-shifted', { 'CONTRIBUTING.md': shifted });

  const verdict = verify(root, 'CONTRIBUTING.md#L5', RULE);

  assert.equal(verdict.status, STATUS.FAIL, 'a wrong line number is a wrong citation, whatever the file contains');
  assert.deepEqual(verdict.observed.foundAtLines, [8]);
  assert.match(verdict.reason, /it appears at line\(s\) 8, which makes the citation wrong rather than the value/);

  // And citing the right line passes, which proves the fixture is otherwise sound.
  assert.equal(verify(root, 'CONTRIBUTING.md#L8', RULE).status, STATUS.PASS);
});

test('fixture ABSENT SOURCE: an untracked cited file is inconclusive, never a pass', () => {
  const root = citedRepo('parity-absent', { 'CONTRIBUTING.md': DOC });
  const verdict = verify(root, 'docs/does-not-exist.md#L5', RULE);

  assert.equal(verdict.status, STATUS.UNKNOWN);
  assert.equal(verdict.observed.sourceTracked, false);
});

test('fixture ABSENT SOURCE: a citation past the end of the file is inconclusive', () => {
  const root = citedRepo('parity-past-eof', { 'CONTRIBUTING.md': DOC });
  const verdict = verify(root, 'CONTRIBUTING.md#L900', RULE);

  assert.equal(verdict.status, STATUS.UNKNOWN);
  assert.match(verdict.reason, /points past the end of the file/);
  assert.equal(verdict.observed.fileLines, DOC.split('\n').length);
});

test('fixture AMBIGUOUS: a citation with no line is not compared at all', () => {
  const root = citedRepo('parity-no-line', { 'CONTRIBUTING.md': DOC });
  const verdict = verify(root, 'CONTRIBUTING.md', RULE);

  assert.equal(verdict.status, STATUS.UNKNOWN);
  assert.match(verdict.reason, /a match anywhere in a file does not verify a location/);
});

test('fixture AMBIGUOUS: a malformed reference and an empty value are inconclusive', () => {
  const root = citedRepo('parity-ambiguous', { 'CONTRIBUTING.md': DOC });

  const malformed = verify(root, 'CONTRIBUTING.md#L0', RULE);
  assert.equal(malformed.status, STATUS.UNKNOWN);
  assert.equal(malformed.observed.malformed, true);

  const empty = verify(root, 'CONTRIBUTING.md#L5', '   ');
  assert.equal(empty.status, STATUS.UNKNOWN);
  assert.match(empty.reason, /nothing determinate to look for/);
});

test('fixture CRLF: the same document with CRLF endings verifies identically', () => {
  const root = citedRepo('parity-crlf', { 'a.txt': 'x\n' });
  writeFileSync(join(root, 'CONTRIBUTING.md'), DOC.replaceAll('\n', '\r\n'));
  git(root, 'add', '-A');

  const crlf = verify(root, 'CONTRIBUTING.md#L5', RULE);
  assert.equal(crlf.status, STATUS.PASS);

  const lfRoot = citedRepo('parity-lf', { 'CONTRIBUTING.md': DOC });
  const lf = verify(lfRoot, 'CONTRIBUTING.md#L5', RULE);

  assert.equal(crlf.observed.observedHash, lf.observed.observedHash, 'line endings must not change the hash of a cited region');
  assert.equal(crlf.observed.fileHash, lf.observed.fileHash);
});

test('fixture NON-UTF8: an undecodable cited file is inconclusive, never a pass or a fail', () => {
  const root = citedRepo('parity-binary', { 'a.txt': 'x\n' });
  writeFileSync(join(root, 'CONTRIBUTING.md'), Buffer.concat([
    Buffer.from('# Contributing\n\n'), Buffer.from([0x66, 0xe9, 0x0a]), Buffer.from(RULE),
  ]));
  git(root, 'add', '-A');

  const verdict = verify(root, 'CONTRIBUTING.md#L3', RULE);
  assert.equal(verdict.status, STATUS.UNKNOWN);
  assert.equal(verdict.observed.undecodable, true);
});

test('evidence carries source, location, expected, observed and both hashes', () => {
  const root = citedRepo('parity-evidence', { 'CONTRIBUTING.md': DOC });
  const { observed } = verify(root, 'CONTRIBUTING.md#L5', RULE);

  for (const field of ['label', 'source', 'path', 'lines', 'expected', 'expectedHash', 'observed', 'observedHash', 'fileHash', 'fileLines']) {
    assert.ok(Object.hasOwn(observed, field), `evidence must carry "${field}"`);
  }
  assert.equal(observed.source, 'CONTRIBUTING.md#L5');
  assert.deepEqual(observed.lines, { from: 5, to: 5 });
});

test('a secret in a cited region is redacted before it is stored or hashed', () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
  const root = citedRepo('parity-secret', { 'ci.yml': `steps:\n  token: ${secret}\n` });

  const verdict = verify(root, 'ci.yml#L2', `token: ${secret}`);
  assert.equal(verdict.status, STATUS.PASS);
  assert.equal(verdict.observed.observed.includes('ghp_'), false, 'the excerpt must not carry the token');
  assert.match(verdict.observed.observed, /<redacted:github-token>/);
});

// -- parity.declaration-source ------------------------------------------------------

test('parity.declaration-source: PASS when every command sits at its cited line', () => {
  const root = citedRepo('decl-pass', { '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - run: go test ./...\n' });
  const tooling = { commands: [{ id: 'test', run: 'go test ./...', source: '.github/workflows/ci.yml#L4', format: 'yaml-run', appliesTo: ['go.mod'] }] };

  const outcome = evaluateCheck('parity.declaration-source', { root, tooling });
  assert.equal(outcome.status, STATUS.PASS, outcome.reason);
});

test('parity.declaration-source: FAIL catches a command that was never in the file', () => {
  // This is the exact defect this delivery was built for: `go build ./...` was
  // a command I wrote into the policy from memory. It is not in the workflow.
  const root = citedRepo('decl-fabricated', { '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - run: go test ./...\n' });
  const tooling = { commands: [{ id: 'build', run: 'go build ./...', source: '.github/workflows/ci.yml#L4', format: 'yaml-run', appliesTo: ['go.mod'] }] };

  const outcome = evaluateCheck('parity.declaration-source', { root, tooling });
  assert.equal(outcome.status, STATUS.FAIL);
  assert.match(outcome.reason, /command "build"/);
});

test('parity.declaration-source: one unverifiable citation makes the whole check UNKNOWN, not PASS', () => {
  const root = citedRepo('decl-partial', { '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - run: go test ./...\n' });
  const tooling = { commands: [
    { id: 'test', run: 'go test ./...', source: '.github/workflows/ci.yml#L4', format: 'yaml-run', appliesTo: ['go.mod'] },
    { id: 'lint', run: 'golangci-lint run', source: '.golangci.yml#L1', format: 'yaml-run', appliesTo: ['go.mod'] },
  ] };

  const outcome = evaluateCheck('parity.declaration-source', { root, tooling });
  assert.equal(outcome.status, STATUS.UNKNOWN, 'a partially verified set is not a verified set');
});

test('parity.declaration-source: a proven divergence outranks an unverifiable one', () => {
  const root = citedRepo('decl-precedence', { '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - run: go test ./...\n' });
  const tooling = { commands: [
    { id: 'build', run: 'go build ./...', source: '.github/workflows/ci.yml#L4', format: 'yaml-run', appliesTo: ['go.mod'] },
    { id: 'lint', run: 'golangci-lint run', source: '.golangci.yml#L1', format: 'yaml-run', appliesTo: ['go.mod'] },
  ] };

  assert.equal(evaluateCheck('parity.declaration-source', { root, tooling }).status, STATUS.FAIL);
});

// -- exact command comparison ------------------------------------------------------

const workflow = (lines) => lines.join('\n') + '\n';
const CI = workflow([
  'jobs:',
  '  unit:',
  '    steps:',
  '      - name: Run unit tests',
  '        run: go test ./... -count=1',
  '      - name: Build',
  '        run: |',
  '          go build -o out ./cmd/x',
  '          ls -la out',
]);

const verifyRun = (root, reference, expected) => verifyCitation({
  root, reference, expected, label: 'command "test"', tracked: new Set(readTrackedPaths(root)), match: 'yaml-run',
});

test('REGRESSION: a prefix of the real command does not validate the citation', () => {
  const root = citedRepo('exact-prefix', { 'ci.yml': CI });

  // The exact defect this correction closes: containment accepted this.
  const verdict = verifyRun(root, 'ci.yml#L5', 'go test ./...');
  assert.equal(verdict.status, STATUS.FAIL, '"go test ./..." is not "go test ./... -count=1"');
  assert.match(verdict.reason, /does not hold the declared value/);

  assert.equal(verifyRun(root, 'ci.yml#L5', 'go test ./... -count=1').status, STATUS.PASS);
});

test('REGRESSION: an extra flag on either side is a divergence', () => {
  const root = citedRepo('exact-flags', { 'ci.yml': CI });
  assert.equal(verifyRun(root, 'ci.yml#L5', 'go test ./... -count=1 -race').status, STATUS.FAIL);
  assert.equal(verifyRun(root, 'ci.yml#L5', 'test ./... -count=1').status, STATUS.FAIL);
});

test('the run field is read, so surrounding YAML never counts as the command', () => {
  const root = citedRepo('exact-field', { 'ci.yml': CI });
  const verdict = verifyRun(root, 'ci.yml#L5', 'go test ./... -count=1');

  assert.equal(verdict.status, STATUS.PASS);
  assert.equal(verdict.observed.comparedValue, 'go test ./... -count=1', 'the indentation and the key are not part of the value');
  assert.equal(verdict.observed.match, 'yaml-run');
});

test('a multi-line block is supported when its whole range is cited', () => {
  const root = citedRepo('exact-block', { 'ci.yml': CI });
  const whole = verifyRun(root, 'ci.yml#L7-L9', 'go build -o out ./cmd/x\nls -la out');

  assert.equal(whole.status, STATUS.PASS);
  assert.equal(whole.observed.comparedValue, 'go build -o out ./cmd/x\nls -la out', 'the block is dedented, not reindented');
});

test('a block cited only at its opening line is UNKNOWN, not a comparison', () => {
  const root = citedRepo('exact-block-partial', { 'ci.yml': CI });
  const verdict = verifyRun(root, 'ci.yml#L7', 'go build -o out ./cmd/x');

  assert.equal(verdict.status, STATUS.UNKNOWN);
  assert.match(verdict.reason, /cite the whole block as a range/);
  assert.equal(verdict.observed.ambiguousRegion, true);
});

test('a partially cited block is a divergence, not a partial pass', () => {
  const root = citedRepo('exact-block-half', { 'ci.yml': CI });
  assert.equal(verifyRun(root, 'ci.yml#L7-L8', 'go build -o out ./cmd/x\nls -la out').status, STATUS.FAIL);
  assert.equal(verifyRun(root, 'ci.yml#L7-L8', 'go build -o out ./cmd/x').status, STATUS.PASS);
});

test('a region this reader cannot interpret unambiguously is UNKNOWN', () => {
  const root = citedRepo('exact-ambiguous', {
    'ci.yml': workflow([
      'steps:',
      '  - run: go test ./...',
      '  - run: go vet ./...',
      '  - name: no command here',
      '  - run: echo hi # a trailing comment',
      '  - run: >',
      '      folded command',
    ]),
  });

  const cases = {
    'two run entries in the range': ['ci.yml#L2-L3', 'go test ./...', /2 "run:" entries/],
    'no run entry at all': ['ci.yml#L4', 'anything', /holds no YAML "run:" entry/],
    'plain scalar with a possible comment': ['ci.yml#L5', 'echo hi', /YAML reads as a comment/],
    'folded block scalar': ['ci.yml#L6-L7', 'folded command', /folded block scalars/],
  };

  for (const [label, [reference, expected, pattern]] of Object.entries(cases)) {
    const verdict = verifyRun(root, reference, expected);
    assert.equal(verdict.status, STATUS.UNKNOWN, `${label} must be inconclusive`);
    assert.match(verdict.reason, pattern, label);
  }
});

test('a quoted scalar is compared by its value, not with its quotes', () => {
  const root = citedRepo('exact-quoted', { 'ci.yml': workflow(['steps:', '  - run: "go test ./..."']) });
  assert.equal(verifyRun(root, 'ci.yml#L2', 'go test ./...').status, STATUS.PASS);
});

test('literal mode compares the whole cited region exactly, not by containment', () => {
  const root = citedRepo('exact-literal', { 'RULES.md': 'intro\n^(feat|fix)\\/[a-z]+$\noutro\n' });
  const literal = (expected, reference = 'RULES.md#L2') => verifyCitation({
    root, reference, expected, label: 'the rule', tracked: new Set(readTrackedPaths(root)), match: 'literal',
  });

  assert.equal(literal('^(feat|fix)\\/[a-z]+$').status, STATUS.PASS);
  assert.equal(literal('^(feat|fix)').status, STATUS.FAIL, 'a prefix of the line is not the line');
});

test('the found-elsewhere diagnosis never turns a divergence into a pass', () => {
  const root = citedRepo('exact-diagnosis', { 'ci.yml': CI });
  // Cite the test step, but declare the build command. The build command lives
  // at line 8; the citation still fails, and line 8 is reported as diagnosis.
  const verdict = verifyRun(root, 'ci.yml#L5', 'go build -o out ./cmd/x');

  assert.equal(verdict.status, STATUS.FAIL);
  assert.deepEqual(verdict.observed.foundAtLines, [8], 'the real location is reported as diagnosis');
});

// -- go.mod parsing -----------------------------------------------------------

test('parseGoMod reads both directive forms, and comments do not count', () => {
  assert.deepEqual(parseGoMod('module x\n\ngo 1.25\n'), { requires: [], replaces: [] });
  assert.deepEqual(parseGoMod('require example.com/a v1.0.0\n').requires, ['example.com/a']);
  assert.deepEqual(parseGoMod('require (\n\ta v1\n\tb v2 // indirect\n)\n').requires, ['a', 'b']);
  assert.deepEqual(parseGoMod('// require a v1\n').requires, []);
  assert.deepEqual(parseGoMod('require (\n)\n').requires, []);
});

test('parseGoMod reads replace directives and classifies the target', () => {
  const single = parseGoMod('replace example.com/a => ../local/a\n');
  assert.deepEqual(single.replaces, [{ from: 'example.com/a', to: '../local/a', local: true }]);

  const block = parseGoMod('replace (\n\texample.com/a => ./vendor/a\n\texample.com/b => example.com/fork v1.2.3\n)\n');
  assert.deepEqual(block.replaces.map((r) => [r.from, r.local]), [['example.com/a', true], ['example.com/b', false]]);

  assert.deepEqual(parseGoMod('replace example.com/a v1.0.0 => /abs/path\n').replaces[0].local, true);
});

test('isLocalReplacement distinguishes a filesystem path from a module path', () => {
  for (const target of ['./a', '../a', '/abs/a', 'C:/a', 'C:\\a', '.\\a']) {
    assert.equal(isLocalReplacement(target), true, `${target} is local`);
  }
  for (const target of ['example.com/fork', 'github.com/x/y v1.0.0', 'golang.org/x/tools']) {
    assert.equal(isLocalReplacement(target), false, `${target} is remote`);
  }
});

test('parseGoMod refuses an unterminated block or a broken replace instead of guessing', () => {
  assert.throws(() => parseGoMod('require (\n\ta v1\n'), /never closed/);
  assert.throws(() => parseGoMod('replace (\n\ta => b\n'), /never closed/);
  assert.throws(() => parseGoMod('replace example.com/a\n'), /without "=>"/);
});

// -- parity.go-module-lockfile ---------------------------------------------------------

test('go module: FAIL when a remote requirement is declared and no go.sum is tracked', () => {
  const root = citedRepo('gomod-missing', { 'go.mod': 'module example\n\ngo 1.25\n\nrequire example.com/a v1.0.0\n' });
  const outcome = evaluateCheck('parity.go-module-lockfile', { root });

  assert.equal(outcome.status, STATUS.FAIL);
  assert.match(outcome.reason, /1 unresolved/);
});

test('go module: PASS when the remote requirement is matched by a tracked go.sum', () => {
  const root = citedRepo('gomod-pass', {
    'go.mod': 'module example\n\ngo 1.25\n\nrequire example.com/a v1.0.0\n',
    'go.sum': 'example.com/a v1.0.0 h1:abc=\n',
  });
  assert.equal(evaluateCheck('parity.go-module-lockfile', { root }).status, STATUS.PASS);
});

test('REGRESSION: every requirement replaced by a local directory is UNKNOWN, never FAIL', () => {
  // Go needs no go.sum here, so calling the absence a violation would be wrong.
  // But the transitive requirements of ../local/a are invisible from here, so
  // calling it a pass would also be wrong.
  const root = citedRepo('gomod-local-replace', {
    'go.mod': 'module example\n\ngo 1.25\n\nrequire example.com/a v1.0.0\n\nreplace example.com/a => ../local/a\n',
  });
  const outcome = evaluateCheck('parity.go-module-lockfile', { root });

  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.match(outcome.reason, /resolve every declared requirement through a local replace/);
  assert.match(outcome.reason, /cannot be read without executing Go tooling/);
});

test('REGRESSION: a partial local replace still demands a go.sum for what remains remote', () => {
  const root = citedRepo('gomod-partial-replace', {
    'go.mod': 'module example\n\ngo 1.25\n\nrequire (\n\texample.com/a v1.0.0\n\texample.com/b v2.0.0\n)\n\nreplace example.com/a => ../local/a\n',
  });
  const outcome = evaluateCheck('parity.go-module-lockfile', { root });

  assert.equal(outcome.status, STATUS.FAIL);
  assert.match(outcome.reason, /1 unresolved/, 'only example.com/b remains remote');
});

test('REGRESSION: a remote replace is still a remote dependency', () => {
  const root = citedRepo('gomod-remote-replace', {
    'go.mod': 'module example\n\ngo 1.25\n\nrequire example.com/a v1.0.0\n\nreplace example.com/a => example.com/fork v1.2.3\n',
  });
  assert.equal(evaluateCheck('parity.go-module-lockfile', { root }).status, STATUS.FAIL, 'replacing with a module still downloads');
});

test('REGRESSION: a residual go.sum beside a module declaring nothing is recorded, not judged', () => {
  // Nothing prunes go.sum until `go mod tidy` runs, so a leftover file is not
  // a violation this check can prove.
  const root = citedRepo('gomod-residual', {
    'go.mod': 'module example\n\ngo 1.25\n',
    'go.sum': 'example.com/old v0.9.0 h1:stale=\n',
  });
  const outcome = evaluateCheck('parity.go-module-lockfile', { root });

  assert.equal(outcome.status, STATUS.PASS);
  assert.match(outcome.reason, /recorded but not judged/);
  assert.equal(outcome.evidence[0].observed.modules[0].lockfileTracked, true, 'presence is observed, not assumed');
});

test('go module: a module declaring nothing and tracking nothing is reported factually', () => {
  const root = citedRepo('gomod-bench', {
    'go.mod': 'module example\n\ngo 1.25\n\nrequire example.com/a v1.0.0\n',
    'go.sum': 'example.com/a v1.0.0 h1:abc=\n',
    'bench/go.mod': 'module example/bench\n\ngo 1.25\n',
  });
  const outcome = evaluateCheck('parity.go-module-lockfile', { root });

  assert.equal(outcome.status, STATUS.PASS);
  assert.match(outcome.reason, /1 declare no requirement at all/);

  const bench = outcome.evidence[0].observed.modules.find((m) => m.manifest === 'bench/go.mod');
  assert.equal(bench.lockfileTracked, false, 'absence is observed, not assumed');
  assert.equal(bench.requires, 0);
});

test('go module: the rule is declared as ours and disclaims being a Go rule', () => {
  const root = citedRepo('gomod-authority', {
    'go.mod': 'module example\n\ngo 1.25\n\nrequire example.com/a v1.0.0\n',
    'go.sum': 'example.com/a v1.0.0 h1:abc=\n',
  });
  const { observed } = evaluateCheck('parity.go-module-lockfile', { root }).evidence[0];

  assert.equal(observed.authority, 'ours');
  assert.match(observed.notAGoRule, /Go itself does not require a go\.sum whenever a require exists/);
  assert.match(observed.scope, /go\.sum contents are never verified/);
});

test('go module: UNKNOWN when a go.mod cannot be decoded or parsed', () => {
  const binary = citedRepo('gomod-binary', { 'go.mod': 'module example\n' });
  writeFileSync(join(binary, 'go.mod'), Buffer.from([0x6d, 0x6f, 0x64, 0xff, 0xfe, 0x0a]));
  git(binary, 'add', '-A');
  assert.equal(evaluateCheck('parity.go-module-lockfile', { root: binary }).status, STATUS.UNKNOWN);

  const broken = citedRepo('gomod-unterminated', { 'go.mod': 'module example\n\nrequire (\n\ta v1\n' });
  const outcome = evaluateCheck('parity.go-module-lockfile', { root: broken });
  assert.equal(outcome.status, STATUS.UNKNOWN);
  assert.match(outcome.reason, /never closed/);
  assert.match(outcome.remediation, /Correct the encoding or directive syntax/);
});

test('go module: UNKNOWN when there is no Go module at all', () => {
  const root = citedRepo('gomod-none', { 'package.json': '{}\n' });
  assert.equal(evaluateCheck('parity.go-module-lockfile', { root }).status, STATUS.UNKNOWN);
});
