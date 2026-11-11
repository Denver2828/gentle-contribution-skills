// Which adoption stage is in force, and the kill switch that reverts it.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readEnforcement, preflightRequired, persistenceRequired, signedReceiptsRequired,
  EnforcementError, ENFORCEMENT_PATH, ENFORCEMENT_VERSION, STAGE,
} from '../lib/enforcement.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'audit.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'audit-enforce-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;
function declaration(document) {
  const path = join(scratch, `enforcement-${sequence += 1}.json`);
  writeFileSync(path, JSON.stringify(document));
  return path;
}

const VALID = {
  enforcementVersion: ENFORCEMENT_VERSION,
  stage: 2,
  killSwitch: 'set stage to 1',
  stages: { 2: { name: 'preflight required', means: 'a PASS preflight is required' } },
};

// -- what is in force right now ---------------------------------------------------

test('the shipped declaration is stage 2, and stage 3 is not enabled', () => {
  const enforcement = readEnforcement();

  assert.equal(enforcement.stage, STAGE.PREFLIGHT_REQUIRED);
  assert.equal(preflightRequired(enforcement), true);
  assert.equal(persistenceRequired(enforcement), false, 'stage 3 must stay disabled');

  const document = JSON.parse(readFileSync(ENFORCEMENT_PATH, 'utf8'));
  assert.equal(document.stages['3'].enabledOn, null, 'stage 3 has no enable date');
  assert.equal(document.stages['2'].enabledOn, '2026-08-01');
});

test('the shipped declaration carries requireSignedReceipts false, with its own kill switch', () => {
  const enforcement = readEnforcement();

  assert.equal(signedReceiptsRequired(enforcement), false, 'the signing requirement is off until its burn-in');
  assert.match(enforcement.requireSignedReceiptsKillSwitch, /requireSignedReceipts.*false/i);
  assert.match(enforcement.requireSignedReceiptsKillSwitch, /verification code stays/i,
    'rollback disables the requirement, never removes the verification');
});

test('requireSignedReceipts flips the requirement on, and a legacy declaration without the field reads as off', () => {
  const on = readEnforcement({
    path: declaration({ ...VALID, requireSignedReceipts: true, requireSignedReceiptsKillSwitch: 'set requireSignedReceipts to false; the verification code stays' }),
  });
  assert.equal(signedReceiptsRequired(on), true);

  const legacy = readEnforcement({ path: declaration(VALID) });
  assert.equal(signedReceiptsRequired(legacy), false, 'a declaration written before the flag existed is not corruption');
});

test('REGRESSION: a malformed signing flag, or one without its kill switch, blocks', () => {
  const cases = {
    'flag as text': declaration({ ...VALID, requireSignedReceipts: 'false', requireSignedReceiptsKillSwitch: 'x' }),
    'flag without kill switch': declaration({ ...VALID, requireSignedReceipts: true }),
    'flag with empty kill switch': declaration({ ...VALID, requireSignedReceipts: false, requireSignedReceiptsKillSwitch: '  ' }),
  };
  for (const [label, path] of Object.entries(cases)) {
    assert.throws(() => readEnforcement({ path }), EnforcementError, `${label} must block`);
  }
});

test('the declaration carries a kill switch and an honest scope', () => {
  const enforcement = readEnforcement();

  assert.match(enforcement.killSwitch, /stage.*1/i);
  assert.match(enforcement.honestScope, /procedural enforcement/);
  assert.match(enforcement.honestScope, /cannot stop a process that decides not to|resists mistakes/i);
});

test('the declaration names the burn-in log', () => {
  const document = JSON.parse(readFileSync(ENFORCEMENT_PATH, 'utf8'));
  assert.equal(document.stages['2'].burnInLog, 'docs/burn-in-stage-2.md');
});

// -- the kill switch ------------------------------------------------------------------

test('REGRESSION: setting the stage to 1 reverts to informative, and nothing else changes', () => {
  const reverted = readEnforcement({ path: declaration({ ...VALID, stage: 1 }) });

  assert.equal(reverted.stage, STAGE.INFORMATIVE);
  assert.equal(preflightRequired(reverted), false, 'the preflight stops being required');
  assert.equal(persistenceRequired(reverted), false);
});

test('stage 3 would require persistence, and is not what ships', () => {
  const future = readEnforcement({ path: declaration({ ...VALID, stage: 3 }) });

  assert.equal(persistenceRequired(future), true);
  assert.notEqual(readEnforcement().stage, 3, 'but the shipped declaration is not stage 3');
});

// -- fail closed --------------------------------------------------------------------------

test('REGRESSION: an unreadable, unknown or unrevertable declaration blocks', () => {
  const cases = {
    'missing file': join(scratch, 'absent.json'),
    'not JSON': (() => { const path = join(scratch, 'broken.json'); writeFileSync(path, '{ not json'); return path; })(),
    'unknown version': declaration({ ...VALID, enforcementVersion: '9.9.9' }),
    'unknown stage': declaration({ ...VALID, stage: 7 }),
    'stage as text': declaration({ ...VALID, stage: '2' }),
    'no kill switch': declaration({ ...VALID, killSwitch: '' }),
  };

  for (const [label, path] of Object.entries(cases)) {
    assert.throws(() => readEnforcement({ path }), EnforcementError, `${label} must block`);
  }
});

test('a declaration that cannot be read never degrades to the permissive stage', () => {
  try {
    readEnforcement({ path: join(scratch, 'absent.json') });
    assert.fail('it must throw rather than return a stage');
  } catch (error) {
    assert.equal(error.detail.failure, 'unreadable');
    assert.match(error.message, /refusing to assume a permissive stage/);
  }
});

// -- over the process boundary ---------------------------------------------------------------

test('the CLI reports the stage on stdout and the kill switch on stderr', () => {
  const outcome = spawnSync(process.execPath, [CLI, 'enforcement'], { encoding: 'utf8' });

  assert.equal(outcome.status, 0);
  const reported = JSON.parse(outcome.stdout);
  assert.deepEqual(reported, {
    name: 'preflight required',
    persistenceRequired: false,
    preflightRequired: true,
    signedReceiptsRequired: false,
    stage: 2,
  });

  assert.match(outcome.stderr, /kill switch:/);
  assert.match(outcome.stderr, /scope: This is procedural enforcement/);
});
