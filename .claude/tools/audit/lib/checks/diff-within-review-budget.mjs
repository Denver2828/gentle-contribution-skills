import { pass, fail, unknown, fromSnapshot } from './_shared.mjs';

// This check exists because of a specific failure: a pull request body that
// declared 100 changed lines while the diff measured 265. The number was
// estimated instead of measured.
//
// And it was then WRONG for a second reason, which is the more interesting one.
// It measured `git diff --cached` -- the index against HEAD -- which on a clean
// tree is zero however large the contribution is. A branch carrying one commit
// of 355 changed lines reported 0, and would have passed a 400-line budget
// without anything being wrong with the arithmetic. The measurement existed,
// ran, and answered a different question than the one being asked.
//
// What is measured now is the publishable candidate: everything that would
// leave this repository if the branch were published -- own commits PLUS
// staged changes, from the point the branch left its upstream.
export default {
  id: 'diff.within-review-budget',
  title: 'The publishable candidate stays within the review budget',
  needsSnapshot: true,
  params: {
    limit: { type: 'integer', required: true, minimum: 1 },
  },
  evaluate({ snapshot, params }) {
    const { candidate, candidateUnavailable, staged } = snapshot.diffstat;

    // No base, no measurement. Falling back to the index would answer a
    // question nobody asked, which is exactly how this check was wrong before.
    if (candidate === null) {
      return unknown(
        `the publishable candidate cannot be measured: ${candidateUnavailable ?? 'no reason was recorded'}`,
        [fromSnapshot('diffstat.candidateUnavailable', {
          candidateUnavailable,
          upstream: snapshot.identity.upstream,
          mergeBase: snapshot.identity.mergeBase,
        })],
        'Configure a readable upstream and merge base, then run the gate again. This check will not substitute the staged diff.'
      );
    }

    const total = candidate.additions + candidate.deletions;
    const evidence = [fromSnapshot('diffstat.candidate', {
      base: candidate.base,
      baseOid: candidate.baseOid,
      upstream: snapshot.identity.upstream,
      files: candidate.files,
      additions: candidate.additions,
      deletions: candidate.deletions,
      binaryFiles: candidate.binaryFiles,
      total,
      limit: params.limit,
      // Recorded beside it so the difference between the two questions stays
      // visible: this is what the check used to measure, and it is not this.
      stagedAgainstHead: staged.additions + staged.deletions,
    })];

    // A binary file reports no line counts. Any total that excludes one is
    // incomplete, and an incomplete total cannot be compared to a budget
    // without asserting more than was observed.
    if (candidate.binaryFiles > 0) {
      return unknown(
        `${candidate.binaryFiles} binary file(s) carry no line counts, so the ${total}-line total is incomplete and cannot be compared to the ${params.limit}-line budget`,
        evidence,
        'Remove the binary files from this line-count decision, or obtain an explicit review-size exception for them.'
      );
    }

    const where = `across ${candidate.files} file(s) since ${candidate.baseOid.slice(0, 12)}`;
    return total <= params.limit
      ? pass(`the publishable candidate measures ${total} lines (+${candidate.additions}/-${candidate.deletions}) ${where}, against a ${params.limit}-line budget`, evidence)
      : fail(
        `the publishable candidate measures ${total} lines (+${candidate.additions}/-${candidate.deletions}) ${where}, over the ${params.limit}-line budget`,
        evidence,
        'Split the change into reviewable slices, or obtain an explicit size exception before publishing.'
      );
  },
};
