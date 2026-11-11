import { pass, fail, unknown, fromSnapshot } from './_shared.mjs';

export default {
  id: 'git.not-behind-upstream',
  title: 'The branch is not behind its upstream',
  needsSnapshot: true,
  params: {
    maxBehind: { type: 'integer', required: false, default: 0, minimum: 0 },
  },
  evaluate({ snapshot, params }) {
    const { upstream, ahead, behind } = snapshot.identity;
    const evidence = [fromSnapshot('identity.behind', { upstream, ahead, behind, maxBehind: params.maxBehind })];

    // Null is not zero. Without an upstream there is nothing to be behind of,
    // and treating that as "not behind" would manufacture a PASS.
    if (behind === null) {
      return unknown(
        'there is no upstream to compare against, so the distance cannot be determined',
        evidence,
        'Configure the branch upstream, then run the gate again.'
      );
    }

    return behind <= params.maxBehind
      ? pass(`the branch is ${behind} commit(s) behind ${upstream}, within the allowed ${params.maxBehind}`, evidence)
      : fail(
        `the branch is ${behind} commit(s) behind ${upstream}, over the allowed ${params.maxBehind}`,
        evidence,
        'Rebase or merge the upstream before publishing.'
      );
  },
};
