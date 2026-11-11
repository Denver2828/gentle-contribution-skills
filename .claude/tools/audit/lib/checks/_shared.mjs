// Helpers shared by the checks. Not a check: discovery skips "_" files.

import { STATUS } from '../status.mjs';
import { makeEvidence, EVIDENCE_TYPE } from '../evidence.mjs';

export { STATUS, EVIDENCE_TYPE };

/** Evidence read from the snapshot, naming the field it came from. */
export function fromSnapshot(field, observed) {
  return makeEvidence({ type: EVIDENCE_TYPE.GIT, source: `snapshot.${field}`, observed });
}

export const pass = (reason, evidence) => ({ status: STATUS.PASS, reason, evidence });
export const fail = (reason, evidence, remediation) => ({ status: STATUS.FAIL, reason, evidence, remediation });
export const unknown = (reason, evidence, remediation) => ({ status: STATUS.UNKNOWN, reason, evidence, remediation });
