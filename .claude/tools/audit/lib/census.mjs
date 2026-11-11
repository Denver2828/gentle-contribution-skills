// Public edition: private incident history omitted. See the operational contract.

import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';

import { sha256Hex, digest } from './canonical.mjs';

/** One singular result, one plural result, and seven refusals. */
export const CENSUS_STATUS = Object.freeze({
  OK: 'ok',
  MIXED_MODEL: 'mixed-model',
  INCOMPLETE: 'incomplete',
  TRANSCRIPT_MISSING: 'transcript-missing',
  TRANSCRIPT_EMPTY: 'transcript-empty',
  TRANSCRIPT_MALFORMED: 'transcript-malformed',
  ASSISTANT_MISSING: 'assistant-missing',
  MODEL_MISSING: 'model-missing',
  TRANSCRIPT_UNSTABLE: 'transcript-unstable',
});

export class CensusSelectorError extends Error {
  constructor(label, value, detail) {
    super(`${label} ${JSON.stringify(value)} is not a safe selector: ${detail}`);
    this.name = 'CensusSelectorError';
  }
}

// Session ids are uuids; agent ids are `agent-<hex>`. Both become path
// components, so both are validated before they touch the filesystem -- an id
// is data, and data is something anyone can write.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AGENT_CORE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSelector(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new CensusSelectorError(label, value, 'expected 1-128 chars of [A-Za-z0-9._-] starting alphanumeric');
  }
  if (value === '.' || value === '..' || value.includes('..')) {
    throw new CensusSelectorError(label, value, 'traversal segments are refused');
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new CensusSelectorError(label, value, 'separators are refused');
  }
  return value;
}

/** `agent-a1b2` and `a1b2` both name the same file; normalise to the core. */
export function normalizeAgentId(agent) {
  if (typeof agent !== 'string') {
    throw new CensusSelectorError('agent', agent, 'expected a string');
  }
  return agent.startsWith('agent-') ? agent.slice('agent-'.length) : agent;
}

/**
 * Resolve exactly the transcript named by (session, agent) under projectsRoot.
 * The caller passes ids, never a path, so a substituted or traversing path
 * cannot redirect the census. Containment is checked lexically here; symlink /
 * junction escapes are caught separately by a realpath check at read time
 * (assertRealWithin), because a lexical check cannot see through a link.
 *
 * @returns {{ path: string, subagentsDir: string, transcriptId: string }}
 */
export function resolveTranscriptPath({ projectsRoot, session, agent }) {
  if (typeof projectsRoot !== 'string' || projectsRoot === '') {
    throw new CensusSelectorError('projectsRoot', projectsRoot, 'a base directory is required');
  }
  const safeSession = assertSelector(session, 'session', SESSION_ID);
  const agentCore = assertSelector(normalizeAgentId(agent), 'agent', AGENT_CORE);

  const subagentsDir = resolve(projectsRoot, safeSession, 'subagents');
  const path = join(subagentsDir, `agent-${agentCore}.jsonl`);

  const rootWithSep = subagentsDir.endsWith(sep) ? subagentsDir : subagentsDir + sep;
  if (!path.startsWith(rootWithSep)) {
    throw new CensusSelectorError('transcript', `${session}/${agent}`, `resolves to ${path}, outside ${subagentsDir}`);
  }

  return { path, subagentsDir, projectsRoot, transcriptId: `${safeSession}/agent-${agentCore}` };
}

/**
 * Refuse a symlink/junction escape anywhere in the chain: the file's real path
 * must be strictly inside the PROJECTS ROOT's real path. Anchoring on the
 * subagents directory would not catch a junction on `session` or `subagents`
 * itself, because that would move the file and its own directory out together.
 * Lexical containment cannot see a link; this resolves both ends through the fs.
 */
export async function assertRealWithin(path, projectsRoot, transcriptId) {
  const realFile = await realpath(path);
  const realRoot = await realpath(projectsRoot);
  const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (!realFile.startsWith(rootWithSep)) {
    throw new CensusSelectorError('transcript', transcriptId, `real path ${realFile} escapes projects root ${realRoot}`);
  }
  return realFile;
}

/** Pure quietness judgement over two filesystem snapshots. */
export function assessStability(a, b) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

async function snapshot(path) {
  const s = await stat(path);
  return { size: s.size, mtimeMs: s.mtimeMs };
}

/**
 * Read the file only if its SIZE and MTIME stay unchanged across the whole
 * observed window: an optional pre-read wait, AND the read itself (a re-snapshot
 * after the read). A settle of 0 skips only the wait; the across-read check
 * always runs. This detects a file being written during the read (a live writer
 * appends, which moves the size); it does NOT prove the bytes are canonical -- a
 * same-size, mtime-preserving rewrite is not caught, by design (see limit 3).
 *
 * `io` is injectable so both branches — a change during the wait and a change
 * across the read — can be exercised deterministically in tests.
 *
 * @returns {{ stable: true, text: string } | { stable: false, size: number }}
 */
export async function stableRead(path, { settleMs = 250, io } = {}) {
  const statFn = (io && io.stat) || snapshot;
  const readFn = (io && io.readFile) || ((p) => readFile(p, 'utf8'));

  const a = await statFn(path);
  let before = a;
  if (settleMs > 0) {
    await new Promise((r) => setTimeout(r, settleMs));
    const b = await statFn(path);
    if (!assessStability(a, b)) return { stable: false, size: b.size };
    before = b;
  }

  const text = await readFn(path);
  const after = await statFn(path);
  if (!assessStability(before, after)) return { stable: false, size: after.size };
  return { stable: true, text };
}

/**
 * Parse a transcript body. Every non-empty line must be JSON, or the whole
 * transcript is malformed -- with a settled file, a broken line is corruption,
 * not a half-written tail.
 */
export function parseTranscript(text) {
  const rawLines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const records = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    let record;
    try {
      record = JSON.parse(rawLines[i]);
    } catch {
      return { malformedAt: i, records: [], rawLines };
    }
    records.push(record);
  }
  return { malformedAt: null, records, rawLines };
}

/** Run-length segments of a model sequence: A,B,A -> [A×1, B×1, A×1]. */
export function segmentModels(sequence) {
  const segments = [];
  for (const model of sequence) {
    const last = segments[segments.length - 1];
    if (last && last.model === model) last.count += 1;
    else segments.push({ model, count: 1 });
  }
  return segments;
}

/**
 * Census the models over parsed records. Every assistant line's message.model
 * is read, in order. Assistant lines with no model are counted -- never dropped,
 * never used to fabricate a model.
 */
export function censusModels(records) {
  const assistant = records.filter((r) => r && r.type === 'assistant');
  const perLine = [];
  let assistantWithoutModel = 0;
  let lastStopReason = null;

  for (const rec of assistant) {
    const model = rec.message && typeof rec.message.model === 'string' ? rec.message.model : null;
    if (model) perLine.push(model);
    else assistantWithoutModel += 1;
    if (rec.message && 'stop_reason' in rec.message) lastStopReason = rec.message.stop_reason ?? null;
  }

  const order = [];
  const counts = new Map();
  for (const model of perLine) {
    if (!counts.has(model)) order.push(model);
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }

  return {
    assistantCount: assistant.length,
    assistantWithoutModel,
    lastStopReason,
    modelSequence: perLine,
    modelOrder: order,
    models: order.map((model) => ({ model, count: counts.get(model) })),
    segments: segmentModels(perLine),
  };
}

/**
 * Full census. Resolves the transcript, confirms it stayed quiet across the
 * observed window (the pre-read wait AND the read itself), parses it, and
 * classifies the outcome into exactly one CENSUS_STATUS. The result always
 * carries the observed models so a mixed-model or incomplete outcome can still
 * declare all of them honestly.
 */
export async function census({ projectsRoot, session, agent, settleMs = 250 }) {
  const resolved = resolveTranscriptPath({ projectsRoot, session, agent });
  const base = { transcriptId: resolved.transcriptId, path: resolved.path };

  // Existence first, so a missing file gets its own status and realpath has
  // something to resolve.
  try {
    await snapshot(resolved.path);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ...base, status: CENSUS_STATUS.TRANSCRIPT_MISSING };
    throw err;
  }

  // Anchor the whole chain against the projects root's real path: a junction on
  // session or subagents cannot move the file outside it.
  await assertRealWithin(resolved.path, resolved.projectsRoot, resolved.transcriptId);

  // Quietness must hold across the pre-read wait AND the read itself.
  const sr = await stableRead(resolved.path, { settleMs });
  if (!sr.stable) return { ...base, status: CENSUS_STATUS.TRANSCRIPT_UNSTABLE, size: sr.size };
  const text = sr.text;

  const transcriptSha = `sha256:${sha256Hex(text)}`;
  const { malformedAt, records, rawLines } = parseTranscript(text);
  if (rawLines.length === 0) return { ...base, transcriptSha, status: CENSUS_STATUS.TRANSCRIPT_EMPTY };
  if (malformedAt !== null) return { ...base, transcriptSha, status: CENSUS_STATUS.TRANSCRIPT_MALFORMED, malformedAt };

  const c = censusModels(records);
  const observed = {
    ...base,
    transcriptSha,
    censusDigest: digest({ modelSequence: c.modelSequence }),
    assistantCount: c.assistantCount,
    assistantWithoutModel: c.assistantWithoutModel,
    lastStopReason: c.lastStopReason,
    models: c.models,
    modelOrder: c.modelOrder,
    segments: c.segments,
  };

  if (c.assistantCount === 0) return { ...observed, status: CENSUS_STATUS.ASSISTANT_MISSING };
  if (c.modelOrder.length === 0) return { ...observed, status: CENSUS_STATUS.MODEL_MISSING };
  // Partial evidence never passes: an assistant with no model is an unknown
  // drawer that could be a different model.
  if (c.assistantWithoutModel > 0) return { ...observed, status: CENSUS_STATUS.INCOMPLETE };
  if (c.modelOrder.length > 1) return { ...observed, status: CENSUS_STATUS.MIXED_MODEL };
  return { ...observed, status: CENSUS_STATUS.OK, model: c.modelOrder[0] };
}
