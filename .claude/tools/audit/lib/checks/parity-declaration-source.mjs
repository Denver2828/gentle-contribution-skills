import { pass, fail, unknown, EVIDENCE_TYPE } from './_shared.mjs';
import { makeEvidence } from '../evidence.mjs';
import { verifyCitation } from '../parity.mjs';
import { STATUS } from '../status.mjs';

// Every declared command must really be at the line it cites.
//
// The aggregation is deliberately pessimistic: one proven divergence fails the
// whole check, and if nothing diverges but something could not be compared,
// the result is UNKNOWN rather than PASS. A partially verified set of
// declarations is not a verified set.
export default {
  id: 'parity.declaration-source',
  title: 'Every declared command sits at the line it cites',
  needsSnapshot: true,
  params: {},
  evaluate({ snapshot, tooling, adapters }) {
    const commands = tooling.commands;

    if (commands.length === 0) {
      return unknown('the policy declares no commands, so there is no citation to verify', [
        makeEvidence({ type: EVIDENCE_TYPE.COMPUTED, source: 'policy.tooling.commands', observed: { declared: 0 } }),
      ], 'Declare the applicable commands with exact source citations, then run the parity gate again.');
    }

    let tracked;
    try {
      tracked = new Set(adapters.readTrackedPaths(snapshot.root));
    } catch (error) {
      return unknown(`the tracked file list could not be read, so no citation can be established: ${error.message}`, [
        makeEvidence({ type: EVIDENCE_TYPE.GIT, source: 'git ls-files -z', observed: { error: error.message } }),
      ], 'Restore a readable Git index, then run the gate again so cited sources can be established.');
    }

    const verdicts = commands.map((command) => verifyCitation({
      root: snapshot.root,
      reference: command.source,
      expected: command.run,
      label: `command "${command.id}"`,
      tracked,
      // Declared by the policy, never inferred from the file extension.
      match: command.format,
    }));

    const evidence = verdicts.map((verdict) => makeEvidence({
      type: EVIDENCE_TYPE.FILE,
      source: verdict.observed.source,
      observed: { status: verdict.status, ...verdict.observed },
    }));

    const diverged = verdicts.filter((verdict) => verdict.status === STATUS.FAIL);
    if (diverged.length > 0) {
      return fail(
        `${diverged.length} of ${commands.length} declaration(s) diverge from their cited source. ${diverged.map((v) => v.reason).join(' | ')}`,
        evidence,
        'Correct the citation to the line the value is actually on, or correct the declared value. Do not point the citation at a file and hope.'
      );
    }

    const inconclusive = verdicts.filter((verdict) => verdict.status === STATUS.UNKNOWN);
    if (inconclusive.length > 0) {
      return unknown(
        `${inconclusive.length} of ${commands.length} declaration(s) could not be compared. ${inconclusive.map((v) => v.reason).join(' | ')}`,
        evidence,
        'Correct or restore the unreadable, ambiguous or out-of-range citations named in the evidence, then run the parity gate again.'
      );
    }

    return pass(`all ${commands.length} declaration(s) sit at the line they cite`, evidence);
  },
};
