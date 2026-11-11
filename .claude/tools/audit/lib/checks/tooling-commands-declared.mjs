import { pass, fail, unknown, EVIDENCE_TYPE } from './_shared.mjs';
import { makeEvidence } from '../evidence.mjs';

// The anti-guessing invariant. A declared command must name the file it was
// read from, and that file must exist in the repository. Nothing here derives
// a command from a manifest, and nothing here runs one.
export default {
  id: 'tooling.commands-declared',
  title: 'Every declared command names a source that exists',
  needsSnapshot: true,
  params: {},
  evaluate({ snapshot, tooling, adapters }) {
    const commands = tooling.commands;
    const observed = { declared: commands.length, commands: commands.map((c) => ({ id: c.id, source: c.source })) };

    if (commands.length === 0) {
      return unknown(
        'the policy declares no commands, so whether this project has a test, build or lint command is undetermined; it is not evidence that it has none',
        [makeEvidence({ type: EVIDENCE_TYPE.COMPUTED, source: 'policy.tooling.commands', observed })],
        'Declare each applicable command with its tracked source, or explicitly exempt the project manifest in policy.'
      );
    }

    let tracked;
    try {
      tracked = new Set(adapters.readTrackedPaths(snapshot.root));
    } catch (error) {
      return unknown(`the tracked file list could not be read: ${error.message}`, [
        makeEvidence({ type: EVIDENCE_TYPE.GIT, source: 'git ls-files -z', observed: { error: error.message } }),
      ], 'Restore a readable Git index, then run the gate again so command sources can be verified.');
    }

    // A source may point at a line: "path#L57". Only the path is verified.
    const dangling = commands
      .filter((command) => !tracked.has(command.source.split('#')[0]))
      .map((command) => `${command.id} -> ${command.source}`)
      .sort();

    const evidence = [
      makeEvidence({
        type: EVIDENCE_TYPE.GIT,
        source: 'git ls-files -z',
        observed: { ...observed, dangling },
      }),
    ];

    return dangling.length === 0
      ? pass(`all ${commands.length} declared command(s) name a tracked source`, evidence)
      : fail(
        `${dangling.length} declared command(s) name a source that is not tracked: ${dangling.join(', ')}`,
        evidence,
        'Point each command at the file it was actually read from, or remove the declaration.'
      );
  },
};
