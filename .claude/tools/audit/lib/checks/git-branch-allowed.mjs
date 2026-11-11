import { pass, fail, unknown, EVIDENCE_TYPE } from './_shared.mjs';
import { makeEvidence } from '../evidence.mjs';
import { verifyCitation } from '../parity.mjs';
import { STATUS } from '../status.mjs';

// A branch rule only authorises anything if someone can point at where it is
// written. The first version of this check carried glob patterns I had
// inferred from looking at branch names: it invented a prefix the convention
// does not contain, omitted seven it does, and accepted nested paths the real
// rule rejects. An inferred convention is not a rule; it is a guess wearing a
// rule's clothes.
//
// So the pattern now arrives together with the file it was read from, and that
// file must be tracked in the repository being audited. When it is not, the
// check is UNKNOWN: there is no established rule to measure the branch against.
export default {
  id: 'git.branch-allowed',
  title: 'The current branch matches a documented naming rule',
  needsSnapshot: true,
  params: {
    // The rule exactly as written at `source`.
    pattern: { type: 'string', required: true, format: 'regexp' },
    // Repository-relative path where the rule is written, optionally with #Lnn.
    source: { type: 'string', required: true },
    // "repository" when the rule is written in the audited repository.
    // "ours" when it is our own policy, which is never presented as a rule of
    // that repository.
    authority: { type: 'string', required: true, enum: ['repository', 'ours'] },
  },
  evaluate({ snapshot, params, adapters }) {
    const { branch, detached } = snapshot.identity;
    const sourcePath = params.source.split('#')[0];
    const observed = { branch, detached, pattern: params.pattern, source: params.source, authority: params.authority };

    if (branch === null) {
      return unknown('HEAD is detached, so there is no branch to match against the rule', [
        makeEvidence({ type: EVIDENCE_TYPE.GIT, source: 'snapshot.identity.branch', observed }),
      ], 'Check out the branch intended for publication, then run the gate again.');
    }

    // Establish the rule before applying it. Only a rule written in the audited
    // repository can be verified from inside it, and "the file exists" is not
    // establishing anything -- the pattern must be at the line it cites.
    if (params.authority === 'repository') {
      let tracked;
      try {
        tracked = new Set(adapters.readTrackedPaths(snapshot.root));
      } catch (error) {
        return unknown(`the tracked file list could not be read, so the rule's source cannot be established: ${error.message}`, [
          makeEvidence({ type: EVIDENCE_TYPE.GIT, source: 'git ls-files -z', observed: { ...observed, error: error.message } }),
        ], 'Restore a readable Git index, then run the gate again so the cited branch rule can be established.');
      }

      if (!tracked.has(sourcePath)) {
        return unknown(
          `the rule cites ${params.source}, which is not tracked in this repository; a branch convention with no verifiable source does not authorise anything`,
          [makeEvidence({ type: EVIDENCE_TYPE.GIT, source: 'git ls-files -z', observed: { ...observed, sourceTracked: false } })],
          'Track the cited rule at that path, or declare the rule as our own policy instead of repository authority.'
        );
      }

      const citation = verifyCitation({
        root: snapshot.root,
        reference: params.source,
        expected: params.pattern,
        label: 'the branch rule',
        tracked,
        // The rule is written as itself on its own line, so the whole cited
        // region is compared -- exactly, not by containment.
        match: 'literal',
      });

      if (citation.status !== STATUS.PASS) {
        const evidence = [makeEvidence({ type: EVIDENCE_TYPE.FILE, source: params.source, observed: { ...observed, ...citation.observed } })];
        return citation.status === STATUS.FAIL
          ? fail(
            `${citation.reason}; the rule this check would apply is therefore not the rule written in the repository`,
            evidence,
            'Correct the citation, or correct the pattern to the one actually written at that location.'
          )
          : unknown(
            citation.reason,
            evidence,
            'Make the cited source readable and unambiguous at the declared line range, then run the gate again.'
          );
      }
    }

    const attribution = params.authority === 'repository'
      ? `the rule at ${params.source}`
      : `our own policy, which is not a rule of the audited repository, recorded at ${params.source}`;

    const evidence = [makeEvidence({
      type: EVIDENCE_TYPE.GIT,
      source: `snapshot.identity.branch + ${params.source}`,
      observed: { ...observed, sourceTracked: params.authority === 'repository' },
    })];

    return new RegExp(params.pattern).test(branch)
      ? pass(`branch "${branch}" matches ${attribution}`, evidence)
      : fail(
        `branch "${branch}" does not match ${attribution}: ${params.pattern}`,
        evidence,
        'Rename the branch to match the documented rule, or change the rule where it is written.'
      );
  },
};
