// ASTRA-02: the audited draft is bound to the authorized publication body.
//
// Before this binding, `freeze` folded the draft's raw digest into subject_id
// and nothing else retained it; `authorize` never compared the publication's
// bodySha256 against the draft. A different body could be authorized -- and
// published through the controlled publisher -- while the PASS audit of the
// original draft stayed attached to the lineage. The publisher's own binding
// (ticket <-> body file) was intact; the missing link was draft <-> ticket.
//
// The binding hashes the NORMALIZED draft (bodyDigest), the same function the
// authorization, the ticket and the publisher apply, so a CRLF/BOM/trailing
// newline variant of the audited bytes still authorizes and any other body
// refuses. The raw draftDigest stays inside subject_id untouched: candidate
// identity does not move.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore, StoreError } from '../lib/store/store.mjs';
import { bodyDigest, normalizeBody } from '../lib/ticket.mjs';
import { buildEvidence } from '../lib/evidence-record.mjs';
import { REQUIRED_SOURCES, READING, CONTRIBUTION } from '../lib/intake.mjs';
import { STATUS } from '../lib/status.mjs';
import { completeCoverage, auditorResult, TASK_CONTRACT } from './helpers/documents.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER = join(HERE, '..', '..', '..', 'skills', 'gentle-ai-aporte', 'scripts', 'ledger.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'audit-draft-binding-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const id = (character) => `sha256:${character.repeat(64)}`;
const CANDIDATE = id('c');
const REPO = 'Gentleman-Programming/gentle-ai';
const AUDITED = 'Reviewed benign body\n';
const OTHER = 'Different unaudited body\n';

const INTAKE = {
  repository: REPO,
  contributionType: CONTRIBUTION.ISSUE,
  readings: REQUIRED_SOURCES.map((source) => ({
    source, command: `${source} --repo ${REPO}`, result: READING.COMPLETE, matches: 0, reviewed: false, coverage: completeCoverage({ source }),
  })),
  competing: [],
};

const store = () => openStore({ override: mkdtempSync(join(scratch, 'store-')), allowOutsideWorkspace: true });

const freezeInput = (draftText) => ({
  candidateId: CANDIDATE, intake: INTAKE, taskContract: TASK_CONTRACT,
  baseTree: 'ab933c1c', candidateTree: '4daf0098',
  pathsDigest: id('1'), draftDigest: id('2'), policyDigest: id('3'), testManifestDigest: id('4'),
  draftBodySha256: bodyDigest(draftText),
});

const evidence = () => buildEvidence({
  result: {
    gate: 'preflight', status: STATUS.PASS,
    binding: { snapshotHash: id('5'), snapshotHashAfter: id('5'), stable: true, policyHash: id('7'), toolVersion: '0.1.0', decisionId: id('9') },
    summary: { pass: 1, fail: 0, unknown: 0, notRun: 0 },
    checks: [{ id: 'a.one', status: STATUS.PASS, required: true, reason: 'ok' }],
  },
  candidate: { status: STATUS.PASS, candidateId: CANDIDATE, reason: 'identified' },
});

const publication = (bodyText) => ({ operation: 'issue-comment', targetRepo: REPO, targetNumber: 42, bodySha256: bodyDigest(bodyText), titleSha256: null });

/** Frozen on `draftText`, audited PASS, evidence recorded: ready to authorize. */
function audited(api, lineage, draftText = AUDITED) {
  const frozen = api.freeze({ lineage, ...freezeInput(draftText) });
  api.recordAudit({ lineage, result: auditorResult(frozen.subject_id, 'PASS') });
  api.recordEvidence({ lineage, evidence: evidence() });
  return frozen;
}

const refusal = (failure) => (error) => error instanceof StoreError && error.detail?.failure === failure;

test('title binding: a different title changes the audited subject and cannot reuse its PASS', () => {
  const api = store();
  const input = { ...freezeInput(AUDITED), draftTitleSha256: bodyDigest('Reviewed title') };
  const first = api.freeze({ lineage: 'titled', ...input });
  const other = api.freeze({ lineage: 'other-title', ...input, draftTitleSha256: bodyDigest('Other title') });
  assert.notEqual(first.subject_id, other.subject_id);
  api.recordAudit({ lineage: 'titled', result: auditorResult(first.subject_id) });
  api.recordEvidence({ lineage: 'titled', evidence: evidence() });
  const binding = { operation: 'issue-create', targetRepo: REPO, bodySha256: bodyDigest(AUDITED), titleSha256: bodyDigest('Other title') };
  assert.throws(() => api.authorize({ lineage: 'titled', publication: binding }), refusal('title-mismatch'));
  assert.equal(api.authorize({ lineage: 'titled', publication: { ...binding, titleSha256: bodyDigest('\uFEFFReviewed title\r\n') } }).state, 'AUTHORIZED');
  assert.throws(() => api.authorize({ lineage: 'titled', publication: binding }), refusal('title-mismatch'));
});

test('title binding: an untitled audit cannot mint an issue-create authorization', () => {
  const api = store();
  audited(api, 'untitled');
  assert.throws(() => api.authorize({ lineage: 'untitled', publication: {
    operation: 'issue-create', targetRepo: REPO, bodySha256: bodyDigest(AUDITED), titleSha256: bodyDigest('Unaudited title'),
  } }), refusal('title-mismatch'));
});

test('title binding: refreeze replaces the title and historical entries without it remain readable', () => {
  const api = store();
  const input = { ...freezeInput(AUDITED), draftTitleSha256: bodyDigest('First') };
  let frozen = api.freeze({ lineage: 'title-correction', ...input });
  api.recordAudit({ lineage: 'title-correction', result: auditorResult(frozen.subject_id, 'NEEDS_CHANGES') });
  api.reserveCorrection({ lineage: 'title-correction' });
  frozen = api.refreeze({ lineage: 'title-correction', ...input, draftTitleSha256: bodyDigest('Corrected') });
  api.recordAudit({ lineage: 'title-correction', result: auditorResult(frozen.subject_id) });
  api.recordEvidence({ lineage: 'title-correction', evidence: evidence() });
  const binding = { operation: 'issue-create', targetRepo: REPO, bodySha256: bodyDigest(AUDITED), titleSha256: bodyDigest('First') };
  assert.throws(() => api.authorize({ lineage: 'title-correction', publication: binding }), refusal('title-mismatch'));
  assert.equal(api.authorize({ lineage: 'title-correction', publication: { ...binding, titleSha256: bodyDigest('Corrected') } }).state, 'AUTHORIZED');

  audited(api, 'historical-untitled');
  const index = JSON.parse(readFileSync(api.layout.index, 'utf8'));
  delete index.lineages['historical-untitled'].draftTitleSha256;
  writeFileSync(api.layout.index, JSON.stringify(index));
  assert.equal(api.status('historical-untitled').state, 'AUDITED_PASS');
  assert.throws(() => api.authorize({ lineage: 'historical-untitled', publication: binding }), refusal('title-mismatch'));
});

test('evidence recovery preserves the first correction, but never restores a spent correction', () => {
  const api = store();
  let frozen = api.freeze({ lineage: 'recover-evidence', ...freezeInput(AUDITED) });
  api.recordAudit({ lineage: 'recover-evidence', result: auditorResult(frozen.subject_id, 'BLOCKED_INCOMPLETE') });
  frozen = api.refreeze({ lineage: 'recover-evidence', ...freezeInput(AUDITED) });
  assert.equal(api.recordAudit({ lineage: 'recover-evidence', result: auditorResult(frozen.subject_id, 'NEEDS_CHANGES') }).state, 'NEEDS_CHANGES');
  assert.equal(api.reserveCorrection({ lineage: 'recover-evidence' }).corrections_used, 1);
  frozen = api.refreeze({ lineage: 'recover-evidence', ...freezeInput(OTHER) });
  api.recordAudit({ lineage: 'recover-evidence', result: auditorResult(frozen.subject_id, 'BLOCKED_INCOMPLETE') });
  frozen = api.refreeze({ lineage: 'recover-evidence', ...freezeInput(OTHER) });
  assert.equal(api.recordAudit({ lineage: 'recover-evidence', result: auditorResult(frozen.subject_id, 'NEEDS_CHANGES') }).state, 'NEEDS_MAINTAINER');
});

test('every publication requires an audit, even when preflight evidence passes', () => {
  const api = store();
  api.freeze({ lineage: 'low-risk', ...freezeInput(AUDITED) });
  api.recordEvidence({ lineage: 'low-risk', evidence: evidence() });
  assert.throws(() => api.authorize({ lineage: 'low-risk', publication: publication(AUDITED) }), /not reachable/);
});

// -- control -----------------------------------------------------------------------------

test('CONTROL: the audited draft authorizes, and the receipt binds exactly its normalized digest', () => {
  const api = store();
  audited(api, 'same-body');
  const { state, receipt } = api.authorize({ lineage: 'same-body', publication: publication(AUDITED) });
  assert.equal(state, 'AUTHORIZED');
  assert.equal(receipt.publication.bodySha256, bodyDigest(AUDITED));
  assert.equal(api.status('same-body').draftBodySha256, bodyDigest(AUDITED), 'the store retains the draft binding beside subject_id');
});

// -- regression ---------------------------------------------------------------------------

test('REGRESSION (ASTRA-02): a body other than the audited draft is refused at authorize, naming both digests', () => {
  const api = store();
  audited(api, 'body-swap');
  assert.throws(() => api.authorize({ lineage: 'body-swap', publication: publication(OTHER) }), (error) => {
    assert.equal(error instanceof StoreError, true);
    assert.equal(error.detail.failure, 'draft-mismatch');
    assert.equal(error.detail.expected, bodyDigest(AUDITED));
    assert.equal(error.detail.found, bodyDigest(OTHER));
    return true;
  });
  assert.equal(api.status('body-swap').state, 'AUDITED_PASS', 'a refused authorization is not a transition');
  assert.equal(api.status('body-swap').receiptId, null, 'no receipt was minted');
});

test('REGRESSION (ASTRA-02): freeze refuses a candidate that does not declare its normalized draft digest', () => {
  const api = store();
  const { draftBodySha256: omitted, ...withoutBinding } = freezeInput(AUDITED);
  assert.equal(typeof omitted, 'string');
  assert.throws(() => api.freeze({ lineage: 'unbound', ...withoutBinding }), refusal('missing-input'));
  assert.throws(() => api.freeze({ lineage: 'unbound', ...withoutBinding, draftBodySha256: 'not-a-digest' }), refusal('missing-input'));
  assert.throws(() => api.status('unbound'), refusal('unknown-lineage'), 'nothing was created');
});

test('REGRESSION (ASTRA-02): a lineage frozen before draft binding cannot mint a new authorization', () => {
  const api = store();
  audited(api, 'legacy');
  // Simulate history: a store written before the field existed carries no
  // draftBodySha256. Readable (the field is optional for old entries), but not
  // a source of new authority.
  const indexPath = join(api.layout.root, 'store.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  delete index.lineages.legacy.draftBodySha256;
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  assert.equal(api.status('legacy').state, 'AUDITED_PASS', 'the historical entry still reads');
  assert.throws(() => api.authorize({ lineage: 'legacy', publication: publication(AUDITED) }), (error) => {
    assert.equal(error.detail.failure, 'missing-draft-binding');
    assert.match(error.detail.remediation, /freeze/i);
    return true;
  });
});

test('refreeze rebinds the draft: the previous body no longer authorizes, the new one does', () => {
  const api = store();
  const first = api.freeze({ lineage: 'corrected', ...freezeInput(AUDITED) });
  api.recordAudit({ lineage: 'corrected', result: auditorResult(first.subject_id, 'NEEDS_CHANGES') });
  api.reserveCorrection({ lineage: 'corrected' });
  const refrozen = api.refreeze({ lineage: 'corrected', ...freezeInput(OTHER) });
  api.recordAudit({ lineage: 'corrected', result: auditorResult(refrozen.subject_id, 'PASS') });
  api.recordEvidence({ lineage: 'corrected', evidence: evidence() });

  assert.equal(api.status('corrected').draftBodySha256, bodyDigest(OTHER));
  assert.throws(() => api.authorize({ lineage: 'corrected', publication: publication(AUDITED) }), refusal('draft-mismatch'));
  assert.equal(api.authorize({ lineage: 'corrected', publication: publication(OTHER) }).state, 'AUTHORIZED');
});

// -- normalization ------------------------------------------------------------------------

test('NORMALIZATION: BOM, CRLF and trailing-newline variants of the audited draft share the binding; other bytes do not', () => {
  const api = store();
  const variants = {
    'lf': 'linea uno\nlinea dos\n',
    'crlf': 'linea uno\r\nlinea dos\r\n',
    'bom+crlf': '\uFEFFlinea uno\r\nlinea dos\r\n',
    'double-bom+cr': '\uFEFF\uFEFFlinea uno\rlinea dos',
    'many trailing newlines': 'linea uno\nlinea dos\n\n\n',
  };
  const canonical = bodyDigest(variants.lf);
  for (const text of Object.values(variants)) assert.equal(bodyDigest(text), canonical);

  audited(api, 'normalized', variants['bom+crlf']);
  assert.equal(api.status('normalized').draftBodySha256, canonical, 'the binding is over the canonical form, never the raw bytes');
  assert.equal(api.authorize({ lineage: 'normalized', publication: publication(variants.lf) }).state, 'AUTHORIZED');

  audited(api, 'normalized-other', variants.lf);
  assert.throws(() => api.authorize({ lineage: 'normalized-other', publication: publication('linea uno\nlinea dos modificada\n') }), refusal('draft-mismatch'));
  assert.notEqual(normalizeBody(variants['bom+crlf']), variants['bom+crlf'], 'the variant really was non-canonical');
});

// -- the ledger: the same draft file feeds freeze and authorize ---------------------------

test('LEDGER: freeze records the normalized draft digest from --draft, and subject-id is unchanged by it', () => {
  const dir = mkdtempSync(join(scratch, 'ledger-'));
  const write = (name, content) => { const path = join(dir, name); writeFileSync(path, content); return path; };
  const files = {
    paths: write('paths.json', JSON.stringify([{ path: 'a', mode: '100644' }])),
    draft: write('draft.md', '\uFEFFcuerpo auditado\r\n'),
    policy: write('policy.json', JSON.stringify({ policyVersion: '1' })),
    manifest: write('test-manifest.json', JSON.stringify({ note: 'no claim' })),
    task: write('task-contract.json', JSON.stringify(TASK_CONTRACT)),
  };
  const argv = ['--base-tree', 'base', '--candidate-tree', 'cand', '--paths', files.paths, '--draft', files.draft, '--policy', files.policy, '--test-manifest', files.manifest, '--task-contract', files.task];
  const run = spawnSync(process.execPath, [LEDGER, 'subject-id', ...argv], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);

  // The identity the ledger prints must equal the one the store derives WITHOUT
  // the new field: draftBodySha256 sits beside subject_id, not inside it.
  const api = store();
  const raw = readFileSync(files.draft);
  const digestOf = (buffer) => `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
  const frozen = api.freeze({
    lineage: 'from-files', candidateId: CANDIDATE, intake: INTAKE, taskContract: TASK_CONTRACT,
    baseTree: 'base', candidateTree: 'cand',
    pathsDigest: digestOf(readFileSync(files.paths)), draftDigest: digestOf(raw),
    policyDigest: digestOf(readFileSync(files.policy)), testManifestDigest: digestOf(readFileSync(files.manifest)),
    draftBodySha256: bodyDigest(raw.toString('utf8')),
  });
  assert.equal(run.stdout.trim(), frozen.subject_id, 'subject_id did not move');
  assert.equal(frozen.draftBodySha256, bodyDigest('cuerpo auditado\n'), 'normalized: BOM and CRLF stripped');
  const titleFile = write('title.txt', 'Reviewed title\r\n');
  const titled = spawnSync(process.execPath, [LEDGER, 'subject-id', ...argv, '--title-file', titleFile], { encoding: 'utf8' });
  assert.equal(titled.status, 0, titled.stderr);
  assert.notEqual(titled.stdout.trim(), frozen.subject_id);
  const titleInput = { candidateId: CANDIDATE, intake: INTAKE, taskContract: TASK_CONTRACT,
    baseTree: 'base', candidateTree: 'cand', pathsDigest: digestOf(readFileSync(files.paths)), draftDigest: digestOf(raw),
    policyDigest: digestOf(readFileSync(files.policy)), testManifestDigest: digestOf(readFileSync(files.manifest)),
    draftBodySha256: bodyDigest(raw.toString('utf8')), draftTitleSha256: bodyDigest('Reviewed title') };
  assert.equal(api.freeze({ lineage: 'titled-from-files', ...titleInput }).subject_id, titled.stdout.trim());
  writeFileSync(titleFile, 'Changed title');
  const changed = spawnSync(process.execPath, [LEDGER, 'subject-id', ...argv, '--title-file', titleFile], { encoding: 'utf8' });
  assert.equal(changed.status, 0, changed.stderr);
  assert.notEqual(changed.stdout.trim(), titled.stdout.trim());
});
