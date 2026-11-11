import { pass, fail, fromSnapshot } from './_shared.mjs';

export default {
  id: 'git.no-conflicts',
  title: 'No unresolved merge conflicts',
  needsSnapshot: true,
  params: {},
  evaluate({ snapshot }) {
    const paths = snapshot.changes.unmerged.map((entry) => entry.path);
    const evidence = [fromSnapshot('changes.unmerged', { count: paths.length, paths })];

    return paths.length === 0
      ? pass('no unmerged entries', evidence)
      : fail(
        `${paths.length} path(s) carry unresolved conflicts: ${paths.join(', ')}`,
        evidence,
        'Resolve the conflicts and stage the results.'
      );
  },
};
