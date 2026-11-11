import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  census,
  censusModels,
  parseTranscript,
  assessStability,
  stableRead,
  segmentModels,
  normalizeAgentId,
  resolveTranscriptPath,
  CENSUS_STATUS,
  CensusSelectorError,
} from '../lib/census.mjs';

const SESSION = '05a10c9a-d3e3-4517-bd83-5f0f3fe1b302';
const AGENT = 'a25a70b8df289b3bb';

function user(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}
function assistant(model, stop = 'end_turn') {
  const message = { role: 'assistant', stop_reason: stop };
  if (model !== null) message.model = model;
  return JSON.stringify({ type: 'assistant', message });
}

async function withTranscript(lines, run, { agent = AGENT } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'census-'));
  try {
    const dir = join(root, SESSION, 'subagents');
    await mkdir(dir, { recursive: true });
    if (lines !== null) {
      await writeFile(join(dir, `agent-${agent}.jsonl`), lines.join('\n'), 'utf8');
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('ok: a single model, with no gaps, is returned verbatim', async () => {
  await withTranscript([user('go'), assistant('claude-fable-5'), assistant('claude-fable-5')], async (root) => {
    const r = await census({ projectsRoot: root, session: SESSION, agent: AGENT, settleMs: 0 });
    assert.equal(r.status, CENSUS_STATUS.OK);
    assert.equal(r.model, 'claude-fable-5');
    assert.equal(r.assistantCount, 2);
    assert.equal(r.assistantWithoutModel, 0);
    assert.deepEqual(r.models, [{ model: 'claude-fable-5', count: 2 }]);
    assert.match(r.censusDigest, /^sha256:[0-9a-f]{64}$/);
  });
});

test('mixed-model: both models returned in order and as segments, none invented', async () => {
  const lines = [user('go'), assistant('claude-fable-5'), assistant('claude-fable-5'), assistant('claude-opus-4-8')];
  await withTranscript(lines, async (root) => {
    const r = await census({ projectsRoot: root, session: SESSION, agent: AGENT, settleMs: 0 });
    assert.equal(r.status, CENSUS_STATUS.MIXED_MODEL);
    assert.equal(r.model, undefined, 'must NOT collapse to a single model');
    assert.deepEqual(r.modelOrder, ['claude-fable-5', 'claude-opus-4-8']);
    assert.deepEqual(r.segments, [
      { model: 'claude-fable-5', count: 2 },
      { model: 'claude-opus-4-8', count: 1 },
    ]);
  });
});

test('incomplete: a gap (assistant with no model) blocks a singular claim but keeps what was seen', async () => {
  await withTranscript([user('x'), assistant('claude-fable-5'), assistant(null)], async (root) => {
    const r = await census({ projectsRoot: root, session: SESSION, agent: AGENT, settleMs: 0 });
    assert.equal(r.status, CENSUS_STATUS.INCOMPLETE, 'partial evidence must never pass as ok');
    assert.equal(r.model, undefined);
    assert.equal(r.assistantWithoutModel, 1);
    assert.deepEqual(r.modelOrder, ['claude-fable-5'], 'the observed model is preserved');
  });
});

test('transcript-missing: no file for the selector', async () => {
  await withTranscript([user('x'), assistant('m')], async (root) => {
    const r = await census({ projectsRoot: root, session: SESSION, agent: 'anonexistentid', settleMs: 0 });
    assert.equal(r.status, CENSUS_STATUS.TRANSCRIPT_MISSING);
  });
});

test('transcript-empty: file exists but has no lines', async () => {
  await withTranscript([], async (root) => {
    const r = await census({ projectsRoot: root, session: SESSION, agent: AGENT, settleMs: 0 });
    assert.equal(r.status, CENSUS_STATUS.TRANSCRIPT_EMPTY);
  });
});

test('transcript-malformed: a non-JSON line fails the whole transcript', async () => {
  await withTranscript([user('x'), 'this is not json', assistant('m')], async (root) => {
    const r = await census({ projectsRoot: root, session: SESSION, agent: AGENT, settleMs: 0 });
    assert.equal(r.status, CENSUS_STATUS.TRANSCRIPT_MALFORMED);
    assert.equal(r.malformedAt, 1);
  });
});

test('assistant-missing: parses but has no assistant line', async () => {
  await withTranscript([user('x'), user('y')], async (root) => {
    const r = await census({ projectsRoot: root, session: SESSION, agent: AGENT, settleMs: 0 });
    assert.equal(r.status, CENSUS_STATUS.ASSISTANT_MISSING);
  });
});

test('model-missing: assistant lines exist but none carries a model', async () => {
  await withTranscript([user('x'), assistant(null)], async (root) => {
    const r = await census({ projectsRoot: root, session: SESSION, agent: AGENT, settleMs: 0 });
    assert.equal(r.status, CENSUS_STATUS.MODEL_MISSING);
    assert.equal(r.assistantWithoutModel, 1);
  });
});

test('stableRead: unstable when the file grows during the pre-read wait', async () => {
  let n = 0;
  const io = { stat: async () => { n += 1; return { size: n * 10, mtimeMs: n }; }, readFile: async () => 'never read' };
  const r = await stableRead('x', { settleMs: 1, io });
  assert.equal(r.stable, false, 'a size change between the two pre-read stats is unstable');
});

test('stableRead: unstable when the file changes ACROSS the read, even with settle 0', async () => {
  let size = 10;
  const io = {
    stat: async () => ({ size, mtimeMs: 1 }),
    readFile: async () => { size = 20; return 'x'; }, // the read itself grows the file
  };
  const r = await stableRead('x', { settleMs: 0, io });
  assert.equal(r.stable, false, 'a change between before-read and after-read snapshot is unstable');
});

test('stableRead: stable when both stats agree around the read', async () => {
  const io = { stat: async () => ({ size: 10, mtimeMs: 1 }), readFile: async () => '{"a":1}' };
  const r = await stableRead('x', { settleMs: 0, io });
  assert.deepEqual(r, { stable: true, text: '{"a":1}' });
});

test('census surfaces transcript-unstable when stableRead reports a change', async () => {
  // End-to-end: a live-growing file returns unstable. Kept coarse; the branch
  // logic itself is pinned deterministically by the stableRead tests above.
  await withTranscript([user('x'), assistant('claude-fable-5')], async (root) => {
    const filePath = join(root, SESSION, 'subagents', `agent-${AGENT}.jsonl`);
    let alive = true;
    const grow = async () => { while (alive) { await writeFile(filePath, `${assistant('m')}\n`, { flag: 'a' }); await new Promise((r) => setTimeout(r, 3)); } };
    const pump = grow();
    try {
      const r = await census({ projectsRoot: root, session: SESSION, agent: AGENT, settleMs: 40 });
      assert.equal(r.status, CENSUS_STATUS.TRANSCRIPT_UNSTABLE);
    } finally { alive = false; await pump; }
  });
});

test('census refuses a junction that escapes the projects root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'census-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'census-out-'));
  try {
    const outSub = join(outside, 'subagents');
    await mkdir(outSub, { recursive: true });
    await writeFile(join(outSub, `agent-${AGENT}.jsonl`), assistant('claude-fable-5'), 'utf8');
    // root/<session> is a junction pointing outside the projects root.
    try {
      await symlink(outside, join(root, SESSION), 'junction');
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'ENOSYS')) return t.skip('no symlink/junction privilege');
      throw err;
    }
    await assert.rejects(
      census({ projectsRoot: root, session: SESSION, agent: AGENT, settleMs: 0 }),
      CensusSelectorError,
      'a real path outside the projects root must be refused',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('resolveTranscriptPath refuses traversal and separators in selectors', () => {
  for (const bad of ['../escape', 'a/b', 'a\\b', '..']) {
    assert.throws(() => resolveTranscriptPath({ projectsRoot: '/root', session: bad, agent: AGENT }), CensusSelectorError);
    assert.throws(() => resolveTranscriptPath({ projectsRoot: '/root', session: SESSION, agent: bad }), CensusSelectorError);
  }
});

test('normalizeAgentId strips the agent- prefix idempotently', () => {
  assert.equal(normalizeAgentId('agent-abc'), 'abc');
  assert.equal(normalizeAgentId('abc'), 'abc');
});

test('assessStability: a growing file is not stable', () => {
  assert.equal(assessStability({ size: 10, mtimeMs: 1 }, { size: 20, mtimeMs: 2 }), false);
  assert.equal(assessStability({ size: 10, mtimeMs: 1 }, { size: 10, mtimeMs: 1 }), true);
});

test('segmentModels preserves the real sequence: A,B,A is three segments, not A×2 B×1', () => {
  assert.deepEqual(segmentModels(['A', 'B', 'A']), [
    { model: 'A', count: 1 },
    { model: 'B', count: 1 },
    { model: 'A', count: 1 },
  ]);
});

test('censusModels reports totals (first-seen) and segments (real order) distinctly', () => {
  const records = [
    { type: 'assistant', message: { model: 'A' } },
    { type: 'assistant', message: { model: 'B' } },
    { type: 'assistant', message: { model: 'A' } },
  ];
  const c = censusModels(records);
  assert.deepEqual(c.models, [{ model: 'A', count: 2 }, { model: 'B', count: 1 }]);
  assert.deepEqual(c.segments, [{ model: 'A', count: 1 }, { model: 'B', count: 1 }, { model: 'A', count: 1 }]);
});

test('parseTranscript ignores blank lines and reports the first malformed index', () => {
  assert.equal(parseTranscript('').rawLines.length, 0);
  assert.equal(parseTranscript('{"a":1}\n\n{"b":2}').records.length, 2);
  assert.equal(parseTranscript('{"a":1}\nnope').malformedAt, 1);
});
