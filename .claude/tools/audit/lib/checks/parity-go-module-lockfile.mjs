import { pass, fail, unknown, EVIDENCE_TYPE } from './_shared.mjs';
import { makeEvidence } from '../evidence.mjs';
import { readFileText, FileUnreadableError, FileUndecodableError } from '../adapters/files.mjs';

// go.mod <-> go.sum.
//
// A previous version of this check asserted "a Go module needs a go.sum if and
// only if its go.mod declares at least one require", and attributed that to how
// Go works. That is false. A module whose requirements are all satisfied by
// `replace` directives pointing at local directories downloads nothing and
// needs no go.sum, requires or not. A go.sum may also retain hashes for
// versions that are no longer needed, since nothing prunes it until
// `go mod tidy` runs.
//
// So this is OUR policy, stated as ours:
//
//   we require a tracked go.sum from any module that declares a dependency we
//   cannot see resolved locally.
//
// And it stops where static reading stops. When every declared requirement is
// replaced by a local directory, the transitive requirements of those local
// modules are invisible without executing Go tooling, so the result is UNKNOWN
// rather than a PASS we cannot support.
//
// SCOPE: this never verifies go.sum CONTENTS against the required modules.
// That needs `go mod verify` or `go mod tidy`, which execute and download.

const GO_MOD = /(^|\/)go\.mod$/;

/** A replacement target is local when it is a filesystem path, not a module path. */
export function isLocalReplacement(target) {
  return /^(\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(target.trim());
}

/**
 * Parse the require and replace directives of a go.mod.
 *
 * Both syntaxes Go accepts are handled: the single-line directive and the
 * parenthesised block. Anything that cannot be read unambiguously throws, so
 * the caller reports UNKNOWN instead of deciding on a partial parse.
 */
export function parseGoMod(text) {
  const requires = [];
  const replaces = [];
  let block = null;

  const addReplace = (line) => {
    const [left, right] = line.split('=>');
    if (right === undefined) throw new Error(`replace directive without "=>": "${line}"`);
    const from = left.replace(/^replace\s+/, '').trim().split(/\s+/)[0];
    const to = right.trim().split(/\s+/)[0];
    if (from === '' || to === undefined || to === '') throw new Error(`replace directive is incomplete: "${line}"`);
    replaces.push({ from, to, local: isLocalReplacement(to) });
  };

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line === '') continue;

    if (block !== null) {
      if (line === ')') { block = null; continue; }
      if (block === 'require') requires.push(line.split(/\s+/)[0]);
      else addReplace(line);
      continue;
    }

    if (/^require\s*\($/.test(line)) { block = 'require'; continue; }
    if (/^replace\s*\($/.test(line)) { block = 'replace'; continue; }
    if (/^require\s+\S+/.test(line)) { requires.push(line.replace(/^require\s+/, '').split(/\s+/)[0]); continue; }
    if (/^replace\s+\S+/.test(line)) { addReplace(line); continue; }
  }

  if (block !== null) throw new Error(`a ${block} block was opened and never closed`);
  return { requires, replaces };
}

/** Requirements that are not resolved to a local directory by a replace. */
export function unresolvedRequirements({ requires, replaces }) {
  const locallyReplaced = new Set(replaces.filter((replace) => replace.local).map((replace) => replace.from));
  return requires.filter((module) => !locallyReplaced.has(module));
}

export default {
  id: 'parity.go-module-lockfile',
  title: 'Every Go module declaring a remote dependency tracks a go.sum (our policy)',
  needsSnapshot: true,
  params: {},
  evaluate({ snapshot, adapters }) {
    const manifests = snapshot.inventory.manifests.filter((path) => GO_MOD.test(path));

    if (manifests.length === 0) {
      return unknown('no go.mod was found in this repository, so there is no Go module pairing to verify', [
        makeEvidence({ type: EVIDENCE_TYPE.GIT, source: 'snapshot.inventory.manifests', observed: { manifests: snapshot.inventory.manifests } }),
      ], 'Remove this Go-specific check from the gate, or make it optional for repositories without a Go module.');
    }

    let tracked;
    try {
      tracked = new Set(adapters.readTrackedPaths(snapshot.root));
    } catch (error) {
      return unknown(`the tracked file list could not be read: ${error.message}`, [
        makeEvidence({ type: EVIDENCE_TYPE.GIT, source: 'git ls-files -z', observed: { error: error.message } }),
      ], 'Restore a readable Git index, then run the gate again so go.sum presence can be established.');
    }

    const modules = [];
    const unparseable = [];

    for (const manifest of manifests) {
      const lockfile = manifest.replace(/go\.mod$/, 'go.sum');
      try {
        const parsed = parseGoMod(readFileText(snapshot.root, manifest));
        const unresolved = unresolvedRequirements(parsed);
        modules.push({
          manifest,
          lockfile,
          requires: parsed.requires.length,
          localReplacements: parsed.replaces.filter((replace) => replace.local).length,
          remoteReplacements: parsed.replaces.filter((replace) => !replace.local).length,
          unresolvedRequirements: unresolved.length,
          lockfileTracked: tracked.has(lockfile),
        });
      } catch (error) {
        const cause = error instanceof FileUndecodableError ? 'not valid UTF-8'
          : error instanceof FileUnreadableError ? 'unreadable'
            : error.message;
        unparseable.push({ manifest, cause });
      }
    }

    const evidence = [makeEvidence({
      type: EVIDENCE_TYPE.FILE,
      source: 'go.mod require/replace directives + git ls-files -z',
      observed: {
        authority: 'ours',
        rule: 'we require a tracked go.sum from any module that declares a requirement not resolved to a local directory by a replace directive',
        notAGoRule: 'Go itself does not require a go.sum whenever a require exists: requirements replaced by local directories download nothing, and a go.sum may retain hashes no longer needed',
        scope: 'presence only; go.sum contents are never verified, because that requires executing Go tooling',
        modules,
        unparseable,
      },
    })];

    if (unparseable.length > 0) {
      return unknown(
        `${unparseable.length} go.mod could not be read or parsed, so the pairing cannot be decided: ${unparseable.map((m) => `${m.manifest} (${m.cause})`).join(', ')}`,
        evidence,
        'Correct the encoding or directive syntax of the named go.mod files, then run the gate again.'
      );
    }

    // Proven violations of our policy first.
    const missing = modules.filter((module) => module.unresolvedRequirements > 0 && !module.lockfileTracked);
    if (missing.length > 0) {
      return fail(
        `${missing.length} module(s) declare requirements that are not resolved locally and track no go.sum: ${missing.map((m) => `${m.manifest} (${m.unresolvedRequirements} unresolved)`).join(', ')}`,
        evidence,
        'Commit the go.sum for those modules. This check never generates one.'
      );
    }

    // Then the cases static reading cannot settle: every requirement is
    // replaced by a local directory, whose own transitive requirements are not
    // visible from here.
    const opaque = modules.filter((module) => module.requires > 0 && module.unresolvedRequirements === 0);
    if (opaque.length > 0) {
      return unknown(
        `${opaque.length} module(s) resolve every declared requirement through a local replace, and the transitive requirements of those local modules cannot be read without executing Go tooling: ${opaque.map((m) => m.manifest).join(', ')}`,
        evidence,
        'Run Go tooling to verify the local replacement modules separately, or make this static check optional for that gate.'
      );
    }

    const withLockfile = modules.filter((module) => module.lockfileTracked);
    const noDependencies = modules.filter((module) => module.requires === 0);
    const residual = noDependencies.filter((module) => module.lockfileTracked);

    // Observed, not judged: a go.sum beside a module that declares nothing is
    // not a violation this check can prove, since nothing prunes go.sum.
    const note = residual.length > 0
      ? `; ${residual.length} module(s) declare no requirement and still track a go.sum, which is recorded but not judged: ${residual.map((m) => m.manifest).join(', ')}`
      : '';

    return pass(
      `${modules.length} Go module(s) satisfy our go.sum policy: ${withLockfile.length} track one, ${noDependencies.length} declare no requirement at all${note}`,
      evidence
    );
  },
};
