// The repository a policy is allowed to run against.
//
// The defect these tests pin: the bundled gentle-ai policy, run against the
// workspace repository, produced 2 FAIL and 3 UNKNOWN rows about a
// CONTRIBUTING.md, a ci.yml and a go.mod belonging to a different repository.
// Every row was confident and every row was a category error.
//
// The second defect: the remote url was recorded in the evidence, redacted.
// Redaction removes credentials that match known shapes and proves nothing
// about the ones that do not, so the url is no longer recorded at all. The
// tests below prove that by construction -- every secret-bearing case asserts
// the secret really is in the input, and then that it is nowhere in the output.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkRepositoryIdentity, parseRemoteUrl, normaliseIdentity, IDENTITY_REFUSAL, TRANSPORT,
} from '../lib/repository-identity.mjs';
import { readRemoteUrl } from '../lib/adapters/git.mjs';
import { runPreflight, FAILURE_CODE } from '../lib/preflight.mjs';
import { validateResult } from '../lib/validate.mjs';
import { STATUS } from '../lib/status.mjs';
import { git, repoWithCommit, initRepo, makeDirectory, FIXTURE_REPOSITORY, cleanupAll } from './helpers/repo.mjs';

after(cleanupAll);

const scratch = mkdtempSync(join(tmpdir(), 'audit-identity-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;

const EXPECTED = FIXTURE_REPOSITORY.expected;

/** Point a fixture repository's `origin` at an arbitrary url. */
function withRemote(url, label = 'identity') {
  const { root } = repoWithCommit({ 'a.txt': 'alpha\n' }, `${label}-${sequence += 1}`);
  git(root, 'remote', 'set-url', 'origin', url);
  return root;
}

const identityOf = (root) =>
  checkRepositoryIdentity({ root, expected: EXPECTED, remote: 'origin', readRemoteUrl });

/**
 * The whole-object assertion every secret-bearing case uses.
 *
 * Not `evidence.url`: the point is that no field anywhere holds the secret, so
 * the assertion is made against the ENTIRE serialized result -- reason,
 * remediation, refusal, and every evidence item including its nested `observed`
 * and `failure`. Checking one named field would keep passing the day someone
 * puts the url somewhere else.
 */
function assertNoSecret(result, secret, label) {
  const serialised = JSON.stringify(result);
  assert.equal(serialised.includes(secret), false,
    `${label}: the secret must appear nowhere in the serialized result`);
  assert.equal(JSON.stringify(result.evidence).includes(secret), false,
    `${label}: the secret must appear nowhere in the serialized evidence`);

  // Regression guard: reintroducing the field fails here even if it happens to
  // hold a value with no secret in it that day.
  for (const item of result.evidence) {
    assert.equal(Object.hasOwn(item.observed, 'url'), false,
      `${label}: no evidence entry may carry a url field`);
  }
}

// -- parsing -------------------------------------------------------------------

test('every supported url form for one repository resolves to the same identity', () => {
  const forms = [
    ['https://github.com/Owner/Repo.git', TRANSPORT.HTTPS],
    ['https://github.com/Owner/Repo', TRANSPORT.HTTPS],
    ['https://github.com/Owner/Repo/', TRANSPORT.HTTPS],
    ['https://github.com/Owner/Repo.git/', TRANSPORT.HTTPS],
    ['https://user:token@github.com/Owner/Repo.git', TRANSPORT.HTTPS],
    ['https://github.com:443/Owner/Repo.git', TRANSPORT.HTTPS],
    ['HTTPS://github.com/Owner/Repo.git', TRANSPORT.HTTPS],
    ['ssh://git@github.com/Owner/Repo.git', TRANSPORT.SSH_URL],
    ['ssh://git@github.com:22/Owner/Repo.git', TRANSPORT.SSH_URL],
    ['SSH://git@github.com/Owner/Repo.git', TRANSPORT.SSH_URL],
    ['git@github.com:Owner/Repo.git', TRANSPORT.SSH_SCP],
    ['git@github.com:Owner/Repo', TRANSPORT.SSH_SCP],
    ['github.com:Owner/Repo.git', TRANSPORT.SSH_SCP],
  ];

  for (const [url, transport] of forms) {
    assert.deepEqual(parseRemoteUrl(url), {
      host: 'github.com', owner: 'Owner', name: 'Repo', transport,
    }, url);
  }
});

test('http:// and git:// no longer parse, which is a deliberate tightening', () => {
  // Both used to resolve to a normal identity. The scheme list is now an
  // allowlist of exactly https and ssh, so a form that is not one of the three
  // supported shapes cannot reach PASS by being "close enough".
  assert.equal(parseRemoteUrl('http://github.com/Owner/Repo.git'), null);
  assert.equal(parseRemoteUrl('git://github.com/Owner/Repo.git'), null);
});

test('the original casing is preserved, because that is what the repository says', () => {
  assert.deepEqual(parseRemoteUrl('https://GitHub.COM/Gentleman-Programming/Gentle-AI.git'), {
    host: 'GitHub.COM', owner: 'Gentleman-Programming', name: 'Gentle-AI', transport: TRANSPORT.HTTPS,
  });
});

test('exactly one trailing .git is stripped', () => {
  assert.equal(parseRemoteUrl('https://github.com/o/thing.git.git').name, 'thing.git');
  assert.equal(parseRemoteUrl('https://github.com/o/thing.github').name, 'thing.github');
});

test('a url this reader cannot resolve is null, never a guess', () => {
  const malformed = [
    '', '   ', '\n\t',
    'https://',
    'https:///Owner/Repo.git',
    'https://github.com',
    'https://github.com/',
    'https://github.com/Owner',
    'https://github.com/Owner/',
    'https://github.com/a/b/c',
    'https://github.com/a//b',
    'https://github.com/Owner/.git',
    '/home/contributor/projects/gentle',
    'C:\\Users\\contributor\\projects\\gentle',
    'C:/Users/contributor/projects/gentle',
    'not a url at all',
    'github.com/Owner/Repo',
    // A bare word is not a host: this is a directory called "somedir", not a
    // remote, and reading it as one is how a local path becomes an identity.
    'somedir:Owner/Repo',
    'localhost:Owner/Repo',
  ];

  for (const url of malformed) {
    assert.equal(parseRemoteUrl(url), null, JSON.stringify(url));
  }

  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(parseRemoteUrl(value), null, JSON.stringify(value));
  }
});

test('every scheme outside the allowlist is refused, known or not', () => {
  const refused = [
    'http://github.com/Owner/Repo.git',
    'git://github.com/Owner/Repo.git',
    'ftp://github.com/Owner/Repo.git',
    'svn+ssh://github.com/Owner/Repo.git',
    'file://github.com/Owner/Repo',
    'file:///C:/repos/gentle-ai',
    'file:///srv/git/Owner/Repo',
    'ftps://github.com/Owner/Repo.git',
    'rsync://github.com/Owner/Repo.git',
    'wibble://github.com/Owner/Repo.git',
  ];

  for (const url of refused) {
    assert.equal(parseRemoteUrl(url), null, url);
  }
});

test('a query or a fragment refuses the whole url, because either can carry a token', () => {
  const carrying = [
    'https://github.com/Owner/Repo.git?access_token=ghp_BBBBBBBBBBBBBBBBBBBB',
    'https://github.com/Owner/Repo.git#token=ghp_CCCCCCCCCCCCCCCCCCCC',
    'https://github.com/Owner/Repo?x=1',
    'https://github.com/Owner/Repo#anchor',
    'git@github.com:Owner/Repo.git?x=1',
    'ssh://git@github.com/Owner/Repo.git#f',
  ];

  for (const url of carrying) {
    assert.equal(parseRemoteUrl(url), null, url);
  }
});

test('normalisation folds case and whitespace, and nothing else', () => {
  assert.deepEqual(normaliseIdentity({ host: ' GitHub.COM ', owner: 'Gentleman-Programming', name: 'Gentle-AI' }), {
    host: 'github.com', owner: 'gentleman-programming', name: 'gentle-ai',
  });
});

test('the transport is not part of the identity: three forms, one repository', () => {
  const https = parseRemoteUrl('https://github.com/Gentleman-Programming/gentle-ai.git');
  const sshUrl = parseRemoteUrl('ssh://git@github.com/Gentleman-Programming/gentle-ai.git');
  const sshScp = parseRemoteUrl('git@github.com:Gentleman-Programming/gentle-ai.git');

  // Three genuinely different transports...
  assert.deepEqual(
    [https.transport, sshUrl.transport, sshScp.transport],
    [TRANSPORT.HTTPS, TRANSPORT.SSH_URL, TRANSPORT.SSH_SCP]
  );
  assert.equal(new Set([https.transport, sshUrl.transport, sshScp.transport]).size, 3);

  // ...and one identity. A policy must not pass or fail on how you connect.
  const identity = { host: 'github.com', owner: 'gentleman-programming', name: 'gentle-ai' };
  assert.deepEqual(normaliseIdentity(https), identity);
  assert.deepEqual(normaliseIdentity(sshUrl), identity);
  assert.deepEqual(normaliseIdentity(sshScp), identity);
});

// -- the decision, over real repositories --------------------------------------

test('the declared repository over HTTPS passes', () => {
  const root = repoWithCommit({ 'a.txt': 'alpha\n' }, 'identity-https').root;
  assert.equal(readRemoteUrl(root, 'origin'), 'https://github.com/Gentleman-Programming/gentle-ai.git');

  const result = identityOf(root);
  assert.equal(result.status, STATUS.PASS);
  assert.equal(result.refusal, null);
  assert.equal(result.evidence.length, 1);
  assert.deepEqual(result.evidence[0].observed.observed, {
    host: 'github.com', owner: 'Gentleman-Programming', name: 'gentle-ai',
  });
  assert.equal(result.evidence[0].observed.transport, TRANSPORT.HTTPS);
});

test('the declared repository over SSH passes, and resolves to the same identity as HTTPS', () => {
  const root = withRemote('git@github.com:Gentleman-Programming/gentle-ai.git', 'identity-ssh');

  const result = identityOf(root);
  assert.equal(result.status, STATUS.PASS);
  assert.equal(result.refusal, null);
  assert.equal(result.evidence[0].observed.transport, TRANSPORT.SSH_SCP);

  // The property that matters: the transport must not change the identity.
  assert.deepEqual(
    normaliseIdentity(parseRemoteUrl('git@github.com:Gentleman-Programming/gentle-ai.git')),
    normaliseIdentity(parseRemoteUrl('https://github.com/Gentleman-Programming/gentle-ai.git'))
  );
});

test('the declared repository over ssh:// passes too', () => {
  const root = withRemote('ssh://git@github.com/Gentleman-Programming/gentle-ai.git', 'identity-ssh-url');

  const result = identityOf(root);
  assert.equal(result.status, STATUS.PASS);
  assert.equal(result.evidence[0].observed.transport, TRANSPORT.SSH_URL);
});

test('the evidence carries exactly the four documented facts, and no url', () => {
  const root = repoWithCommit({ 'a.txt': 'alpha\n' }, 'identity-evidence-shape').root;

  const { observed } = identityOf(root).evidence[0];
  assert.deepEqual(Object.keys(observed).sort(), ['expected', 'observed', 'remote', 'transport']);
  assert.equal(observed.remote, 'origin');
  assert.deepEqual(observed.expected, EXPECTED);
});

test('another repository is a FAIL, with both identities on record', () => {
  const root = withRemote('https://github.com/Someone-Else/other-project.git', 'identity-wrong');

  const result = identityOf(root);
  assert.equal(result.status, STATUS.FAIL, 'a mismatch is a fact about the repository, not a gap in the reading');
  assert.equal(result.refusal, IDENTITY_REFUSAL.MISMATCH);

  const { observed } = result.evidence[0];
  assert.deepEqual(observed.expected, EXPECTED);
  assert.deepEqual(observed.observed, { host: 'github.com', owner: 'Someone-Else', name: 'other-project' });
  assert.equal(observed.transport, TRANSPORT.HTTPS);
  assert.match(result.reason, /Gentleman-Programming\/gentle-ai/);
  assert.match(result.reason, /Someone-Else\/other-project/);
});

test('a repository with no remote is UNKNOWN, never a pass and never a mismatch', () => {
  const root = initRepo('identity-no-remote', { origin: null });
  assert.equal(readRemoteUrl(root, 'origin'), null, 'the fixture really has no remote');

  const result = identityOf(root);
  assert.equal(result.status, STATUS.UNKNOWN);
  assert.equal(result.refusal, IDENTITY_REFUSAL.REMOTE_MISSING);
  assert.equal(result.evidence[0].observed.observed, null);
  assert.equal(result.evidence[0].observed.transport, null);
  assert.equal(Object.hasOwn(result.evidence[0].observed, 'url'), false, 'no url field, on any branch');
});

test('a remote url that cannot be parsed is UNKNOWN, once per malformed shape', () => {
  const shapes = [
    '/srv/git/gentle-ai',
    'C:/Users/contributor/projects/gentle-ai',
    'https://github.com/Gentleman-Programming/gentle-ai/extra',
    'https://github.com/gentle-ai.git',
    'file:///srv/git/gentle-ai',
    // Deliberate tightening: these two used to parse and pass.
    'http://github.com/Gentleman-Programming/gentle-ai.git',
    'git://github.com/Gentleman-Programming/gentle-ai.git',
    'nonsense',
  ];

  for (const url of shapes) {
    const root = withRemote(url, 'identity-unparseable');
    const result = identityOf(root);

    assert.equal(result.status, STATUS.UNKNOWN, url);
    assert.equal(result.refusal, IDENTITY_REFUSAL.REMOTE_UNPARSEABLE, url);
    assert.equal(result.evidence[0].observed.observed, null, url);
    assert.equal(result.evidence[0].observed.transport, null, url);
  }
});

test('REGRESSION: file:// never resolves, and never reaches PASS', () => {
  // `file://` used to be accepted in some shapes. A local path says which
  // directory this is, not which repository, and the whole module exists to
  // refuse that substitution.
  const shapes = [
    'file://github.com/Gentleman-Programming/gentle-ai',
    'file:///C:/repos/gentle-ai',
  ];

  for (const url of shapes) {
    assert.equal(parseRemoteUrl(url), null, url);

    const root = withRemote(url, 'identity-file-url');
    const result = identityOf(root);
    assert.equal(result.status, STATUS.UNKNOWN, url);
    assert.notEqual(result.status, STATUS.PASS, url);
    assert.equal(result.refusal, IDENTITY_REFUSAL.REMOTE_UNPARSEABLE, url);
  }
});

test('REGRESSION: an unknown scheme is UNKNOWN over a real repository too', () => {
  const shapes = [
    'ftp://github.com/Gentleman-Programming/gentle-ai.git',
    'git://github.com/Gentleman-Programming/gentle-ai.git',
    'http://github.com/Gentleman-Programming/gentle-ai.git',
    'svn+ssh://github.com/Gentleman-Programming/gentle-ai.git',
  ];

  for (const url of shapes) {
    const root = withRemote(url, 'identity-scheme');
    const result = identityOf(root);
    assert.equal(result.status, STATUS.UNKNOWN, url);
    assert.equal(result.refusal, IDENTITY_REFUSAL.REMOTE_UNPARSEABLE, url);
  }
});

test('a read that fails is UNKNOWN and unreadable, distinct from a remote that is absent', () => {
  const failure = new Error('git exploded while reading the config');
  failure.name = 'GitCommandError';
  failure.code = 128;

  const result = checkRepositoryIdentity({
    root: makeDirectory('identity-unreadable'),
    expected: EXPECTED,
    remote: 'origin',
    readRemoteUrl: () => { throw failure; },
  });

  assert.equal(result.status, STATUS.UNKNOWN);
  assert.equal(result.refusal, IDENTITY_REFUSAL.REMOTE_UNREADABLE);
  assert.equal(result.evidence.length, 1);

  // The message is NOT interpolated: git builds it out of stderr, and stderr
  // quotes the remote url. What is recorded is structured instead.
  assert.equal(result.reason.includes('git exploded'), false,
    'no free text from the error may reach the reason');
  assert.match(result.reason, /remote "origin"/);
  assert.deepEqual(result.evidence[0].observed.failure, { name: 'GitCommandError', exitCode: 128 });
  assert.equal(result.evidence[0].observed.observed, null);
  assert.equal(result.evidence[0].observed.transport, null);
});

test('an unreadable read with no usable error still records a bounded failure', () => {
  const result = checkRepositoryIdentity({
    root: makeDirectory('identity-unreadable-bare'),
    expected: EXPECTED,
    remote: 'origin',
    readRemoteUrl: () => { throw 'a bare string, thrown'; },
  });

  assert.equal(result.status, STATUS.UNKNOWN);
  assert.deepEqual(result.evidence[0].observed.failure, { name: 'Error', exitCode: null });
});

test('the comparison is case-insensitive', () => {
  const root = withRemote('https://GITHUB.COM/GENTLEMAN-PROGRAMMING/GENTLE-AI.git', 'identity-case');

  const result = identityOf(root);
  assert.equal(result.status, STATUS.PASS);
  // What is REPORTED stays as configured; only the comparison folds case.
  assert.deepEqual(result.evidence[0].observed.observed, {
    host: 'GITHUB.COM', owner: 'GENTLEMAN-PROGRAMMING', name: 'GENTLE-AI',
  });
});

test('REGRESSION: the directory name is never the identity', () => {
  // A folder named exactly like the declared repository, holding a different
  // one. Reading the identity from the path would have passed this.
  const parent = makeDirectory('identity-by-name');
  const root = join(parent, 'gentle-ai');
  git(parent, 'init', '-q', '-b', 'main', 'gentle-ai');
  git(root, 'remote', 'add', 'origin', 'https://github.com/Someone-Else/gentle-ai.git');

  assert.equal(root.replaceAll('\\', '/').endsWith('/gentle-ai'), true, 'the folder really is named gentle-ai');

  const result = identityOf(root);
  assert.equal(result.status, STATUS.FAIL);
  assert.equal(result.refusal, IDENTITY_REFUSAL.MISMATCH);
});

// -- credentials ----------------------------------------------------------------

test('REGRESSION: a credential in the remote url reaches nothing that is reported', () => {
  const token = 'ghp_AAAAAAAAAAAAAAAAAAAA';
  const url = `https://user:${token}@github.com/Gentleman-Programming/gentle-ai.git`;

  // Positive control: without this, a test that quietly stopped looking at the
  // right value would still pass.
  assert.equal(url.includes(token), true, 'the input must really carry the token');

  const root = withRemote(url, 'identity-credential');
  assert.equal(readRemoteUrl(root, 'origin').includes(token), true, 'and git must really hold it');

  const result = identityOf(root);
  assert.equal(result.status, STATUS.PASS, 'credentials do not change which repository this is');

  assertNoSecret(result, token, 'user:password url');
  assert.equal(JSON.stringify(result).includes('user:'), false, 'nor the user:password pair it travelled in');
  assert.equal(result.reason.includes(token), false, 'and the reason is not an exception');
});

test('REGRESSION: a bare token in the userinfo reaches nothing that is reported', () => {
  const token = 'ghp_AAAAAAAAAAAAAAAAAAAA';
  const url = `https://${token}@github.com/Gentleman-Programming/gentle-ai.git`;

  assert.equal(url.includes(token), true, 'the input must really carry the token');

  const root = withRemote(url, 'identity-bare-token');
  assert.equal(readRemoteUrl(root, 'origin').includes(token), true, 'and git must really hold it');

  const result = identityOf(root);
  assert.equal(result.status, STATUS.PASS, 'a credential does not change which repository this is');
  assert.deepEqual(result.evidence[0].observed.observed, {
    host: 'github.com', owner: 'Gentleman-Programming', name: 'gentle-ai',
  });

  // Worth stating: this shape has no ":" in the userinfo, so the url-credential
  // redaction pattern would not have matched it at all. Not recording the url
  // is what makes the outcome the same either way.
  assertNoSecret(result, token, 'bare-token url');
});

test('REGRESSION: a password in the userinfo reaches nothing that is reported', () => {
  const secret = 's3cr3t-p4ssw0rd';
  const url = `https://user:${secret}@github.com/Gentleman-Programming/gentle-ai.git`;

  assert.equal(url.includes(secret), true, 'the input must really carry the password');

  const root = withRemote(url, 'identity-password');
  assert.equal(readRemoteUrl(root, 'origin').includes(secret), true, 'and git must really hold it');

  const result = identityOf(root);
  assert.equal(result.status, STATUS.PASS);
  assertNoSecret(result, secret, 'password url');
});

test('REGRESSION: a token in the query is UNKNOWN, and is never recorded', () => {
  const token = 'ghp_BBBBBBBBBBBBBBBBBBBB';
  const url = `https://github.com/Gentleman-Programming/gentle-ai.git?access_token=${token}`;

  assert.equal(url.includes(token), true, 'the input must really carry the token');
  assert.equal(parseRemoteUrl(url), null, 'a query refuses the whole url');

  const root = withRemote(url, 'identity-query-token');
  assert.equal(readRemoteUrl(root, 'origin').includes(token), true, 'and git must really hold it');

  const result = identityOf(root);
  assert.equal(result.status, STATUS.UNKNOWN);
  assert.equal(result.refusal, IDENTITY_REFUSAL.REMOTE_UNPARSEABLE);
  assertNoSecret(result, token, 'token in query');
});

test('REGRESSION: a token in the fragment is UNKNOWN, and is never recorded', () => {
  const token = 'ghp_CCCCCCCCCCCCCCCCCCCC';
  const url = `https://github.com/Gentleman-Programming/gentle-ai.git#token=${token}`;

  assert.equal(url.includes(token), true, 'the input must really carry the token');
  assert.equal(parseRemoteUrl(url), null, 'a fragment refuses the whole url');

  const root = withRemote(url, 'identity-fragment-token');
  assert.equal(readRemoteUrl(root, 'origin').includes(token), true, 'and git must really hold it');

  const result = identityOf(root);
  assert.equal(result.status, STATUS.UNKNOWN);
  assert.equal(result.refusal, IDENTITY_REFUSAL.REMOTE_UNPARSEABLE);
  assertNoSecret(result, token, 'token in fragment');
});

test('REGRESSION: every branch is walked, and no branch discloses the secret', () => {
  const secret = 'ghp_DDDDDDDDDDDDDDDDDDDD';
  const declared = `https://user:${secret}@github.com/Gentleman-Programming/gentle-ai.git`;
  const other = `https://user:${secret}@github.com/Someone-Else/other-project.git`;
  const unparseable = `https://github.com/Gentleman-Programming/gentle-ai.git?token=${secret}`;

  // Positive controls, first. If any of these stops being true the inputs have
  // drifted and the rest of the test proves nothing.
  for (const url of [declared, other, unparseable]) {
    assert.equal(url.includes(secret), true, `the input must really carry the secret: ${url}`);
  }

  // 1. PASS
  const pass = identityOf(withRemote(declared, 'identity-branch-pass'));
  assert.equal(pass.status, STATUS.PASS);
  assertNoSecret(pass, secret, 'pass branch');

  // 2. FAIL -- mismatch
  const mismatch = identityOf(withRemote(other, 'identity-branch-mismatch'));
  assert.equal(mismatch.status, STATUS.FAIL);
  assert.equal(mismatch.refusal, IDENTITY_REFUSAL.MISMATCH);
  assertNoSecret(mismatch, secret, 'mismatch branch');

  // 3. UNKNOWN -- missing. No url exists, so there is no secret to leak; the
  //    shape assertion still has to hold on this branch.
  const missing = identityOf(initRepo('identity-branch-missing', { origin: null }));
  assert.equal(missing.refusal, IDENTITY_REFUSAL.REMOTE_MISSING);
  assertNoSecret(missing, secret, 'missing branch');

  // 4. UNKNOWN -- unparseable
  const unresolved = identityOf(withRemote(unparseable, 'identity-branch-unparseable'));
  assert.equal(unresolved.refusal, IDENTITY_REFUSAL.REMOTE_UNPARSEABLE);
  assertNoSecret(unresolved, secret, 'unparseable branch');

  // 5. UNKNOWN -- unreadable. This is the branch change 3 exists for: git builds
  //    GitCommandError's message out of its own stderr, and stderr quotes the
  //    remote url. Both message and stderr carry the secret here.
  const failure = new Error(
    `git config --get remote.origin.url exited 128: fatal: unable to access '${declared}': failed`
  );
  failure.name = 'GitCommandError';
  failure.code = 128;
  failure.stderr = `fatal: unable to access '${declared}': failed to connect`;
  failure.argv = ['config', '--get', 'remote.origin.url'];

  assert.equal(failure.message.includes(secret), true, 'the error message must really carry the secret');
  assert.equal(failure.stderr.includes(secret), true, 'and so must its stderr');

  const unreadable = checkRepositoryIdentity({
    root: makeDirectory('identity-branch-unreadable'),
    expected: EXPECTED,
    remote: 'origin',
    readRemoteUrl: () => { throw failure; },
  });

  assert.equal(unreadable.status, STATUS.UNKNOWN);
  assert.equal(unreadable.refusal, IDENTITY_REFUSAL.REMOTE_UNREADABLE);
  assertNoSecret(unreadable, secret, 'unreadable branch');

  // What IS recorded: structured, bounded, and enough to diagnose.
  assert.deepEqual(unreadable.evidence[0].observed.failure, { name: 'GitCommandError', exitCode: 128 });
  const serialised = JSON.stringify(unreadable);
  assert.equal(serialised.includes('unable to access'), false, 'no fragment of the message either');
  assert.equal(serialised.includes('failed to connect'), false, 'and none of the stderr');
  assert.equal(serialised.includes('rev-parse'), false);
  assert.equal(Object.hasOwn(unreadable.evidence[0].observed, 'argv'), false, 'argv is not recorded');
});

// -- the gate: nothing runs when the identity does not hold -----------------------

function policyFile(document) {
  const path = join(scratch, `policy-${sequence += 1}.json`);
  writeFileSync(path, JSON.stringify(document));
  return path;
}

function checkDirectory(files) {
  const directory = mkdtempSync(join(scratch, 'checks-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(directory, name), body);
  return directory;
}

const identityPolicy = (checks) => policyFile({
  policyVersion: '1.0.0',
  id: 'identity-test',
  version: '1',
  repository: FIXTURE_REPOSITORY,
  gates: { preflight: { checks } },
});

test('REGRESSION: when the identity does not hold, no check runs at all', async () => {
  const root = withRemote('https://github.com/Someone-Else/other-project.git', 'identity-gate');

  // A check that leaves a trace the moment it is even IMPORTED. Discovery
  // imports check modules, so this witness proves the catalogue was never
  // built, not merely that no check was evaluated.
  const witness = join(scratch, `witness-${sequence += 1}.txt`);
  const directory = checkDirectory({
    'sideeffect.mjs': `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(witness.replaceAll('\\', '/'))}, 'imported\\n');
      export default {
        id: 'probe.sideeffect',
        title: 'Records that it ran',
        needsSnapshot: false,
        params: {},
        evaluate: () => {
          writeFileSync(${JSON.stringify(witness.replaceAll('\\', '/'))}, 'evaluated\\n');
          return { status: 'PASS', reason: 'ran', evidence: [] };
        },
      };
    `,
  });

  const { result, plan } = await runPreflight({
    cwd: root,
    policy: identityPolicy([{ id: 'probe.sideeffect', required: true }]),
    gate: 'preflight',
    checksDirectory: directory,
  });

  assert.equal(result.checks.length, 1, 'exactly one row, and it is the refusal');
  assert.equal(result.checks[0].id, 'gate.repository-identity');
  assert.equal(result.checks[0].title, 'The repository matches the identity the policy declares');
  assert.equal(result.checks[0].required, true);
  assert.equal(result.checks[0].status, STATUS.FAIL);
  assert.equal(existsSync(witness), false, 'no check module may be imported or evaluated');
  assert.equal(plan, null, 'no plan is built for a repository the policy is not about');
  assert.equal(result.status, STATUS.FAIL);
  assert.ok(result.errors.some((error) => error.code === FAILURE_CODE.IDENTITY), JSON.stringify(result.errors));
  assert.equal(validateResult(result).valid, true);
});

test('an unreadable identity blocks the same way a mismatched one does', async () => {
  const root = initRepo('identity-gate-missing', { origin: null });

  const { result } = await runPreflight({
    cwd: root,
    policy: identityPolicy([{ id: 'git.repository-readable', required: true }]),
    gate: 'preflight',
  });

  assert.deepEqual(result.checks.map((check) => check.id), ['gate.repository-identity']);
  assert.equal(result.checks[0].status, STATUS.UNKNOWN);
  assert.equal(result.status, STATUS.UNKNOWN, 'an unknown identity authorises nothing');
  assert.equal(result.binding.snapshotHashAfter, null);
  assert.equal(validateResult(result).valid, true);
});

test('REGRESSION: a credential in the remote url reaches nothing the gate reports either', async () => {
  const token = 'ghp_EEEEEEEEEEEEEEEEEEEE';
  const url = `https://user:${token}@github.com/Someone-Else/other-project.git`;
  assert.equal(url.includes(token), true, 'the input must really carry the token');

  const root = withRemote(url, 'identity-gate-credential');
  assert.equal(readRemoteUrl(root, 'origin').includes(token), true, 'and git must really hold it');

  const { result } = await runPreflight({
    cwd: root,
    policy: identityPolicy([{ id: 'git.repository-readable', required: true }]),
    gate: 'preflight',
  });

  assert.equal(result.status, STATUS.FAIL);
  assert.equal(JSON.stringify(result).includes(token), false,
    'the whole gate result, not just the identity evidence');
  assert.equal(validateResult(result).valid, true);
});

test('the blocking result is still bound to the reading taken before it', async () => {
  const root = withRemote('https://github.com/Someone-Else/other-project.git', 'identity-binding');

  const { result, snapshot, snapshotAfter } = await runPreflight({
    cwd: root,
    policy: identityPolicy([{ id: 'git.repository-readable', required: true }]),
    gate: 'preflight',
  });

  assert.equal(result.binding.snapshotHash, snapshot.hash);
  assert.equal(snapshotAfter, null);
  assert.match(result.binding.policyHash, /^sha256:[0-9a-f]{64}$/);
});

test('a passing identity adds no row and lets the run proceed', async () => {
  const root = repoWithCommit({ 'a.txt': 'alpha\n' }, 'identity-proceeds').root;

  const { result } = await runPreflight({
    cwd: root,
    policy: identityPolicy([
      { id: 'git.repository-readable', required: true },
      { id: 'git.no-conflicts', required: true },
      { id: 'git.no-operation-in-progress', required: true },
    ]),
    gate: 'preflight',
  });

  assert.equal(result.checks.some((check) => check.id === 'gate.repository-identity'), false,
    'identity is a precondition, not a check; a passing precondition adds nothing to the report');
  assert.equal(result.status, STATUS.PASS);
  for (const id of ['git.repository-readable', 'git.no-conflicts', 'git.no-operation-in-progress']) {
    assert.equal(result.checks.find((check) => check.id === id).status, STATUS.PASS, id);
  }
});
