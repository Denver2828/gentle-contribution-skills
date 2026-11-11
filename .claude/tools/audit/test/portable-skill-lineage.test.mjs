import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { REQUIRED_PROVENANCE_IDS, SCHEMA_ID, digestBytes, manifestContentId, verifyPortableSkillLineage } from '../lib/portable-skill-lineage.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'portable-skill-lineage-'));
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'verify-portable-skill-lineage.mjs');
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const finalize = (manifest) => { manifest.skill.content_id = manifestContentId(manifest); return manifest; };

function fixture() {
  const root = join(scratch, `case-${counter += 1}`); mkdirSync(root);
  const files = { authority: 'authority.md', consumer: 'consumer.md', proof: 'proof.mjs' };
  for (const [role, path] of Object.entries(files)) writeFileSync(join(root, path), `${role} contract\n`);
  const bindings = Object.entries(files).map(([role, path]) => ({ id: `${role}-binding`, role, path, sha256: digestBytes(readFileSync(join(root, path))) }));
  const kinds = ['observation', 'evidence', 'decision', 'authority', 'consumer', 'proof'];
  const steps = kinds.map((kind, i) => ({
    id: `${String(i + 1).padStart(2, '0')}-${kind}`, kind,
    depends_on: i ? [`${String(i).padStart(2, '0')}-${kinds[i - 1]}`] : [],
    input_contract: [`${kind} input`], output_contract: [`${kind} output`], completion_contract: [`${kind} completion`],
    provenance_source_ids: [REQUIRED_PROVENANCE_IDS[i]],
    artifact_bindings: ['authority', 'consumer', 'proof'].includes(kind) ? [`${kind}-binding`] : [],
  }));
  const manifest = finalize({
    schema_id: SCHEMA_ID,
    skill: { id: 'fixture-skill', version: '1.0.0', manifest_version: '1.0.0', content_id: '', supersedes: [] },
    history: REQUIRED_PROVENANCE_IDS.map((source_id) => ({ source_id, date: '2026-08-29', what: `Recorded ${source_id}.`, why: 'Preserve privacy-safe provenance.' })),
    bindings, steps,
    repair_contract: { mode: 'bounded_step_repair', max_steps_per_version: 1, stable_step_identity_required: true, auto_repair: false, human_review_required: true, supersedes_required: true, recheck: ['affected_consumers', 'affected_proofs'], version_rule: 'Advance and supersede.' },
    privacy_contract: { engram_role: 'memory_and_source_not_authority', allowed_history_fields: ['source_id', 'date', 'what', 'why'], excluded: ['raw_prompts', 'reasoning_traces', 'private_content', 'usernames', 'absolute_personal_paths'] },
    revision: { kind: 'genesis', prior_manifest: null, changed_step_id: null, revalidated_binding_ids: [] },
  });
  return { root, files, manifest };
}

function successor(base, changedKind = 'proof') {
  const priorPath = 'prior-manifest.json';
  const priorBytes = Buffer.from(`${JSON.stringify(base.manifest, null, 2)}\n`);
  writeFileSync(join(base.root, priorPath), priorBytes);
  const manifest = JSON.parse(JSON.stringify(base.manifest));
  manifest.skill.version = '1.0.1'; manifest.skill.manifest_version = '1.0.1'; manifest.skill.supersedes = [base.manifest.skill.content_id];
  const step = manifest.steps.find((entry) => entry.kind === changedKind); step.completion_contract = [`${changedKind} repaired`];
  const affected = changedKind === 'proof' ? ['proof-binding'] : changedKind === 'consumer' ? ['consumer-binding', 'proof-binding'] : ['consumer-binding', 'proof-binding'];
  manifest.revision = { kind: 'repair', prior_manifest: { path: priorPath, sha256: digestBytes(priorBytes) }, changed_step_id: step.id, revalidated_binding_ids: affected };
  return finalize(manifest);
}
const codes = (result) => result.findings.map((finding) => finding.code);

test('coherent explicit genesis is current and read-only', () => {
  const { root, files, manifest } = fixture(); const before = readFileSync(join(root, files.authority), 'utf8');
  const result = verifyPortableSkillLineage({ manifest, root });
  assert.equal(result.current_state, 'current'); assert.equal(result.exit_code, 0); assert.equal(result.findings.length, 0); assert.equal(readFileSync(join(root, files.authority), 'utf8'), before);
});

test('a valid one-step successor binds its prior and revalidates affected proof', () => {
  const base = fixture(); const result = verifyPortableSkillLineage({ manifest: successor(base), root: base.root });
  assert.equal(result.current_state, 'current'); assert.equal(result.findings.length, 0);
});

test('2.0.0 cannot claim genesis to bypass two-step repair validation', () => {
  const x = fixture();
  x.manifest.skill.version = '2.0.0'; x.manifest.skill.manifest_version = '2.0.0';
  x.manifest.steps.find((step) => step.kind === 'consumer').completion_contract = ['consumer changed'];
  x.manifest.steps.find((step) => step.kind === 'proof').completion_contract = ['proof changed'];
  finalize(x.manifest);
  const result = verifyPortableSkillLineage({ manifest: x.manifest, root: x.root });
  assert.equal(result.current_state, 'blocked'); assert.equal(result.exit_code, 2);
  assert.ok(codes(result).includes('revision_kind_inconsistent'));
  assert.ok(codes(result).includes('prior_manifest_binding_invalid'));
  writeFileSync(join(x.root, 'bypass.json'), `${JSON.stringify(x.manifest)}\n`);
  const run = spawnSync(process.execPath, [CLI, '--manifest', 'bypass.json', '--root', x.root], { encoding: 'utf8' });
  assert.equal(run.status, 2); assert.equal(JSON.parse(run.stdout).current_state, 'blocked');
});

test('1.0.0 cannot declare repair semantics', () => {
  const x = fixture(); x.manifest.revision.kind = 'repair'; finalize(x.manifest);
  const result = verifyPortableSkillLineage({ manifest: x.manifest, root: x.root });
  assert.equal(result.current_state, 'blocked'); assert.ok(codes(result).includes('revision_kind_inconsistent'));
});

test('consumer drift needs review while authority drift blocks', () => {
  const a = fixture(); writeFileSync(join(a.root, a.files.consumer), 'drift\n'); assert.equal(verifyPortableSkillLineage({ manifest: a.manifest, root: a.root }).current_state, 'needs_review');
  const b = fixture(); writeFileSync(join(b.root, b.files.authority), 'drift\n'); assert.equal(verifyPortableSkillLineage({ manifest: b.manifest, root: b.root }).current_state, 'blocked');
});

test('empty identity and malformed versions fail closed', () => {
  const x = fixture(); x.manifest.skill.id = ''; x.manifest.skill.version = '1.0'; x.manifest.skill.manifest_version = 'next'; finalize(x.manifest);
  assert.ok(codes(verifyPortableSkillLineage({ manifest: x.manifest, root: x.root })).includes('skill_identity_invalid'));
});

test('duplicate supersession entries are rejected', () => {
  const x = fixture(); const id = `sha256:${'a'.repeat(64)}`; x.manifest.skill.supersedes = [id, id]; finalize(x.manifest);
  assert.ok(codes(verifyPortableSkillLineage({ manifest: x.manifest, root: x.root })).includes('supersedes_duplicate'));
});

test('unknown top-level and nested privacy-excluded fields are rejected', () => {
  const x = fixture(); x.manifest.extra = true; x.manifest.steps[0].raw_prompt = 'must not pass'; finalize(x.manifest);
  const found = codes(verifyPortableSkillLineage({ manifest: x.manifest, root: x.root }));
  assert.ok(found.includes('unknown_field')); assert.ok(found.includes('privacy_excluded_field'));
});

test('invalid repair policy is rejected', () => {
  const x = fixture(); x.manifest.repair_contract.auto_repair = true; x.manifest.repair_contract.max_steps_per_version = 2; finalize(x.manifest);
  assert.ok(codes(verifyPortableSkillLineage({ manifest: x.manifest, root: x.root })).includes('repair_contract_invalid'));
});

test('later version with invalid prior binding is rejected', () => {
  const x = fixture(); const next = successor(x); next.revision.prior_manifest.sha256 = `sha256:${'0'.repeat(64)}`; finalize(next);
  assert.ok(codes(verifyPortableSkillLineage({ manifest: next, root: x.root })).includes('prior_manifest_binding_mismatch'));
});

test('later version changing two steps is rejected', () => {
  const x = fixture(); const next = successor(x); next.steps.find((step) => step.kind === 'consumer').completion_contract = ['also changed']; next.revision.revalidated_binding_ids = ['consumer-binding', 'proof-binding']; finalize(next);
  assert.ok(codes(verifyPortableSkillLineage({ manifest: next, root: x.root })).includes('changed_step_cardinality'));
});

test('affected consumer or proof omitted from current revalidation is rejected', () => {
  const x = fixture(); const next = successor(x, 'consumer'); next.revision.revalidated_binding_ids = ['consumer-binding']; finalize(next);
  assert.ok(codes(verifyPortableSkillLineage({ manifest: next, root: x.root })).includes('affected_bindings_not_revalidated'));
});

test('duplicate bindings fail closed', () => {
  const x = fixture(); x.manifest.bindings.push({ ...x.manifest.bindings[0] }); finalize(x.manifest);
  assert.ok(codes(verifyPortableSkillLineage({ manifest: x.manifest, root: x.root })).includes('binding_id_duplicate'));
});

test('missing bound artifact is blocked', () => {
  const x = fixture(); unlinkSync(join(x.root, x.files.proof));
  const result = verifyPortableSkillLineage({ manifest: x.manifest, root: x.root }); assert.equal(result.current_state, 'blocked'); assert.ok(codes(result).includes('binding_unreadable'));
});

test('stale manifest content identity is blocked', () => {
  const x = fixture(); x.manifest.steps[0].completion_contract = ['unbound edit'];
  assert.ok(codes(verifyPortableSkillLineage({ manifest: x.manifest, root: x.root })).includes('manifest_content_id_mismatch'));
});

test('malformed CLI JSON returns a structured blocked result', () => {
  const x = fixture(); writeFileSync(join(x.root, 'bad.json'), '{not-json');
  const run = spawnSync(process.execPath, [CLI, '--manifest', 'bad.json', '--root', x.root], { encoding: 'utf8' });
  assert.equal(run.status, 2); assert.equal(JSON.parse(run.stdout).current_state, 'blocked'); assert.match(JSON.parse(run.stdout).findings[0].code, /manifest_unreadable/);
});
