import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BURN_IN_DAYS, discoverInstructionSources, runContextDoctor,
} from '../lib/context-doctor.mjs';
import { canonicalProspectivePath } from './helpers/paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'context-doctor.mjs');
const PROJECT_ROOT = join(HERE, '..', '..', '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'context-doctor-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;
const fresh = (name) => {
  const root = join(scratch, `${name}-${sequence += 1}`);
  mkdirSync(root, { recursive: true });
  return root;
};
const write = (root, path, content) => {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
};
const categories = (receipt) => new Set(receipt.findings.map((finding) => finding.category));

test('fixed inputs produce the same share-safe receipt across machine paths', () => {
  const first = fresh('determinism-a');
  const second = fresh('determinism-b');
  const content = '# Instructions\n\nUse the repository test command.\n';
  write(first, 'AGENTS.md', content);
  write(second, 'AGENTS.md', content);
  const now = '2026-08-28T09:00:00-03:00';
  const a = runContextDoctor({ repositoryRoot: first, stateRoot: fresh('state-a'), now }).receipt;
  const b = runContextDoctor({ repositoryRoot: second, stateRoot: fresh('state-b'), now }).receipt;
  assert.deepEqual(a, b);
  assert.equal(a.blocking, false);
  assert.equal(a.mode, 'advisory');
  assert.equal(a.observedAt, '2026-08-28T12:00:00.000Z');
  assert.equal(a.observationWindow.firstObservedAt, '2026-08-28T12:00:00.000Z');
});

test('share-safe receipt excludes paths, usernames, snippets, sessions and environment values', () => {
  const root = fresh('synthetic-identity-private-repository');
  write(root, 'AGENTS.md', 'NEVER expose TOP_SECRET_RULE_TEXT.\nMachine file: C:\\Users\\synthetic-user-7f3a\\private.txt\n');
  const { receipt, reportPath } = runContextDoctor({ repositoryRoot: root, stateRoot: fresh('private-state'), now: '2026-08-28T12:00:00.000Z' });
  const serialized = JSON.stringify(receipt);
  for (const secret of [root, 'synthetic-user-7f3a', 'TOP_SECRET_RULE_TEXT', 'private.txt', 'session', 'environment']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  const detailed = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(
    detailed.repositoryRoot,
    canonicalProspectivePath(root),
    'raw paths are confined to the ignored/private detailed report',
  );
  assert.equal(categories(receipt).has('machine-specific-absolute-path'), true);
});

test('missing instruction files are measured as zero and unsupported semantics stay UNMEASURED', () => {
  const root = fresh('missing');
  const receipt = runContextDoctor({ repositoryRoot: root, stateRoot: fresh('missing-state'), now: '2026-08-28T12:00:00.000Z' }).receipt;
  assert.equal(receipt.sources.length, 0);
  assert.equal(receipt.inventory.rawBytes, 0);
  assert.equal(receipt.inventory.classification, 'non-standing-corpus');
  assert.equal(receipt.standingContext.classification, 'per-co-load-domain-no-cross-client-total');
  assert.equal(receipt.checks.find((check) => check.check === 'behavioral-backtest-codex-engram').status, 'UNMEASURED');
  assert.equal(receipt.checks.find((check) => check.check === 'claude-line-guidance-causality-for-codex').status, 'UNMEASURED');
});

test('user Claude and Codex surfaces require explicit opt-in', () => {
  const root = fresh('user-opt-in-repo');
  const claude = fresh('user-claude');
  const codex = fresh('user-codex');
  write(claude, 'CLAUDE.md', 'Claude user rule.\n');
  write(codex, 'AGENTS.md', 'Codex user rule.\n');
  assert.equal(discoverInstructionSources({ repositoryRoot: root, userClaudeRoot: claude, userCodexRoot: codex }).length, 0);
  const sources = discoverInstructionSources({
    repositoryRoot: root, includeUserScope: true, userClaudeRoot: claude, userCodexRoot: codex,
  });
  assert.deepEqual(sources.map((source) => [source.platform, source.scope]).sort(), [['claude', 'user'], ['codex', 'user']]);
  for (const source of sources) {
    for (const key of ['client', 'coLoadDomain', 'loadPhase', 'loadCondition', 'rawBytes', 'effectiveBytes', 'evidenceStatus', 'listingBytes', 'bodyBytes']) {
      assert.equal(Object.hasOwn(source, key), true, key);
    }
  }
});

test('baseline growth is advisory and the 28-day boundary never auto-promotes', () => {
  const root = fresh('baseline');
  const state = fresh('baseline-state');
  const instructions = write(root, 'AGENTS.md', 'Keep the first rule.\n');
  const firstAt = '2026-01-01T00:00:00.000Z';
  const first = runContextDoctor({ repositoryRoot: root, stateRoot: state, now: firstAt, thresholdOverrides: { growthBytes: 10 } }).receipt;
  assert.equal(first.baseline.established, true);
  assert.deepEqual(first.baseline.standingDeltaByDomain.map((item) => item.deltaBytes), [0]);
  writeFileSync(instructions, `Keep the first rule.\n${'new standing context '.repeat(20)}\n`, 'utf8');
  const second = runContextDoctor({ repositoryRoot: root, stateRoot: state, now: '2026-01-02T00:00:00.000Z', thresholdOverrides: { growthBytes: 10 } }).receipt;
  assert.equal(categories(second).has('standing-context-growth'), true);
  assert.equal(second.findings.find((item) => item.category === 'standing-context-growth').action, 'prune');
  const boundary = runContextDoctor({ repositoryRoot: root, stateRoot: state, now: '2026-01-29T00:00:00.000Z', thresholdOverrides: { growthBytes: 10 } }).receipt;
  assert.equal(boundary.burnIn.days, BURN_IN_DAYS);
  assert.equal(boundary.burnIn.phase, 'awaiting-human-decision');
  assert.equal(boundary.burnIn.promotion, 'explicit-human-decision-required');
  assert.equal(boundary.blocking, false);
  assert.equal(boundary.mode, 'advisory');
  runContextDoctor({ repositoryRoot: root, stateRoot: state, now: '2026-01-30T00:00:00.000Z', thresholdOverrides: { growthBytes: 10, historyLimit: 2 } });
  const history = JSON.parse(readFileSync(join(state, 'history.json'), 'utf8'));
  assert.equal(history.entries.length, 2);
  assert.equal(history.firstObservedAt, firstAt);
  assert.equal(history.lastObservedAt, '2026-01-30T00:00:00.000Z');
});

test('deterministic detectors emit a closed action for each measured finding', () => {
  const root = fresh('detectors');
  const duplicate = 'This instruction block is intentionally long enough to prove normalized duplication across repeated paragraphs and sources.';
  write(root, 'counted.txt', 'one\ntwo\n');
  write(root, 'AGENTS.md', [
    duplicate,
    '',
    duplicate,
    '',
    'Machine path C:\\Users\\alice\\project\\file.txt',
    'Missing import @./missing/file.md',
    '@./counted.txt has 99 lines',
    'MUST NEVER ALWAYS IMPORTANT CRITICAL MANDATORY obey.',
    '2026-01-01 historical note',
    '2026-01-02 changelog note',
  ].join('\n'));
  write(root, '.claude/settings.json', JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codegraph prompt-hook' }] }] },
  }));
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('detectors-state'),
    now: '2026-08-28T12:00:00.000Z',
    thresholdOverrides: { duplicateMinChars: 60, emphasisMinimum: 2, emphasisRatio: 0.01, datedLines: 1 },
  }).receipt;
  const found = categories(receipt);
  for (const category of [
    'duplicate-normalized-instruction-block', 'machine-specific-absolute-path', 'dead-local-reference',
    'stale-countable-numeric-claim', 'emphasis-saturation', 'dated-changelog-accretion',
    'hook-dynamic-context-unmeasured',
  ]) assert.equal(found.has(category), true, category);
  const hook = receipt.findings.find((item) => item.category === 'hook-dynamic-context-unmeasured');
  assert.equal(hook.loadPhase, 'hook_dynamic');
  assert.equal(hook.payloadStatus, 'UNMEASURED');
  assert.equal(receipt.checks.find((check) => check.check === 'hook-dynamic-payload').status, 'UNMEASURED');
  assert.equal(JSON.stringify(receipt).includes('prompt injection'), false);
  for (const item of receipt.findings) assert.match(item.action, /^(prune|extract|scope|convert-to-hook|keep|inspect)$/);
});

test('nested src instruction surfaces are excluded and never receive runtime state', () => {
  const root = fresh('sut-boundary');
  write(root, 'AGENTS.md', 'Outer instruction.\n');
  const sut = write(root, 'src/AGENTS.md', 'MUST use C:\\Users\\SUT_ONLY\\secret and @./missing/file.md\n');
  const before = readFileSync(sut);
  const state = join(root, '.claude', 'state', 'context-doctor');
  const outcome = runContextDoctor({ repositoryRoot: root, stateRoot: state, now: '2026-08-28T12:00:00.000Z' });
  assert.equal(outcome.receipt.sources.length, 1);
  assert.deepEqual(readFileSync(sut), before);
  assert.equal(outcome.reportPath.startsWith(join(root, 'src')), false);
  assert.equal(readFileSync(outcome.reportPath, 'utf8').includes('SUT_ONLY'), false);
});

test('CLI findings and the post-burn-in phase still exit zero and never block', () => {
  const root = fresh('cli-advisory');
  const work = fresh('cli-work');
  const config = write(fresh('cli-config'), 'thresholds.json', JSON.stringify({ alwaysOnBytes: 1 }));
  write(root, 'CLAUDE.md', 'This exceeds one byte.\n');
  const result = spawnSync(process.execPath, [CLI, '--cwd', root, '--work', work, '--config', config, '--now', '2026-08-28T12:00:00.000Z'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.blocking, false);
  assert.equal(receipt.mode, 'advisory');
  assert.equal(categories(receipt).has('standing-context-budget'), true);
  assert.match(result.stderr, /ADVISORY/);
  assert.match(result.stderr, /private report:/);
  assert.equal(result.stdout.includes(work), false, 'private report location must stay outside the share-safe receipt');
  const unsafeWork = spawnSync(process.execPath, [CLI, '--cwd', root, '--work', join(root, 'private-report')], { encoding: 'utf8' });
  assert.equal(unsafeWork.status, 2);
  assert.match(unsafeWork.stderr, /outside/);
});

test('all CLI path inputs reject the nested SUT before reading or writing', () => {
  const root = fresh('path-boundary');
  const sut = join(root, 'src');
  mkdirSync(sut, { recursive: true });
  write(root, 'AGENTS.md', 'Outer only.\n');
  const probes = [
    ['receipt', ['--cwd', root, '--receipt', join(sut, 'receipt.json')]],
    ['config', ['--cwd', root, '--config', write(root, 'src/thresholds.json', '{}')]],
    ['user-root', ['--cwd', root, '--include-user-scope', '--user-claude-root', join(sut, 'user')]],
    ['cwd', ['--cwd', join(PROJECT_ROOT, 'src')]],
  ];
  for (const [label, args] of probes) {
    const before = readdirSync(sut).sort();
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, `${label}: ${result.stderr}`);
    assert.equal(result.stdout, '', label);
    assert.deepEqual(readdirSync(sut).sort(), before, `${label} must not mutate the SUT`);
  }
  assert.equal(existsSync(join(root, '.claude', 'state', 'context-doctor')), false);
  assert.equal(existsSync(join(sut, 'receipt.json')), false);
});

test('a junction-backed external work path that resolves into src is refused without mutation', () => {
  const root = fresh('junction-repository');
  const sut = join(root, 'src');
  const alias = join(fresh('junction-parent'), 'work-alias');
  mkdirSync(sut, { recursive: true });
  symlinkSync(sut, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const before = readdirSync(sut);
  const result = spawnSync(process.execPath, [CLI, '--cwd', root, '--work', alias], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(readdirSync(sut), before);
});

test('contaminated history is rejected without receipt leakage or forward mutation', () => {
  const root = fresh('history-repository');
  const state = fresh('history-state');
  write(root, 'AGENTS.md', 'Stable instruction.\n');
  const first = spawnSync(process.execPath, [CLI, '--cwd', root, '--work', state, '--now', '2026-08-28T12:00:00.000Z'], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const latest = readFileSync(join(state, 'latest-receipt.json'));
  const reportsBefore = readdirSync(join(state, 'reports')).sort();
  const historyPath = join(state, 'history.json');
  const history = JSON.parse(readFileSync(historyPath, 'utf8'));
  history.firstObservedAt = 'C:\\Users\\synthetic-history-poison\\private.txt';
  writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  const invalidDate = spawnSync(process.execPath, [CLI, '--cwd', root, '--work', state, '--now', '2026-08-29T12:00:00.000Z'], { encoding: 'utf8' });
  assert.equal(invalidDate.status, 2);
  assert.equal(invalidDate.stdout, '');
  assert.equal(invalidDate.stderr.includes('synthetic-history-poison'), false);
  assert.deepEqual(readFileSync(join(state, 'latest-receipt.json')), latest);
  assert.deepEqual(readdirSync(join(state, 'reports')).sort(), reportsBefore);

  history.firstObservedAt = '2026-08-28T12:00:00.000Z';
  history.untrusted = 'must-not-project';
  writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  const openSchema = spawnSync(process.execPath, [CLI, '--cwd', root, '--work', state, '--now', '2026-08-29T12:00:00.000Z'], { encoding: 'utf8' });
  assert.equal(openSchema.status, 2);
  assert.equal(openSchema.stdout, '');
  assert.equal(openSchema.stderr.includes('must-not-project'), false);
  assert.deepEqual(readFileSync(join(state, 'latest-receipt.json')), latest);
  assert.deepEqual(readdirSync(join(state, 'reports')).sort(), reportsBefore);
});

test('an incomplete baseline is rejected instead of fabricating a zero delta', () => {
  const root = fresh('baseline-invalid-repository');
  const state = fresh('baseline-invalid-state');
  write(root, 'AGENTS.md', 'Stable instruction.\n');
  write(state, 'baseline.json', JSON.stringify({
    baselineVersion: 'context-doctor-baseline/v2',
    establishedAt: '2026-08-28T12:00:00.000Z',
    sourceAggregates: [],
  }));
  const result = spawnSync(process.execPath, [CLI, '--cwd', root, '--work', state, '--now', '2026-08-29T12:00:00.000Z'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /baseline.*closed schema/);
  assert.deepEqual(readdirSync(state).sort(), ['baseline.json']);
});

test('a v1 baseline is rejected with an explicit v2 rebaseline continuation', () => {
  const root = fresh('baseline-v1-repository');
  const state = fresh('baseline-v1-state');
  write(root, 'AGENTS.md', 'Stable instruction.\n');
  write(state, 'baseline.json', JSON.stringify({
    baselineVersion: 'context-doctor-baseline/v1',
    establishedAt: '2026-08-28T12:00:00.000Z',
    aggregate: {},
    sourceAggregates: [],
  }));
  const result = spawnSync(process.execPath, [CLI, '--cwd', root, '--work', state, '--now', '2026-08-29T12:00:00.000Z'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /new --work directory.*rebaseline v2/);
  assert.deepEqual(readdirSync(state).sort(), ['baseline.json']);
});

test('Codex project docs parse signed underscored TOML integers and use default caps without hiding raw bytes', () => {
  const root = fresh('codex-cap-repository');
  const codex = fresh('codex-cap-user');
  const claude = fresh('codex-cap-claude');
  write(root, 'AGENTS.md', 'R'.repeat(50_000));
  write(codex, 'AGENTS.md', 'U'.repeat(50_000));
  write(codex, 'config.toml', 'project_doc_max_bytes = +40_000\n');
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-cap-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  const repositorySource = receipt.sources.find((source) => source.client === 'codex' && source.scope === 'repository' && source.loadPhase === 'startup_full');
  const userSource = receipt.sources.find((source) => source.client === 'codex' && source.scope === 'user' && source.loadPhase === 'startup_full');
  assert.equal(repositorySource.rawBytes, 50_000);
  assert.equal(repositorySource.effectiveBytes, 40_000, 'project_doc_max_bytes caps the repository-scope AGENTS.md');
  assert.equal(repositorySource.budgetBytes, 40_000);
  assert.equal(repositorySource.budgetSource, 'user-config');
  assert.equal(userSource.rawBytes, 50_000);
  assert.equal(userSource.effectiveBytes, 50_000, 'Codex never caps the global user AGENTS.md (agents_md.rs, rust-v0.144.0)');
  assert.equal(userSource.budgetBytes, null);
  assert.equal(userSource.budgetSource, 'none');
  const domain = receipt.standingContext.domains.find((item) => item.coLoadDomain === 'codex:startup');
  assert.equal(domain.budgetBytes, 40_000);
  assert.equal(domain.budgetSource, 'user-config');
  assert.equal(domain.evidenceStatus, 'DOCUMENTED_CONFIGURED');

  writeFileSync(join(codex, 'config.toml'), '# default applies\n', 'utf8');
  const defaultReceipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-default-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  const defaultRepositorySource = defaultReceipt.sources.find((source) => source.client === 'codex' && source.scope === 'repository' && source.loadPhase === 'startup_full');
  const defaultUserSource = defaultReceipt.sources.find((source) => source.client === 'codex' && source.scope === 'user' && source.loadPhase === 'startup_full');
  assert.equal(defaultRepositorySource.effectiveBytes, 32 * 1024);
  assert.equal(defaultRepositorySource.budgetSource, 'documented-default');
  assert.equal(defaultUserSource.effectiveBytes, 50_000);
  assert.equal(defaultUserSource.budgetSource, 'none');
  const defaultDomain = defaultReceipt.standingContext.domains.find((item) => item.coLoadDomain === 'codex:startup');
  assert.equal(defaultDomain.budgetBytes, 32 * 1024);
  assert.equal(defaultDomain.budgetSource, 'documented-default');
  assert.equal(defaultDomain.evidenceStatus, 'DOCUMENTED_DEFAULT');
});

test('Codex model_instructions_file and experimental_compact_prompt_file are measured as separate instruction channels', () => {
  const root = fresh('codex-instruction-channels-repository');
  const codex = fresh('codex-instruction-channels-user');
  const claude = fresh('codex-instruction-channels-claude');
  const modelInstructionsContent = 'Model instruction override body.\n';
  const compactPromptContent = 'Compact prompt body.\n';
  const modelInstructions = write(codex, 'engram-instructions.md', modelInstructionsContent);
  const compactPrompt = write(codex, 'engram-compact-prompt.md', compactPromptContent);
  const escape = (value) => value.replace(/\\/g, '\\\\');
  write(codex, 'config.toml', [
    `model_instructions_file = "${escape(modelInstructions)}"`,
    `experimental_compact_prompt_file = "${escape(compactPrompt)}"`,
    '',
  ].join('\n'));
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-instruction-channels-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  const modelSource = receipt.sources.find((source) => source.sourceClass === 'model-instructions-file');
  const compactSource = receipt.sources.find((source) => source.sourceClass === 'compact-prompt-file');
  assert.ok(modelSource, 'model-instructions-file source expected');
  assert.ok(compactSource, 'compact-prompt-file source expected');
  assert.equal(modelSource.client, 'codex');
  assert.equal(modelSource.scope, 'user');
  assert.equal(modelSource.loadPhase, 'startup_full');
  assert.equal(modelSource.coLoadDomain, 'codex:startup');
  assert.equal(modelSource.evidenceStatus, 'MEASURED');
  assert.equal(modelSource.budgetSource, 'none');
  assert.equal(modelSource.budgetBytes, null);
  assert.equal(modelSource.standingBytes, Buffer.byteLength(modelInstructionsContent, 'utf8'));
  assert.equal(compactSource.client, 'codex');
  assert.equal(compactSource.scope, 'user');
  assert.equal(compactSource.loadPhase, 'compact_dynamic');
  assert.equal(compactSource.coLoadDomain, 'codex:compact');
  assert.equal(compactSource.standingBytes, 0);
  assert.equal(compactSource.rawBytes, Buffer.byteLength(compactPromptContent, 'utf8'));
  const startupDomain = receipt.standingContext.domains.find((domain) => domain.coLoadDomain === 'codex:startup');
  assert.ok(startupDomain.standingBytes >= modelSource.standingBytes, 'codex:startup standing bytes must include the model instructions file');
  const compactDomain = receipt.conditionalContext.domains.find((domain) => domain.coLoadDomain === 'codex:compact');
  assert.ok(compactDomain, 'codex:compact domain expected in conditional context');
  assert.equal(compactDomain.standingBytes, 0);
});

test('Codex config without instruction-file keys yields neither sources nor checks', () => {
  const root = fresh('codex-instruction-channels-absent-repository');
  const codex = fresh('codex-instruction-channels-absent-user');
  const claude = fresh('codex-instruction-channels-absent-claude');
  write(codex, 'config.toml', '# no instruction file keys\n');
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-instruction-channels-absent-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  assert.equal(receipt.sources.some((source) => source.sourceClass === 'model-instructions-file'), false);
  assert.equal(receipt.sources.some((source) => source.sourceClass === 'compact-prompt-file'), false);
  assert.equal(receipt.checks.some((check) => check.check === 'codex-model-instructions-file'), false);
  assert.equal(receipt.checks.some((check) => check.check === 'codex-compact-prompt-file'), false);
});

test('declared Codex instruction-file keys with missing or empty targets are UNMEASURED, never thrown', () => {
  const root = fresh('codex-instruction-channels-dangling-repository');
  const codex = fresh('codex-instruction-channels-dangling-user');
  const claude = fresh('codex-instruction-channels-dangling-claude');
  const missingPath = join(codex, 'missing-instructions.md');
  const emptyPath = write(codex, 'empty-compact-prompt.md', '');
  const escape = (value) => value.replace(/\\/g, '\\\\');
  write(codex, 'config.toml', [
    `model_instructions_file = "${escape(missingPath)}"`,
    `experimental_compact_prompt_file = "${escape(emptyPath)}"`,
    '',
  ].join('\n'));
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-instruction-channels-dangling-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  assert.equal(receipt.sources.some((source) => source.sourceClass === 'model-instructions-file'), false);
  assert.equal(receipt.sources.some((source) => source.sourceClass === 'compact-prompt-file'), false);
  const modelCheck = receipt.checks.find((check) => check.check === 'codex-model-instructions-file');
  const compactCheck = receipt.checks.find((check) => check.check === 'codex-compact-prompt-file');
  assert.ok(modelCheck, 'codex-model-instructions-file check expected');
  assert.ok(compactCheck, 'codex-compact-prompt-file check expected');
  assert.equal(modelCheck.status, 'UNMEASURED');
  assert.equal(compactCheck.status, 'UNMEASURED');
  assert.match(modelCheck.reason, /does not exist|unreadable/);
  assert.match(compactCheck.reason, /empty/);
});

test('a Codex instruction-file key accepts a TOML literal string verbatim, without escape processing', () => {
  const root = fresh('codex-literal-string-repository');
  const codex = fresh('codex-literal-string-user');
  const claude = fresh('codex-literal-string-claude');
  const content = 'Literal string body.\n';
  const modelInstructions = write(codex, 'engram-instructions.md', content);
  write(codex, 'config.toml', `model_instructions_file = '${modelInstructions}'\n`);
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-literal-string-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  const modelSource = receipt.sources.find((source) => source.sourceClass === 'model-instructions-file');
  assert.ok(modelSource, 'a literal-string declaration must still produce a source'); // guards T1: without literal-string support this stays undeclared
  assert.equal(modelSource.standingBytes, Buffer.byteLength(content, 'utf8'));
  assert.equal(receipt.checks.some((check) => check.check === 'codex-model-instructions-file'), false);
});

test('a Codex instruction-file key declared as a multi-line TOML string is UNMEASURED, never silently undeclared', () => {
  const root = fresh('codex-multiline-string-repository');
  const codex = fresh('codex-multiline-string-user');
  const claude = fresh('codex-multiline-string-claude');
  write(codex, 'config.toml', 'model_instructions_file = """abc"""\n');
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-multiline-string-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  assert.equal(receipt.sources.some((source) => source.sourceClass === 'model-instructions-file'), false);
  const check = receipt.checks.find((item) => item.check === 'codex-model-instructions-file');
  assert.ok(check, 'a multi-line string declaration must still surface a check'); // guards T1: without this the key is silently dropped with no check at all
  assert.equal(check.status, 'UNMEASURED');
  assert.equal(check.reason, 'unsupported TOML string form');
});

test('a Codex instruction-file key declared twice throws even when the two declarations use different string forms', () => {
  const root = fresh('codex-duplicate-key-repository');
  const codex = fresh('codex-duplicate-key-user');
  const claude = fresh('codex-duplicate-key-claude');
  write(codex, 'config.toml', [
    "model_instructions_file = 'one.md'",
    'model_instructions_file = "two.md"',
    '',
  ].join('\n'));
  assert.throws(() => runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-duplicate-key-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }), /model_instructions_file must be declared exactly once/); // guards T1: the exactly-once guard must count every string form, not only basic strings
});

test('Codex instruction-file discovery reads config.toml through one observation shared by sources and checks', () => {
  const root = fresh('single-discovery-repository');
  const codex = fresh('single-discovery-user');
  const claude = fresh('single-discovery-claude');
  const modelContent = 'Single discovery model body.\n';
  const modelInstructions = write(codex, 'engram-instructions.md', modelContent);
  const missingCompactPrompt = join(codex, 'missing-compact-prompt.md');
  const escape = (value) => value.replace(/\\/g, '\\\\');
  write(codex, 'config.toml', [
    `model_instructions_file = "${escape(modelInstructions)}"`,
    `experimental_compact_prompt_file = "${escape(missingCompactPrompt)}"`,
    '',
  ].join('\n'));
  let discoveryCallCount = 0;
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('single-discovery-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
    observe: { onCodexInstructionFileDiscovery: () => { discoveryCallCount += 1; } },
  }).receipt;
  // A duplicated discovery pass (the pre-fix behavior) would call
  // discoverCodexInstructionFileSources a second time, once inside
  // discoverInstructionSources and once more inside runContextDoctor just to
  // recompute checks. Counted through the injectable observer hook rather
  // than an exported process-global counter (see T5).
  assert.equal(discoveryCallCount, 1, 'Codex instruction-file discovery must run exactly once per runContextDoctor call'); // guards T2 and T5
  const modelSource = receipt.sources.find((source) => source.sourceClass === 'model-instructions-file');
  const compactCheck = receipt.checks.find((item) => item.check === 'codex-compact-prompt-file');
  assert.ok(modelSource, 'the declared model_instructions_file must produce a source from the shared observation');
  assert.ok(compactCheck, 'the declared but missing experimental_compact_prompt_file must produce a check from the same observation');
  assert.equal(compactCheck.status, 'UNMEASURED');
});

test('a relative Codex instruction-file declaration resolves against the Codex user root, never process.cwd()', () => {
  const root = fresh('codex-relative-path-repository');
  const codex = fresh('codex-relative-path-user');
  const claude = fresh('codex-relative-path-claude');
  const content = 'Relative declaration body.\n';
  write(codex, 'nested/engram-instructions.md', content);
  write(codex, 'config.toml', 'model_instructions_file = "nested/engram-instructions.md"\n');
  const measure = () => runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-relative-path-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  const originalCwd = process.cwd();
  let first;
  let second;
  try {
    process.chdir(scratch);
    first = measure();
  } finally {
    process.chdir(originalCwd);
  }
  const otherCwd = fresh('codex-relative-path-alt-cwd');
  try {
    process.chdir(otherCwd);
    second = measure();
  } finally {
    process.chdir(originalCwd);
  }
  const modelSourceA = first.sources.find((source) => source.sourceClass === 'model-instructions-file');
  const modelSourceB = second.sources.find((source) => source.sourceClass === 'model-instructions-file');
  assert.ok(modelSourceA, 'a relative declaration must resolve against the Codex user root from the first cwd'); // guards T3
  assert.ok(modelSourceB, 'a relative declaration must resolve identically from a different cwd'); // guards T3
  assert.equal(modelSourceA.sourceId, modelSourceB.sourceId);
  assert.equal(modelSourceA.contentId, modelSourceB.contentId);
});

test('the codex:startup domain reports no budget when only the model-instructions-file channel is present', () => {
  const root = fresh('codex-startup-budget-repository');
  const codex = fresh('codex-startup-budget-user');
  const claude = fresh('codex-startup-budget-claude');
  const content = 'Model instructions only body.\n';
  const modelInstructions = write(codex, 'engram-instructions.md', content);
  const escape = (value) => value.replace(/\\/g, '\\\\');
  write(codex, 'config.toml', `model_instructions_file = "${escape(modelInstructions)}"\n`);
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-startup-budget-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  const startupDomain = receipt.standingContext.domains.find((domain) => domain.coLoadDomain === 'codex:startup');
  assert.ok(startupDomain, 'codex:startup domain expected');
  assert.equal(startupDomain.sourceCount, 1);
  assert.equal(startupDomain.budgetSource, 'none'); // guards T4
  assert.equal(startupDomain.budgetBytes, null); // guards T4
});

test('a Codex instruction-file key pointing at a directory is UNMEASURED, never thrown', () => {
  const root = fresh('codex-directory-target-repository');
  const codex = fresh('codex-directory-target-user');
  const claude = fresh('codex-directory-target-claude');
  const directoryTarget = fresh('codex-directory-target-value');
  const escape = (value) => value.replace(/\\/g, '\\\\');
  write(codex, 'config.toml', `model_instructions_file = "${escape(directoryTarget)}"\n`);
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-directory-target-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  assert.equal(receipt.sources.some((source) => source.sourceClass === 'model-instructions-file'), false);
  const check = receipt.checks.find((item) => item.check === 'codex-model-instructions-file');
  assert.ok(check);
  assert.equal(check.status, 'UNMEASURED');
  assert.match(check.reason, /does not exist or is unreadable/); // guards T5
});

test('a Codex instruction-file key resolving inside the read-only src SUT is UNMEASURED, never read', () => {
  const root = fresh('codex-outside-boundary-repository');
  const codex = fresh('codex-outside-boundary-user');
  const claude = fresh('codex-outside-boundary-claude');
  const outsideBoundaryTarget = join(root, 'src', 'model-instructions.md');
  const escape = (value) => value.replace(/\\/g, '\\\\');
  write(codex, 'config.toml', `model_instructions_file = "${escape(outsideBoundaryTarget)}"\n`);
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-outside-boundary-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  assert.equal(receipt.sources.some((source) => source.sourceClass === 'model-instructions-file'), false);
  const check = receipt.checks.find((item) => item.check === 'codex-model-instructions-file');
  assert.ok(check);
  assert.equal(check.status, 'UNMEASURED');
  assert.match(check.reason, /could not be resolved safely/); // guards T5
});

test('a Codex instruction-file key decodes \\u escapes to the correct unicode path segment', () => {
  const root = fresh('codex-unicode-escape-repository');
  const codex = fresh('codex-unicode-escape-user');
  const claude = fresh('codex-unicode-escape-claude');
  const content = 'Unicode escape body.\n';
  const modelInstructions = write(codex, 'café-instructions.md', content);
  const escaped = modelInstructions.replace(/\\/g, '\\\\').replace(/é/g, '\\u00e9');
  write(codex, 'config.toml', `model_instructions_file = "${escaped}"\n`);
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-unicode-escape-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  const modelSource = receipt.sources.find((source) => source.sourceClass === 'model-instructions-file');
  assert.ok(modelSource, 'a \\u00e9 escape must resolve to the real unicode file path'); // guards T6
  assert.equal(modelSource.standingBytes, Buffer.byteLength(content, 'utf8'));
});

test('a Codex instruction-file key with an unsupported TOML escape is UNMEASURED, never silently corrupted', () => {
  const root = fresh('codex-invalid-escape-repository');
  const codex = fresh('codex-invalid-escape-user');
  const claude = fresh('codex-invalid-escape-claude');
  write(codex, 'config.toml', 'model_instructions_file = "bad\\qend"\n');
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-invalid-escape-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  assert.equal(receipt.sources.some((source) => source.sourceClass === 'model-instructions-file'), false);
  const check = receipt.checks.find((item) => item.check === 'codex-model-instructions-file');
  assert.ok(check);
  assert.equal(check.status, 'UNMEASURED');
  assert.equal(check.reason, 'unsupported TOML escape'); // guards T6
});

test('a Codex instruction-file key decodes a valid \\U0001F600-style 8-hex escape to the correct supplementary-plane code point', () => {
  const root = fresh('codex-supplementary-escape-repository');
  const codex = fresh('codex-supplementary-escape-user');
  const claude = fresh('codex-supplementary-escape-claude');
  const content = 'Supplementary-plane escape body.\n';
  const emoji = String.fromCodePoint(0x1f600);
  const modelInstructions = write(codex, `${emoji}-instructions.md`, content);
  const escaped = modelInstructions.replace(/\\/g, '\\\\').replace(emoji, '\\U0001F600');
  write(codex, 'config.toml', `model_instructions_file = "${escaped}"\n`);
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-supplementary-escape-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  const modelSource = receipt.sources.find((source) => source.sourceClass === 'model-instructions-file');
  assert.ok(modelSource, 'a valid \\U0001F600 escape must resolve to the real supplementary-plane file path'); // guards T1: asserts modelSource is found; a broken 8-hex \U decode leaves the key unparsed and this source absent
  assert.equal(modelSource.standingBytes, Buffer.byteLength(content, 'utf8'));
});

test('a Codex instruction-file key with a \\U escape above the maximum code point is UNMEASURED, never silently corrupted', () => {
  const root = fresh('codex-oversized-escape-repository');
  const codex = fresh('codex-oversized-escape-user');
  const claude = fresh('codex-oversized-escape-claude');
  write(codex, 'config.toml', 'model_instructions_file = "bad\\U00110000end"\n');
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-oversized-escape-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  assert.equal(receipt.sources.some((source) => source.sourceClass === 'model-instructions-file'), false);
  const check = receipt.checks.find((item) => item.check === 'codex-model-instructions-file');
  assert.ok(check);
  assert.equal(check.status, 'UNMEASURED');
  assert.equal(check.reason, 'unsupported TOML escape'); // guards T1: asserts the reason string; removing the 0x10FFFF upper-bound check on \U would let this pass String.fromCodePoint and throw a RangeError instead
});

test('a Codex instruction-file key with a short-hex \\u escape is UNMEASURED, never silently corrupted', () => {
  const root = fresh('codex-short-hex-escape-repository');
  const codex = fresh('codex-short-hex-escape-user');
  const claude = fresh('codex-short-hex-escape-claude');
  write(codex, 'config.toml', 'model_instructions_file = "bad\\u12"\n');
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-short-hex-escape-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  assert.equal(receipt.sources.some((source) => source.sourceClass === 'model-instructions-file'), false);
  const check = receipt.checks.find((item) => item.check === 'codex-model-instructions-file');
  assert.ok(check);
  assert.equal(check.status, 'UNMEASURED');
  assert.equal(check.reason, 'unsupported TOML escape'); // guards T1: asserts the reason string; removing the 4-hex-digit length check on \u would let a short hex run consume trailing quote/content bytes as hex digits
});

test('a Codex instruction-file key with a \\u surrogate code point is rejected as an unsupported TOML escape', () => {
  const root = fresh('codex-u-surrogate-escape-repository');
  const codex = fresh('codex-u-surrogate-escape-user');
  const claude = fresh('codex-u-surrogate-escape-claude');
  write(codex, 'config.toml', 'model_instructions_file = "bad\\uD800end"\n');
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-u-surrogate-escape-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  assert.equal(receipt.sources.some((source) => source.sourceClass === 'model-instructions-file'), false);
  const check = receipt.checks.find((item) => item.check === 'codex-model-instructions-file');
  assert.ok(check);
  assert.equal(check.status, 'UNMEASURED');
  assert.equal(check.reason, 'unsupported TOML escape'); // guards T2: asserts the reason string; removing the \u surrogate-range check lets String.fromCodePoint silently accept the lone surrogate U+D800 (TOML requires Unicode scalar values)
});

test('a Codex instruction-file key with a \\U surrogate code point is rejected as an unsupported TOML escape', () => {
  const root = fresh('codex-cap-u-surrogate-escape-repository');
  const codex = fresh('codex-cap-u-surrogate-escape-user');
  const claude = fresh('codex-cap-u-surrogate-escape-claude');
  write(codex, 'config.toml', 'model_instructions_file = "bad\\U0000DFFFend"\n');
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-cap-u-surrogate-escape-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  assert.equal(receipt.sources.some((source) => source.sourceClass === 'model-instructions-file'), false);
  const check = receipt.checks.find((item) => item.check === 'codex-model-instructions-file');
  assert.ok(check);
  assert.equal(check.status, 'UNMEASURED');
  assert.equal(check.reason, 'unsupported TOML escape'); // guards T2: asserts the reason string; removing the \U surrogate-range check lets String.fromCodePoint silently accept the lone surrogate U+DFFF (TOML requires Unicode scalar values)
});

test('a Codex instruction-file key declared with nothing after the equals sign is UNMEASURED, never silently absent', () => {
  const root = fresh('codex-empty-rhs-repository');
  const codex = fresh('codex-empty-rhs-user');
  const claude = fresh('codex-empty-rhs-claude');
  write(codex, 'config.toml', 'model_instructions_file =\n');
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-empty-rhs-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  assert.equal(receipt.sources.some((source) => source.sourceClass === 'model-instructions-file'), false);
  const check = receipt.checks.find((item) => item.check === 'codex-model-instructions-file');
  assert.ok(check, 'a bare `key =` line must still surface a check'); // guards T3: with the `(.+?)` capture, a bare `key =` line never matches and the key is silently treated as absent (no check at all)
  assert.equal(check.status, 'UNMEASURED');
  assert.equal(check.reason, 'unsupported TOML string form');
});

test('a Codex instruction-file key declared with only trailing whitespace after the equals sign is UNMEASURED, never silently absent', () => {
  const root = fresh('codex-blank-rhs-repository');
  const codex = fresh('codex-blank-rhs-user');
  const claude = fresh('codex-blank-rhs-claude');
  write(codex, 'config.toml', 'model_instructions_file = \n');
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-blank-rhs-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  assert.equal(receipt.sources.some((source) => source.sourceClass === 'model-instructions-file'), false);
  const check = receipt.checks.find((item) => item.check === 'codex-model-instructions-file');
  assert.ok(check, 'a `key = ` line with only trailing whitespace must still surface a check'); // guards T3
  assert.equal(check.status, 'UNMEASURED');
  assert.equal(check.reason, 'unsupported TOML string form');
});

test('a Codex instruction-file basic-string declaration followed by a trailing comment still measures the file', () => {
  const root = fresh('codex-basic-string-comment-repository');
  const codex = fresh('codex-basic-string-comment-user');
  const claude = fresh('codex-basic-string-comment-claude');
  const content = 'Trailing comment basic-string body.\n';
  const modelInstructions = write(codex, 'engram-instructions.md', content);
  const escaped = modelInstructions.replace(/\\/g, '\\\\');
  write(codex, 'config.toml', `model_instructions_file = "${escaped}" # a trailing comment\n`);
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-basic-string-comment-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  const modelSource = receipt.sources.find((source) => source.sourceClass === 'model-instructions-file');
  assert.ok(modelSource, 'a trailing comment after a basic-string declaration must not prevent measurement'); // guards T4
  assert.equal(modelSource.standingBytes, Buffer.byteLength(content, 'utf8'));
});

test('a Codex instruction-file literal-string declaration followed by a trailing comment still measures the file', () => {
  const root = fresh('codex-literal-string-comment-repository');
  const codex = fresh('codex-literal-string-comment-user');
  const claude = fresh('codex-literal-string-comment-claude');
  const content = 'Trailing comment literal-string body.\n';
  const modelInstructions = write(codex, 'engram-instructions.md', content);
  write(codex, 'config.toml', `model_instructions_file = '${modelInstructions}' # a trailing comment\n`);
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('codex-literal-string-comment-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  const modelSource = receipt.sources.find((source) => source.sourceClass === 'model-instructions-file');
  assert.ok(modelSource, 'a trailing comment after a literal-string declaration must not prevent measurement'); // guards T4
  assert.equal(modelSource.standingBytes, Buffer.byteLength(content, 'utf8'));
});

test('model-instructions-override finding is share-safe and only fires when the key is declared', () => {
  const root = fresh('model-instructions-override-repository');
  const codex = fresh('model-instructions-override-user');
  const claude = fresh('model-instructions-override-claude');
  const modelInstructionsContent = 'Custom base instructions overriding the built-in Codex prompt.\n';
  const modelInstructions = write(codex, 'engram-instructions.md', modelInstructionsContent);
  const escape = (value) => value.replace(/\\/g, '\\\\');
  write(codex, 'config.toml', `model_instructions_file = "${escape(modelInstructions)}"\n`);
  const { receipt, reportPath } = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('model-instructions-override-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  });
  const item = receipt.findings.find((entry) => entry.category === 'model-instructions-override');
  assert.ok(item, 'model-instructions-override finding expected');
  assert.equal(item.action, 'inspect');
  assert.equal(item.severity, 'advisory');
  assert.equal(item.coLoadDomain, 'codex:startup');
  assert.equal(item.observedBytes, Buffer.byteLength(modelInstructionsContent, 'utf8'));
  const serializedReceipt = JSON.stringify(receipt);
  assert.equal(serializedReceipt.includes(codex), false, 'receipt must not carry the Codex user root path');
  assert.equal(serializedReceipt.includes('engram-instructions.md'), false);
  const detailed = JSON.parse(readFileSync(reportPath, 'utf8'));
  const detailedFinding = detailed.findings.find((entry) => entry.category === 'model-instructions-override');
  assert.equal(detailedFinding.detail.configPath, join(canonicalProspectivePath(codex), 'config.toml'));
  assert.equal(detailedFinding.detail.path, canonicalProspectivePath(modelInstructions));
  assert.match(detailedFinding.detail.reason, /replac/i);

  const withoutKey = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('model-instructions-override-absent-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: fresh('model-instructions-override-absent-codex'),
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  assert.equal(withoutKey.findings.some((entry) => entry.category === 'model-instructions-override'), false);
});

test('an invalid present Codex project_doc_max_bytes fails closed instead of using the default', () => {
  const root = fresh('codex-invalid-budget-repository');
  const codex = fresh('codex-invalid-budget-user');
  const state = fresh('codex-invalid-budget-state');
  write(root, 'AGENTS.md', 'Repository instructions.\n');
  write(codex, 'config.toml', 'project_doc_max_bytes = 40__000\n');
  assert.throws(() => runContextDoctor({
    repositoryRoot: root,
    stateRoot: state,
    userCodexRoot: codex,
    userClaudeRoot: fresh('codex-invalid-budget-claude'),
    now: '2026-08-28T12:00:00.000Z',
  }), /exists but is not a valid decimal integer/);
  assert.deepEqual(readdirSync(state), []);
});

test('skill metadata and body are separate, OpenAI metadata is counted, and Claude disable-model-invocation suppresses listing load', () => {
  const root = fresh('skill-loading-repository');
  const claude = fresh('skill-loading-claude');
  const codex = fresh('skill-loading-codex');
  write(claude, 'skills/private-skill/SKILL.md', [
    '---', 'name: private-skill', 'description: private description', 'disable-model-invocation: true', '---', '', 'Body loaded only when invoked.',
  ].join('\n'));
  write(claude, 'skills/private-skill/agents/openai.yaml', [
    'interface:', '  short_description: "Codex-only description must not affect Claude"',
  ].join('\n'));
  write(codex, 'skills/codex-skill/SKILL.md', [
    '---', 'name: codex-skill', 'description: fallback description', '---', '', 'Codex body loaded only when invoked.',
  ].join('\n'));
  write(codex, 'skills/codex-skill/agents/openai.yaml', [
    'interface:', '  display_name: "Codex Skill"', '  short_description: "Documented listing description"',
    'policy:', '  allow_implicit_invocation: false',
  ].join('\n'));
  const sources = discoverInstructionSources({
    repositoryRoot: root, includeUserScope: true, userClaudeRoot: claude, userCodexRoot: codex,
  });
  const disabled = sources.find((source) => source.client === 'claude');
  assert.equal(disabled.loadPhase, 'on_invoke_full');
  assert.equal(disabled.listingBytes > 0, true);
  assert.equal(disabled.listingBytes, Buffer.byteLength('private-skill\nprivate description', 'utf8'));
  assert.equal(disabled.bodyBytes, Buffer.byteLength('\nBody loaded only when invoked.', 'utf8'));
  assert.equal(disabled.standingBytes, 0);
  assert.equal(disabled.loadComponents.some((component) => component.loadPhase === 'startup_metadata'), false);
  const codexSkill = sources.find((source) => source.client === 'codex');
  assert.equal(codexSkill.hasOpenAiMetadata, true);
  assert.equal(codexSkill.listingBytes > 0, true);
  assert.equal(codexSkill.bodyBytes < codexSkill.rawBytes, true);
  assert.equal(codexSkill.listingLoadPhase, null);
  assert.equal(codexSkill.listingLoadCondition, 'implicit-invocation-disabled');
  assert.equal(codexSkill.standingBytes, 0);
  assert.equal(codexSkill.loadComponents.some((component) => component.loadPhase === 'startup_metadata'), false);
});

test('tampered baseline domain aggregates are rejected before they can fabricate growth', () => {
  const root = fresh('baseline-domain-tamper-repository');
  const state = fresh('baseline-domain-tamper-state');
  const codex = fresh('baseline-domain-tamper-codex');
  write(root, 'AGENTS.md', 'R'.repeat(100));
  write(codex, 'config.toml', 'project_doc_max_bytes = 64\n');
  runContextDoctor({
    repositoryRoot: root, stateRoot: state, userCodexRoot: codex,
    userClaudeRoot: fresh('baseline-domain-tamper-claude'), now: '2026-08-28T12:00:00.000Z',
  });
  const baselinePath = join(state, 'baseline.json');
  const latestBefore = readFileSync(join(state, 'latest-receipt.json'));
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const domain = baseline.domainAggregates.find((item) => item.coLoadDomain === 'codex:startup');
  domain.effectiveBytes += 4;
  domain.standingBytes += 4;
  domain.estimatedTokens = Math.ceil(domain.effectiveBytes / 4);
  domain.standingEstimatedTokens = Math.ceil(domain.standingBytes / 4);
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  assert.throws(() => runContextDoctor({
    repositoryRoot: root, stateRoot: state, userCodexRoot: codex,
    userClaudeRoot: fresh('baseline-domain-tamper-claude-2'), now: '2026-08-29T12:00:00.000Z',
  }), /domainAggregates do not match its sources/);
  assert.deepEqual(readFileSync(join(state, 'latest-receipt.json')), latestBefore);
});

test('the former 525 duplicate groups reduce to one confirmed co-loaded prune group', () => {
  const root = fresh('duplicate-v2-repository');
  const claude = fresh('duplicate-v2-claude');
  const codex = fresh('duplicate-v2-codex');
  const longDescription = (name) => `${name} ${'frontmatter metadata '.repeat(6)}`;
  const repeated = 'R'.repeat(126);
  const mirrorParagraphs = Array.from({ length: 510 }, (_, index) => `Mirror paragraph ${index} ${'x'.repeat(100)}`);
  const skill = (name, blocks) => ['---', `name: ${name}`, `description: ${longDescription(name)}`, '---', '', ...blocks.flatMap((block) => [block, ''])].join('\n');
  const main = skill('sdd-design', [...mirrorParagraphs, repeated, repeated]);
  for (const client of [claude, codex]) write(client, 'skills/sdd-design/SKILL.md', main);
  const shared = Array.from({ length: 6 }, (_, index) => `Shared boilerplate ${index} ${'b'.repeat(100)}`);
  for (let index = 0; index < 7; index += 1) {
    const blocks = [index > 0 ? shared[index - 1] : null, index < 6 ? shared[index] : null].filter(Boolean);
    const body = skill(`conditional-${index}`, blocks);
    for (const client of [claude, codex]) write(client, `skills/conditional-${index}/SKILL.md`, body);
  }
  const sources = discoverInstructionSources({
    repositoryRoot: root, includeUserScope: true, userClaudeRoot: claude, userCodexRoot: codex,
  });
  const normalize = (block) => block.toLowerCase().replace(/[`*_>#-]/g, ' ').replace(/\s+/g, ' ').trim();
  const naive = new Map();
  for (const source of sources) {
    for (const block of source.text.split(/\r?\n\s*\r?\n/)) {
      const normalized = normalize(block);
      if (normalized.length < 80) continue;
      naive.set(normalized, (naive.get(normalized) ?? 0) + 1);
    }
  }
  assert.equal([...naive.values()].filter((count) => count > 1).length, 525);
  const receipt = runContextDoctor({
    repositoryRoot: root,
    stateRoot: fresh('duplicate-v2-state'),
    includeUserScope: true,
    userClaudeRoot: claude,
    userCodexRoot: codex,
    now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  const prune = receipt.findings.filter((finding) => finding.category === 'duplicate-normalized-instruction-block');
  assert.equal(prune.length, 1);
  assert.equal(prune[0].action, 'prune');
  assert.equal(prune[0].confirmedSavingsBytesPerLoad, 126);
  assert.equal(prune[0].confirmedSavingsEstimatedTokensPerLoad, 32);
  assert.equal(receipt.findings.filter((finding) => finding.category === 'cross-client-skill-mirror').length, 8);
  assert.equal(receipt.findings.filter((finding) => finding.category === 'conditional-cross-skill-boilerplate').length, 6);
  assert.equal(receipt.findings.filter((finding) => finding.category === 'cross-client-skill-mirror').every((finding) => finding.action === 'keep'), true);
});

test('frontmatter-only repetition is excluded from duplicate pruning', () => {
  const root = fresh('frontmatter-repository');
  const claude = fresh('frontmatter-claude');
  const codex = fresh('frontmatter-codex');
  const content = ['---', 'name: mirrored', `description: ${'same frontmatter '.repeat(8)}`, '---', '', 'Short body.'].join('\n');
  write(claude, 'skills/mirrored/SKILL.md', content);
  write(codex, 'skills/mirrored/SKILL.md', content);
  const receipt = runContextDoctor({
    repositoryRoot: root, stateRoot: fresh('frontmatter-state'), includeUserScope: true,
    userClaudeRoot: claude, userCodexRoot: codex, now: '2026-08-28T12:00:00.000Z',
  }).receipt;
  assert.equal(receipt.findings.some((finding) => finding.category === 'duplicate-normalized-instruction-block'), false);
  assert.equal(receipt.findings.filter((finding) => finding.category === 'cross-client-skill-mirror').length, 1);
});

test('project integration stays explicit: the skill exists and no hook invokes the doctor', () => {
  const skill = readFileSync(join(PROJECT_ROOT, '.claude', 'skills', 'gentle-ai-context-doctor', 'SKILL.md'), 'utf8');
  for (const section of ['Activation Contract', 'Hard Rules', 'Decision Gates', 'Execution Steps', 'Output Contract', 'References']) {
    assert.match(skill, new RegExp(`^## ${section}$`, 'm'));
  }
  const settings = readFileSync(join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf8');
  assert.equal(/context-doctor/i.test(settings), false);
});
