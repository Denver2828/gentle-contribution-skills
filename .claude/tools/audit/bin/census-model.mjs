#!/usr/bin/env node
// Census the model that drew a subagent's output, from its transcript.
//
//   node census-model.mjs --session <id> --agent <agent-id> [--projects-root <dir>] [--settle-ms 250]
//
// Prints one JSON object to stdout and exits:
//   0  ok          -- exactly one model AND every assistant line carried one;
//                     use `.model` for Tool/model
//   2  mixed-model  -- more than one model; declare ALL of `.models`/`.segments`
//   1  any other status (incomplete, model-missing, assistant-missing,
//      transcript-missing/empty/malformed/unstable) or an unsafe selector --
//      do NOT publish a model claim; resolve first
//   3  usage error (missing required argument)
//
// The exit code fails closed: only 0 yields a single Tool/model value, and
// mixed-model gets its own code so a caller declares every model rather than
// picking one. `incomplete` (a gap where one assistant line has no model) is a
// refusal, not a pass -- the unknown line could be a different model.
//
// LIMIT, stated: the caller supplies (session, agent, projects-root). The
// census proves the model OF THAT TRANSCRIPT. That this transcript is the drawer
// of a given contribution is the operator's assertion; the tool refuses
// traversal, not substitution by another valid pair. Binding to the drawer's
// launch record is future work.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { census, CENSUS_STATUS, CensusSelectorError } from '../lib/census.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/**
 * Default projects root: the Claude Code slug of the current project directory
 * under ~/.claude/projects. A convenience only. Containment is re-checked
 * against whatever root is used (traversal and symlink/junction escapes are
 * refused), but a DIFFERENT valid root+pair simply names a DIFFERENT real
 * transcript -- picking the one that actually drew this contribution is
 * procedural (see the LIMIT above), not something this default enforces.
 * Override with --projects-root.
 */
function defaultProjectsRoot() {
  const slug = process.cwd().replace(/[^A-Za-z0-9]/g, '-');
  return join(homedir(), '.claude', 'projects', slug);
}

const EXIT = { [CENSUS_STATUS.OK]: 0, [CENSUS_STATUS.MIXED_MODEL]: 2 };

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.session || args.session === true) {
    process.stderr.write('census-model: --session <id> is required\n');
    process.exit(3);
  }
  if (!args.agent || args.agent === true) {
    process.stderr.write('census-model: --agent <agent-id> is required\n');
    process.exit(3);
  }

  const projectsRoot = typeof args['projects-root'] === 'string' ? args['projects-root'] : defaultProjectsRoot();
  const settleMs = args['settle-ms'] !== undefined ? Number(args['settle-ms']) : 250;
  if (!Number.isFinite(settleMs) || settleMs < 0) {
    process.stderr.write('census-model: --settle-ms must be a non-negative number\n');
    process.exit(3);
  }

  let result;
  try {
    result = await census({ projectsRoot, session: args.session, agent: args.agent, settleMs });
  } catch (err) {
    if (err instanceof CensusSelectorError) {
      process.stdout.write(`${JSON.stringify({ status: 'unsafe-selector', reason: err.message })}\n`);
      process.exit(1);
    }
    throw err;
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(EXIT[result.status] ?? 1);
}

main().catch((err) => {
  process.stderr.write(`census-model: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
