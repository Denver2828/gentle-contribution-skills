import { pass, fail, fromSnapshot } from './_shared.mjs';

export default {
  id: 'git.worktree-clean',
  title: 'The working tree carries no unintended changes',
  needsSnapshot: true,
  params: {
    allowStaged: { type: 'boolean', required: false, default: false },
    allowUntracked: { type: 'boolean', required: false, default: false },
  },
  evaluate({ snapshot, params }) {
    const { staged, unstaged, untracked } = snapshot.changes;
    const evidence = [fromSnapshot('changes', {
      staged: staged.length, unstaged: unstaged.length, untracked: untracked.length,
      allowStaged: params.allowStaged, allowUntracked: params.allowUntracked,
    })];

    const offences = [];
    if (staged.length > 0 && !params.allowStaged) offences.push(`${staged.length} staged`);
    if (unstaged.length > 0) offences.push(`${unstaged.length} unstaged`);
    if (untracked.length > 0 && !params.allowUntracked) offences.push(`${untracked.length} untracked`);

    return offences.length === 0
      ? pass('the working tree carries no change the policy disallows', evidence)
      : fail(
        `the working tree carries ${offences.join(', ')} change(s) the policy disallows`,
        evidence,
        'Commit, stash or remove the changes, or declare them allowed in the policy.'
      );
  },
};
