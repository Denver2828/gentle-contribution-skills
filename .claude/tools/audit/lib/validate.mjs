// Contract validation for audit results.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validate as validateAgainst } from './jsonschema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(HERE, '..', 'schema', 'result.v1.json');
export const SNAPSHOT_SCHEMA_PATH = join(HERE, '..', 'schema', 'snapshot.v1.json');
export const EVIDENCE_SCHEMA_PATH = join(HERE, '..', 'schema', 'evidence.v1.json');
export const AUTHORIZATION_SCHEMA_PATH = join(HERE, '..', 'schema', 'authorization.v1.json');
export const AUTHORIZATION_1_1_SCHEMA_PATH = join(HERE, '..', 'schema', 'authorization.v1.1.json');
export const PUBLICATION_SCHEMA_PATH = join(HERE, '..', 'schema', 'publication.v1.json');
export const TICKET_SCHEMA_PATH = join(HERE, '..', 'schema', 'ticket.v1.json');
export const SIGNATURE_SCHEMA_PATH = join(HERE, '..', 'schema', 'signature.v1.json');
export const AUDITOR_RESULT_SCHEMA_PATH = join(HERE, '..', 'schema', 'auditor-result.v1.json');
export const AUDITOR_RESULT_V2_SCHEMA_PATH = join(HERE, '..', 'schema', 'auditor-result.v2.json');
export const AUDITOR_RESULT_V3_SCHEMA_PATH = join(HERE, '..', 'schema', 'auditor-result.v3.json');
export const AUDITOR_RESULT_V4_SCHEMA_PATH = join(HERE, '..', 'schema', 'auditor-result.v4.json');
export const TASK_CONTRACT_SCHEMA_PATH = join(HERE, '..', 'schema', 'task-contract.v1.json');
export const RETIREMENT_SCHEMA_PATH = join(HERE, '..', 'schema', 'retirement.v1.json');

const cache = new Map();

function loadSchema(path) {
  if (!cache.has(path)) cache.set(path, JSON.parse(readFileSync(path, 'utf8')));
  return cache.get(path);
}

export function resultSchema() {
  return loadSchema(SCHEMA_PATH);
}

export function snapshotSchema() {
  return loadSchema(SNAPSHOT_SCHEMA_PATH);
}

export const validateEvidence = (document) => validateAgainst(loadSchema(EVIDENCE_SCHEMA_PATH), document);

/**
 * Receipts are versioned: 1.0.0 predates the publication binding and stays
 * readable so historical receipts and their attempts remain listable; 1.1.0
 * requires it. The dispatch is on the document's own declared version, and an
 * unknown version falls into the 1.1.0 schema, whose `const` names it invalid
 * rather than letting it pick whichever schema it happens to satisfy.
 */
export const validateAuthorization = (document) => validateAgainst(
  loadSchema(document?.authorizationVersion === '1.0.0' ? AUTHORIZATION_SCHEMA_PATH : AUTHORIZATION_1_1_SCHEMA_PATH),
  document
);

export const validatePublication = (document) => validateAgainst(loadSchema(PUBLICATION_SCHEMA_PATH), document);
export const validateTicket = (document) => validateAgainst(loadSchema(TICKET_SCHEMA_PATH), document);
export const validateSignature = (document) => validateAgainst(loadSchema(SIGNATURE_SCHEMA_PATH), document);
export const validateTaskContract = (document) => validateAgainst(loadSchema(TASK_CONTRACT_SCHEMA_PATH), document);

const blank = (value) => typeof value !== 'string' || value.trim() === '';

/**
 * A v3 design-coverage row declares how it was covered, and the code requires
 * that declaration to be whole. It never judges whether the assessment itself
 * was right: `assessed` needs evidence, `not_applicable` a justification, and
 * `not_assessed` a justification plus whether the gap is material to the
 * decision. Whether the declared set is complete is a verdict matter, decided
 * in auditor-result.mjs, not a refusal here.
 */
function designDeclarationErrors(document) {
  const errors = [];
  if (document.designCoverage.length > 50) {
    errors.push({ path: '$/designCoverage', message: 'designCoverage may contain at most 50 bounded rows' });
  }
  if (document.maintainerDecisions.length > 20) {
    errors.push({ path: '$/maintainerDecisions', message: 'maintainerDecisions may contain at most 20 bounded entries' });
  }
  for (const [index, decision] of document.maintainerDecisions.entries()) {
    const at = `$/maintainerDecisions[${index}]`;
    if (blank(decision.decision)) errors.push({ path: `${at}/decision`, message: 'a decision must state what is to be decided' });
    if (blank(decision.evidence)) errors.push({ path: `${at}/evidence`, message: 'a decision must carry non-blank evidence' });
    for (const [optionIndex, option] of decision.options.entries()) {
      if (blank(option)) errors.push({ path: `${at}/options[${optionIndex}]`, message: 'a decision option must not be blank' });
    }
    if (decision.options.length > 10) {
      errors.push({ path: `$/maintainerDecisions[${index}]/options`, message: 'a decision may name at most 10 options' });
    }
    if (new Set(decision.options.map((option) => option.trim())).size !== decision.options.length) {
      errors.push({ path: `$/maintainerDecisions[${index}]/options`, message: 'a decision must name distinct options' });
    }
  }
  for (const [index, row] of document.designCoverage.entries()) {
    const at = `$/designCoverage[${index}]`;
    if (blank(row.evidence)) errors.push({ path: `${at}/evidence`, message: 'design coverage must carry non-blank evidence' });
    if (row.status === 'assessed') {
      if (row.material !== null) errors.push({ path: `${at}/material`, message: 'an assessed aspect declares no material gap; material must be null' });
      if (row.justification !== null) errors.push({ path: `${at}/justification`, message: 'an assessed aspect carries its result in evidence; justification must be null' });
      continue;
    }
    if (blank(row.justification)) {
      errors.push({ path: `${at}/justification`, message: `${row.status} design coverage must carry a non-empty justification` });
    }
    if (row.status === 'not_applicable' && row.material !== null) {
      errors.push({ path: `${at}/material`, message: 'a not_applicable aspect declares no material gap; material must be null' });
    }
    if (row.status === 'not_assessed' && typeof row.material !== 'boolean') {
      errors.push({ path: `${at}/material`, message: 'a not_assessed aspect must declare whether the gap is material (true or false)' });
    }
  }
  return errors;
}

/**
 * A v4 acceptance row declares the check behind its result and what that
 * check leaves undemonstrated. A decisive row (PASS or FAIL) must carry all
 * three texts; a row that was not run, or does not apply, may carry none, and
 * whatever it does carry must not be blank. This is presence, not truth: no
 * code here can tell a pertinent method from an irrelevant one, or an honest
 * limit from filler. That review belongs to the auditor, and it is not
 * approximated with a word list.
 */
// Whitespace, controls, format characters (zero-width space, soft hyphen, word
// joiner) and the letter-class blanks trim() keeps: Hangul fillers and the
// blank braille pattern. Used only for the v4 trace fields, so no rule that an
// earlier version was written under becomes stricter on read.
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{Z}\u115F\u1160\u3164\uFFA0\u2800]/gu;
const noVisibleText = (value) => typeof value !== 'string' || value.replace(INVISIBLE, '') === '';

function acceptanceTraceErrors(entry, at) {
  const blank = noVisibleText;
  const errors = [];
  const decisive = entry.status === 'PASS' || entry.status === 'FAIL';
  if (entry.verification === null) {
    if (decisive) errors.push({ path: `${at}/verification`, message: `${entry.status} coverage must carry its verification (method and falsifier)` });
  } else {
    if (blank(entry.verification.method)) {
      errors.push({ path: `${at}/verification/method`, message: 'verification method must state what was executed, inspected or contrasted' });
    }
    if (blank(entry.verification.falsifier)) {
      errors.push({ path: `${at}/verification/falsifier`, message: 'verification falsifier must state the observation that contradicts the claim (the one that would have, or the one observed)' });
    }
  }
  if (entry.limit === null) {
    if (decisive) errors.push({ path: `${at}/limit`, message: `${entry.status} coverage must carry the limit of what its evidence demonstrates` });
  } else if (blank(entry.limit)) {
    errors.push({ path: `${at}/limit`, message: 'limit must state what remains outside what was demonstrated' });
  }
  return errors;
}

const AUDITOR_RESULT_SCHEMA_PATHS = Object.freeze({
  'auditor-result/v1': AUDITOR_RESULT_SCHEMA_PATH,
  'auditor-result/v2': AUDITOR_RESULT_V2_SCHEMA_PATH,
  'auditor-result/v3': AUDITOR_RESULT_V3_SCHEMA_PATH,
  'auditor-result/v4': AUDITOR_RESULT_V4_SCHEMA_PATH,
});

/**
 * Auditor result v1, v2 and v3 remain readable history, each validated by its
 * own schema and never by a later one. Forward task-bound audits use v4. An
 * unknown version falls into the v4 schema, whose `const` names it invalid.
 * From v2 on, every non-PASS acceptance row explains both why it did not pass
 * and how to resolve it; v3 adds the design-coverage declaration rules above;
 * v4 adds non-blank acceptance evidence and per-row verification and limit.
 */
export function validateAuditorResult(document) {
  const version = document?.schemaVersion;
  const path = Object.hasOwn(AUDITOR_RESULT_SCHEMA_PATHS, version ?? '')
    ? AUDITOR_RESULT_SCHEMA_PATHS[version]
    : AUDITOR_RESULT_V4_SCHEMA_PATH;
  const structural = validateAgainst(loadSchema(path), document);
  if (!structural.valid || version === 'auditor-result/v1') return structural;

  const declaresDesign = version === 'auditor-result/v3' || version === 'auditor-result/v4';
  const semantic = declaresDesign ? designDeclarationErrors(document) : [];
  if (document.acceptanceCoverage.length > 200) {
    semantic.push({ path: '$/acceptanceCoverage', message: 'acceptanceCoverage may contain at most 200 bounded rows' });
  }
  for (const [index, entry] of document.acceptanceCoverage.entries()) {
    // v4 only. The refusal of blank acceptance evidence was added while v3 was
    // the admission version and after v3 results had been written without it;
    // v3 can no longer be admitted, so applying it to v3 would only refuse
    // history on read.
    if (version === 'auditor-result/v4' && entry.evidence.trim() === '') {
      semantic.push({ path: `$/acceptanceCoverage[${index}]/evidence`, message: `${entry.status} coverage must carry non-blank evidence` });
    }
    if (version === 'auditor-result/v4') semantic.push(...acceptanceTraceErrors(entry, `$/acceptanceCoverage[${index}]`));
    if (entry.status === 'PASS') continue;
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      semantic.push({ path: `$/acceptanceCoverage[${index}]/reason`, message: `${entry.status} coverage must carry a non-empty reason` });
    }
    if (typeof entry.remediation !== 'string' || entry.remediation.trim() === '') {
      semantic.push({ path: `$/acceptanceCoverage[${index}]/remediation`, message: `${entry.status} coverage must carry actionable non-empty remediation` });
    }
  }
  return { valid: semantic.length === 0, errors: semantic };
}
export const validateRetirement = (document) => validateAgainst(loadSchema(RETIREMENT_SCHEMA_PATH), document);

export class ContractError extends Error {
  constructor(errors) {
    const detail = errors.map((error) => `  ${error.path}: ${error.message}`).join('\n');
    super(`result violates schema result.v1.json:\n${detail}`);
    this.name = 'ContractError';
    this.errors = errors;
  }
}

export function validateResult(result) {
  const structural = validateAgainst(resultSchema(), result);
  if (!structural.valid) return structural;

  const semantic = [];
  for (let index = 0; index < result.checks.length; index += 1) {
    const check = result.checks[index];
    if (check.required && check.status !== 'PASS'
      && (typeof check.remediation !== 'string' || check.remediation.trim() === '')) {
      semantic.push({
        path: `$.checks[${index}].remediation`,
        message: `required ${check.status} must carry a non-empty remediation`,
      });
    }
  }
  return { valid: semantic.length === 0, errors: semantic };
}

export function validateSnapshot(snapshot) {
  return validateAgainst(snapshotSchema(), snapshot);
}

/** Throw unless the result satisfies the contract. Nothing invalid escapes. */
export function assertValidResult(result) {
  const { valid, errors } = validateResult(result);
  if (!valid) throw new ContractError(errors);
  return result;
}

export function assertValidSnapshot(snapshot) {
  const { valid, errors } = validateSnapshot(snapshot);
  if (!valid) throw new ContractError(errors);
  return snapshot;
}
