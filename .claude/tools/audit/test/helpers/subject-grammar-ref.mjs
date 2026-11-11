// Selects which Git ref the subject-grammar history test reads from.
//
// On `push` events the workflow leaves SUBJECT_GRAMMAR_REF unset, and the
// test reads `HEAD` exactly as before. On `pull_request` events `checkout`
// leaves the default merge ref checked out -- GitHub's synthetic merge
// commit, whose subject (`Merge <head> into <base>`) is not in the
// repository's grammar by design -- so the workflow exports the PR head SHA
// in SUBJECT_GRAMMAR_REF and this module reads history from that commit
// instead. A ref that does not resolve to a commit fails the test closed:
// it never falls back to HEAD silently, because that would hide the exact
// case this exists to catch.
import { spawnSync } from 'node:child_process';

// A conservative Git ref/SHA shape, checked before the value ever reaches
// git: no leading dash (argv-injection guard, even though this value is
// always passed as its own argv element and never through a shell), no
// `..`, `~`, `^`, `:`, `?`, `*`, `[`, `\`, whitespace, or control
// characters, no doubled or trailing slash, and no trailing dot. A 7-40
// character hex SHA (short or full) always matches this shape too.
const UNSAFE_CHARACTERS = /[\s~^:?*[\\]/;
const SAFE_REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function isSafeGitRef(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  if (UNSAFE_CHARACTERS.test(value)) return false;
  if (!SAFE_REF_SHAPE.test(value)) return false;
  if (value.includes('..') || value.includes('//')) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) return false;
  if (value.endsWith('.')) return false;
  return true;
}

/**
 * Resolve which ref the subject-grammar test should read history from.
 *
 * Unset or empty -> HEAD (today's behavior, `requested: false`). Anything
 * else must have a safe ref shape, or this throws rather than silently
 * falling back to HEAD.
 */
export function resolveSubjectGrammarRef(env = process.env) {
  const raw = env.SUBJECT_GRAMMAR_REF;
  if (raw === undefined || raw === '') return { ref: 'HEAD', requested: false };
  if (!isSafeGitRef(raw)) {
    throw new Error(`SUBJECT_GRAMMAR_REF is not a safe Git ref shape: ${JSON.stringify(raw)}`);
  }
  return { ref: raw, requested: true };
}

/**
 * The commit subjects the grammar test must validate, from the resolved ref.
 *
 * When a ref was explicitly requested (SUBJECT_GRAMMAR_REF set), first
 * confirm it resolves to a commit in `cwd` -- fail closed with a clear
 * message if not, never fall back to HEAD.
 */
export function subjectGrammarHistory(cwd, env = process.env) {
  const { ref, requested } = resolveSubjectGrammarRef(env);
  if (requested) {
    const exists = spawnSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd, encoding: 'utf8' });
    if (exists.status !== 0) {
      throw new Error(
        `SUBJECT_GRAMMAR_REF=${ref} does not resolve to a commit in ${cwd} ` +
          `(fail closed, no fallback to HEAD): ${exists.stderr.trim()}`
      );
    }
  }
  const history = spawnSync('git', ['log', '--format=%s', ref], { cwd, encoding: 'utf8' });
  if (history.status !== 0) {
    throw new Error(`git log --format=%s ${ref} failed in ${cwd}: ${history.stderr.trim()}`);
  }
  return history.stdout.split(/\r?\n/).filter(Boolean);
}
