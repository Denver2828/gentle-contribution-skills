#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runContextDoctor, validateContextDoctorPaths } from '../lib/context-doctor.mjs';

const USAGE = 'usage: context-doctor [--cwd <repo>] [--work <external-dir>] [--receipt <file>] [--config <json>] [--include-user-scope] [--user-claude-root <dir>] [--user-codex-root <dir>] [--now <iso>]';
const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(HERE, '..', '..', '..', '..');

function parse(argv) {
  const options = { includeUserScope: false };
  const valued = new Set(['--cwd', '--work', '--receipt', '--config', '--user-claude-root', '--user-codex-root', '--now']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--include-user-scope') { options.includeUserScope = true; continue; }
    if (!valued.has(token) || argv[index + 1] === undefined) throw new Error(`unknown or incomplete argument: ${token}`);
    options[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parse(argv); }
  catch (error) { process.stderr.write(`${USAGE}\ncontext-doctor: ${error.message}\n`); return 2; }

  const requestedRepository = resolve(args.cwd ?? process.cwd());
  const requestedState = resolve(args.work ?? join(requestedRepository, '.claude', 'state', 'context-doctor'));
  const requestedReceipt = args.receipt === undefined ? null : resolve(args.receipt);
  const requestedConfig = args.config === undefined ? null : resolve(args.config);
  const requestedClaudeRoot = resolve(args['user-claude-root'] ?? join(homedir(), '.claude'));
  const requestedCodexRoot = resolve(args['user-codex-root'] ?? join(homedir(), '.codex'));
  let safe;
  try {
    safe = validateContextDoctorPaths({
      outerRoot: HARNESS_ROOT,
      repositoryRoot: requestedRepository,
      stateRoot: requestedState,
      receiptPath: requestedReceipt,
      configPath: requestedConfig,
      userClaudeRoot: requestedClaudeRoot,
      userCodexRoot: requestedCodexRoot,
      requireExternalState: args.work !== undefined,
    });
    if (safe.receiptPath !== null && !existsSync(dirname(safe.receiptPath))) {
      throw new Error('context-doctor receipt directory does not exist');
    }
  } catch (error) {
    process.stderr.write(`context-doctor: ${error.message}\n`);
    return 2;
  }

  let thresholdOverrides = {};
  if (safe.configPath !== null) {
    try {
      if (!existsSync(safe.configPath)) throw new Error('file does not exist');
      thresholdOverrides = JSON.parse(readFileSync(safe.configPath, 'utf8'));
    } catch (error) {
      process.stderr.write(`context-doctor: cannot read config: ${error.message}\n`);
      return 2;
    }
  }

  try {
    const outcome = runContextDoctor({
      outerRoot: HARNESS_ROOT,
      repositoryRoot: safe.repositoryRoot,
      stateRoot: safe.stateRoot,
      includeUserScope: args.includeUserScope,
      userClaudeRoot: safe.userClaudeRoot,
      userCodexRoot: safe.userCodexRoot,
      now: args.now ?? new Date().toISOString(),
      thresholdOverrides,
      requireExternalState: args.work !== undefined,
    });
    const receiptText = `${JSON.stringify(outcome.receipt, null, 2)}\n`;
    if (safe.receiptPath !== null) {
      const revalidated = validateContextDoctorPaths({
        outerRoot: HARNESS_ROOT,
        repositoryRoot: safe.repositoryRoot,
        stateRoot: safe.stateRoot,
        receiptPath: safe.receiptPath,
        userClaudeRoot: safe.userClaudeRoot,
        userCodexRoot: safe.userCodexRoot,
        requireExternalState: args.work !== undefined,
      });
      writeFileSync(revalidated.receiptPath, receiptText, 'utf8');
    }
    process.stdout.write(receiptText);
    process.stderr.write(`context-doctor: ADVISORY ${outcome.receipt.burnIn.phase}; ${outcome.receipt.findings.length} finding(s); blocking=false\n`);
    process.stderr.write(`context-doctor: private report: ${outcome.reportPath}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`context-doctor: ${error.message}\n`);
    return 2;
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();

if (invokedDirectly) process.exit(main());
