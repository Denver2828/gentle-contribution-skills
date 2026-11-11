// Deterministic, advisory inspection of agent instruction surfaces.

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson } from './canonical.mjs';

export const CONTEXT_DOCTOR_VERSION = 'context-doctor/v2';
export const RECEIPT_VERSION = 'context-doctor-receipt/v2';
export const ACTIONS = Object.freeze(['prune', 'extract', 'scope', 'convert-to-hook', 'keep', 'inspect']);
export const DEFAULT_THRESHOLDS = Object.freeze({
  alwaysOnBytes: 20_000,
  growthBytes: 2_048,
  duplicateMinChars: 80,
  emphasisRatio: 0.04,
  emphasisMinimum: 5,
  datedLines: 5,
  historyLimit: 56,
});
export const BURN_IN_DAYS = 28;

const DAY_MS = 24 * 60 * 60 * 1000;
const EXCLUDED_REPOSITORY_ROOTS = new Set(['.git', '.codegraph', 'node_modules', 'src', 'src-worktrees']);
const EMPHASIS = /\b(?:MUST|NEVER|ALWAYS|CRITICAL|IMPORTANT|MANDATORY)\b/g;
const MACHINE_PATH = /(?:\b[A-Za-z]:[\\/][^\s)`'"<>]+)|(?:^|\s)(?:\/Users\/|\/home\/|\/tmp\/)[^\s)`'"<>]+/gm;
const LOCAL_IMPORT = /(?:^|[\s(])@((?:\.{1,2}\/|\/)[^\s)`'"<>]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)/gm;
const DATED_LINE = /\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/20\d{2}\b|\b(?:changelog|historical|history|deprecated since)\b/i;
const LOAD_PHASES = new Set(['startup_full', 'startup_metadata', 'on_invoke_full', 'on_reference_read', 'hook_dynamic', 'compact_dynamic']);
const LOAD_CONDITIONS = new Set(['client-startup', 'client-skill-listing', 'skill-invoked', 'matching-reference-read', 'compact-prompt-invoked']);
const LISTING_LOAD_CONDITIONS = new Set(['client-skill-listing', 'model-invocation-disabled', 'implicit-invocation-disabled']);
const EVIDENCE_STATUSES = new Set(['MEASURED', 'DOCUMENTED_DEFAULT', 'DOCUMENTED_CONFIGURED', 'UNMEASURED']);
const DEFAULT_CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const opaqueId = (value) => sha256(canonicalJson(value));
const normalizedSlashes = (value) => value.split(sep).join('/');
const bounded = (value, length = 160) => value.replace(/\s+/g, ' ').trim().slice(0, length);

function lineCount(text) {
  if (text.length === 0) return 0;
  const normalized = text.replace(/\r\n/g, '\n');
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n').length : normalized.split('\n').length;
}

function within(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function canonicalProspectivePath(value) {
  let current = resolve(value);
  const suffix = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(basename(current));
    current = parent;
  }
  const ancestor = existsSync(current) ? realpathSync.native(current) : current;
  return resolve(ancestor, ...suffix);
}

function createPathBoundary({ outerRoot, repositoryRoot, additionalSutRoots = [] }) {
  const canonicalOuter = canonicalProspectivePath(outerRoot);
  const canonicalRepository = canonicalProspectivePath(repositoryRoot);
  const sutRoots = [...new Set([
    join(canonicalOuter, 'src'),
    join(canonicalRepository, 'src'),
    ...additionalSutRoots,
  ].map(canonicalProspectivePath))];
  return {
    outerRoot: canonicalOuter,
    repositoryRoot: canonicalRepository,
    assert(candidate, label, { outsideRoots = [] } = {}) {
      if (typeof candidate !== 'string' || candidate.trim() === '') throw new Error(`${label} path is required`);
      const canonical = canonicalProspectivePath(candidate);
      if (sutRoots.some((sutRoot) => within(sutRoot, canonical))) {
        throw new Error(`${label} resolves inside the read-only src SUT`);
      }
      if (outsideRoots.some((root) => within(canonicalProspectivePath(root), canonical))) {
        throw new Error(`${label} must resolve outside the requested repository and outer harness`);
      }
      return canonical;
    },
  };
}

export function validateContextDoctorPaths({
  repositoryRoot,
  outerRoot = repositoryRoot,
  stateRoot = join(repositoryRoot, '.claude', 'state', 'context-doctor'),
  receiptPath = null,
  configPath = null,
  userClaudeRoot = join(homedir(), '.claude'),
  userCodexRoot = join(homedir(), '.codex'),
  requireExternalState = false,
}) {
  const boundary = createPathBoundary({ outerRoot, repositoryRoot });
  const repository = boundary.assert(repositoryRoot, 'context-doctor repository root');
  if (!existsSync(repository) || !statSync(repository).isDirectory()) {
    throw new Error('context-doctor repository root must be an existing directory');
  }
  const outsideRoots = requireExternalState ? [boundary.outerRoot, repository] : [];
  return {
    boundary,
    repositoryRoot: repository,
    stateRoot: boundary.assert(stateRoot, 'context-doctor state', { outsideRoots }),
    receiptPath: receiptPath === null ? null : boundary.assert(receiptPath, 'context-doctor receipt'),
    configPath: configPath === null ? null : boundary.assert(configPath, 'context-doctor config'),
    userClaudeRoot: boundary.assert(userClaudeRoot, 'context-doctor Claude user root'),
    userCodexRoot: boundary.assert(userCodexRoot, 'context-doctor Codex user root'),
  };
}

function readJson(path, label, boundary) {
  const safePath = boundary.assert(path, label);
  let parsed;
  try { parsed = JSON.parse(readFileSync(safePath, 'utf8')); }
  catch (error) { throw new Error(`${label} is unreadable JSON: ${error.message}`); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function writeJson(path, value, boundary) {
  const safePath = boundary.assert(path, 'context-doctor output');
  mkdirSync(dirname(safePath), { recursive: true });
  const revalidated = boundary.assert(safePath, 'context-doctor output');
  writeFileSync(revalidated, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function mergedThresholds(overrides = {}) {
  const unknown = Object.keys(overrides).filter((key) => !(key in DEFAULT_THRESHOLDS));
  if (unknown.length > 0) throw new Error(`unknown context-doctor threshold(s): ${unknown.join(', ')}`);
  const result = { ...DEFAULT_THRESHOLDS, ...overrides };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`context-doctor threshold ${key} must be a non-negative finite number`);
    }
  }
  result.historyLimit = Math.max(1, Math.min(365, Math.floor(result.historyLimit)));
  return result;
}

function walk(directory, { repositoryRoot = null, boundary = null } = {}) {
  const safeDirectory = boundary === null ? directory : boundary.assert(directory, 'context-doctor scan directory');
  if (!existsSync(safeDirectory)) return [];
  const found = [];
  for (const entry of readdirSync(safeDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(safeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (repositoryRoot !== null) {
        const rel = normalizedSlashes(relative(repositoryRoot, path));
        const first = rel.split('/')[0];
        if (EXCLUDED_REPOSITORY_ROOTS.has(first) || rel === '.claude/state' || rel.startsWith('.claude/state/')) continue;
      }
      found.push(...walk(path, { repositoryRoot, boundary }));
    } else if (entry.isFile()) found.push(path);
  }
  return found;
}

function hasScopedRuleFrontmatter(text) {
  if (!text.startsWith('---')) return false;
  const end = text.indexOf('\n---', 3);
  return end !== -1 && /^paths\s*:/m.test(text.slice(3, end));
}

function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { metadata: {}, body: text };
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null) return { metadata: {}, body: text };
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (entry === null) continue;
    metadata[entry[1]] = entry[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return { metadata, body: text.slice(match[0].length) };
}

function yamlScalar(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*${escaped}\\s*:\\s*(.+?)\\s*$`, 'm').exec(text);
  return match === null ? null : match[1].trim().replace(/^['"]|['"]$/g, '');
}

function skillListing(path, relativePath, frontmatter, client, boundary) {
  const openaiPath = boundary.assert(join(dirname(path), 'agents', 'openai.yaml'), 'context-doctor skill metadata');
  let displayName = null;
  let shortDescription = null;
  let openAiYaml = '';
  if (existsSync(openaiPath) && statSync(openaiPath).isFile()) {
    openAiYaml = readFileSync(openaiPath, 'utf8');
    displayName = yamlScalar(openAiYaml, 'display_name');
    shortDescription = yamlScalar(openAiYaml, 'short_description');
  }
  const name = frontmatter.name || basename(dirname(path));
  const description = client === 'codex' ? (shortDescription || frontmatter.description || '') : (frontmatter.description || '');
  const fields = client === 'codex'
    ? [displayName || name, description, relativePath]
    : [name, description];
  const allowImplicit = yamlScalar(openAiYaml, 'allow_implicit_invocation');
  return {
    bytes: Buffer.byteLength(fields.join('\n'), 'utf8'),
    name,
    hasOpenAiMetadata: client === 'codex' && (displayName !== null || shortDescription !== null),
    allowImplicitInvocation: allowImplicit === null ? null : allowImplicit.toLowerCase() !== 'false',
  };
}

function sourceDescriptor(path, { root, scope, platform, boundary }) {
  const safePath = boundary.assert(path, 'context-doctor instruction source');
  const rel = normalizedSlashes(relative(root, safePath));
  const base = basename(safePath).toLowerCase();
  const lower = rel.toLowerCase();
  const bytes = readFileSync(safePath);
  const text = bytes.toString('utf8');
  const sourceClass = base === 'agents.md' || base === 'claude.md'
    ? 'instruction-file'
    : lower.includes('/rules/') || lower.startsWith('rules/')
      ? 'rule-file'
      : 'skill-file';
  const { metadata, body } = splitFrontmatter(text);
  const scopedRule = sourceClass === 'rule-file' && hasScopedRuleFrontmatter(text);
  const loadPhase = sourceClass === 'skill-file'
    ? 'on_invoke_full'
    : scopedRule ? 'on_reference_read' : 'startup_full';
  const skill = sourceClass === 'skill-file'
    ? skillListing(safePath, rel, metadata, platform, boundary)
    : { bytes: 0, name: null, hasOpenAiMetadata: false };
  const disableModelInvocation = platform === 'claude'
    && String(metadata['disable-model-invocation']).toLowerCase() === 'true';
  const startupMetadataEligible = sourceClass === 'skill-file'
    && !disableModelInvocation
    && !(platform === 'codex' && skill.allowImplicitInvocation === false);
  const bodyBytes = sourceClass === 'skill-file' ? Buffer.byteLength(body, 'utf8') : bytes.length;
  const domainSuffix = sourceClass === 'skill-file'
    ? opaqueId(['skill-load-domain', scope, platform, (skill.name || rel).toLowerCase()]).slice(7, 23)
    : loadPhase === 'startup_full' ? 'startup' : opaqueId(['reference-domain', scope, platform, rel]).slice(7, 23);
  const coLoadDomain = `${platform}:${sourceClass === 'skill-file' ? `skill:${domainSuffix}` : domainSuffix}`;
  const listingBytes = sourceClass === 'skill-file' ? skill.bytes : 0;
  const source = {
    path: safePath,
    relativePath: rel,
    sourceId: opaqueId(['context-source', scope, platform, rel.toLowerCase()]),
    client: platform,
    platform,
    scope,
    sourceClass,
    coLoadDomain,
    loadPhase,
    loadCondition: loadPhase === 'startup_full' ? 'client-startup'
      : loadPhase === 'on_invoke_full' ? 'skill-invoked' : 'matching-reference-read',
    rawBytes: bytes.length,
    effectiveBytes: bodyBytes,
    evidenceStatus: 'MEASURED',
    listingBytes,
    bodyBytes,
    standingBytes: loadPhase === 'startup_full' ? bodyBytes : (startupMetadataEligible ? listingBytes : 0),
    listingLoadPhase: startupMetadataEligible ? 'startup_metadata' : null,
    listingLoadCondition: sourceClass === 'skill-file'
      ? (disableModelInvocation ? 'model-invocation-disabled'
        : platform === 'codex' && skill.allowImplicitInvocation === false
          ? 'implicit-invocation-disabled' : 'client-skill-listing') : null,
    disableModelInvocation,
    skillName: skill.name,
    hasOpenAiMetadata: skill.hasOpenAiMetadata,
    budgetBytes: null,
    budgetSource: 'none',
    bytes,
    text,
    bodyText: body,
    metrics: {
      bytes: bytes.length,
      lines: lineCount(text),
      estimatedTokens: Math.ceil(bytes.length / 4),
      tokenEstimateHeuristic: 'ceil(utf8-bytes/4)',
      contentId: sha256(bytes),
    },
  };
  source.loadComponents = [{
    coLoadDomain,
    loadPhase,
    loadCondition: source.loadCondition,
    effectiveBytes: source.effectiveBytes,
    standing: loadPhase === 'startup_full',
    evidenceStatus: source.evidenceStatus,
  }];
  if (startupMetadataEligible) {
    source.loadComponents.push({
      coLoadDomain: `${platform}:startup`,
      loadPhase: 'startup_metadata',
      loadCondition: 'client-skill-listing',
      effectiveBytes: listingBytes,
      standing: true,
      evidenceStatus: 'MEASURED',
    });
  }
  return source;
}

function readCodexProjectDocBudget(userCodexRoot, boundary) {
  const configPath = boundary.assert(join(userCodexRoot, 'config.toml'), 'context-doctor Codex config');
  if (!existsSync(configPath)) {
    return { bytes: DEFAULT_CODEX_PROJECT_DOC_MAX_BYTES, source: 'documented-default', evidenceStatus: 'DOCUMENTED_DEFAULT' };
  }
  const text = readFileSync(configPath, 'utf8');
  const assignments = [];
  let insideTable = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) insideTable = true;
    if (insideTable || !/^\s*project_doc_max_bytes\b/.test(line)) continue;
    const match = /^\s*project_doc_max_bytes\s*=\s*([^\s#]+)\s*(?:#.*)?$/.exec(line);
    if (match === null) throw new Error('Codex project_doc_max_bytes exists but is not a valid decimal integer');
    assignments.push(match[1]);
  }
  if (assignments.length === 0) {
    return { bytes: DEFAULT_CODEX_PROJECT_DOC_MAX_BYTES, source: 'documented-default', evidenceStatus: 'DOCUMENTED_DEFAULT' };
  }
  if (assignments.length !== 1) throw new Error('Codex project_doc_max_bytes must be declared exactly once');
  const raw = assignments[0];
  if (!/^[+-]?(?:0|[1-9](?:_?[0-9])*)$/.test(raw)) {
    throw new Error('Codex project_doc_max_bytes exists but is not a valid decimal integer');
  }
  const bytes = Number(raw.replaceAll('_', ''));
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Codex project_doc_max_bytes must be a positive safe integer');
  return { bytes, source: 'user-config', evidenceStatus: 'DOCUMENTED_CONFIGURED' };
}

class TomlEscapeError extends Error {}

// Decodes a TOML basic-string body (the text between the double quotes,
// backslash escapes still literal). Throws TomlEscapeError for any escape
// sequence TOML does not define, including a malformed or out-of-range
// \uXXXX / \UXXXXXXXX unicode escape.
function unescapeTomlBasicString(raw) {
  let result = '';
  let index = 0;
  while (index < raw.length) {
    const char = raw[index];
    if (char !== '\\') { result += char; index += 1; continue; }
    const next = raw[index + 1];
    if (next === undefined) throw new TomlEscapeError('trailing backslash');
    switch (next) {
      case '\\': result += '\\'; index += 2; break;
      case '"': result += '"'; index += 2; break;
      case 'n': result += '\n'; index += 2; break;
      case 't': result += '\t'; index += 2; break;
      case 'r': result += '\r'; index += 2; break;
      case 'b': result += '\b'; index += 2; break;
      case 'f': result += '\f'; index += 2; break;
      case 'u': {
        const hex = raw.slice(index + 2, index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new TomlEscapeError('invalid \\u escape');
        const codePoint = parseInt(hex, 16);
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
          throw new TomlEscapeError('\\u escape is a surrogate code point (TOML requires Unicode scalar values)');
        }
        result += String.fromCodePoint(codePoint);
        index += 6;
        break;
      }
      case 'U': {
        const hex = raw.slice(index + 2, index + 10);
        if (!/^[0-9a-fA-F]{8}$/.test(hex)) throw new TomlEscapeError('invalid \\U escape');
        const codePoint = parseInt(hex, 16);
        if (codePoint > 0x10ffff) throw new TomlEscapeError('invalid \\U escape code point');
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
          throw new TomlEscapeError('\\U escape is a surrogate code point (TOML requires Unicode scalar values)');
        }
        result += String.fromCodePoint(codePoint);
        index += 10;
        break;
      }
      default:
        throw new TomlEscapeError(`unsupported escape \\${next}`);
    }
  }
  return result;
}

// Parses one already-isolated TOML value (the trimmed right-hand side of a
// `key = <value>` assignment) as either a basic string (`"..."`, escapes
// decoded) or a literal string (`'...'`, verbatim, no escapes). A multi-line
// string (`"""`/`'''`) or any other value shape is reported as unparseable
// rather than silently accepted or ignored.
function parseTomlStringAssignment(rhs) {
  const trimmed = rhs.trim();
  if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
    return { status: 'unparseable', reason: 'unsupported TOML string form' };
  }
  if (trimmed.startsWith('"')) {
    const match = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(trimmed);
    if (match === null) return { status: 'unparseable', reason: 'unsupported TOML string form' };
    try {
      return { status: 'declared', value: unescapeTomlBasicString(match[1]) };
    } catch (error) {
      if (error instanceof TomlEscapeError) return { status: 'unparseable', reason: 'unsupported TOML escape' };
      throw error;
    }
  }
  if (trimmed.startsWith("'")) {
    const match = /^'([^']*)'\s*(?:#.*)?$/.exec(trimmed);
    if (match === null) return { status: 'unparseable', reason: 'unsupported TOML string form' };
    return { status: 'declared', value: match[1] };
  }
  return { status: 'unparseable', reason: 'unsupported TOML string form' };
}

// Reads top-level (before any `[table]` header) string-valued keys from
// `~/.codex/config.toml`. Each key resolves to one of:
//   - { status: 'absent' } — the key is not declared;
//   - { status: 'declared', value } — a basic or literal string, decoded and
//     resolved to an absolute path (relative values resolve against
//     userCodexRoot, never process.cwd());
//   - { status: 'unparseable', reason } — the key is declared exactly once
//     but its value is not a supported TOML string form or contains an
//     unsupported escape.
// A key declared more than once (in any of these forms) always throws.
function readCodexTopLevelStringKeys(userCodexRoot, boundary, keys) {
  const configPath = boundary.assert(join(userCodexRoot, 'config.toml'), 'context-doctor Codex config');
  const result = Object.fromEntries(keys.map((key) => [key, { status: 'absent' }]));
  if (!existsSync(configPath)) return result;
  const text = readFileSync(configPath, 'utf8');
  const collected = Object.fromEntries(keys.map((key) => [key, []]));
  let insideTable = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) insideTable = true;
    if (insideTable) continue;
    for (const key of keys) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`^\\s*${escaped}\\s*=\\s*(.*?)\\s*$`).exec(line);
      if (match !== null) collected[key].push(match[1]);
    }
  }
  for (const key of keys) {
    if (collected[key].length > 1) throw new Error(`Codex ${key} must be declared exactly once`);
    if (collected[key].length === 1) {
      const parsed = parseTomlStringAssignment(collected[key][0]);
      result[key] = parsed.status === 'unparseable'
        ? parsed
        : { status: 'declared', value: isAbsolute(parsed.value) ? resolve(parsed.value) : resolve(userCodexRoot, parsed.value) };
    }
  }
  return result;
}

const CODEX_INSTRUCTION_FILE_KEYS = Object.freeze({
  modelInstructionsFile: Object.freeze({
    tomlKey: 'model_instructions_file',
    sourceClass: 'model-instructions-file',
    loadPhase: 'startup_full',
    coLoadDomain: 'codex:startup',
    loadCondition: 'client-startup',
    check: 'codex-model-instructions-file',
  }),
  compactPromptFile: Object.freeze({
    tomlKey: 'experimental_compact_prompt_file',
    sourceClass: 'compact-prompt-file',
    loadPhase: 'compact_dynamic',
    coLoadDomain: 'codex:compact',
    loadCondition: 'compact-prompt-invoked',
    check: 'codex-compact-prompt-file',
  }),
});

function codexInstructionFileSource(safePath, bytes, entry) {
  const text = bytes.toString('utf8');
  const standing = entry.loadPhase === 'startup_full';
  const source = {
    path: safePath,
    relativePath: normalizedSlashes(basename(safePath)),
    sourceId: opaqueId(['context-source', 'user', 'codex', entry.sourceClass, normalizedSlashes(safePath).toLowerCase()]),
    client: 'codex',
    platform: 'codex',
    scope: 'user',
    sourceClass: entry.sourceClass,
    coLoadDomain: entry.coLoadDomain,
    loadPhase: entry.loadPhase,
    loadCondition: entry.loadCondition,
    rawBytes: bytes.length,
    effectiveBytes: bytes.length,
    evidenceStatus: 'MEASURED',
    listingBytes: 0,
    bodyBytes: bytes.length,
    standingBytes: standing ? bytes.length : 0,
    listingLoadPhase: null,
    listingLoadCondition: null,
    disableModelInvocation: false,
    skillName: null,
    hasOpenAiMetadata: false,
    budgetBytes: null,
    budgetSource: 'none',
    bytes,
    text,
    bodyText: text,
    metrics: {
      bytes: bytes.length,
      lines: lineCount(text),
      estimatedTokens: Math.ceil(bytes.length / 4),
      tokenEstimateHeuristic: 'ceil(utf8-bytes/4)',
      contentId: sha256(bytes),
    },
  };
  source.loadComponents = [{
    coLoadDomain: entry.coLoadDomain,
    loadPhase: entry.loadPhase,
    loadCondition: entry.loadCondition,
    effectiveBytes: source.effectiveBytes,
    standing,
    evidenceStatus: source.evidenceStatus,
  }];
  return source;
}

// Discovers the Codex instruction-file channels declared in `config.toml`
// (`model_instructions_file`, `experimental_compact_prompt_file`). A declared
// key whose target is missing, unreadable, or empty never throws: it yields a
// `checks[]` entry with status UNMEASURED and no source.
//
// `observe.onCodexInstructionFileDiscovery`, when supplied, is called once
// per invocation of this function. Node's builtin `node:fs` ESM named
// exports are not live bindings onto the CommonJS module.exports object in
// this Node version, so spying on `readFileSync` from a test file cannot
// observe calls made from inside this module; this hook lets a caller (in
// practice, a test) prove discoverCodexInstructionFileSources runs at most
// once per discoverInstructionSources/runContextDoctor observation without
// depending on that fragile fs-level interception, and without exporting
// process-global test state from this module.
function discoverCodexInstructionFileSources(userCodexRoot, boundary, observe = {}) {
  observe.onCodexInstructionFileDiscovery?.();
  const keys = Object.values(CODEX_INSTRUCTION_FILE_KEYS).map((entry) => entry.tomlKey);
  const declared = readCodexTopLevelStringKeys(userCodexRoot, boundary, keys);
  const sources = [];
  const checks = [];
  for (const entry of Object.values(CODEX_INSTRUCTION_FILE_KEYS)) {
    const declaration = declared[entry.tomlKey];
    if (declaration.status === 'absent') continue;
    if (declaration.status === 'unparseable') {
      checks.push({ check: entry.check, status: 'UNMEASURED', reason: declaration.reason });
      continue;
    }
    const declaredValue = declaration.value;
    let safePath;
    try {
      safePath = boundary.assert(declaredValue, `context-doctor Codex ${entry.tomlKey}`);
    } catch (error) {
      checks.push({ check: entry.check, status: 'UNMEASURED', reason: `declared ${entry.tomlKey} could not be resolved safely: ${error.message}` });
      continue;
    }
    let stats = null;
    try { if (existsSync(safePath)) stats = statSync(safePath); }
    catch { stats = null; }
    if (stats === null || !stats.isFile()) {
      checks.push({ check: entry.check, status: 'UNMEASURED', reason: `declared ${entry.tomlKey} target does not exist or is unreadable` });
      continue;
    }
    if (stats.size === 0) {
      checks.push({ check: entry.check, status: 'UNMEASURED', reason: `declared ${entry.tomlKey} target is empty` });
      continue;
    }
    let bytes;
    try { bytes = readFileSync(safePath); }
    catch (error) {
      checks.push({ check: entry.check, status: 'UNMEASURED', reason: `declared ${entry.tomlKey} target could not be read: ${error.message}` });
      continue;
    }
    sources.push(codexInstructionFileSource(safePath, bytes, entry));
  }
  return { sources, checks };
}

function applyCodexProjectDocBudget(sources, userCodexRoot, boundary) {
  const budget = readCodexProjectDocBudget(userCodexRoot, boundary);
  let remaining = budget.bytes;
  const startup = sources.filter((source) => source.client === 'codex' && source.loadPhase === 'startup_full' && source.scope !== 'user')
    .sort((a, b) => (a.scope === b.scope ? a.relativePath.localeCompare(b.relativePath) : a.scope === 'user' ? -1 : 1));
  for (const source of startup) {
    const effective = Math.min(source.rawBytes, remaining);
    remaining -= effective;
    source.effectiveBytes = effective;
    source.standingBytes = effective;
    source.evidenceStatus = budget.evidenceStatus;
    source.budgetBytes = budget.bytes;
    source.budgetSource = budget.source;
    source.loadComponents[0] = { ...source.loadComponents[0], effectiveBytes: effective, evidenceStatus: budget.evidenceStatus };
  }
  return budget;
}

function isRepositoryInstruction(path, repositoryRoot) {
  const rel = normalizedSlashes(relative(repositoryRoot, path));
  const base = basename(path).toLowerCase();
  if (base === 'agents.md' || base === 'claude.md') return true;
  if (/^\.claude\/rules\/.*\.md$/i.test(rel)) return true;
  return /^\.claude\/skills\/[^/]+\/skill\.md$/i.test(rel);
}

function platformFor(path) {
  const base = basename(path).toLowerCase();
  const lower = normalizedSlashes(path).toLowerCase();
  if (base === 'agents.md' || lower.includes('/.codex/')) return 'codex';
  return 'claude';
}

function userInstructionPaths(root, platform, boundary) {
  const safeRoot = boundary.assert(root, `context-doctor ${platform} user root`);
  if (!existsSync(safeRoot)) return [];
  const direct = boundary.assert(
    platform === 'claude' ? join(safeRoot, 'CLAUDE.md') : join(safeRoot, 'AGENTS.md'),
    `context-doctor ${platform} user instruction`,
  );
  const paths = existsSync(direct) ? [direct] : [];
  for (const child of platform === 'claude' ? ['rules', 'skills'] : ['skills']) {
    const directory = boundary.assert(join(safeRoot, child), `context-doctor ${platform} user ${child}`);
    for (const path of walk(directory, { boundary })) {
      const rel = normalizedSlashes(relative(safeRoot, path));
      if (child === 'rules' && path.toLowerCase().endsWith('.md')) paths.push(path);
      if (child === 'skills' && /(?:^|\/)skill\.md$/i.test(rel)) paths.push(path);
    }
  }
  return [...new Set(paths)].sort();
}

export function discoverInstructionSources({
  repositoryRoot,
  outerRoot = repositoryRoot,
  includeUserScope = false,
  userClaudeRoot = join(homedir(), '.claude'),
  userCodexRoot = join(homedir(), '.codex'),
  boundary = createPathBoundary({ outerRoot, repositoryRoot }),
  applyBudgets = true,
  observe = {},
}) {
  const root = boundary.assert(repositoryRoot, 'context-doctor repository root');
  const repository = walk(root, { repositoryRoot: root, boundary })
    .filter((path) => isRepositoryInstruction(path, root))
    .map((path) => sourceDescriptor(path, {
      root, scope: 'repository', platform: platformFor(path), boundary,
    }));
  if (!includeUserScope) {
    const result = repository.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    if (applyBudgets) applyCodexProjectDocBudget(result, userCodexRoot, boundary);
    Object.defineProperty(result, 'checks', { value: [], enumerable: false });
    return result;
  }

  const claudeRoot = boundary.assert(userClaudeRoot, 'context-doctor Claude user root');
  const codexRoot = boundary.assert(userCodexRoot, 'context-doctor Codex user root');
  const codexInstructionFiles = discoverCodexInstructionFileSources(codexRoot, boundary, observe);
  const user = [
    ...userInstructionPaths(claudeRoot, 'claude', boundary)
      .map((path) => sourceDescriptor(path, {
        root: claudeRoot, scope: 'user', platform: 'claude', boundary,
      })),
    ...userInstructionPaths(codexRoot, 'codex', boundary)
      .map((path) => sourceDescriptor(path, {
        root: codexRoot, scope: 'user', platform: 'codex', boundary,
      })),
    ...codexInstructionFiles.sources,
  ];
  const result = [...repository, ...user].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  if (applyBudgets) applyCodexProjectDocBudget(result, codexRoot, boundary);
  // Non-enumerable so existing callers that treat this return value as a
  // plain array of sources (JSON.stringify, spreads, length checks, ...)
  // observe no schema change; runContextDoctor reads it explicitly so that
  // the Codex instruction-file config is discovered exactly once per run.
  Object.defineProperty(result, 'checks', { value: codexInstructionFiles.checks, enumerable: false });
  return result;
}

function normalizeBlock(block) {
  return block.toLowerCase().replace(/[`*_>#-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function finding(category, action, sources, detail = {}, threshold = null) {
  if (!ACTIONS.includes(action)) throw new Error(`invalid context-doctor action: ${action}`);
  const sourceIds = [...new Set(sources.map((source) => typeof source === 'string' ? source : source.sourceId))].sort();
  return {
    findingId: opaqueId(['context-finding', category, action, sourceIds, detail]),
    category,
    action,
    severity: 'advisory',
    sourceIds,
    threshold,
    detail,
  };
}

function resolveImport(source, raw, repositoryRoot) {
  const clean = raw.replace(/[.,;:]+$/, '');
  return clean.startsWith('/') ? resolve(repositoryRoot, clean.slice(1)) : resolve(dirname(source.path), clean);
}

function countableClaims(source, repositoryRoot, boundary) {
  const results = [];
  const patterns = [
    /@([^\s]+)\s+(?:has|contains|totals?)\s+(\d+)\s+lines?/i,
    /(\d+)\s+lines?\s+(?:in|at)\s+@([^\s]+)/i,
  ];
  for (const [lineIndex, line] of source.text.split(/\r?\n/).entries()) {
    for (const [patternIndex, pattern] of patterns.entries()) {
      const match = pattern.exec(line);
      if (match === null) continue;
      const rawPath = patternIndex === 0 ? match[1] : match[2];
      const claimed = Number(patternIndex === 0 ? match[2] : match[1]);
      const target = boundary.assert(resolveImport(source, rawPath, repositoryRoot), 'context-doctor numeric claim target');
      if (!existsSync(target) || !statSync(target).isFile()) continue;
      if (statSync(target).size > 1_000_000) {
        results.push({ unmeasured: true });
        continue;
      }
      const actual = lineCount(readFileSync(target, 'utf8'));
      results.push({ unmeasured: false, line: lineIndex + 1, claimed, actual, rawPath, sample: bounded(line) });
    }
  }
  return results;
}

function hookSettings({ repositoryRoot, includeUserScope, userClaudeRoot, boundary }) {
  const paths = [{ path: join(repositoryRoot, '.claude', 'settings.json'), scope: 'repository' }];
  if (includeUserScope) paths.push({ path: join(userClaudeRoot, 'settings.json'), scope: 'user' });
  return paths.map((item) => ({
    ...item,
    path: boundary.assert(item.path, 'context-doctor hook settings'),
  })).filter((item) => existsSync(item.path));
}

function inspectHookRisk(options, findings, checks) {
  let measured = 0;
  let dynamic = 0;
  for (const item of hookSettings(options)) {
    let settings;
    try { settings = readJson(item.path, 'Claude settings', options.boundary); }
    catch {
      checks.push({ check: 'hook-dynamic-payload', status: 'UNKNOWN', reason: 'a settings file was not readable JSON' });
      continue;
    }
    measured += 1;
    const hooks = settings.hooks;
    if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) continue;
    const userPrompt = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [];
    const hookTypes = [];
    for (const entry of userPrompt) {
      for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
        hookTypes.push(typeof hook?.type === 'string' ? hook.type : 'unknown');
      }
    }
    if (userPrompt.length > 0) {
      dynamic += userPrompt.length;
      const sourceId = opaqueId(['hook-settings', item.scope, normalizedSlashes(relative(options.repositoryRoot, item.path))]);
      findings.push(finding('hook-dynamic-context-unmeasured', 'inspect', [sourceId], {
        hookEntries: userPrompt.length,
        event: 'UserPromptSubmit',
        hookTypes: [...new Set(hookTypes)].sort(),
        channel: 'stdout-or-additionalContext',
        loadPhase: 'hook_dynamic',
        payloadStatus: 'UNMEASURED',
        path: item.path,
      }));
    }
  }
  if (!checks.some((check) => check.check === 'hook-dynamic-payload' && check.status === 'UNKNOWN')) {
    checks.push({
      check: 'hook-dynamic-payload',
      status: dynamic > 0 ? 'UNMEASURED' : 'MEASURED',
      reason: dynamic > 0
        ? `${dynamic} UserPromptSubmit hook group(s) configured; runtime stdout/additionalContext was not executed or measured`
        : `${measured} settings surface(s) inspected; no UserPromptSubmit hook group was configured`,
    });
  }
}

export function inspectInstructionSources(sources, {
  repositoryRoot,
  outerRoot = repositoryRoot,
  thresholds = DEFAULT_THRESHOLDS,
  boundary = createPathBoundary({ outerRoot, repositoryRoot }),
  userCodexRoot = join(homedir(), '.codex'),
  ...hookOptions
}) {
  const findings = [];
  const checks = [];
  const duplicateBlocks = new Map();
  let cheapNumericClaims = 0;
  let unmeasuredNumericClaims = 0;

  for (const source of sources) {
    for (const block of source.bodyText.split(/\r?\n\s*\r?\n/)) {
      const normalized = normalizeBlock(block);
      if (normalized.length < thresholds.duplicateMinChars) continue;
      const key = sha256(normalized);
      const occurrences = duplicateBlocks.get(key) ?? [];
      occurrences.push({ source, sample: bounded(block), blockBytes: Buffer.byteLength(block.trim(), 'utf8'), normalizedLength: normalized.length });
      duplicateBlocks.set(key, occurrences);
    }

    const machinePaths = [...source.text.matchAll(MACHINE_PATH)];
    if (machinePaths.length > 0) {
      findings.push(finding('machine-specific-absolute-path', 'scope', [source], {
        count: machinePaths.length,
        path: source.path,
        sample: bounded(machinePaths[0][0]),
      }));
    }

    const missing = [];
    for (const match of source.text.matchAll(LOCAL_IMPORT)) {
      const target = boundary.assert(resolveImport(source, match[1], repositoryRoot), 'context-doctor local reference');
      if (!existsSync(target)) missing.push({ raw: match[1], target });
    }
    if (missing.length > 0) {
      findings.push(finding('dead-local-reference', 'inspect', [source], {
        count: missing.length,
        path: source.path,
        sample: bounded(`@${missing[0].raw}`),
        resolvedTarget: missing[0].target,
      }));
    }

    if (source.sourceClass === 'model-instructions-file') {
      findings.push(finding('model-instructions-override', 'inspect', [source], {
        coLoadDomain: source.coLoadDomain,
        observedBytes: source.standingBytes,
        configPath: join(userCodexRoot, 'config.toml'),
        path: source.path,
        reason: 'Codex documents model_instructions_file as replacing the built-in model instructions for the selected model.',
      }));
    }

    for (const claim of countableClaims(source, repositoryRoot, boundary)) {
      if (claim.unmeasured) {
        unmeasuredNumericClaims += 1;
        continue;
      }
      cheapNumericClaims += 1;
      if (claim.claimed !== claim.actual) {
        findings.push(finding('stale-countable-numeric-claim', 'inspect', [source], {
          claimed: claim.claimed,
          actual: claim.actual,
          line: claim.line,
          path: source.path,
          sample: claim.sample,
        }));
      }
    }

    const words = source.text.match(/[A-Za-z]+/g) ?? [];
    const emphasisCount = (source.text.match(EMPHASIS) ?? []).length;
    const emphasisRatio = words.length === 0 ? 0 : emphasisCount / words.length;
    if (emphasisCount >= thresholds.emphasisMinimum && emphasisRatio > thresholds.emphasisRatio) {
      findings.push(finding('emphasis-saturation', 'prune', [source], {
        emphasisCount,
        wordCount: words.length,
        ratio: emphasisRatio,
        path: source.path,
      }, { emphasisMinimum: thresholds.emphasisMinimum, emphasisRatio: thresholds.emphasisRatio }));
    }

    const dated = source.text.split(/\r?\n/).filter((line) => DATED_LINE.test(line));
    if (dated.length > thresholds.datedLines) {
      findings.push(finding('dated-changelog-accretion', 'extract', [source], {
        count: dated.length,
        path: source.path,
        sample: bounded(dated[0]),
      }, { datedLines: thresholds.datedLines }));
    }
  }

  const mirrorFamilies = new Map();
  for (const source of sources.filter((item) => item.sourceClass === 'skill-file')) {
    const key = canonicalJson([String(source.skillName).toLowerCase(), source.metrics.contentId]);
    const family = mirrorFamilies.get(key) ?? [];
    family.push(source);
    mirrorFamilies.set(key, family);
  }
  for (const family of mirrorFamilies.values()) {
    if (new Set(family.map((source) => source.client)).size < 2) continue;
    findings.push(finding('cross-client-skill-mirror', 'keep', family, {
      occurrences: family.length,
      mirrorFamily: opaqueId(['mirror-family', family[0].skillName, family[0].metrics.contentId]),
      confirmedSavingsBytesPerLoad: 0,
    }));
  }

  for (const occurrences of duplicateBlocks.values()) {
    if (occurrences.length < 2) continue;
    const buckets = new Map();
    for (const occurrence of occurrences) {
      const key = `${occurrence.source.coLoadDomain}\0${occurrence.source.loadPhase}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(occurrence);
      buckets.set(key, bucket);
    }
    const competitive = [...buckets.values()].filter((bucket) => bucket.length > 1);
    if (competitive.length > 0) {
      const savings = competitive.map((bucket) => (bucket.length - 1) * bucket[0].blockBytes);
      const confirmedSavingsBytesPerLoad = Math.max(...savings);
      findings.push(finding('duplicate-normalized-instruction-block', 'prune', occurrences.map((item) => item.source), {
        occurrences: occurrences.length,
        normalizedLength: occurrences[0].normalizedLength,
        confirmedSavingsBytesPerLoad,
        confirmedSavingsEstimatedTokensPerLoad: Math.ceil(confirmedSavingsBytesPerLoad / 4),
        competitiveDomainCount: competitive.length,
        paths: occurrences.map((item) => item.source.path),
        sample: occurrences[0].sample,
      }, { duplicateMinChars: thresholds.duplicateMinChars }));
      continue;
    }
    const withinClientAcrossDomains = ['claude', 'codex'].some((client) => {
      const selected = occurrences.filter((item) => item.source.client === client);
      return new Set(selected.map((item) => item.source.coLoadDomain)).size > 1;
    });
    if (withinClientAcrossDomains) {
      findings.push(finding('conditional-cross-skill-boilerplate', 'keep', occurrences.map((item) => item.source), {
        occurrences: occurrences.length,
        confirmedSavingsBytesPerLoad: 0,
      }, { duplicateMinChars: thresholds.duplicateMinChars }));
    }
  }

  inspectHookRisk({ repositoryRoot, boundary, ...hookOptions }, findings, checks);
  checks.push({ check: 'countable-numeric-claims', status: 'MEASURED', reason: `${cheapNumericClaims} cheaply countable claim(s) inspected` });
  if (unmeasuredNumericClaims > 0) {
    checks.push({ check: 'oversized-numeric-claim-targets', status: 'UNMEASURED', reason: `${unmeasuredNumericClaims} target(s) exceeded the bounded one-megabyte reader` });
  }
  checks.push({ check: 'behavioral-backtest-codex-engram', status: 'UNMEASURED', reason: 'no privacy-safe transcript adapter is available in this slice' });
  checks.push({ check: 'claude-line-guidance-causality-for-codex', status: 'UNMEASURED', reason: 'Claude guidance is not treated as causal evidence for Codex' });

  return {
    findings: findings.sort((a, b) => a.findingId.localeCompare(b.findingId)),
    checks: checks.sort((a, b) => a.check.localeCompare(b.check)),
  };
}

function inventoryAggregate(sources) {
  const rawBytes = sources.reduce((sum, source) => sum + source.rawBytes, 0);
  return {
    classification: 'non-standing-corpus',
    sourceCount: sources.length,
    rawBytes,
    lines: sources.reduce((sum, source) => sum + source.metrics.lines, 0),
    estimatedTokens: Math.ceil(rawBytes / 4),
  };
}

function loadComponentsForSource(source) {
  const components = [{
    coLoadDomain: source.coLoadDomain,
    loadPhase: source.loadPhase,
    rawBytes: source.sourceClass === 'skill-file' ? source.bodyBytes : source.rawBytes,
    effectiveBytes: source.effectiveBytes,
    standing: source.loadPhase === 'startup_full',
    evidenceStatus: source.evidenceStatus,
  }];
  if (source.listingLoadPhase === 'startup_metadata' && source.listingLoadCondition === 'client-skill-listing') {
    components.push({
      coLoadDomain: `${source.client}:startup`,
      loadPhase: 'startup_metadata',
      rawBytes: source.listingBytes,
      effectiveBytes: source.listingBytes,
      standing: true,
      evidenceStatus: 'MEASURED',
    });
  }
  return components;
}

function domainAggregates(sources) {
  const domains = new Map();
  for (const source of sources) {
    for (const component of loadComponentsForSource(source)) {
      const current = domains.get(component.coLoadDomain) ?? {
        coLoadDomain: component.coLoadDomain,
        client: source.client,
        loadPhases: new Set(),
        rawBytes: 0,
        effectiveBytes: 0,
        standingBytes: 0,
        sourceIds: new Set(),
        evidenceStatuses: new Set(),
        budgetBytes: null,
        budgetSource: 'none',
      };
      if (current.client !== source.client) throw new Error('context-doctor co-load domain cannot mix clients');
      current.loadPhases.add(component.loadPhase);
      current.rawBytes += component.rawBytes;
      current.effectiveBytes += component.effectiveBytes;
      if (component.standing) current.standingBytes += component.effectiveBytes;
      current.sourceIds.add(source.sourceId);
      current.evidenceStatuses.add(component.evidenceStatus);
      if (component.coLoadDomain === 'codex:startup' && source.budgetBytes !== null) {
        current.budgetBytes = source.budgetBytes;
        current.budgetSource = source.budgetSource;
      }
      domains.set(component.coLoadDomain, current);
    }
  }
  return [...domains.values()].map((domain) => ({
    coLoadDomain: domain.coLoadDomain,
    client: domain.client,
    loadPhases: [...domain.loadPhases].sort(),
    rawBytes: domain.rawBytes,
    effectiveBytes: domain.effectiveBytes,
    estimatedTokens: Math.ceil(domain.effectiveBytes / 4),
    standingBytes: domain.standingBytes,
    standingEstimatedTokens: Math.ceil(domain.standingBytes / 4),
    sourceCount: domain.sourceIds.size,
    evidenceStatus: domain.evidenceStatuses.has('UNMEASURED') ? 'UNMEASURED'
      : domain.evidenceStatuses.has('DOCUMENTED_CONFIGURED') ? 'DOCUMENTED_CONFIGURED'
        : domain.evidenceStatuses.has('DOCUMENTED_DEFAULT') ? 'DOCUMENTED_DEFAULT' : 'MEASURED',
    budgetBytes: domain.budgetBytes,
    budgetSource: domain.budgetSource,
  })).sort((a, b) => a.coLoadDomain.localeCompare(b.coLoadDomain));
}

function sourceAggregates(sources) {
  return sources.map((source) => ({
    sourceId: source.sourceId,
    client: source.client,
    scope: source.scope,
    sourceClass: source.sourceClass,
    coLoadDomain: source.coLoadDomain,
    loadPhase: source.loadPhase,
    loadCondition: source.loadCondition,
    rawBytes: source.rawBytes,
    effectiveBytes: source.effectiveBytes,
    evidenceStatus: source.evidenceStatus,
    listingBytes: source.listingBytes,
    bodyBytes: source.bodyBytes,
    standingBytes: source.standingBytes,
    lines: source.metrics.lines,
    estimatedTokens: Math.ceil(source.effectiveBytes / 4),
    tokenEstimateHeuristic: 'ceil(utf8-bytes/4)',
    contentId: source.metrics.contentId,
    listingLoadPhase: source.listingLoadPhase,
    listingLoadCondition: source.listingLoadCondition,
    budgetBytes: source.budgetBytes,
    budgetSource: source.budgetSource,
  })).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

const INVENTORY_KEYS = Object.freeze(['classification', 'sourceCount', 'rawBytes', 'lines', 'estimatedTokens']);
const DOMAIN_KEYS = Object.freeze([
  'coLoadDomain', 'client', 'loadPhases', 'rawBytes', 'effectiveBytes', 'estimatedTokens', 'standingBytes',
  'standingEstimatedTokens', 'sourceCount', 'evidenceStatus', 'budgetBytes', 'budgetSource',
]);
const SOURCE_AGGREGATE_KEYS = Object.freeze([
  'sourceId', 'client', 'scope', 'sourceClass', 'coLoadDomain', 'loadPhase', 'loadCondition',
  'rawBytes', 'effectiveBytes', 'evidenceStatus', 'listingBytes', 'bodyBytes', 'standingBytes',
  'lines', 'estimatedTokens', 'tokenEstimateHeuristic', 'contentId', 'listingLoadPhase', 'listingLoadCondition',
  'budgetBytes', 'budgetSource',
]);
const CONTENT_ID = /^sha256:[0-9a-f]{64}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function assertClosedObject(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) throw new Error(`${label} has an invalid closed schema`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function normalizeTimestamp(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be an RFC3339 timestamp`);
  const match = RFC3339.exec(value);
  if (match === null) throw new Error(`${label} must be an RFC3339 timestamp`);
  const [, year, month, day, hour, minute, second, , offsetHour = '00', offsetMinute = '00'] = match;
  const parts = [year, month, day, hour, minute, second, offsetHour, offsetMinute].map(Number);
  const [y, mo, d, h, mi, s, oh, om] = parts;
  const calendar = new Date(Date.UTC(y, mo - 1, d));
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== mo - 1 || calendar.getUTCDate() !== d
    || h > 23 || mi > 59 || s > 59 || oh > 23 || om > 59) {
    throw new Error(`${label} must be a valid RFC3339 timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid RFC3339 timestamp`);
  return new Date(parsed).toISOString();
}

function validateInventory(value, label) {
  const inventory = assertClosedObject(value, INVENTORY_KEYS, label);
  if (inventory.classification !== 'non-standing-corpus') throw new Error(`${label} must be labelled non-standing-corpus`);
  const result = { classification: inventory.classification };
  for (const key of INVENTORY_KEYS.slice(1)) result[key] = nonNegativeInteger(inventory[key], `${label}.${key}`);
  if (result.estimatedTokens !== Math.ceil(result.rawBytes / 4)) throw new Error(`${label} has an invalid token estimate`);
  return result;
}

function validateDomainAggregate(value, label) {
  const domain = assertClosedObject(value, DOMAIN_KEYS, label);
  if (typeof domain.coLoadDomain !== 'string' || !['claude', 'codex'].includes(domain.client)
    || !Array.isArray(domain.loadPhases) || domain.loadPhases.some((phase) => !LOAD_PHASES.has(phase))
    || !EVIDENCE_STATUSES.has(domain.evidenceStatus)
    || !['none', 'documented-default', 'user-config'].includes(domain.budgetSource)) {
    throw new Error(`${label} has invalid loading metadata`);
  }
  const result = { ...domain };
  for (const key of ['rawBytes', 'effectiveBytes', 'estimatedTokens', 'standingBytes', 'standingEstimatedTokens', 'sourceCount']) {
    result[key] = nonNegativeInteger(domain[key], `${label}.${key}`);
  }
  if (domain.budgetBytes !== null) {
    result.budgetBytes = nonNegativeInteger(domain.budgetBytes, `${label}.budgetBytes`);
    if (result.budgetBytes < 1) throw new Error(`${label}.budgetBytes must be positive`);
  }
  if (result.estimatedTokens !== Math.ceil(result.effectiveBytes / 4)
    || result.standingEstimatedTokens !== Math.ceil(result.standingBytes / 4)
    || result.effectiveBytes > result.rawBytes
    || result.standingBytes > result.effectiveBytes) throw new Error(`${label} has inconsistent metrics`);
  return result;
}

function validateSourceAggregate(value, label) {
  const source = assertClosedObject(value, SOURCE_AGGREGATE_KEYS, label);
  if (!CONTENT_ID.test(source.sourceId) || !CONTENT_ID.test(source.contentId)) throw new Error(`${label} must carry valid content identities`);
  if (!['claude', 'codex'].includes(source.client)
    || !['repository', 'user'].includes(source.scope)
    || !['instruction-file', 'rule-file', 'skill-file', 'model-instructions-file', 'compact-prompt-file'].includes(source.sourceClass)
    || typeof source.coLoadDomain !== 'string'
    || !LOAD_PHASES.has(source.loadPhase)
    || !LOAD_CONDITIONS.has(source.loadCondition)
    || !EVIDENCE_STATUSES.has(source.evidenceStatus)
    || source.tokenEstimateHeuristic !== 'ceil(utf8-bytes/4)') {
    throw new Error(`${label} has invalid source metadata`);
  }
  if (source.listingLoadPhase !== null && source.listingLoadPhase !== 'startup_metadata') throw new Error(`${label} has invalid listing phase`);
  if (source.listingLoadCondition !== null && !LISTING_LOAD_CONDITIONS.has(source.listingLoadCondition)) throw new Error(`${label} has invalid listing condition`);
  if (!['none', 'documented-default', 'user-config'].includes(source.budgetSource)) throw new Error(`${label} has invalid budget source`);
  const budgetBytes = source.budgetBytes === null ? null : nonNegativeInteger(source.budgetBytes, `${label}.budgetBytes`);
  if (budgetBytes !== null && budgetBytes < 1) throw new Error(`${label}.budgetBytes must be positive`);
  if ((source.budgetSource === 'none') !== (budgetBytes === null)) throw new Error(`${label} has inconsistent budget metadata`);
  const budgetedCodexDocument = source.client === 'codex' && source.loadPhase === 'startup_full' && source.scope !== 'user';
  if (budgetedCodexDocument !== (source.budgetSource !== 'none')) throw new Error(`${label} has budget metadata on the wrong source`);
  if (source.budgetSource === 'documented-default'
    && (budgetBytes !== DEFAULT_CODEX_PROJECT_DOC_MAX_BYTES || source.evidenceStatus !== 'DOCUMENTED_DEFAULT')) {
    throw new Error(`${label} has invalid documented-default budget evidence`);
  }
  if (source.budgetSource === 'user-config' && source.evidenceStatus !== 'DOCUMENTED_CONFIGURED') {
    throw new Error(`${label} has invalid configured budget evidence`);
  }
  const metrics = Object.fromEntries(['rawBytes', 'effectiveBytes', 'listingBytes', 'bodyBytes', 'standingBytes', 'lines', 'estimatedTokens']
    .map((key) => [key, nonNegativeInteger(source[key], `${label}.${key}`)]));
  if (metrics.estimatedTokens !== Math.ceil(metrics.effectiveBytes / 4)
    || metrics.effectiveBytes > metrics.rawBytes || metrics.bodyBytes > metrics.rawBytes) throw new Error(`${label} has inconsistent source metrics`);
  const expectedStanding = source.loadPhase === 'startup_full' ? metrics.effectiveBytes
    : source.listingLoadPhase === 'startup_metadata' && source.listingLoadCondition === 'client-skill-listing'
      ? metrics.listingBytes : 0;
  if (metrics.standingBytes !== expectedStanding) throw new Error(`${label} has inconsistent standing metrics`);
  if (source.sourceClass === 'skill-file' && source.listingLoadCondition === null) throw new Error(`${label} must declare skill listing semantics`);
  if (source.sourceClass !== 'skill-file' && (metrics.listingBytes !== 0 || source.listingLoadPhase !== null || source.listingLoadCondition !== null)) {
    throw new Error(`${label} has unexpected listing metadata`);
  }
  return { ...source, ...metrics, budgetBytes };
}

function validateBaseline(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.baselineVersion !== undefined && value.baselineVersion !== 'context-doctor-baseline/v2') {
    throw new Error('unsupported context-doctor baseline version; use a new --work directory or remove only this context-doctor state to rebaseline v2');
  }
  const baseline = assertClosedObject(
    value,
    ['baselineVersion', 'establishedAt', 'inventory', 'domainAggregates', 'sourceAggregates'],
    'context-doctor baseline',
  );
  if (baseline.baselineVersion !== 'context-doctor-baseline/v2') {
    throw new Error('unsupported context-doctor baseline version; use a new --work directory or remove only this context-doctor state to rebaseline v2');
  }
  if (!Array.isArray(baseline.domainAggregates)) throw new Error('context-doctor baseline domainAggregates must be an array');
  if (!Array.isArray(baseline.sourceAggregates)) throw new Error('context-doctor baseline sourceAggregates must be an array');
  const sources = baseline.sourceAggregates.map((source, index) => validateSourceAggregate(source, `context-doctor baseline source ${index}`));
  if (new Set(sources.map((source) => source.sourceId)).size !== sources.length) throw new Error('context-doctor baseline source identities must be unique');
  const inventory = validateInventory(baseline.inventory, 'context-doctor baseline inventory');
  const domains = baseline.domainAggregates.map((domain, index) => validateDomainAggregate(domain, `context-doctor baseline domain ${index}`));
  if (new Set(domains.map((domain) => domain.coLoadDomain)).size !== domains.length) throw new Error('context-doctor baseline domain identities must be unique');
  const calculatedRaw = sources.reduce((sum, source) => sum + source.rawBytes, 0);
  if (inventory.sourceCount !== sources.length || inventory.rawBytes !== calculatedRaw
    || inventory.lines !== sources.reduce((sum, source) => sum + source.lines, 0)) {
    throw new Error('context-doctor baseline inventory does not match its sources');
  }
  const sortedDomains = domains.sort((a, b) => a.coLoadDomain.localeCompare(b.coLoadDomain));
  const reconstructedDomains = domainAggregates(sources);
  if (canonicalJson(sortedDomains) !== canonicalJson(reconstructedDomains)) {
    throw new Error('context-doctor baseline domainAggregates do not match its sources');
  }
  return {
    baselineVersion: baseline.baselineVersion,
    establishedAt: normalizeTimestamp(baseline.establishedAt, 'context-doctor baseline establishedAt'),
    inventory,
    domainAggregates: sortedDomains,
    sourceAggregates: sources.sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
  };
}

function validateFindingCounts(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error(`${label} contains an invalid finding category`);
    result[key] = nonNegativeInteger(value[key], `${label}.${key}`);
  }
  return result;
}

function validateHistory(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.historyVersion !== undefined && value.historyVersion !== 'context-doctor-history/v2') {
    throw new Error('unsupported context-doctor history version; use a new --work directory or remove only this context-doctor state to rebaseline v2');
  }
  const history = assertClosedObject(
    value,
    ['historyVersion', 'firstObservedAt', 'lastObservedAt', 'entries'],
    'context-doctor history',
  );
  if (history.historyVersion !== 'context-doctor-history/v2') {
    throw new Error('unsupported context-doctor history version; use a new --work directory or remove only this context-doctor state to rebaseline v2');
  }
  if (!Array.isArray(history.entries) || history.entries.length < 1 || history.entries.length > 365) {
    throw new Error('context-doctor history entries must contain 1-365 records');
  }
  const firstObservedAt = normalizeTimestamp(history.firstObservedAt, 'context-doctor history firstObservedAt');
  const lastObservedAt = normalizeTimestamp(history.lastObservedAt, 'context-doctor history lastObservedAt');
  const entries = history.entries.map((entry, index) => {
    const item = assertClosedObject(entry, ['observedAt', 'receiptId', 'inventory', 'domainAggregates', 'findingCounts'], `context-doctor history entry ${index}`);
    if (!CONTENT_ID.test(item.receiptId)) throw new Error(`context-doctor history entry ${index} has an invalid receipt id`);
    return {
      observedAt: normalizeTimestamp(item.observedAt, `context-doctor history entry ${index} observedAt`),
      receiptId: item.receiptId,
      inventory: validateInventory(item.inventory, `context-doctor history entry ${index} inventory`),
      domainAggregates: Array.isArray(item.domainAggregates)
        ? item.domainAggregates.map((domain, domainIndex) => validateDomainAggregate(domain, `context-doctor history entry ${index} domain ${domainIndex}`))
        : (() => { throw new Error(`context-doctor history entry ${index} domainAggregates must be an array`); })(),
      findingCounts: validateFindingCounts(item.findingCounts, `context-doctor history entry ${index} findingCounts`),
    };
  });
  if (entries.some((entry, index) => index > 0 && entry.observedAt < entries[index - 1].observedAt)
    || firstObservedAt > entries[0].observedAt || lastObservedAt !== entries.at(-1).observedAt) {
    throw new Error('context-doctor history timestamps are inconsistent');
  }
  return { historyVersion: history.historyVersion, firstObservedAt, lastObservedAt, entries };
}

function safeFindings(findings) {
  return findings.map((item) => ({
    findingId: item.findingId,
    category: item.category,
    action: item.action,
    severity: item.severity,
    sourceIds: item.sourceIds,
    threshold: item.threshold,
    count: item.detail.count ?? item.detail.occurrences ?? 1,
    ...(item.detail.confirmedSavingsBytesPerLoad === undefined ? {} : { confirmedSavingsBytesPerLoad: item.detail.confirmedSavingsBytesPerLoad }),
    ...(item.detail.confirmedSavingsEstimatedTokensPerLoad === undefined ? {} : { confirmedSavingsEstimatedTokensPerLoad: item.detail.confirmedSavingsEstimatedTokensPerLoad }),
    ...(item.detail.event === undefined ? {} : { event: item.detail.event }),
    ...(item.detail.channel === undefined ? {} : { channel: item.detail.channel }),
    ...(item.detail.loadPhase === undefined ? {} : { loadPhase: item.detail.loadPhase }),
    ...(item.detail.payloadStatus === undefined ? {} : { payloadStatus: item.detail.payloadStatus }),
    ...(item.detail.coLoadDomain === undefined ? {} : { coLoadDomain: item.detail.coLoadDomain }),
    ...(item.detail.observedBytes === undefined ? {} : { observedBytes: item.detail.observedBytes }),
  }));
}

function burnIn(establishedAt, observedAt) {
  const normalizedStart = normalizeTimestamp(establishedAt, 'context-doctor burn-in start');
  const normalizedObserved = normalizeTimestamp(observedAt, 'context-doctor observation');
  const start = Date.parse(normalizedStart);
  const observed = Date.parse(normalizedObserved);
  const end = start + BURN_IN_DAYS * DAY_MS;
  return {
    days: BURN_IN_DAYS,
    startedAt: normalizedStart,
    endsAt: new Date(end).toISOString(),
    phase: observed < end ? 'burn-in' : 'awaiting-human-decision',
    promotion: 'explicit-human-decision-required',
  };
}

function readHistory(path, boundary) {
  if (!existsSync(path)) return { historyVersion: 'context-doctor-history/v2', firstObservedAt: null, lastObservedAt: null, entries: [] };
  return validateHistory(readJson(path, 'context-doctor history', boundary));
}

export function runContextDoctor({
  repositoryRoot,
  outerRoot = repositoryRoot,
  stateRoot = join(repositoryRoot, '.claude', 'state', 'context-doctor'),
  includeUserScope = false,
  userClaudeRoot = join(homedir(), '.claude'),
  userCodexRoot = join(homedir(), '.codex'),
  now = new Date().toISOString(),
  thresholdOverrides = {},
  requireExternalState = false,
  observe = {},
}) {
  const paths = validateContextDoctorPaths({
    outerRoot,
    repositoryRoot,
    stateRoot,
    userClaudeRoot,
    userCodexRoot,
    requireExternalState,
  });
  const {
    boundary, repositoryRoot: root, stateRoot: state,
    userClaudeRoot: claudeRoot, userCodexRoot: codexRoot,
  } = paths;
  const observedAt = normalizeTimestamp(now, 'context-doctor --now');
  const thresholds = mergedThresholds(thresholdOverrides);
  const baselinePath = boundary.assert(join(state, 'baseline.json'), 'context-doctor baseline');
  const historyPath = boundary.assert(join(state, 'history.json'), 'context-doctor history');
  let baseline;
  let baselineEstablished = false;
  if (existsSync(baselinePath)) {
    baseline = validateBaseline(readJson(baselinePath, 'context-doctor baseline', boundary));
  } else {
    if (existsSync(historyPath)) throw new Error('context-doctor history cannot exist without a baseline');
    baselineEstablished = true;
  }
  const priorHistory = readHistory(historyPath, boundary);
  if (!baselineEstablished && priorHistory.firstObservedAt !== null
    && priorHistory.firstObservedAt !== baseline.establishedAt) {
    throw new Error('context-doctor history is not bound to the baseline start');
  }
  if (priorHistory.lastObservedAt !== null && observedAt < priorHistory.lastObservedAt) {
    throw new Error('context-doctor observation predates durable history');
  }

  const sources = discoverInstructionSources({
    repositoryRoot: root,
    outerRoot: boundary.outerRoot,
    includeUserScope,
    userClaudeRoot: claudeRoot,
    userCodexRoot: codexRoot,
    boundary,
    observe,
  });
  const inventory = inventoryAggregate(sources);
  const domains = domainAggregates(sources);
  if (baselineEstablished) {
    baseline = validateBaseline({
      baselineVersion: 'context-doctor-baseline/v2',
      establishedAt: observedAt,
      inventory,
      domainAggregates: domains,
      sourceAggregates: sourceAggregates(sources),
    });
  }
  if (baseline.establishedAt > observedAt) throw new Error('context-doctor observation predates its baseline');

  const inspected = inspectInstructionSources(sources, {
    repositoryRoot: root,
    outerRoot: boundary.outerRoot,
    includeUserScope,
    userClaudeRoot: claudeRoot,
    userCodexRoot: codexRoot,
    thresholds,
    boundary,
  });
  const checks = [...inspected.checks, ...(sources.checks ?? [])].sort((a, b) => a.check.localeCompare(b.check));
  const findings = [...inspected.findings];
  const baselineDomains = new Map(baseline.domainAggregates.map((domain) => [domain.coLoadDomain, domain]));
  const standingDeltaByDomain = domains.filter((domain) => domain.standingBytes > 0 || baselineDomains.has(domain.coLoadDomain)).map((domain) => ({
    coLoadDomain: domain.coLoadDomain,
    client: domain.client,
    deltaBytes: domain.standingBytes - (baselineDomains.get(domain.coLoadDomain)?.standingBytes ?? 0),
  })).sort((a, b) => a.coLoadDomain.localeCompare(b.coLoadDomain));
  if (!baselineEstablished) {
    for (const delta of standingDeltaByDomain.filter((item) => item.deltaBytes > thresholds.growthBytes)) {
      findings.push(finding('standing-context-growth', 'prune', [], { ...delta }, { growthBytes: thresholds.growthBytes }));
    }
  }
  for (const domain of domains.filter((item) => item.standingBytes > thresholds.alwaysOnBytes)) {
    findings.push(finding('standing-context-budget', 'extract', [], {
      coLoadDomain: domain.coLoadDomain, observedBytes: domain.standingBytes,
    }, { alwaysOnBytes: thresholds.alwaysOnBytes }));
  }
  findings.sort((a, b) => a.findingId.localeCompare(b.findingId));

  const firstObservedAt = priorHistory.firstObservedAt ?? baseline.establishedAt;
  const receiptBase = {
    schemaVersion: RECEIPT_VERSION,
    toolVersion: CONTEXT_DOCTOR_VERSION,
    observedAt,
    mode: 'advisory',
    blocking: false,
    burnIn: burnIn(baseline.establishedAt, observedAt),
    observationWindow: { firstObservedAt, lastObservedAt: observedAt },
    tokenEstimateHeuristic: 'ceil(utf8-bytes/4)',
    thresholds,
    inventory,
    standingContext: {
      classification: 'per-co-load-domain-no-cross-client-total',
      domains: domains.filter((domain) => domain.standingBytes > 0),
    },
    conditionalContext: {
      classification: 'on-demand-or-dynamic',
      domains: domains.filter((domain) => domain.standingBytes === 0),
    },
    baseline: {
      established: baselineEstablished,
      contentId: opaqueId(baseline),
      standingDeltaByDomain,
    },
    sources: sourceAggregates(sources),
    findings: safeFindings(findings),
    checks,
  };
  const receipt = { ...receiptBase, receiptId: opaqueId(receiptBase) };
  const findingCounts = Object.fromEntries([...new Set(findings.map((item) => item.category))].sort()
    .map((category) => [category, findings.filter((item) => item.category === category).length]));
  const history = {
    historyVersion: 'context-doctor-history/v2',
    firstObservedAt,
    lastObservedAt: observedAt,
    entries: [...priorHistory.entries, { observedAt, receiptId: receipt.receiptId, inventory, domainAggregates: domains, findingCounts }]
      .slice(-thresholds.historyLimit),
  };
  if (baselineEstablished) writeJson(baselinePath, baseline, boundary);
  writeJson(historyPath, history, boundary);
  writeJson(join(state, 'latest-receipt.json'), receipt, boundary);

  const detailed = {
    reportVersion: 'context-doctor-private-report/v2',
    observedAt,
    repositoryRoot: root,
    includeUserScope,
    sources: sources.map((source) => ({
      sourceId: source.sourceId,
      path: source.path,
      client: source.client,
      scope: source.scope,
      sourceClass: source.sourceClass,
      coLoadDomain: source.coLoadDomain,
      loadPhase: source.loadPhase,
      loadCondition: source.loadCondition,
      rawBytes: source.rawBytes,
      effectiveBytes: source.effectiveBytes,
      evidenceStatus: source.evidenceStatus,
      listingBytes: source.listingBytes,
      bodyBytes: source.bodyBytes,
      metrics: source.metrics,
    })),
    findings,
    checks,
    receipt,
  };
  const reportPath = join(state, 'reports', `report-${receipt.receiptId.slice(7, 23)}.json`);
  writeJson(reportPath, detailed, boundary);
  return {
    receipt,
    reportPath: boundary.assert(reportPath, 'context-doctor private report'),
    baselinePath,
    historyPath,
  };
}
