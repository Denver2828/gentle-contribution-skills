// Generator for test/fixtures/pre-v3-store: an AUTHORIZED lineage built by the
// pre-v3 code (commit ea7a8af) with a v2 auditor result, task contract,
// evidence and receipt. It is the provenance of the fixture, kept so it can be
// regenerated; it is not a test. Usage:
//   git archive ea7a8af .claude/tools/audit | tar -x -C <old>
//   node make-pre-v3-store.mjs <old>/.claude/tools/audit <out-store-dir>
// `node --test` also loads every .mjs under test/; without arguments this
// file does nothing.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [oldDir, out] = process.argv.slice(2);
if (oldDir === undefined || out === undefined || !process.argv[1]?.endsWith('make-pre-v3-store.mjs')) {
  process.exit(0);
}
const load = (rel) => import(pathToFileURL(join(oldDir, rel)).href);

const { openStore } = await load('lib/store/store.mjs');
const { bodyDigest } = await load('lib/ticket.mjs');
const { buildEvidence } = await load('lib/evidence-record.mjs');
const { REQUIRED_SOURCES, READING, CONTRIBUTION } = await load('lib/intake.mjs');
const { STATUS } = await load('lib/status.mjs');
const { completeCoverage, auditorResult, TASK_CONTRACT } = await load('test/helpers/documents.mjs');

const id = (c) => `sha256:${c.repeat(64)}`;
const CANDIDATE = id('c');
const BODY = 'hola mundo\ncon dos lineas\n';
const INTAKE = {
  repository: 'Gentleman-Programming/gentle-ai',
  contributionType: CONTRIBUTION.ISSUE,
  readings: REQUIRED_SOURCES.map((source) => ({
    source, command: `${source} --repo Gentleman-Programming/gentle-ai`, result: READING.COMPLETE, matches: 0, reviewed: false, coverage: completeCoverage({ source }),
  })),
  competing: [],
};
const FREEZE = {
  baseTree: 'ab933c1c', candidateTree: '4daf0098',
  pathsDigest: id('1'), draftDigest: id('2'), policyDigest: id('3'), testManifestDigest: id('4'),
  draftBodySha256: bodyDigest(BODY), taskContract: TASK_CONTRACT, intake: INTAKE,
};
const evidence = buildEvidence({
  result: {
    gate: 'preflight', status: STATUS.PASS,
    binding: { snapshotHash: id('5'), snapshotHashAfter: id('5'), stable: true, policyHash: id('7'), toolVersion: '0.1.0', decisionId: id('9') },
    summary: { pass: 1, fail: 0, unknown: 0, notRun: 0 },
    checks: [{ id: 'a.one', status: STATUS.PASS, required: true, reason: 'ok' }],
  },
  candidate: { status: STATUS.PASS, candidateId: CANDIDATE, reason: 'identified' },
});
const BINDING = { operation: 'issue-comment', targetRepo: 'Gentleman-Programming/gentle-ai', targetNumber: 3297, bodySha256: bodyDigest(BODY), titleSha256: null };

const api = openStore({ override: out, allowOutsideWorkspace: true });
const lineage = 'pre-v3';
const frozen = api.freeze({ lineage, candidateId: CANDIDATE, ...FREEZE });
const audit = auditorResult(frozen.subject_id, 'PASS');
if (audit.schemaVersion !== 'auditor-result/v2') throw new Error(`expected v2, got ${audit.schemaVersion}`);
api.recordAudit({ lineage, result: audit });
api.recordEvidence({ lineage, evidence });
const { receipt, state } = api.authorize({ lineage, publication: BINDING });
console.log(JSON.stringify({ state, receiptId: receipt.receiptId, auditResultId: api.status(lineage).auditResultId }));
