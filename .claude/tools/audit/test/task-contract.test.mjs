import test from 'node:test';
import assert from 'node:assert/strict';

import {
  admitTaskContract,
  assessAcceptanceCoverage,
  taskContractDigest,
  taskContractIntact,
  validateTaskContractDocument,
} from '../lib/task-contract.mjs';
import { passingAcceptanceCoverage, TASK_CONTRACT } from './helpers/documents.mjs';

test('task contract identity is canonical across object key order', () => {
  const reordered = {
    escalate_when: [...TASK_CONTRACT.escalate_when],
    done_when: TASK_CONTRACT.done_when.map(({ condition, id }) => ({ condition, id })),
    constraints: [...TASK_CONTRACT.constraints],
    goal: TASK_CONTRACT.goal,
    schemaVersion: TASK_CONTRACT.schemaVersion,
  };
  const first = admitTaskContract(TASK_CONTRACT);
  const second = admitTaskContract(reordered);

  assert.equal(first.taskContractDigest, second.taskContractDigest);
  assert.equal(taskContractDigest(first), first.taskContractDigest);
  assert.equal(taskContractIntact(first), true);
});

test('task contract refuses structurally empty and semantically vacuous values', () => {
  for (const invalid of [
    { ...TASK_CONTRACT, goal: '' },
    { ...TASK_CONTRACT, goal: '   ' },
    { ...TASK_CONTRACT, constraints: [] },
    { ...TASK_CONTRACT, constraints: ['\t'] },
    { ...TASK_CONTRACT, done_when: [] },
    { ...TASK_CONTRACT, done_when: [{ id: 'acceptance-1', condition: ' ' }] },
    { ...TASK_CONTRACT, escalate_when: [] },
    { ...TASK_CONTRACT, escalate_when: ['\n'] },
  ]) {
    assert.equal(validateTaskContractDocument(invalid).valid, false, JSON.stringify(invalid));
    assert.throws(() => admitTaskContract(invalid), /task contract violates/);
  }
});

test('duplicate done_when acceptance ids are refused', () => {
  const duplicate = {
    ...TASK_CONTRACT,
    done_when: [TASK_CONTRACT.done_when[0], { ...TASK_CONTRACT.done_when[1], id: TASK_CONTRACT.done_when[0].id }],
  };
  const checked = validateTaskContractDocument(duplicate);
  assert.equal(checked.valid, false);
  assert.match(checked.errors.map((error) => error.message).join(' '), /duplicate acceptance id/);
});

test('coverage assessment is exact and deterministic', () => {
  const admitted = admitTaskContract(TASK_CONTRACT);
  const passing = assessAcceptanceCoverage(admitted, passingAcceptanceCoverage());
  assert.equal(passing.complete, true);
  assert.equal(passing.satisfied, true);
  assert.equal(passing.remediation, null);

  const missing = assessAcceptanceCoverage(admitted, passingAcceptanceCoverage().slice(0, 1));
  assert.equal(missing.complete, false);
  assert.match(missing.reason, /missing 1 \(acceptance-2\)/);
  assert.match(missing.remediation, /exactly one coverage row/);
});

test('decisive FAIL completes coverage but never satisfies acceptance', () => {
  const coverage = passingAcceptanceCoverage();
  coverage[0] = { ...coverage[0], status: 'FAIL', reason: 'Observed failure.', remediation: 'Fix the claim.' };
  const assessed = assessAcceptanceCoverage(admitTaskContract(TASK_CONTRACT), coverage);
  assert.equal(assessed.complete, true);
  assert.equal(assessed.satisfied, false);
  assert.equal(assessed.remediation, null);
  assert.match(assessed.reason, /failed 1 \(acceptance-1\)/);
  for (const rows of [coverage.slice(0, 1), [...coverage, coverage[0]], [...coverage, { ...coverage[0], acceptanceId: 'unknown' }]]) {
    const incomplete = assessAcceptanceCoverage(admitTaskContract(TASK_CONTRACT), rows);
    assert.equal(incomplete.complete, false);
    assert.equal(incomplete.satisfied, false);
  }
});

test('caller-supplied task contract identities are refused rather than trusted', () => {
  const admitted = admitTaskContract(TASK_CONTRACT);
  assert.throws(() => admitTaskContract(admitted), /must omit taskContractDigest/);
  assert.equal(taskContractIntact({ ...admitted, goal: 'changed after admission' }), false);
});
