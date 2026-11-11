import { pass, fail, fromSnapshot } from './_shared.mjs';

// The other half of the anti-guessing rule. A manifest the snapshot found and
// no declaration covers is a project whose commands nobody stated. The engine
// refuses to infer them; it says so instead.
export default {
  id: 'tooling.manifests-covered',
  title: 'Every detected manifest has a declared command',
  needsSnapshot: true,
  params: {
    exempt: { type: 'string[]', required: false, default: [] },
  },
  evaluate({ snapshot, tooling, params }) {
    const covered = new Set(tooling.commands.flatMap((command) => command.appliesTo));
    const uncovered = snapshot.inventory.manifests
      .filter((manifest) => !covered.has(manifest) && !params.exempt.includes(manifest))
      .sort();

    const evidence = [fromSnapshot('inventory.manifests', {
      manifests: snapshot.inventory.manifests,
      covered: [...covered].sort(),
      exempt: params.exempt,
      uncovered,
    })];

    return uncovered.length === 0
      ? pass(`all ${snapshot.inventory.manifests.length} detected manifest(s) are covered by a declared command`, evidence)
      : fail(
        `${uncovered.length} detected manifest(s) have no declared command: ${uncovered.join(', ')}`,
        evidence,
        'Declare the commands for those projects with their exact source, or list them as exempt with intent.'
      );
  },
};
