import { pass, fail, fromSnapshot } from './_shared.mjs';

export default {
  id: 'git.no-operation-in-progress',
  title: 'No Git operation is mid-transaction',
  needsSnapshot: true,
  params: {},
  evaluate({ snapshot }) {
    const { operation } = snapshot.identity;
    const evidence = [fromSnapshot('identity.operation', { operation })];

    return operation === 'none'
      ? pass('no merge, rebase, cherry-pick, revert or bisect is in progress', evidence)
      : fail(
        `a ${operation} is in progress, so the working tree is mid-transaction`,
        evidence,
        `Finish or abort the ${operation} before publishing anything from this tree.`
      );
  },
};
