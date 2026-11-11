// Which adoption stage is in force.
//
// Kept as data, not as prose, so reverting is an edit to one field rather than
// an argument about what a paragraph meant. A stage this file does not declare
// blocks: an unreadable or unknown enforcement level is not a reason to assume
// the permissive one.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENFORCEMENT_PATH = join(HERE, '..', 'enforcement.json');
export const ENFORCEMENT_VERSION = '1.0.0';

export const STAGE = Object.freeze({
  INFORMATIVE: 1,
  PREFLIGHT_REQUIRED: 2,
  PERSISTENCE_REQUIRED: 3,
});

export class EnforcementError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'EnforcementError';
    this.detail = detail;
  }
}

/** Read the declared stage. Anything unreadable or unknown blocks. */
export function readEnforcement({ path = ENFORCEMENT_PATH } = {}) {
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new EnforcementError(
      `the enforcement declaration at ${path} could not be read; refusing to assume a permissive stage`,
      { failure: 'unreadable', path, error: error.message }
    );
  }

  if (document?.enforcementVersion !== ENFORCEMENT_VERSION) {
    throw new EnforcementError(
      `the enforcement declaration is version ${JSON.stringify(document?.enforcementVersion)} and this engine supports ${ENFORCEMENT_VERSION}`,
      { failure: 'incompatible-version', found: document?.enforcementVersion ?? null }
    );
  }
  if (!Object.values(STAGE).includes(document.stage)) {
    throw new EnforcementError(
      `the enforcement declaration names stage ${JSON.stringify(document.stage)}, which is not one of ${Object.values(STAGE).join(', ')}`,
      { failure: 'unknown-stage', found: document.stage ?? null }
    );
  }
  if (typeof document.killSwitch !== 'string' || document.killSwitch.trim() === '') {
    throw new EnforcementError(
      'the enforcement declaration carries no kill switch; a stage nobody can revert is not a stage anyone should enable',
      { failure: 'no-kill-switch' }
    );
  }
  // The flag is optional -- a declaration written before it existed reads as
  // "not required", exactly like a lineage written before intake existed --
  // but a declared flag must be a real boolean with its own kill switch. A
  // string "false" that reads as truthy is exactly the ambiguity this blocks.
  if (Object.hasOwn(document, 'requireSignedReceipts')) {
    if (typeof document.requireSignedReceipts !== 'boolean') {
      throw new EnforcementError(
        `requireSignedReceipts is ${JSON.stringify(document.requireSignedReceipts)}, and only true or false decide anything`,
        { failure: 'malformed-signing-flag', found: document.requireSignedReceipts ?? null }
      );
    }
    if (typeof document.requireSignedReceiptsKillSwitch !== 'string' || document.requireSignedReceiptsKillSwitch.trim() === '') {
      throw new EnforcementError(
        'requireSignedReceipts is declared without its own kill switch; a requirement nobody can revert is not a requirement anyone should enable',
        { failure: 'no-signing-kill-switch' }
      );
    }
  }

  return {
    stage: document.stage,
    name: document.stages?.[String(document.stage)]?.name ?? '(unnamed)',
    means: document.stages?.[String(document.stage)]?.means ?? '',
    killSwitch: document.killSwitch,
    requireSignedReceipts: document.requireSignedReceipts === true,
    requireSignedReceiptsKillSwitch: document.requireSignedReceiptsKillSwitch ?? '',
    honestScope: document.honestScope ?? '',
    document,
  };
}

/** Is a passing preflight required before evidence may be recorded? */
export function preflightRequired(enforcement = readEnforcement()) {
  return enforcement.stage >= STAGE.PREFLIGHT_REQUIRED;
}

/** Are persistence and gate-publish required before publication? */
export function persistenceRequired(enforcement = readEnforcement()) {
  return enforcement.stage >= STAGE.PERSISTENCE_REQUIRED;
}

/**
 * Is a verified human signature required on the receipt before gate-publish,
 * reserve-attempt and the publisher proceed? Independent of the stage, with
 * its own kill switch: rollback sets the flag to false and the verification
 * code stays.
 */
export function signedReceiptsRequired(enforcement = readEnforcement()) {
  return enforcement.requireSignedReceipts === true;
}
