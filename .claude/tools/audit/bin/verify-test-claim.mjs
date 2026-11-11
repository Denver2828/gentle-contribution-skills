#!/usr/bin/env node
// Public edition: private incident history omitted. See the operational contract.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Parse one supplied JSON-lines stream without discarding evidence. Callers must
 * supply a complete, unfiltered stream captured directly from a Go-produced
 * `go test -json` process; this parser cannot prove that provenance or
 * completeness. Blank lines are harmless; every other line must be one JSON
 * object. Malformed lines are carried so admission fails closed downstream.
 */
export function parseTestEvents(raw) {
  if (typeof raw !== 'string') {
    return { events: [], malformedLines: [{ line: 0, reason: 'input is not text' }] };
  }

  const events = [];
  const malformedLines = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    try {
      const event = JSON.parse(line);
      if (event === null || typeof event !== 'object' || Array.isArray(event)) {
        malformedLines.push({ line: index + 1, reason: 'JSON value is not an object' });
      } else {
        events.push(event);
      }
    } catch {
      malformedLines.push({ line: index + 1, reason: 'invalid JSON' });
    }
  }
  return { events, malformedLines };
}

/**
 * Count terminal executions, not unique test definitions. A subtest is any Test
 * name containing '/'; the rest are top-level functions. Only pass/fail/skip
 * actions with a Test name count, and repeated names count once per terminal
 * event because `-count` and `-cpu` legitimately repeat executions.
 */
export function countResults(parsed) {
  const { events, malformedLines } = parsed;
  const terminal = events.filter(
    (e) => ['pass', 'fail', 'skip'].includes(e.Action) && typeof e.Test === 'string',
  );
  const tally = (list) => ({
    total: list.length,
    pass: list.filter((e) => e.Action === 'pass').length,
    fail: list.filter((e) => e.Action === 'fail').length,
    skip: list.filter((e) => e.Action === 'skip').length,
  });
  const observedPackages = new Set(
    events.filter((e) => typeof e.Package === 'string' && e.Package !== '').map((e) => e.Package),
  );
  const packageTerminals = events.filter(
    (e) => ['pass', 'fail'].includes(e.Action)
      && typeof e.Package === 'string'
      && e.Package !== ''
      && e.Test === undefined,
  );
  const packageCompletionCounts = new Map();
  for (const event of packageTerminals) {
    packageCompletionCounts.set(
      event.Package,
      (packageCompletionCounts.get(event.Package) ?? 0) + 1,
    );
  }

  return {
    subtests: tally(terminal.filter((e) => e.Test.includes('/'))),
    toplevel: tally(terminal.filter((e) => !e.Test.includes('/'))),
    packages: {
      observed: observedPackages.size,
      pass: packageTerminals.filter((e) => e.Action === 'pass').length,
      fail: packageTerminals.filter((e) => e.Action === 'fail').length,
      missingCompletion: [...observedPackages].filter(
        (name) => !packageCompletionCounts.has(name),
      ),
      duplicateCompletion: [...packageCompletionCounts.entries()]
        .filter(([, count]) => count !== 1)
        .map(([name]) => name),
    },
    integrity: {
      malformedLines,
      terminalTestsMissingPackage: terminal.filter(
        (e) => typeof e.Package !== 'string' || e.Package === '',
      ).length,
    },
  };
}

/**
 * Judge one claim against the measured counts.
 *
 * @param counts result of countResults
 * @param claim  { subtests, skip, fail? } -- fail defaults to 0, so an
 *               undisclosed failure refuses instead of passing silently
 * @returns {{decision: 'admit'|'refuse', reasons: string[]}}
 */
export function judgeClaim(counts, claim) {
  const reasons = [];
  const measured = counts.subtests;
  const claimedFail = claim.fail ?? 0;

  if (counts.integrity.malformedLines.length > 0) {
    reasons.push(`the stream contains ${counts.integrity.malformedLines.length} malformed nonblank JSON line(s)`);
  }
  if (counts.integrity.terminalTestsMissingPackage > 0) {
    reasons.push(`${counts.integrity.terminalTestsMissingPackage} terminal test result(s) have no package identity`);
  }
  if (measured.total === 0 && counts.toplevel.total === 0) {
    reasons.push('the stream carries no test results; a claim over nothing is not a measurement');
  }
  if (counts.packages.observed === 0) {
    reasons.push('the stream carries no package identity or completion');
  }
  if (counts.packages.missingCompletion.length > 0) {
    reasons.push(`missing package completion for: ${counts.packages.missingCompletion.join(', ')}`);
  }
  if (counts.packages.duplicateCompletion.length > 0) {
    reasons.push(`ambiguous package completion for: ${counts.packages.duplicateCompletion.join(', ')}`);
  }
  if (counts.packages.fail > 0) {
    reasons.push(`${counts.packages.fail} package completion(s) failed; an unsuccessful run cannot admit a count claim`);
  }
  if (counts.toplevel.fail > 0) {
    reasons.push(`${counts.toplevel.fail} top-level test(s) failed; this CLI verifies subtest counts only and requires the surrounding run to pass`);
  }
  if (counts.toplevel.skip > 0) {
    reasons.push(`${counts.toplevel.skip} top-level test(s) skipped; this CLI requires every top-level test to pass`);
  }
  if (Number(claim.subtests) !== measured.total) {
    reasons.push(`claimed ${claim.subtests} subtests, -json counts ${measured.total}`);
  }
  if (Number(claim.skip) !== measured.skip) {
    reasons.push(`claimed ${claim.skip} skips, -json counts ${measured.skip} (an undisclosed skip is a false green)`);
  }
  if (Number(claimedFail) !== measured.fail) {
    reasons.push(`claimed ${claimedFail} failures, -json counts ${measured.fail}`);
  }

  return reasons.length ? { decision: 'refuse', reasons } : { decision: 'admit', reasons: [] };
}

// -- process boundary -------------------------------------------------------------

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const file = value('--json');
  const subtests = value('--subtests');
  const skip = value('--skip');
  const fail = value('--fail');

  if (file === undefined || subtests === undefined || skip === undefined) {
    process.stderr.write('usage: verify-test-claim --json <file|-> --subtests N --skip N [--fail N]\n');
    process.stderr.write('scope: counts subtest terminal executions, not unique definitions, from a complete, unfiltered stream captured directly from a Go-produced `go test -json` process\n');
    process.stderr.write('boundary: this checker cannot prove input provenance or completeness; the caller must demonstrate direct capture\n');
    process.exit(2);
  }

  let raw;
  try {
    raw = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  } catch (error) {
    process.stderr.write(`verify-test-claim: cannot read ${file}: ${error.message}\n`);
    process.exit(2);
  }

  const counts = countResults(parseTestEvents(raw));
  const verdict = judgeClaim(counts, {
    subtests: Number(subtests),
    skip: Number(skip),
    ...(fail !== undefined ? { fail: Number(fail) } : {}),
  });

  if (verdict.decision === 'refuse') {
    process.stderr.write('CLAIM REFUSED:\n');
    for (const reason of verdict.reasons) process.stderr.write(`  - ${reason}\n`);
    process.exit(1);
  }
  const m = counts.subtests;
  process.stdout.write(`CLAIM ADMITTED: ${m.total} subtest terminal execution(s) (${m.skip} skip, ${m.fail} fail) match the supplied stream; this checker does not prove capture provenance or completeness.\n`);
  process.exit(0);
}
