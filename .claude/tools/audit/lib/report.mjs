// Human summary, derived from the structured result and never the other way
// round. If a fact is not in the JSON, it does not appear here.

import { STATUS } from './status.mjs';

const MARK = {
  [STATUS.PASS]: 'PASS   ',
  [STATUS.FAIL]: 'FAIL   ',
  [STATUS.UNKNOWN]: 'UNKNOWN',
  [STATUS.NOT_RUN]: 'NOT_RUN',
};

export function renderHuman(result) {
  const lines = [];

  lines.push(`gate ${result.gate}: ${result.status}`);
  lines.push(`  run       ${result.runId}`);
  lines.push(`  policy    ${result.policy.id}@${result.policy.version}`);
  lines.push(`  repo      ${result.repository.root}`);
  lines.push(`  head      ${result.repository.head ?? '(unknown)'} on ${result.repository.branch ?? '(detached)'}`);
  lines.push(`  summary   ${result.summary.pass} pass / ${result.summary.fail} fail / ${result.summary.unknown} unknown / ${result.summary.notRun} not run`);
  lines.push('');

  for (const check of result.checks) {
    const scope = check.required ? 'required' : 'optional';
    lines.push(`  [${MARK[check.status]}] ${check.id} (${scope})`);
    lines.push(`             ${check.reason}`);
    if (check.status !== STATUS.PASS && check.remediation) {
      lines.push(`             remediation: ${check.remediation}`);
    }
  }

  if (result.errors.length > 0) {
    lines.push('');
    lines.push('  errors:');
    for (const error of result.errors) {
      lines.push(`    ${error.code}${error.checkId ? ` (${error.checkId})` : ''}: ${error.message}`);
    }
  }

  lines.push('');
  lines.push(result.status === STATUS.PASS
    ? '  PASS authorises the transition. The JSON on stdout is the authority.'
    : `  ${result.status} blocks. Nothing may proceed on this result.`);

  return lines.join('\n');
}
