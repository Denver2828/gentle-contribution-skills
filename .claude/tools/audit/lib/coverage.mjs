import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validate as validateAgainst } from './jsonschema.mjs';
import { canonicalJson, sha256Hex } from './canonical.mjs';

const SCHEMA = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'schema', 'coverage-receipt.v1.json'), 'utf8'));

export const coverageReceiptId = (receipt) => `sha256:${sha256Hex(canonicalJson(receipt))}`;

export function evaluateCoverage(receipt, { requireInterval = false, requireStableRetrieval = false } = {}) {
  const checked = validateAgainst(SCHEMA, receipt);
  if (!checked.valid) return { complete: false, reason: `invalid coverage receipt: ${checked.errors[0].path} ${checked.errors[0].message}` };
  const counted = receipt.pages.reduce((total, page) => total + page.count, 0);
  if (counted !== receipt.returnedCount) return { complete: false, reason: `page counts total ${counted}, not returnedCount ${receipt.returnedCount}` };
  if (receipt.reviewedCount !== receipt.returnedCount) return { complete: false, reason: `reviewedCount ${receipt.reviewedCount} does not cover returnedCount ${receipt.returnedCount}` };
  if (receipt.exclusions.length > 0) return { complete: false, reason: `coverage carries ${receipt.exclusions.length} unresolved exclusion(s)` };
  if (requireInterval && receipt.interval === null) return { complete: false, reason: 'the consumer requires an explicit interval' };
  if (requireStableRetrieval && receipt.retrieval !== 'stable-id') return { complete: false, reason: 'the consumer requires stable-id retrieval' };
  if (receipt.pages[0].cursor !== null) return { complete: false, reason: 'the first page is not anchored at the retrieval origin' };
  for (let index = 0; index < receipt.pages.length - 1; index += 1) {
    if (receipt.pages[index].nextCursor === null || receipt.pages[index].nextCursor !== receipt.pages[index + 1].cursor) {
      return { complete: false, reason: `page ${index} does not bind its next cursor to page ${index + 1}` };
    }
  }
  // An authoritative total the enumerator wrote is a claim about the whole
  // listing; when it contradicts what was returned, no termination proves
  // completeness, cursor exhaustion included (ASTRA-05: a paginator that dies
  // early reports nextCursor null while the API already said the total).
  if (receipt.authoritativeTotal !== null && receipt.authoritativeTotal !== receipt.returnedCount) {
    return { complete: false, reason: `authoritativeTotal ${receipt.authoritativeTotal} contradicts returnedCount ${receipt.returnedCount}; no termination proves completeness against a total the listing did not reach` };
  }
  const last = receipt.pages.at(-1);
  const terminated = receipt.termination === 'cursor-exhausted' && last.nextCursor === null
    || ['authoritative-total', 'finite-listing'].includes(receipt.termination)
      && receipt.authoritativeTotal === receipt.returnedCount;
  if (!terminated) return { complete: false, reason: 'no cursor exhaustion or matching authoritative total proves termination' };
  return { complete: true, reason: 'all returned items were reviewed and termination is proven', receiptId: coverageReceiptId(receipt) };
}

export function assertCoverage(receipt, options) {
  const result = evaluateCoverage(receipt, options);
  if (!result.complete) throw new Error(`coverage incomplete: ${result.reason}. Next action: continue pagination/retrieval and regenerate the receipt.`);
  return result;
}
