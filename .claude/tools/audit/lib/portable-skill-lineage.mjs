import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export const SCHEMA_ID = 'gentle-ai.portable-skill-lineage/v1';
export const REQUIRED_PROVENANCE_IDS = Object.freeze([
  'engram:900001', 'engram:900002', 'engram:900003', 'engram:900004', 'engram:900005', 'engram:900006', 'engram:900007',
  'engram:900008', 'engram:900009', 'engram:900010', 'engram:900011', 'engram:900012', 'engram:900013', 'engram:900014',
]);
const STATES = { current: 0, needs_review: 1, blocked: 2 };
const KINDS = ['observation', 'evidence', 'decision', 'authority', 'consumer', 'proof'];
const ROLES = new Set(['authority', 'consumer', 'proof']);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SOURCE = /^engram:[1-9][0-9]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FORBIDDEN = new Set(['rawprompt', 'rawprompts', 'reasoningtrace', 'reasoningtraces', 'privatecontent', 'username', 'usernames', 'absolutepersonalpath', 'absolutepersonalpaths']);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.trim() !== '';
const texts = (v, empty = false) => Array.isArray(v) && (empty || v.length > 0) && v.every(text);
const unique = (v) => Array.isArray(v) && new Set(v).size === v.length;
const sameSet = (a, b) => a.length === b.length && a.every((v) => b.includes(v));
const canon = (v) => Array.isArray(v) ? v.map(canon) : object(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
export const canonicalJson = (v) => JSON.stringify(canon(v));
export const digestBytes = (v) => `sha256:${createHash('sha256').update(v).digest('hex')}`;
export function manifestContentId(manifest) {
  const copy = JSON.parse(JSON.stringify(manifest));
  if (object(copy.skill)) delete copy.skill.content_id;
  return digestBytes(Buffer.from(canonicalJson(copy), 'utf8'));
}
function safePath(root, path) {
  if (!text(path) || isAbsolute(path) || path.includes('\\')) return null;
  const absolute = resolve(root, path);
  const rel = relative(resolve(root), absolute);
  return rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel) ? null : absolute;
}
function compareVersion(a, b) {
  const left = a.split('.').map(Number); const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

function verify({ manifest, root, readFile, artifactsCurrent, seen }) {
  const findings = []; const artifacts = []; const artifactState = new Map();
  const add = (state, code, reason, action) => findings.push({ state, code, reason, action });
  const allowed = (value, keys, at) => {
    if (!object(value)) return;
    for (const key of Object.keys(value)) if (!keys.includes(key)) add('blocked', 'unknown_field', `Unknown field ${at}.${key}.`, 'Remove fields outside the versioned schema.');
  };
  const privateKeys = (value, at = '$') => {
    if (Array.isArray(value)) return value.forEach((entry, i) => privateKeys(entry, `${at}[${i}]`));
    if (!object(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN.has(key.replace(/[^A-Za-z0-9]/g, '').toLowerCase())) add('blocked', 'privacy_excluded_field', `Privacy-excluded field ${at}.${key} is present.`, 'Remove private or prompt-derived fields.');
      privateKeys(entry, `${at}.${key}`);
    }
  };
  if (!object(manifest)) {
    add('blocked', 'manifest_not_object', 'Manifest root is not an object.', 'Replace it with a valid manifest.');
    return finish(null, null, findings, artifacts);
  }
  privateKeys(manifest);
  allowed(manifest, ['schema_id', 'skill', 'history', 'bindings', 'steps', 'repair_contract', 'privacy_contract', 'revision'], '$');
  if (manifest.schema_id !== SCHEMA_ID) add('blocked', 'schema_id_invalid', `Expected ${SCHEMA_ID}.`, 'Migrate to the supported schema.');

  const skill = manifest.skill;
  allowed(skill, ['id', 'version', 'manifest_version', 'content_id', 'supersedes'], '$.skill');
  if (!object(skill) || !ID.test(skill?.id ?? '') || !VERSION.test(skill?.version ?? '') || !VERSION.test(skill?.manifest_version ?? '')
      || !DIGEST.test(skill?.content_id ?? '') || !Array.isArray(skill?.supersedes) || !skill.supersedes.every((v) => DIGEST.test(v))) {
    add('blocked', 'skill_identity_invalid', 'Skill identity or version lineage is invalid.', 'Use a non-empty kebab-case ID, x.y.z versions, and SHA-256 identities.');
  } else {
    if (!unique(skill.supersedes)) add('blocked', 'supersedes_duplicate', 'Supersedes contains duplicates.', 'Keep each prior identity once.');
    if (skill.supersedes.includes(skill.content_id)) add('blocked', 'supersedes_self', 'Manifest supersedes itself.', 'Name prior identities only.');
  }
  if (skill?.content_id !== manifestContentId(manifest)) add('blocked', 'manifest_content_id_mismatch', 'Manifest content ID is stale.', 'Review and recompute content_id.');

  const history = Array.isArray(manifest.history) ? manifest.history : [];
  const historyIds = new Set();
  if (!history.length) add('blocked', 'history_missing', 'Historical provenance is absent.', 'Restore it.');
  history.forEach((entry, i) => {
    allowed(entry, ['source_id', 'date', 'what', 'why'], `$.history[${i}]`);
    if (!object(entry) || !SOURCE.test(entry?.source_id ?? '') || !DATE.test(entry?.date ?? '') || !text(entry?.what) || !text(entry?.why)) add('blocked', 'history_entry_invalid', `History entry ${i} is invalid.`, 'Use source_id, date, what, and why only.');
    else if (historyIds.has(entry.source_id)) add('blocked', 'history_id_duplicate', `${entry.source_id} is duplicated.`, 'Keep one entry per source.');
    else historyIds.add(entry.source_id);
  });
  for (const id of REQUIRED_PROVENANCE_IDS) if (!historyIds.has(id)) add('blocked', 'required_provenance_missing', `${id} is absent.`, 'Restore the required provenance.');

  const bindings = Array.isArray(manifest.bindings) ? manifest.bindings : [];
  const bindingMap = new Map();
  if (!bindings.length) add('blocked', 'bindings_missing', 'No artifacts are bound.', 'Bind authority, consumer, and proof artifacts.');
  bindings.forEach((binding, i) => {
    allowed(binding, ['id', 'role', 'path', 'sha256'], `$.bindings[${i}]`);
    if (!object(binding) || !text(binding?.id) || !ROLES.has(binding?.role) || safePath(root, binding?.path) === null || !DIGEST.test(binding?.sha256 ?? '')) return add('blocked', 'binding_invalid', `Binding ${i} is invalid.`, 'Use a unique ID, role, safe path, and digest.');
    if (bindingMap.has(binding.id)) return add('blocked', 'binding_id_duplicate', `${binding.id} is duplicated.`, 'Keep binding IDs unique.');
    bindingMap.set(binding.id, binding);
    if (!artifactsCurrent) return;
    try {
      const actual = digestBytes(readFile(safePath(root, binding.path)));
      const state = actual === binding.sha256 ? 'current' : binding.role === 'authority' ? 'blocked' : 'needs_review';
      artifactState.set(binding.id, state); artifacts.push({ id: binding.id, role: binding.role, path: binding.path, state, expected: binding.sha256, actual });
      if (state !== 'current') add(state, `${binding.role}_drift`, `${binding.path} drifted.`, 'Review drift and issue a bounded successor if accepted.');
    } catch (error) {
      artifactState.set(binding.id, 'blocked'); artifacts.push({ id: binding.id, role: binding.role, path: binding.path, state: 'blocked', reason: 'unreadable' });
      add('blocked', 'binding_unreadable', `${binding.path} is missing or unreadable: ${error.code ?? error.message}.`, 'Restore or deliberately replace it.');
    }
  });

  const steps = Array.isArray(manifest.steps) ? manifest.steps : [];
  const stepMap = new Map(); const counts = new Map(KINDS.map((k) => [k, 0]));
  steps.forEach((step, i) => {
    allowed(step, ['id', 'kind', 'depends_on', 'input_contract', 'output_contract', 'completion_contract', 'provenance_source_ids', 'artifact_bindings'], `$.steps[${i}]`);
    if (!object(step) || !text(step?.id) || !KINDS.includes(step?.kind) || !texts(step?.depends_on, true) || !unique(step?.depends_on)
        || !texts(step?.input_contract) || !texts(step?.output_contract) || !texts(step?.completion_contract)
        || !texts(step?.provenance_source_ids) || !unique(step?.provenance_source_ids) || !texts(step?.artifact_bindings, true) || !unique(step?.artifact_bindings)) return add('blocked', 'step_invalid', `Step ${i} is invalid.`, 'Use the strict step schema.');
    if (stepMap.has(step.id)) return add('blocked', 'step_id_duplicate', `${step.id} is duplicated.`, 'Keep step IDs unique.');
    stepMap.set(step.id, step); counts.set(step.kind, counts.get(step.kind) + 1);
  });
  for (const kind of KINDS) if (counts.get(kind) !== 1) add('blocked', 'step_kind_cardinality', `Expected one ${kind} step.`, 'Restore the six-link chain.');
  for (const step of stepMap.values()) {
    for (const id of step.depends_on) if (!stepMap.has(id) || id === step.id) add('blocked', 'dependency_invalid', `${step.id} has invalid dependency ${id}.`, 'Use another existing step.');
    for (const id of step.provenance_source_ids) if (!historyIds.has(id)) add('blocked', 'step_provenance_missing', `${step.id} cites ${id}.`, 'Restore its history entry.');
    for (const id of step.artifact_bindings) if (!bindingMap.has(id)) add('blocked', 'step_binding_missing', `${step.id} cites ${id}.`, 'Restore its binding.');
    if (['authority', 'consumer', 'proof'].includes(step.kind) && !step.artifact_bindings.some((id) => bindingMap.get(id)?.role === step.kind)) add('blocked', 'step_role_binding_missing', `${step.kind} lacks its role binding.`, 'Bind a current artifact.');
  }
  const byKind = new Map([...stepMap.values()].map((step) => [step.kind, step]));
  KINDS.forEach((kind, i) => {
    const step = byKind.get(kind); if (!step) return;
    if (i === 0 && step.depends_on.length) add('blocked', 'chain_root_invalid', 'Observation is not the root.', 'Remove its dependencies.');
    if (i > 0 && !step.depends_on.includes(byKind.get(KINDS[i - 1])?.id)) add('blocked', 'six_link_chain_broken', `${kind} lacks its predecessor.`, 'Restore the ordered chain.');
  });
  const visiting = new Set(); const visited = new Set();
  const cyclic = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of stepMap.get(id)?.depends_on ?? []) if (stepMap.has(dependency) && cyclic(dependency)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  if ([...stepMap.keys()].some(cyclic)) add('blocked', 'dependency_cycle', 'Step dependencies contain a cycle.', 'Restore an acyclic six-link lineage.');

  const repair = manifest.repair_contract;
  allowed(repair, ['mode', 'max_steps_per_version', 'stable_step_identity_required', 'auto_repair', 'human_review_required', 'supersedes_required', 'recheck', 'version_rule'], '$.repair_contract');
  if (!object(repair) || repair.mode !== 'bounded_step_repair' || repair.max_steps_per_version !== 1 || repair.stable_step_identity_required !== true
      || repair.auto_repair !== false || repair.human_review_required !== true || repair.supersedes_required !== true || !texts(repair.recheck)
      || !unique(repair.recheck) || !sameSet(repair.recheck, ['affected_consumers', 'affected_proofs']) || !text(repair.version_rule)) add('blocked', 'repair_contract_invalid', 'Repair policy is invalid.', 'Require one stable step, human review, exact rechecks, and supersession.');
  const privacy = manifest.privacy_contract;
  allowed(privacy, ['engram_role', 'allowed_history_fields', 'excluded'], '$.privacy_contract');
  if (!object(privacy) || privacy.engram_role !== 'memory_and_source_not_authority' || !texts(privacy.allowed_history_fields) || !unique(privacy.allowed_history_fields)
      || !sameSet(privacy.allowed_history_fields, ['source_id', 'date', 'what', 'why']) || !texts(privacy.excluded) || !unique(privacy.excluded)
      || !sameSet(privacy.excluded, ['raw_prompts', 'reasoning_traces', 'private_content', 'usernames', 'absolute_personal_paths'])) add('blocked', 'privacy_contract_invalid', 'Privacy policy is invalid.', 'Use the exact source-only privacy contract.');

  const revision = manifest.revision;
  allowed(revision, ['kind', 'prior_manifest', 'changed_step_id', 'revalidated_binding_ids'], '$.revision');
  if (!object(revision) || !['genesis', 'repair'].includes(revision?.kind) || !(revision?.changed_step_id === null || text(revision?.changed_step_id))
      || !texts(revision?.revalidated_binding_ids, true) || !unique(revision?.revalidated_binding_ids)) add('blocked', 'revision_invalid', 'Revision metadata is invalid.', 'Declare strict genesis or repair metadata.');
  else {
    const derivedKind = skill?.version === '1.0.0' && skill?.manifest_version === '1.0.0' ? 'genesis' : 'repair';
    if (revision.kind !== derivedKind) add('blocked', 'revision_kind_inconsistent', `Declared ${revision.kind} conflicts with version-derived ${derivedKind} semantics.`, `Declare revision.kind as ${derivedKind}.`);
    if (derivedKind === 'genesis') {
      if (revision.prior_manifest !== null || revision.changed_step_id !== null || revision.revalidated_binding_ids.length || (skill?.supersedes?.length ?? 0)) add('blocked', 'genesis_invalid', 'Version 1.0.0 genesis must not name a predecessor, change, revalidation, or supersession.', 'Use explicit empty genesis metadata.');
    } else validateRepair({ manifest, skill, revision, stepMap, bindingMap, artifactState, root, readFile, artifactsCurrent, seen, add, allowed });
  }
  return finish(skill?.id ?? null, skill?.manifest_version ?? null, findings, artifacts);
}

function validateRepair({ skill, revision, stepMap, bindingMap, artifactState, root, readFile, artifactsCurrent, seen, add, allowed }) {
  if (!object(skill) || !VERSION.test(skill.version ?? '') || !VERSION.test(skill.manifest_version ?? '') || !Array.isArray(skill.supersedes)) return;
  allowed(revision.prior_manifest, ['path', 'sha256'], '$.revision.prior_manifest');
  if (!object(revision.prior_manifest) || safePath(root, revision.prior_manifest.path) === null || !DIGEST.test(revision.prior_manifest.sha256 ?? '')) return add('blocked', 'prior_manifest_binding_invalid', 'Repair lacks a valid prior manifest binding.', 'Bind the predecessor path and digest.');
  const path = safePath(root, revision.prior_manifest.path);
  if (seen.has(path)) return add('blocked', 'prior_manifest_cycle', 'Prior manifest chain cycles.', 'Bind the immediate predecessor once.');
  let prior;
  try {
    const raw = readFile(path);
    if (digestBytes(raw) !== revision.prior_manifest.sha256) return add('blocked', 'prior_manifest_binding_mismatch', 'Prior manifest digest does not match.', 'Restore the exact predecessor.');
    prior = JSON.parse(raw.toString('utf8'));
  } catch (error) { return add('blocked', 'prior_manifest_unreadable', `Prior manifest is unreadable: ${error.code ?? error.message}.`, 'Restore it.'); }
  const priorResult = verify({ manifest: prior, root, readFile, artifactsCurrent: false, seen: new Set([...seen, path]) });
  if (priorResult.current_state !== 'current') return add('blocked', 'prior_manifest_invalid', 'Prior manifest fails lineage validation.', 'Repair the predecessor chain.');
  if (compareVersion(skill.version, prior.skill.version) <= 0 || compareVersion(skill.manifest_version, prior.skill.manifest_version) <= 0) add('blocked', 'version_not_advanced', 'Skill and manifest versions must advance.', 'Issue greater x.y.z versions.');
  if (skill.supersedes.length !== 1 || skill.supersedes[0] !== prior.skill.content_id) add('blocked', 'prior_supersession_mismatch', 'Repair must supersede exactly the prior content ID.', 'Bind only prior.skill.content_id.');
  const priorSteps = new Map(prior.steps.map((step) => [step.id, step]));
  if (!sameSet([...stepMap.keys()], [...priorSteps.keys()])) return add('blocked', 'step_identity_changed', 'Stable step IDs changed.', 'Preserve the prior ID set.');
  for (const [id, step] of stepMap) if (step.kind !== priorSteps.get(id)?.kind) add('blocked', 'step_kind_changed', `${id} changed kind.`, 'Preserve its kind.');
  const changed = [...stepMap.keys()].filter((id) => canonicalJson(stepMap.get(id)) !== canonicalJson(priorSteps.get(id)));
  if (changed.length !== 1) return add('blocked', 'changed_step_cardinality', `Expected one changed step; found ${changed.length}.`, 'Split the repair.');
  if (revision.changed_step_id !== changed[0]) add('blocked', 'changed_step_mismatch', 'Declared changed step is wrong.', 'Name the mechanically changed step.');
  const affected = new Set(changed);
  const expand = (map) => { let grew = true; while (grew) { grew = false; for (const step of map.values()) if (!affected.has(step.id) && step.depends_on.some((id) => affected.has(id))) { affected.add(step.id); grew = true; } } };
  expand(stepMap); expand(priorSteps);
  const priorBindings = new Map(prior.bindings.map((binding) => [binding.id, binding])); const required = new Set();
  for (const id of affected) for (const bindingId of [...(stepMap.get(id)?.artifact_bindings ?? []), ...(priorSteps.get(id)?.artifact_bindings ?? [])]) {
    const role = bindingMap.get(bindingId)?.role ?? priorBindings.get(bindingId)?.role;
    if (role === 'consumer' || role === 'proof') required.add(bindingId);
  }
  const expected = [...required].sort(); const declared = [...revision.revalidated_binding_ids].sort();
  if (!sameSet(expected, declared)) add('blocked', 'affected_bindings_not_revalidated', `Expected revalidation of [${expected.join(', ')}].`, 'Declare every affected consumer/proof binding.');
  for (const id of expected) {
    if (!bindingMap.has(id)) add('blocked', 'affected_binding_missing', `${id} is absent.`, 'Restore it.');
    if (artifactsCurrent && artifactState.get(id) !== 'current') add('blocked', 'affected_binding_not_current', `${id} is not current.`, 'Resolve drift before accepting repair.');
  }
}

export function verifyPortableSkillLineage({ manifest, root, readFile = readFileSync }) {
  return verify({ manifest, root, readFile, artifactsCurrent: true, seen: new Set() });
}
function finish(skillId, version, findings, artifacts) {
  const state = findings.reduce((current, finding) => STATES[finding.state] > STATES[current] ? finding.state : current, 'current');
  return { schema_id: SCHEMA_ID, skill_id: skillId, manifest_version: version, current_state: state, artifacts, findings,
    summary: { current: artifacts.filter((a) => a.state === 'current').length, needs_review: artifacts.filter((a) => a.state === 'needs_review').length, blocked: artifacts.filter((a) => a.state === 'blocked').length }, exit_code: STATES[state] };
}
