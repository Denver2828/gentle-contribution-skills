import { pass, fail, unknown, fromSnapshot } from './_shared.mjs';

export default {
  id: 'git.upstream-configured',
  title: 'The current branch tracks an upstream',
  needsSnapshot: true,
  params: {},
  evaluate({ snapshot }) {
    const { branch, upstream, detached } = snapshot.identity;
    const evidence = [fromSnapshot('identity.upstream', { branch, upstream, detached })];

    if (branch === null) {
      return unknown(
        'HEAD is detached, so there is no branch whose tracking could be established',
        evidence,
        'Check out the branch intended for publication, then run the gate again.'
      );
    }
    return upstream !== null
      ? pass(`branch "${branch}" tracks ${upstream}`, evidence)
      : fail(
        `branch "${branch}" tracks no upstream, so it cannot be compared against a remote`,
        evidence,
        'Push the branch with --set-upstream, or select a policy that does not require tracking.'
      );
  },
};
