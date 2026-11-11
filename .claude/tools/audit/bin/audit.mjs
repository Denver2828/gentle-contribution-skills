#!/usr/bin/env node
// Audit CLI.
//
// Contract at the process boundary:
//   stdout  canonical JSON, and nothing else. Safe to pipe.
//   stderr  human summary and diagnostics. Never parsed.
//
// Exit codes (delivery 1 subset):
//   0  gate PASS               / document valid
//   1  gate FAIL
//   2  gate UNKNOWN or NOT_RUN -- it did not conclude, so nothing proceeds
//   3  usage or configuration error
//   4  invalid result: the contract was violated
//
// Subcommands here are the ones the engine can honestly support today.
// `snapshot`, `parity` and `gate` arrive with their deliveries.

import { readFileSync } from 'node:fs';
import { canonicalJson } from '../lib/canonical.mjs';
import { validateResult, validateSnapshot } from '../lib/validate.mjs';
import { takeSnapshot } from '../lib/snapshot.mjs';
import { runPreflight } from '../lib/preflight.mjs';
import { policySchema, PolicyError } from '../lib/policy.mjs';
import { discoverChecks, RegistryError } from '../lib/registry.mjs';
import { readEnforcement, preflightRequired, persistenceRequired, signedReceiptsRequired, EnforcementError } from '../lib/enforcement.mjs';
import { validate as validateAgainstSchema } from '../lib/jsonschema.mjs';
import { EXIT, STATUS, exitCodeFor } from '../lib/status.mjs';

const validatePolicyDocument = (document) => validateAgainstSchema(policySchema(), document);
import { renderHuman } from '../lib/report.mjs';
import { runHarnessHealthCanary, runSelftestScenario } from '../lib/harness-health.mjs';

const USAGE = `usage:
  audit.mjs snapshot [--cwd <path>] [--format json]
  audit.mjs check --policy <name|path> --gate <name> [--cwd <path>]
                 [--check-timeout-ms <n>] [--discovery-timeout-ms <n>]
                 (both may only LOWER the budget the policy declares)
  audit.mjs catalogue
  audit.mjs enforcement
  audit.mjs validate --input <file> [--kind result|snapshot|policy]
  audit.mjs selftest --scenario <pass|fail|unknown|not-run|throw|malformed|empty>
  audit.mjs selftest --all

stdout is canonical JSON; stderr is the human summary.
exit: 0 pass/valid, 1 fail, 2 inconclusive, 3 usage, 4 contract violation`;

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const next = argv[index + 1];
    out[argv[index].slice(2)] = next && !next.startsWith('--') ? next : 'true';
  }
  return out;
}

/** A numeric flag, or undefined. A flag present without a value is a usage error. */
function numericArg(args, name) {
  const raw = args[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw === 'true' || !Number.isFinite(value)) usageError(`--${name} requires a number`);
  return value;
}

function usageError(message) {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(EXIT.USAGE);
}

// -- validate ---------------------------------------------------------------

function commandValidate(args) {
  if (!args.input || args.input === 'true') usageError('validate: missing --input <path>');

  const kind = args.kind ?? 'result';
  if (!['result', 'snapshot', 'policy'].includes(kind)) usageError('validate: --kind must be "result", "snapshot" or "policy"');

  let document;
  try {
    document = JSON.parse(readFileSync(args.input, 'utf8'));
  } catch (error) {
    usageError(`validate: cannot read or parse ${args.input}: ${error.message}`);
  }

  const validator = { result: validateResult, snapshot: validateSnapshot, policy: validatePolicyDocument };
  const { valid, errors } = validator[kind](document);
  process.stdout.write(`${canonicalJson({ valid, errors })}\n`);

  if (!valid) {
    process.stderr.write(`invalid result: ${errors.length} violation(s)\n`);
    for (const error of errors) process.stderr.write(`  ${error.path}: ${error.message}\n`);
    process.exit(EXIT.CONTRACT);
  }

  process.stderr.write(`valid against schema/${kind}.v1.json\n`);
  process.exit(EXIT.PASS);
}

// -- enforcement ------------------------------------------------------------

function commandEnforcement() {
  let enforcement;
  try {
    enforcement = readEnforcement();
  } catch (error) {
    if (error instanceof EnforcementError) {
      process.stderr.write(`configuration error: ${error.message}
`);
      process.exit(EXIT.USAGE);
    }
    throw error;
  }

  process.stdout.write(`${canonicalJson({
    stage: enforcement.stage,
    name: enforcement.name,
    preflightRequired: preflightRequired(enforcement),
    persistenceRequired: persistenceRequired(enforcement),
    signedReceiptsRequired: signedReceiptsRequired(enforcement),
  })}
`);

  process.stderr.write(`stage ${enforcement.stage}: ${enforcement.name}
`);
  process.stderr.write(`  ${enforcement.means}
`);
  process.stderr.write(`  preflight required   ${preflightRequired(enforcement)}
`);
  process.stderr.write(`  persistence required ${persistenceRequired(enforcement)}
`);
  process.stderr.write(`  signed receipts required ${signedReceiptsRequired(enforcement)}
`);
  process.stderr.write(`
  kill switch: ${enforcement.killSwitch}
`);
  if (enforcement.requireSignedReceiptsKillSwitch !== '') {
    process.stderr.write(`
  signing kill switch: ${enforcement.requireSignedReceiptsKillSwitch}
`);
  }
  process.stderr.write(`
  scope: ${enforcement.honestScope}
`);
  process.exit(EXIT.PASS);
}

// -- catalogue --------------------------------------------------------------

async function commandCatalogue() {
  const catalogue = await discoverChecks();
  const entries = [...catalogue.values()].map((definition) => ({
    id: definition.id,
    title: definition.title,
    needsSnapshot: definition.needsSnapshot,
    params: Object.fromEntries(
      Object.entries(definition.params).map(([name, spec]) => [name, { type: spec.type, required: spec.required }])
    ),
    origin: definition.origin,
  }));

  process.stdout.write(`${canonicalJson({ checks: entries })}\n`);
  process.stderr.write(`${entries.length} check(s) discovered in lib/checks/\n`);
  for (const entry of entries) process.stderr.write(`  ${entry.id}  (${entry.origin})\n`);
  process.exit(EXIT.PASS);
}

// -- check ------------------------------------------------------------------

async function commandCheck(args) {
  if (!args.policy || args.policy === 'true') usageError('check: missing --policy <name|path>');
  if (!args.gate || args.gate === 'true') usageError('check: missing --gate <name>');

  let outcome;
  try {
    outcome = await runPreflight({
      cwd: args.cwd && args.cwd !== 'true' ? args.cwd : process.cwd(),
      policy: args.policy,
      gate: args.gate,
      checkTimeoutMs: numericArg(args, 'check-timeout-ms'),
      discoveryTimeoutMs: numericArg(args, 'discovery-timeout-ms'),
    });
  } catch (error) {
    // A policy that cannot be resolved is a configuration error. It blocks as
    // such, and is never reported as a gate that ran and found nothing wrong.
    if (error instanceof PolicyError || error instanceof RegistryError) {
      process.stderr.write(`configuration error: ${error.message}\n`);
      process.exit(EXIT.USAGE);
    }
    throw error;
  }

  const { valid, errors } = validateResult(outcome.result);
  if (!valid) {
    process.stderr.write('the engine produced a result that violates its own contract:\n');
    for (const error of errors) process.stderr.write(`  ${error.path}: ${error.message}\n`);
    process.exit(EXIT.CONTRACT);
  }

  process.stdout.write(`${canonicalJson(outcome.result)}\n`);
  process.stderr.write(`${renderHuman(outcome.result)}\n`);
  process.exit(exitCodeFor(outcome.result.status));
}

// -- snapshot ---------------------------------------------------------------

function renderSnapshot(snapshot) {
  const { identity, worktree, changes, diffstat, counts } = snapshot;
  const tracking = identity.upstream
    ? `${identity.upstream} (+${identity.ahead}/-${identity.behind})`
    : '(no upstream)';

  return [
    `snapshot ${snapshot.hash}`,
    `  root      ${snapshot.root}`,
    `  head      ${identity.head ?? '(unborn)'} [${identity.headKind}]`,
    `  branch    ${identity.branch ?? '(detached)'} -> ${tracking}`,
    `  operation ${identity.operation}`,
    `  worktree  ${worktree.clean ? 'clean' : 'dirty'}${worktree.conflicted ? ', CONFLICTED' : ''}`,
    `  staged    ${changes.staged.length} entr(y|ies), +${diffstat.staged.additions}/-${diffstat.staged.deletions}` +
      `${diffstat.staged.binaryFiles > 0 ? ` (+${diffstat.staged.binaryFiles} binary, no line counts)` : ''}`,
    `  unstaged  ${changes.unstaged.length} entr(y|ies), +${diffstat.unstaged.additions}/-${diffstat.unstaged.deletions}` +
      `${diffstat.unstaged.binaryFiles > 0 ? ` (+${diffstat.unstaged.binaryFiles} binary, no line counts)` : ''}`,
    `  untracked ${changes.untracked.length}`,
    `  tracked   ${counts.tracked}`,
  ].join('\n');
}

function commandSnapshot(args) {
  if (args.format && args.format !== 'json' && args.format !== 'true') {
    usageError('snapshot: --format only supports "json"');
  }

  const outcome = takeSnapshot({ cwd: args.cwd && args.cwd !== 'true' ? args.cwd : process.cwd() });

  if (outcome.status !== STATUS.PASS) {
    // No snapshot means no snapshot. An empty change list would be a lie.
    process.stdout.write(`${canonicalJson({ status: outcome.status, reason: outcome.reason, evidence: outcome.evidence })}\n`);
    process.stderr.write(`snapshot ${outcome.status}: ${outcome.reason}\n`);
    process.exit(exitCodeFor(outcome.status));
  }

  const { valid, errors } = validateSnapshot(outcome.snapshot);
  if (!valid) {
    process.stderr.write('the snapshot violates schema/snapshot.v1.json:\n');
    for (const error of errors) process.stderr.write(`  ${error.path}: ${error.message}\n`);
    process.exit(EXIT.CONTRACT);
  }

  process.stdout.write(`${canonicalJson(outcome.snapshot)}\n`);
  process.stderr.write(`${renderSnapshot(outcome.snapshot)}\n`);
  process.exit(EXIT.PASS);
}

// -- selftest ---------------------------------------------------------------

const SCENARIOS = new Set(['pass', 'fail', 'unknown', 'not-run', 'throw', 'malformed', 'empty']);

async function commandSelftest(args) {
  if (args.all !== undefined) {
    if (args.all !== 'true' || args.scenario !== undefined) {
      usageError('selftest: --all is a flag and cannot be combined with --scenario');
    }
    const report = await runHarnessHealthCanary();
    process.stdout.write(`${canonicalJson(report)}\n`);
    const passed = report.cases.filter((entry) => entry.passed).length;
    process.stderr.write(`harness health: ${report.status} (${passed}/${report.cases.length} canaries matched in ${report.durationMs}ms)\n`);
    process.exit(report.status === STATUS.PASS ? EXIT.PASS : EXIT.FAIL);
  }

  const scenario = args.scenario;
  if (!SCENARIOS.has(scenario)) {
    usageError(`selftest: --scenario must be one of ${[...SCENARIOS].join(', ')}`);
  }

  const result = await runSelftestScenario(scenario);

  const { valid, errors } = validateResult(result);
  if (!valid) {
    process.stderr.write('the engine produced a result that violates its own contract:\n');
    for (const error of errors) process.stderr.write(`  ${error.path}: ${error.message}\n`);
    process.exit(EXIT.CONTRACT);
  }

  process.stdout.write(`${canonicalJson(result)}\n`);
  process.stderr.write(`${renderHuman(result)}\n`);
  process.exit(exitCodeFor(result.status));
}

// -- dispatch ---------------------------------------------------------------

const [, , command, ...rest] = process.argv;
const args = parseArgs(rest);

switch (command) {
  case 'snapshot':
    commandSnapshot(args);
    break;
  case 'check':
    await commandCheck(args);
    break;
  case 'catalogue':
    await commandCatalogue();
    break;
  case 'enforcement':
    commandEnforcement();
    break;
  case 'validate':
    commandValidate(args);
    break;
  case 'selftest':
    await commandSelftest(args);
    break;
  case '--help':
  case 'help':
  case undefined:
    process.stderr.write(`${USAGE}\n`);
    process.exit(EXIT.USAGE);
    break;
  default:
    usageError(`unknown command "${command}"`);
}
