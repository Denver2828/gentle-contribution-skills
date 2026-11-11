import { pass, fail, unknown, fromSnapshot, EVIDENCE_TYPE } from './_shared.mjs';
import { makeEvidence } from '../evidence.mjs';

export default {
  id: 'files.required-present',
  title: 'Every file the policy requires is tracked',
  needsSnapshot: true,
  params: {
    paths: { type: 'string[]', required: true },
  },
  evaluate({ snapshot, params, adapters }) {
    let tracked;
    try {
      tracked = new Set(adapters.readTrackedPaths(snapshot.root));
    } catch (error) {
      return unknown(`the tracked file list could not be read: ${error.message}`, [
        makeEvidence({ type: EVIDENCE_TYPE.GIT, source: 'git ls-files -z', observed: { error: error.message } }),
      ], 'Restore a readable Git index, then run the gate again. Required-file presence is not inferred without it.');
    }

    const missing = params.paths.filter((path) => !tracked.has(path)).sort();
    const evidence = [
      makeEvidence({
        type: EVIDENCE_TYPE.GIT,
        source: 'git ls-files -z',
        observed: { required: params.paths, missing, trackedCount: tracked.size },
      }),
    ];

    return missing.length === 0
      ? pass(`all ${params.paths.length} required file(s) are tracked`, evidence)
      : fail(
        `${missing.length} required file(s) are not tracked: ${missing.join(', ')}`,
        evidence,
        'Add the missing files, or remove them from the policy if they are genuinely not required.'
      );
  },
};
