#!/usr/bin/env node
// Public edition: private incident history omitted. See the operational contract.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CANONICAL = resolve(HERE, '..', '..', '..', 'tools', 'audit', 'lib', 'canonical.mjs');
const EVIDENCE_RECORD = resolve(HERE, '..', '..', '..', 'tools', 'audit', 'lib', 'evidence-record.mjs');
const { digest } = await import(pathToFileURL(CANONICAL).href);
const { derivedGateStatus } = await import(pathToFileURL(EVIDENCE_RECORD).href);

const usage = `usage:
  evidence.mjs --gate-result <file> --subject-id <sha256:...> --reason-file <file> --out <file>

Builds a schema-valid evidence record from an \`audit.mjs check\` result.

The reason must name the subject_id it describes. That is the one guard here:
a reason copied from another candidate carries the other candidate's subject_id
and is refused.

stdout is the evidenceId. exit 0 written; 1 refused; 2 usage.`;

function die(code, message) {
  process.stderr.write(`evidence: ${message}\n`);
  process.exit(code);
}

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith('--')) die(2, `unexpected argument ${JSON.stringify(token)}\n\n${usage}`);
  const key = token.slice(2);
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) die(2, `--${key} needs a value\n\n${usage}`);
  args[key] = value;
  i += 1;
}

for (const required of ['gate-result', 'subject-id', 'reason-file', 'out']) {
  if (!args[required]) die(2, `--${required} is required\n\n${usage}`);
}

const subjectId = args['subject-id'];
if (!/^sha256:[0-9a-f]{64}$/.test(subjectId)) {
  die(2, `--subject-id must be a full sha256:<64 hex> value, prefix included. `
    + `A bare digest without the prefix is the shape that once discarded a verdict and marked a lineage STALE.`);
}

for (const path of [args['gate-result'], args['reason-file']]) {
  if (!existsSync(path)) die(1, `no such file: ${path}`);
}

let gate;
try {
  gate = JSON.parse(readFileSync(args['gate-result'], 'utf8'));
} catch (error) {
  die(1, `the gate result is not readable JSON: ${error.message}`);
}

if (!gate.binding || !gate.gate || !gate.status) {
  die(1, `the gate result carries no binding, gate or status. `
    + `Pass the stdout of \`audit.mjs check --policy <p> --gate <g> --cwd <path>\`, not a summary of it.`);
}

const reason = readFileSync(args['reason-file'], 'utf8').trim();
if (reason === '') die(1, 'the reason file is empty');

// The one guard. A reason that does not name its own subject is either careless
// or borrowed, and both were real failures.
if (!reason.includes(subjectId)) {
  die(1, `the reason does not name ${subjectId}.\n`
    + `        Evidence describes one candidate. A reason that names a different subject, or none, `
    + `is how a record came to describe the wrong contribution. Write the reason for this candidate `
    + `and quote its subject_id inside it.`);
}

const passed = [], failed = [], inconclusive = [], skipped = [];
for (const check of gate.checks || []) {
  const row = {
    id: check.id,
    required: check.required !== false,
    reason: check.reason || check.detail || check.message || '',
  };
  if (check.status === 'PASS') passed.push(row);
  else if (check.status === 'FAIL') failed.push(row);
  else if (check.status === 'UNKNOWN') inconclusive.push(row);
  else skipped.push(row);
}

// The status is copied from the gate result, so it is only as honest as the
// file. Derive what the checks aggregate to, by the engine's own rule, and
// refuse a file that claims otherwise: `audit.mjs check` never emits PASS over
// zero required checks (it emits UNKNOWN and exit 2), so a file that does was
// edited, and a gate that verifies nothing must not become PASS evidence
// (ASTRA-04). The same derivation refuses again at record-evidence and at
// authorize, so this is the first of three doors, not the only one.
const derived = derivedGateStatus({ verifications: { passed, failed, inconclusive, skipped } });
if (derived !== gate.status) {
  die(1, `the gate result claims ${gate.status} but its checks aggregate to ${derived}. `
    + `Pass the stdout of \`audit.mjs check\` as it was produced, not an edited copy: `
    + `a gate that verifies nothing is UNKNOWN, not PASS, and must not authorise anything.`);
}

const body = {
  evidenceVersion: '1.0.0',
  gate: gate.gate,
  gateStatus: gate.status,
  candidate: {
    status: gate.status,
    candidateId: gate.binding.snapshotHash,
    reason,
  },
  binding: {
    decisionId: gate.binding.decisionId,
    policyHash: gate.binding.policyHash,
    snapshotHash: gate.binding.snapshotHash,
    snapshotHashAfter: gate.binding.snapshotHashAfter,
    stable: gate.binding.stable,
    toolVersion: gate.binding.toolVersion,
  },
  verifications: { passed, failed, inconclusive, skipped },
  summary: {
    pass: passed.length,
    fail: failed.length,
    unknown: inconclusive.length,
    notRun: skipped.length,
  },
  authorises: false,
};

const evidenceId = digest(body);
const record = {
  evidenceVersion: body.evidenceVersion,
  evidenceId,
  gate: body.gate,
  gateStatus: body.gateStatus,
  candidate: body.candidate,
  binding: body.binding,
  verifications: body.verifications,
  summary: body.summary,
  authorises: body.authorises,
};

writeFileSync(args.out, `${JSON.stringify(record, null, 1)}\n`);
process.stdout.write(`${evidenceId}\n`);
process.stderr.write(
  `evidence: ${record.gate} ${record.gateStatus} -- `
  + `${record.summary.pass} pass, ${record.summary.fail} fail, `
  + `${record.summary.unknown} unknown, ${record.summary.notRun} not run\n`
  + `evidence: written to ${args.out}\n`
);
