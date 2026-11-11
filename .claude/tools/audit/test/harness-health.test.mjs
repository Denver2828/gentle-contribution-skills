import test from 'node:test';
import assert from 'node:assert/strict';

import { runHarnessHealthCanary, HEALTH_TIMEOUT_MS } from '../lib/harness-health.mjs';
import { STATUS } from '../lib/status.mjs';

test('the aggregate canary observes every expected failure mode without failing itself', async () => {
  const report = await runHarnessHealthCanary();

  assert.equal(report.status, STATUS.PASS);
  assert.equal(report.cases.every((entry) => entry.passed), true);
  assert.deepEqual(
    report.cases.map((entry) => entry.scenario),
    ['pass', 'fail', 'unknown', 'not-run', 'throw', 'malformed', 'missing-remediation', 'empty', 'timeout']
  );
  assert.deepEqual(report.cases.at(-1).observed, {
    kind: 'timeout',
    terminated: true,
    timeoutMs: HEALTH_TIMEOUT_MS,
  });
});
