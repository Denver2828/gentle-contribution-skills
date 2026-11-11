#!/usr/bin/env node
// Public edition: private incident history omitted. See the operational contract.

import { pathToFileURL } from 'node:url';

export const UPSTREAM_REPO = 'gentleman-programming/gentle-ai';
export const PUBLISHER_PATH = '.claude/tools/audit/bin/publish.mjs';

/**
 * Write-shaped tokens, matched against a lowercased, whitespace-collapsed
 * command. The gh subcommands that mutate; the explicit HTTP mutation methods
 * of both gh api and curl; every field-carrying flag of gh api (-f/-F,
 * --field, --raw-field, --input), because `gh api` with any field flips to
 * POST without ever saying POST. curl's implicit-POST data flags deny for
 * the same reason: --data* and --form in EXTRA_WRITE_SHAPES, short -d in
 * SHORT_DATA_FLAG with its read-tool exemption (W-2b). Wider than strictly
 * necessary, on purpose: the false positive costs a rephrase.
 */
const WRITE_SHAPES = [
  /\bissue\s+create\b/,
  /\bissue\s+comment\b/,
  /\bissue\s+edit\b/,
  /\bissue\s+close\b/,
  /\bpr\s+create\b/,
  /\bpr\s+comment\b/,
  /\bpr\s+edit\b/,
  /\bpr\s+merge\b/,
  /\brelease\s+create\b/,
  /(^|\s)-x\s*(post|patch|put|delete)\b/,
  /--method[=\s]+["']?(post|patch|put|delete)\b/,
  /(^|\s)-f[=\s]/,
  /(^|\s)--(raw-)?field[=\s]/,
  /(^|\s)--input\b/,
  // curl's -d, --data* and --form live below: --data* and --form in
  // EXTRA_WRITE_SHAPES, short -d in SHORT_DATA_FLAG (W-2b).
  // W-1 (2026-10-01): a git push names the target URL and matched nothing.
  // Up to six tokens of global options may sit between `git` and the verb.
  /\bgit(?:\.exe)?(?:\s+\S+){0,6}?\s+(?:push|send-pack|http-push)(?:\s|$)/,
];

/**
 * Write shapes added or moved after the 2026-10-01 repro (W-1, W-2), each with the view of
 * the command it is matched over. Views are the whole command, never a
 * segment (ASTRA-06): `lower` is the flat string plus its quote-free copy;
 * `bare` is only the quote-free copy, for the deny-unless-read method
 * shapes, whose negative lookahead would read a quoted `"GET"` as some other
 * method; `cased` keeps the original case, because curl's short options are
 * case-sensitive (`-d` data vs `-D` dump-header, `-F` form vs `-f` fail).
 * `client: true` shapes are curl/wget flags that other tools reuse for reads
 * (gh's `--json` and `--body-file`, `-F`/`-T`/`-K`), so they count only when
 * the command names an HTTP client or a GitHub API host. That condition only
 * ever ADDS denies: no shape that denied before W-2 sits behind it (W-2b).
 */
const EXTRA_WRITE_SHAPES = [
  // Any method that is not a read, including a quoted or variable one.
  { shape: /(^|\s)--(?:request|method)(?:=|\s+)(?!(?:get|head)(?:\s|$|[;&|)]))\S+/, view: 'bare' },
  { shape: /(^|\s)-[A-Za-z]*X\s*(?!(?:GET|HEAD|get|head)(?:\s|$|[;&|)]))\S+/, view: 'bareCased' },
  // curl and wget payload carriers. --data* and --form deny with or without
  // a client in sight, as before W-2: the client can hide behind `$C`,
  // `$'\x63url'`, httpie, xh or a script (W-2b adversarial BLOCK).
  { shape: /(^|\s)--(?:expand-)?data(-\w+)?\b/, view: 'lower' },
  { shape: /(^|\s)--form\b/, view: 'lower' },
  { shape: /(^|\s)--(?:upload-file|post-data|post-file|body-data)\b/, view: 'lower' },
  { shape: /(^|\s)--(?:json|config|body-file)\b/, view: 'lower', client: true },
  { shape: /(^|\s)-[A-Za-z]*[dFTK]\S*/, view: 'cased', client: true },
];

/**
 * curl's short data flag in every spelling the shell hands curl: `-d`, glued
 * `-d@b.json`, bundled `-sSd` (W-2b). Matched over the lowercased flat string
 * and its quote-free copy, with or without a client named. Its one exemption:
 * the flag directly follows a read tool whose `-d` means something else
 * (`base64 -d` decode, `ls -d`/`eza -d` directory, `tr -d` delete, `[ -d`/
 * `test -d` is-directory), and that tool stands in command position -- at the
 * start, after a shell separator, or after a shell keyword that itself does.
 * `$C base64 -d @b <url>` hands base64 to curl as a URL, so position matters.
 * The exemption must hold for every `-d` in BOTH views, so a quote or a
 * backslash can never create it, only remove it.
 */
const SHORT_DATA_FLAG = /(^|\s)(-d\S*|-[a-z]+d(?![a-z])\S*)/g;
const D_READ_TOOLS = new Set(['base64', 'ls', 'tr', 'eza', '[', 'test']);
const SHELL_KEYWORDS = new Set(['if', 'then', 'do', 'else', 'elif', 'while', 'until', '!']);

/**
 * A command that redefines what a name runs -- a function, an alias, PATH,
 * a hash entry, a sourced file -- voids the exemption: `ls() { curl "$@"; }`
 * makes `ls -d` a post.
 */
const REDEFINES_COMMANDS = /\(\s*\)|\bfunction\s|\balias\s|\bpath=|\bhash\s|\benable\s|\bsource\s|(?:^|[;&|(`]\s*)\.\s/;

/** True when the text before a token leaves that token in command position. */
function atCommandPosition(before) {
  const text = before.trimEnd();
  if (text === '') return true;
  // A separator counts unless a redirection (`>&`) or an escape owns it; a
  // `(` after `<`/`>` opens a process substitution, which is a command.
  if (/(?:(?:^|[^<>/\\])[;&|`]|(?:^|[^/\\])\()$/.test(text)) return true;
  const last = text.match(/(?:^|[\s;&|(`])([^\s;&|(`]+)$/);
  return last !== null && SHELL_KEYWORDS.has(last[1])
    && atCommandPosition(text.slice(0, text.length - last[1].length));
}

/** The first short `-d` in `text` that no read tool owns, or null. */
function unexemptShortDataFlag(text, redefines) {
  SHORT_DATA_FLAG.lastIndex = 0;
  let match;
  while ((match = SHORT_DATA_FLAG.exec(text)) !== null) {
    const flagStart = match.index + match[1].length;
    const owner = redefines ? null : text.slice(0, flagStart).match(/(^|[\s;&|(`])([^\s;&|(`]+)\s+$/);
    const exempt = owner !== null && D_READ_TOOLS.has(owner[2])
      && atCommandPosition(text.slice(0, flagStart - owner[0].length + owner[1].length));
    if (!exempt) return match[2];
  }
  return null;
}

/**
 * Something that can send an HTTP request body: curl (any spelling the shell
 * resolves to curl once quotes are removed), wget, or a GitHub API host any
 * other client could be pointed at.
 */
const HTTP_CLIENT = /\b(?:curl|wget2?)\b|\b(?:api|uploads)\.github\.com\b/;

/**
 * Read-shaped gh subcommands: the ONLY way a gh command naming the upstream
 * repository reaches allow.
 *
 * The write list above enumerates verbs, so any verb nobody enumerated reached
 * allow by default. `gh pr ready` was exactly that hole: a public draft->ready
 * flip on an open pull request, matching no write token. So were `pr close`,
 * `pr reopen`, `pr review`, `issue reopen`, `issue transfer`, `label delete`,
 * and every verb gh adds after this file was written.
 *
 * Reads are a small, stable, enumerable set; writes are open-ended and grow
 * with the tool. Deny-by-default belongs on the open-ended side, which is why
 * the gh branch is an allowlist while curl and the HTTP-shape flags stay a
 * denylist -- those are cross-cutting and have no enumerable read side.
 */
const GH_READ_SHAPES = [
  /^(issue|pr|release|run|workflow|label|repo|gist|cache|ruleset|project) (view|list)$/,
  /^pr (diff|checks|status)$/,
  /^issue status$/,
  /^search (issues|prs|repos|code|commits)$/,
  /^run (watch|download)$/,
  /^release download$/,
  /^api\b/,
];

/**
 * Every `gh` invocation in the flattened command, found by anchoring on what
 * can precede a real invocation: start of string, whitespace, `(`, `/`
 * (a path to the binary: `/usr/bin/gh`), `;`, `|`, `&`, or a backtick or
 * `$(` (both end in `(`, already covered). The lookahead requiring whitespace
 * right after `gh`(`.exe`)? keeps `github.com` and `env GH_PAGER=` from ever
 * matching -- there is no whitespace directly after those.
 *
 * The match itself consumes only the anchor and `gh`; it does not also
 * capture the verb tokens. A single regex that captured every remaining
 * token in one greedy group would swallow a second `gh …` appearing later in
 * the same command whole, so that second invocation would never be judged on
 * its own merits -- the `.exec` loop below reads each invocation's own verb
 * tokens from the remainder separately, which is what lets it find every
 * invocation, not just the first.
 */
const GH_INVOCATION = /(^|[\s(/;|&`])gh(?:\.exe)?(?=\s)/g;

/** More room than a leading global flag or two plus a two-token verb ever needs. */
const GH_VERB_TOKEN_WINDOW = 6;

/**
 * The verb right after one `gh` invocation, read from the remainder of the
 * flat string that follows it. Leading global flags are skipped first (a
 * token starting with `-` is skipped, and so is the next token when that
 * flag carries no `=`, since the value is a separate token): `gh --repo X
 * issue view 1` must still find "issue view" as the verb, not "--repo X".
 * What is left is the next one or two tokens, joined with a single space so
 * both an exact two-token read shape (`pr diff`) and the one-token prefix
 * shape (`api`) can test the same string.
 *
 * Returns null when no verb token exists at all -- an invocation with
 * nothing after it to judge is doubt, and doubt denies.
 */
function extractVerb(remainder) {
  const tokens = remainder.trim().split(' ').filter(Boolean).slice(0, GH_VERB_TOKEN_WINDOW);
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const flag = tokens[i];
    i += 1;
    if (!flag.includes('=')) i += 1;
  }
  if (i >= tokens.length) return null;
  return tokens.slice(i, i + 2).join(' ');
}

/** Every denial teaches the same sanctioned path; only the why differs. */
const sanctionedPath = (why) => `${why} Writes to ${UPSTREAM_REPO} go through the controlled publisher only: node ${PUBLISHER_PATH} --lineage <lineage> --body-file <file>. It consumes the lineage's ticket, runs the exact operation the ticket names, verifies the published bytes, and records the attempt. Reads (view, list, api GET, search, diff, checks) pass untouched.`;

// -- deny diagnostics (G1) ----------------------------------------------------------------
//
// Pure helpers that run only AFTER decide() has already chosen deny, and only
// produce text appended to that reason. They never see a command that would
// allow, and nothing they compute feeds back into the decision: a generic
// reason made a false positive cost trial-and-error rephrasing, a named cause
// makes it cost one informed retry.

const SHELL_OPERATORS = new Set(['&&', '||', ';', '|', '&']);
const REPO_FLAG = /(?:^|\s)(?:-r|--repo)(?:=|\s+)["']?([^\s"']+)/g;

/**
 * True when every upstream mention in the flat command sits inside a
 * `github.com/<owner>/<repo>` web URL (never the `api.github.com/repos/` API
 * path) and at least one -R/--repo names a repository, none of them upstream.
 * Returns the named repositories in that case, otherwise null.
 */
function upstreamOnlyInPayloadUrl(flat) {
  const targets = [...flat.matchAll(REPO_FLAG)].map((m) => m[1]);
  if (targets.length === 0 || targets.some((t) => t.includes(UPSTREAM_REPO))) return null;
  let from = 0;
  let index;
  while ((index = flat.indexOf(UPSTREAM_REPO, from)) !== -1) {
    const before = flat.slice(0, index);
    if (!before.endsWith('github.com/') || before.endsWith('api.github.com/')) return null;
    from = index + UPSTREAM_REPO.length;
  }
  return targets;
}

/**
 * The diagnostic for a write-shape deny: the shape (from the view it matched
 * in), whether that view had quotes removed or the shape needed an HTTP
 * client named, and the conditional payload hint.
 */
function writeShapeDiagnostic(matched, flat, normalized = false, condition = null) {
  let text = ` Cause: the command matched the write shape \`${matched}\` and names ${UPSTREAM_REPO}.`;
  if (normalized) text += ' The shape matched after removing quote characters and backslashes, as the shell does.';
  if (condition === 'client') text += ' It counts because the command names curl, wget or a GitHub API host.';
  if (condition === 'short-d') text += ' A short -d counts unless it directly follows base64, ls, tr, eza, [ or test standing as its own command.';
  const targets = upstreamOnlyInPayloadUrl(flat);
  if (targets !== null) {
    text += ` The upstream name appears only inside a URL in the command text, while -R/--repo names ${targets.join(', ')}. If the target is not upstream, put that text in a file (--body-file, written with the Write tool) so the command itself carries no upstream mention.`;
  }
  return text;
}

/** The diagnostic for a read-shape deny: the invocation, the verb it read, or "no verb". */
function readShapeDiagnostic(remainder, verb) {
  const tokens = remainder.trim().split(' ').filter(Boolean);
  const shown = ['gh', ...tokens.slice(0, GH_VERB_TOKEN_WINDOW)].join(' ');
  let text = verb === null
    ? ` Cause: the gh invocation \`${shown}\` has no verb to read.`
    : ` Cause: the gh invocation \`${shown}\` read the verb \`${verb}\`, which is no known read shape.`;
  const flag = tokens[0];
  if (flag !== undefined && flag.startsWith('-') && !flag.includes('=')) {
    const consumed = tokens[1];
    if (consumed !== undefined && SHELL_OPERATORS.has(consumed)) {
      text += ` The leading flag \`${flag}\` took \`${consumed}\` as its value; run \`gh ${flag}\` as its own command.`;
    } else if (consumed === undefined) {
      text += ` The leading flag \`${flag}\` leaves nothing to read as a verb; run \`gh ${flag}\` as its own command.`;
    }
  }
  return text;
}

/**
 * Judge one Bash command string as a whole -- no segmentation.
 *
 * The publisher never takes the upstream repository as an argument, so its
 * own invocation is never what trips a denial; it simply reaches step 5 on
 * its own merits, same as any other command that mentions the repository
 * only in a harmless way. There is no publisher exception to apply, which is
 * also why a mention of the publisher path inside a write -- a comment, an
 * issue body, an echo -- no longer buys anything: the write shape already
 * denied before that mention was ever read (ASTRA-06 round-one correction).
 *
 * @returns {{decision: 'allow'|'deny', reason: string|null}}
 */
export function decide(command) {
  if (typeof command !== 'string') {
    return { decision: 'deny', reason: 'the hook received no command string to judge, and doubt denies' };
  }

  const flat = command.toLowerCase().replace(/\s+/g, ' ').replace(/\\/g, '/');
  // The same whole command with every quote character and backslash removed
  // (W-1): the shell removes them before the program sees its argv, so
  // `c''url -X P''OST` is curl posting. Matched in addition to `flat`, never
  // instead of it, so it can only add denies.
  const bareCased = command.replace(/["'\\]/g, '').replace(/\s+/g, ' ');
  const bare = bareCased.toLowerCase();
  const casedFlat = command.replace(/\s+/g, ' ').replace(/\\/g, '/');

  // The repository is never named: not this guard's question at all, no
  // matter what else the command does.
  if (!flat.includes(UPSTREAM_REPO) && !bare.includes(UPSTREAM_REPO)) return { decision: 'allow', reason: null };

  // Denials are evaluated over the WHOLE command before any exception. A
  // write shape hiding past a redirection (`2>&1 -f title=x`), inside a
  // quoted argument (`--body "a; b"`), or in a trailing `#` comment still
  // denies -- there is nothing left to split that could separate it from the
  // repository mention it belongs with.
  const deny = (matched, normalized, condition = null) => ({
    decision: 'deny',
    reason: sanctionedPath('That command matches a known write shape.') + writeShapeDiagnostic(matched.trim(), flat, normalized, condition),
  });
  for (const shape of WRITE_SHAPES) {
    if (shape.test(flat)) return deny(flat.match(shape)[0], false);
  }
  for (const shape of WRITE_SHAPES) {
    if (shape.test(bare)) return deny(bare.match(shape)[0], true);
  }
  const redefines = REDEFINES_COMMANDS.test(flat) || REDEFINES_COMMANDS.test(bare);
  for (const [text, normalized] of [[flat, false], [bare, true]]) {
    const flag = unexemptShortDataFlag(text, redefines);
    if (flag !== null) return deny(flag, normalized, 'short-d');
  }
  const clientNamed = HTTP_CLIENT.test(flat) || HTTP_CLIENT.test(bare);
  const views = { lower: [[flat, false], [bare, true]], bare: [[bare, true]], cased: [[casedFlat, false], [bareCased, true]], bareCased: [[bareCased, true]] };
  for (const { shape, view, client = false } of EXTRA_WRITE_SHAPES) {
    if (client && !clientNamed) continue;
    for (const [text, normalized] of views[view]) {
      if (shape.test(text)) return deny(text.match(shape)[0], normalized, client ? 'client' : null);
    }
  }

  // Every gh invocation against the upstream repository must PROVE it is a
  // read, at its own verb position -- never by a read shape found elsewhere
  // in the string, whether a comment (`# gh pr view`), a second command
  // (`; gh pr view ...`), or a subshell (`$(gh pr ready ...)`). Anything
  // unrecognised, or an invocation with no verb to read at all, is denied: a
  // guard whose coverage depends on having predicted every future
  // subcommand is not coverage, it is a guess.
  // The quote-free copy is scanned too (W-1): `g''h pr ready` is gh.
  for (const text of [flat, bare]) {
    GH_INVOCATION.lastIndex = 0;
    let invocation;
    while ((invocation = GH_INVOCATION.exec(text)) !== null) {
      const remainder = text.slice(invocation.index + invocation[0].length);
      const verb = extractVerb(remainder);
      if (verb === null || !GH_READ_SHAPES.some((shape) => shape.test(verb))) {
        return {
          decision: 'deny',
          reason: sanctionedPath('That gh command names the upstream repository and matches no known read shape, so doubt denies it.')
            + readShapeDiagnostic(remainder, verb),
        };
      }
    }
  }

  return { decision: 'allow', reason: null };
}

// -- process boundary -------------------------------------------------------------

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();

if (invokedDirectly) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      process.stderr.write('publish-guard: the hook input was not readable JSON; denying rather than guessing\n');
      process.exit(2);
    }

    // Wired for Bash. Any other tool's event is not this guard's question.
    if (input?.tool_name !== undefined && input.tool_name !== 'Bash') process.exit(0);

    const verdict = decide(input?.tool_input?.command);
    if (verdict.decision === 'deny') {
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason,
        },
      })}\n`);
    }
    process.exit(0);
  });
}
