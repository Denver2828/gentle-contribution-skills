import { pass, fail, fromSnapshot } from './_shared.mjs';

// The precondition every other check depends on. It is the one check that
// examines the snapshot OUTCOME rather than the snapshot, which is why it does
// not declare needsSnapshot: a missing snapshot is the finding, not a blocker.
export default {
  id: 'git.repository-readable',
  title: 'The repository state could be read',
  needsSnapshot: false,
  params: {},
  evaluate({ snapshotOutcome }) {
    if (snapshotOutcome.snapshot !== null) {
      const { identity, counts } = snapshotOutcome.snapshot;
      return pass(
        `repository state read: ${counts.tracked} tracked files at ${identity.head ?? '(unborn HEAD)'}`,
        [fromSnapshot('identity', { head: identity.head, branch: identity.branch, tracked: counts.tracked })]
      );
    }

    // "Not a work tree" is an observed fact, so it is a violation. Every other
    // failure to read is inconclusive, and stays inconclusive.
    if (/not inside a Git work tree/.test(snapshotOutcome.reason)) {
      return fail(
        snapshotOutcome.reason,
        snapshotOutcome.evidence,
        'Run the gate from inside the repository you intend to publish from.'
      );
    }
    return {
      status: snapshotOutcome.status,
      reason: snapshotOutcome.reason,
      evidence: snapshotOutcome.evidence,
      remediation: 'Restore readable Git repository state, then run the gate again. The check will not guess missing state.',
    };
  },
};
