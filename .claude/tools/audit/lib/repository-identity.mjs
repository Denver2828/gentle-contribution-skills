// Repository identity: the precondition that a policy is being run against the
// repository it was written for.
//
// This module exists because of a specific failure. The bundled `gentle-ai`
// policy declares rules about ONE repository -- that repository's
// CONTRIBUTING.md, the exact line numbers of its ci.yml, its go.mod. It
// declared no target, so it could be pointed anywhere. Run against the
// workspace repository it produced 2 FAIL and 3 UNKNOWN rows: five confident
// statements about files that belong to another repository. Every one of them
// read as a defect and every one of them was a category error -- the rows were
// arithmetically correct and semantically meaningless, which is the worst
// combination a report can have.
//
// So identity is decided BEFORE any check executes. Not as a check among
// checks: a check runs inside the gate, and by then the catalogue has been
// imported and the first rows already exist. This is evaluated between the
// snapshot and discovery, and a non-PASS result ends the run with a single
// row saying why. Nothing that could produce a row about the wrong repository
// ever gets the chance to.
//
// A mismatch is a knowable fact about the repository, so it is FAIL. Every
// other outcome -- unreadable remote, absent remote, unparseable url -- is a
// gap in the reading and stays UNKNOWN. This mirrors lib/intake.mjs, where an
// observed competitor is FAIL and an incomplete search is UNKNOWN.
//
// The second thing this module is responsible for is NOT disclosing the remote
// url. A remote url is a routine carrier of credentials, and the reader that
// resolves it is the last place that ever sees it. See `record` below.

import { STATUS } from './status.mjs';
import { makeEvidence, EVIDENCE_TYPE } from './evidence.mjs';
import { readRemoteUrl as readRemoteUrlFromGit } from './adapters/git.mjs';

export const IDENTITY_REFUSAL = Object.freeze({
  REMOTE_MISSING: 'identity.remote-missing',
  REMOTE_UNREADABLE: 'identity.remote-unreadable',
  REMOTE_UNPARSEABLE: 'identity.remote-unparseable',
  MISMATCH: 'identity.mismatch',
});

/**
 * The three remote forms this reader supports, and nothing else.
 *
 * This is an allowlist on purpose. A url shape that is not one of these three
 * does not become a best-effort parse: it becomes UNKNOWN. The transport is
 * reported so a reader can see HOW the repository was named, but it is never
 * part of the identity -- see `normaliseIdentity`.
 */
export const TRANSPORT = Object.freeze({
  HTTPS: 'https',       // https://host/owner/name(.git)
  SSH_URL: 'ssh-url',   // ssh://[user@]host[:port]/owner/name(.git)
  SSH_SCP: 'ssh-scp',   // [user@]host:owner/name(.git)
});

/** `scheme://` prefix of an absolute url, with the scheme captured. */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

/**
 * The only schemes that resolve, lowercased, mapped to their transport.
 *
 * Deliberately short. `http` and `git` used to parse here and no longer do:
 * both are cleartext transports, neither is a form this project's remotes take,
 * and accepting a scheme merely because it is well known is how the allowlist
 * turns back into a denylist.
 */
const ALLOWED_SCHEME = Object.freeze({
  https: TRANSPORT.HTTPS,
  ssh: TRANSPORT.SSH_URL,
});

/**
 * Split a remote url into its authority, its path and its transport, or null.
 *
 * Two shapes are accepted, because Git accepts two shapes for the same
 * repository: an absolute url with an allowed scheme, and the scp-like
 * `user@host:path` form. They must resolve to the same identity, or the same
 * repository would pass over HTTPS and fail over SSH.
 */
function split(url) {
  const scheme = SCHEME.exec(url);

  if (scheme !== null) {
    // Allowlist, not denylist. Everything outside ALLOWED_SCHEME is refused
    // without being parsed -- including `file://`, which is named here because
    // it used to be accepted in some shapes. `file:///srv/git/gentle-ai` is a
    // local path wearing a url; a local path says which directory this is, not
    // which repository, and that is exactly the confusion this module refuses.
    const transport = ALLOWED_SCHEME[scheme[1].toLowerCase()];
    if (transport === undefined) return null;

    const rest = url.slice(scheme[0].length);
    const separator = rest.indexOf('/');
    if (separator === -1) return null;
    return { authority: rest.slice(0, separator), path: rest.slice(separator + 1), transport };
  }

  // scp-like: everything before the first colon is the authority.
  const colon = url.indexOf(':');
  if (colon === -1) return null;

  const authority = url.slice(0, colon);
  // A path separator in the authority means this is a filesystem path, not a
  // host -- otherwise a local clone would be reported as a remote repository.
  // Backslashes count: `C:\Users\contributor\projects\gentle` is the Windows spelling
  // of the same mistake.
  if (authority.includes('/') || authority.includes('\\')) return null;
  // A single-character authority is a Windows drive letter, not a host.
  if (authority.length === 1) return null;

  return { authority, path: url.slice(colon + 1), transport: TRANSPORT.SSH_SCP };
}

/**
 * The host of an authority, with credentials and port removed.
 *
 * Credentials are dropped rather than redacted, and dropped here rather than
 * later: they are not part of the identity, and nothing downstream of this
 * function ever holds them. The url itself is never recorded anywhere.
 */
function hostOf(authority) {
  const afterCredentials = authority.slice(authority.lastIndexOf('@') + 1);
  // A port is a transport detail. github.com and github.com:443 are the same
  // repository, and a policy that had to declare the port would be declaring
  // how you connect rather than what you are auditing.
  const port = afterCredentials.indexOf(':');
  return port === -1 ? afterCredentials : afterCredentials.slice(0, port);
}

/**
 * Parse a remote url into `{host, owner, name, transport}`, or null when it is
 * not one of the three supported forms. The ORIGINAL casing is preserved: this
 * is what gets reported as observed, and reporting a lowercased spelling of
 * what the repository actually says would be reporting a value nobody
 * configured.
 *
 * Null is not a soft failure. Every caller turns it into UNKNOWN, so nothing
 * that fails to parse here can ever reach PASS.
 */
export function parseRemoteUrl(url) {
  if (typeof url !== 'string') return null;

  const trimmed = url.trim();
  if (trimmed === '') return null;

  // A security rule, not a parsing convenience. A query or a fragment is a
  // routine carrier of a token -- `...?access_token=ghp_...` is a real shape --
  // and a permissive parser would fold that token into the last path segment
  // and put it straight into `observed.name`, which IS reported. No supported
  // remote form needs either character, so both refuse the whole url.
  if (trimmed.includes('?') || trimmed.includes('#')) return null;

  const parts = split(trimmed);
  if (parts === null) return null;

  const host = hostOf(parts.authority);
  if (host === '') return null;

  // A bare word is not a host. In the scp-like form there is no scheme to lean
  // on, so a hostname with no dot is far more likely to be a directory:
  // `somedir:owner/name` and `C:/repos/name` are how a local path gets mistaken
  // for a remote, and the drive-letter refusal in `split` covers only the
  // shorter of the two.
  if (parts.transport === TRANSPORT.SSH_SCP && !host.includes('.')) return null;

  // A trailing slash is cosmetic; anything else about the path is not.
  const path = parts.path.replace(/\/+$/, '');
  if (path === '') return null;

  const segments = path.split('/');
  // Exactly owner and name. Fewer means no owner; more means this reader does
  // not know which two segments are the repository, and guessing is how the
  // wrong repository gets confirmed as the right one.
  if (segments.length !== 2) return null;
  if (segments.some((segment) => segment === '')) return null;

  const [owner, lastSegment] = segments;
  // Exactly one trailing ".git": a repository genuinely named "thing.git"
  // clones from "thing.git.git".
  const name = lastSegment.endsWith('.git') ? lastSegment.slice(0, -4) : lastSegment;
  if (name === '') return null;

  return { host, owner, name, transport: parts.transport };
}

/**
 * The comparison form of an identity: trimmed and lowercased.
 *
 * Used ONLY to compare. What gets reported as observed is always the original
 * spelling, so the report says what the repository says.
 *
 * Only host, owner and name take part. The transport deliberately does not: the
 * same repository named over HTTPS, over `ssh://` and in the scp-like form is
 * one repository, and folding the transport into the identity would make a
 * policy pass or fail on how you happen to connect.
 */
export function normaliseIdentity(identity) {
  if (identity === null || typeof identity !== 'object') return null;
  const fold = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : null);
  return { host: fold(identity.host), owner: fold(identity.owner), name: fold(identity.name) };
}

const describe = (identity) => `${identity.host}/${identity.owner}/${identity.name}`;

const sameIdentity = (left, right) =>
  left !== null && right !== null
  && left.host === right.host && left.owner === right.owner && left.name === right.name;

/**
 * Decide whether this repository is the one the policy declares.
 *
 * `readRemoteUrl` is injected so every branch can be driven without a real
 * remote. It is called as `readRemoteUrl(root, remote)` and either returns the
 * url, returns null when the remote is not configured, or throws when the read
 * itself failed.
 *
 * The identity comes from the remote and from NOTHING else. In particular it
 * is never derived from the directory name: a clone can be checked out into
 * any folder, and a folder named `gentle-ai` holding a different repository is
 * exactly the confusion this module exists to refuse.
 *
 * @returns {{status: string, reason: string, refusal: string|null, evidence: object[], remediation?: string}}
 */
export function checkRepositoryIdentity({ root, expected, remote = 'origin', readRemoteUrl = readRemoteUrlFromGit }) {
  const declared = { host: expected?.host ?? null, owner: expected?.owner ?? null, name: expected?.name ?? null };

  // Always exactly one evidence item, whatever happened. A refusal that does
  // not record what was expected and what was seen cannot be audited, and a
  // shape that changes per branch cannot be read at a glance.
  //
  // The raw url is NOT among the recorded facts, in any form -- not raw, not
  // redacted, not hashed, not truncated. Pattern-based redaction removes
  // credentials that match known shapes; it is not, and cannot be, a proof that
  // no secret is present. A url can carry a token in a shape no pattern knows,
  // in the userinfo, in a query or in a fragment. The only way to guarantee a
  // url is not disclosed is never to record it, so the url stops at this
  // function and what leaves is the parsed identity and nothing else.
  const record = (observed, transport, extra = null) => [makeEvidence({
    type: EVIDENCE_TYPE.GIT,
    source: `git config --get remote.${remote}.url`,
    observed: {
      remote,
      expected: declared,
      observed,
      transport,
      ...(extra ?? {}),
    },
  })];

  let url;
  try {
    url = readRemoteUrl(root, remote);
  } catch (error) {
    // The exception's message is not interpolated, and neither is its stderr or
    // its argv. `GitCommandError` builds its message out of git's stderr, and
    // git quotes the remote url when it complains about one -- so the message is
    // attacker-influenced free text that can carry the very url this module
    // refuses to disclose. Handing that text to a redactor and asking whether it
    // is safe is the same unprovable assumption this change exists to remove.
    // What is recorded instead is structured and bounded: the error class and
    // the process exit code, which is what a reader needs to tell "git is
    // missing" from "the config file is unreadable".
    return {
      status: STATUS.UNKNOWN,
      reason: `the url of remote "${remote}" could not be read, so this repository's identity is unknown`,
      refusal: IDENTITY_REFUSAL.REMOTE_UNREADABLE,
      evidence: record(null, null, {
        failure: { name: error?.name ?? 'Error', exitCode: error?.code ?? null },
      }),
      remediation: 'Make the repository readable and run the gate again. An unreadable remote is not a matching one.',
    };
  }

  if (typeof url !== 'string' || url.trim() === '') {
    return {
      status: STATUS.UNKNOWN,
      reason: `this repository configures no remote "${remote}", so there is nothing to compare against the ${describe(declared)} identity the policy declares`,
      refusal: IDENTITY_REFUSAL.REMOTE_MISSING,
      evidence: record(null, null),
      remediation: `Configure remote "${remote}", or run a policy written for this repository. The identity is never guessed from the directory name.`,
    };
  }

  const parsed = parseRemoteUrl(url);
  if (parsed === null) {
    // The reason names the failure and the remedy. It does not quote the url,
    // and neither does the evidence: an unparseable url is the case MOST likely
    // to be unparseable *because* something unexpected is embedded in it.
    return {
      status: STATUS.UNKNOWN,
      reason: `the url configured for remote "${remote}" is not a form this reader can resolve into host, owner and name, so this repository's identity is unknown`,
      refusal: IDENTITY_REFUSAL.REMOTE_UNPARSEABLE,
      evidence: record(null, null),
      remediation: 'Point the remote at the repository over one of the three supported forms (https://host/owner/name.git, ssh://git@host/owner/name.git or git@host:owner/name.git).',
    };
  }

  const { transport, ...observed } = parsed;
  const evidence = record(observed, transport);

  if (!sameIdentity(normaliseIdentity(observed), normaliseIdentity(declared))) {
    // Observed, and different. That is a fact about the repository, not a gap
    // in the reading, so it is the one branch here that is FAIL.
    return {
      status: STATUS.FAIL,
      reason: `this policy declares the repository ${describe(declared)}, and remote "${remote}" points at ${describe(observed)}; its rules describe files that belong to another repository`,
      refusal: IDENTITY_REFUSAL.MISMATCH,
      evidence,
      remediation: 'Run this policy from the repository it declares, or write a policy for this one. Nothing is reported about a repository this policy was not written for.',
    };
  }

  return {
    status: STATUS.PASS,
    reason: `remote "${remote}" points at ${describe(observed)}, which is the repository this policy declares`,
    refusal: null,
    evidence,
  };
}
