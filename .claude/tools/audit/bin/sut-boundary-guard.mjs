#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { decideSutCommand } from '../lib/sut-boundary.mjs';
import { WORKSPACE_ROOT } from '../lib/store/paths.mjs';

export const decide = (command) => decideSutCommand(command, {
  outerRoot: WORKSPACE_ROOT,
  sutRoot: join(WORKSPACE_ROOT, 'src'),
});

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();

if (invokedDirectly) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw); } catch {
      process.stderr.write('sut-boundary-guard: unreadable hook input; denying rather than guessing\n');
      process.exit(2);
    }
    if (input?.tool_name !== undefined && input.tool_name !== 'Bash') process.exit(0);
    const verdict = decide(input?.tool_input?.command);
    if (verdict.decision === 'deny') {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason,
      } })}\n`);
    }
    process.exit(0);
  });
}
