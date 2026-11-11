// Conservative classifier for read-only "state" shell commands, shared by
// odd-trace.mjs (Claude Code) and odd-trace-codex.mjs (Codex). ODD's own
// delegation table allows "Bash for state (`git`, `gh`)" inline, so the trace
// scripts report a second view of the ~20-call backstop that leaves these
// calls out. The original counts are never changed; this only feeds new,
// additive report fields.
//
// The rule is deliberately narrow: a command is a state read only when every
// segment of it (split on `&&`, `||`, `;`, `|` and newlines, outside quotes)
// is a known read-only verb from the lists below. Anything unknown,
// unparseable, or carrying a construct that could run or write something
// else (command substitution, subshells, background `&`, file redirection,
// heredocs) is NOT a state read and keeps counting toward the backstop.
//
// Rule set version 2 (OTS-3) adds one widening: a segment reached through a
// single `|` may also be a read-only text filter (PIPE_FILTERS), provided
// the pipeline it belongs to starts with a state read. A filter anywhere
// else (standalone, or after `&&`/`||`/`;`) is still not a state read: a
// standalone file read is an exploratory read, a different ODD signal.

const GIT_SUBCOMMANDS = [
  "status", "log", "diff", "show", "rev-parse", "branch", "remote", "ls-files",
  "ls-remote", "merge-base", "cat-file", "config", "worktree", "describe",
];
// Subcommands whose every argument is read-only (the rest carry their own checks).
const GIT_PLAIN = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-remote", "merge-base", "cat-file", "describe",
]);
const GIT_BRANCH_FLAGS = new Set([
  "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "-l", "--list", "--show-current",
  "--no-color", "--color", "--no-column", "--column", "-i", "--ignore-case",
]);
const GIT_BRANCH_VALUE_FLAGS = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"]);
const GIT_CONFIG_QUERY = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"]);
const GIT_CONFIG_MODIFIERS = new Set([
  "--show-origin", "--show-scope", "--global", "--local", "--system", "--worktree", "--includes",
  "--no-includes", "--name-only", "-z", "--null",
]);
const GH_ALLOWED = [
  "issue view", "issue list", "pr view", "pr list", "pr diff", "pr checks", "search *",
  "release list", "release view", "repo view", "run list", "run view", "api (GET only, no body fields)",
];
const GH_PAIRS = new Set(GH_ALLOWED.filter((v) => /^[a-z]+ [a-z]+$/.test(v)));
const NODE_LEDGER_VERBS = new Set(["status", "intake"]);
const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh"]);
const POWERSHELL_WRAPPERS = new Set(["powershell", "pwsh"]);

// OTS-3 pipe consumers. Each checker gets the filter's arguments and returns
// whether that invocation only reads stdin (or a file) and writes stdout.
const isShortCluster = (a) => /^-[^-]/.test(a);
const BAT_PAGING_OFF = new Set(["-p", "-pp", "--plain", "-P", "--paging=never"]);
const BAT_FLAGS = new Set(["-p", "-pp", "--plain", "-P", "--paging=never", "-n", "--number"]);
const BAT_VALUE_FLAGS = new Set(["-l", "--language", "-r", "--line-range"]);
const BAT_EQ_FLAGS = ["--language=", "--line-range=", "--style=", "--color=", "--decorations="];
const UNIQ_VALUE_FLAGS = new Set(["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"]);
const PIPE_FILTERS = {
  head: () => true,
  tail: (args) => !args.some((a) => /^--follow(=|$)/.test(a) || (isShortCluster(a) && /[fF]/.test(a))),
  wc: () => true,
  sort: (args) => !args.some((a) => /^--(output|compress-program)(=|$)/.test(a) || (isShortCluster(a) && a.includes("o"))),
  uniq: (args) => {
    let positional = 0;
    for (let k = 0; k < args.length; k += 1) {
      if (UNIQ_VALUE_FLAGS.has(args[k])) k += 1;
      else if (args[k] === "-" || !args[k].startsWith("-")) positional += 1;
    }
    return positional <= 1; // a second positional is an output file
  },
  cut: () => true,
  tr: () => true,
  grep: () => true,
  egrep: () => true,
  fgrep: () => true,
  rg: (args) => !args.some((a) => /^--pre(-glob)?(=|$)/.test(a)),
  jq: () => true,
  bat: (args) => {
    if (!args.some((a) => BAT_PAGING_OFF.has(a))) return false;
    for (let k = 0; k < args.length; k += 1) {
      const a = args[k];
      if (BAT_FLAGS.has(a) || BAT_EQ_FLAGS.some((p) => a.startsWith(p))) continue;
      if (BAT_VALUE_FLAGS.has(a)) {
        k += 1;
        continue;
      }
      if (a.startsWith("-")) return false; // --pager and anything unlisted
    }
    return true;
  },
};

/**
 * The classifier's rules, embedded in each report as `stateReadClassifier`
 * so a reader can audit exactly what was left out of the excluding view.
 * `version` names the rule set: 1 = OTS-1, 2 = OTS-3 (pipe filters, and the
 * widened Codex exec shapes documented by the Codex trace).
 */
export const STATE_READ_CLASSIFIER = {
  version: 2,
  rule: "a call is a state read only when every segment of its shell command (split on &&, ||, ;, | and newlines outside quotes) is a listed read-only verb, or a listed read-only filter reached through | in a pipeline that starts with a state read; unknown or unparseable commands are not state reads",
  pipeFilters: {
    rule: "after a single | only, in a pipeline whose first segment is a state read; a later pipe segment may also be another state read; a filter standalone or after &&, ||, ; is not a state read; a filter segment may not carry leading NAME=value assignments",
    allowed: [
      "head",
      "tail (no -f, -F, --follow)",
      "wc",
      "sort (no -o, --output, --compress-program)",
      "uniq (at most one positional argument, so no output file)",
      "cut",
      "tr",
      "grep, egrep, fgrep",
      "rg (no --pre, --pre-glob)",
      "jq",
      "bat (needs -p, -pp, --plain, -P or --paging=never; other flags only -n, --number, -l/--language, -r/--line-range, --style=, --color=, --decorations=)",
    ],
    notFilters: ["awk", "gawk", "sed", "perl", "python", "node", "xargs", "tee", "less", "sh", "bash", "any other shell or program"],
    names: "program basename, lowercased, .exe stripped",
  },
  neutralSegments: [
    "cd <one path> (alone it is not a state read)",
    "leading NAME=value env assignments",
  ],
  rejectedConstructs: [
    "$(...) or backtick command substitution",
    "( ) subshells",
    "a single & (background or PowerShell call operator)",
    "< input redirection and heredocs",
    "> or >> redirection, except N>&M and >/dev/null, >$null, >NUL",
    "unterminated quotes",
  ],
  git: {
    globalOptions: ["-C <path>", "--no-pager"],
    allowedSubcommands: GIT_SUBCOMMANDS,
    restrictions: [
      "--output / --output=<file> is rejected on every subcommand",
      "branch: listing flags only (" + [...GIT_BRANCH_FLAGS, ...GIT_BRANCH_VALUE_FLAGS].join(", ") + "); a positional name only with -l/--list",
      "remote: no arguments, -v/--verbose, show <name>, or get-url <name>",
      "config: needs one of " + [...GIT_CONFIG_QUERY].join(", ") + " (or the get/list subcommand); other flags only from " + [...GIT_CONFIG_MODIFIERS].join(", "),
      "worktree: list only",
      "fetch, pull, commit, push and every other subcommand are not state reads",
    ],
  },
  gh: {
    allowed: GH_ALLOWED,
    restrictions: [
      "api: no -X/--method other than GET, and no -f/-F/--field/--raw-field/--input",
      "create, comment, edit, merge, close, ready and every other verb are not state reads",
    ],
  },
  node: ["node <path>/ledger.mjs status ...", "node <path>/ledger.mjs intake ..."],
  shellWrappers: "argv arrays [bash|sh|zsh, -c|-lc, <cmd>] and [powershell|pwsh(.exe), ...flags, -Command|-c, <cmd>] are unwrapped; other argv arrays are joined with spaces",
};

/** Lowercased basename without a trailing .exe, for program-name matching. */
function programName(token) {
  return token.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
}

/**
 * Quote-aware split of a command into segments `{ tokens, piped }`, where
 * `piped` says the segment was reached through a single `|`. Returns null
 * when the command carries a construct the classifier refuses to reason
 * about.
 */
function tokenize(cmd) {
  const segments = [];
  let tokens = [];
  let piped = false;
  let cur = null; // null = no token in progress; "" = empty quoted token
  const endToken = () => {
    if (cur !== null) tokens.push(cur);
    cur = null;
  };
  const endSegment = (nextPiped = false) => {
    endToken();
    segments.push({ tokens, piped });
    tokens = [];
    piped = nextPiped;
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    const rest = cmd.slice(i);
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) return null;
      cur = (cur ?? "") + cmd.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let text = "";
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === "`" || cmd.startsWith("$(", j)) return null;
        if (cmd[j] === "\\" && j + 1 < cmd.length) {
          text += cmd[j + 1];
          j += 2;
          continue;
        }
        text += cmd[j];
        j += 1;
      }
      if (j >= cmd.length) return null;
      cur = (cur ?? "") + text;
      i = j + 1;
    } else if (c === "`" || rest.startsWith("$(") || c === "(" || c === ")" || c === "<") {
      return null;
    } else if (rest.startsWith("&&") || rest.startsWith("||")) {
      endSegment();
      i += 2;
    } else if (c === "&") {
      return null;
    } else if (c === ";" || c === "|" || c === "\n" || c === "\r") {
      endSegment(c === "|");
      i += 1;
    } else if (c === ">") {
      // Only harmless redirections: to another descriptor or to the null device.
      const m = /^>(?:&\d|\s*(?:\/dev\/null|\$null|NUL)(?=$|[\s;&|]))/i.exec(rest);
      if (!m) return null;
      if (cur !== null && /^\d$/.test(cur)) cur = null; // the "2" of "2>&1"
      endToken();
      i += m[0].length;
    } else if (c === "\\" && cmd[i + 1] === "\n") {
      endToken();
      i += 2;
    } else if (/\s/.test(c)) {
      endToken();
      i += 1;
    } else {
      cur = (cur ?? "") + c;
      i += 1;
    }
  }
  endSegment();
  return segments;
}

function hasOutputFlag(args) {
  return args.some((a) => a === "--output" || a.startsWith("--output="));
}

function isGitBranchListing(args) {
  const listMode = args.includes("-l") || args.includes("--list");
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (GIT_BRANCH_FLAGS.has(a)) continue;
    if (GIT_BRANCH_VALUE_FLAGS.has(a)) {
      k += 1;
      continue;
    }
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq !== -1 && GIT_BRANCH_VALUE_FLAGS.has(a.slice(0, eq))) continue;
    if (a.startsWith("-")) return false;
    if (!listMode) return false; // a bare name creates a branch
  }
  return true;
}

function isGitRemoteRead(args) {
  if (args.length === 0) return true;
  if (args.every((a) => a === "-v" || a === "--verbose")) return true;
  if (args[0] === "show") return args.slice(1).every((a) => a === "-n" || !a.startsWith("-"));
  if (args[0] === "get-url") return args.slice(1).every((a) => ["--push", "--all"].includes(a) || !a.startsWith("-"));
  return false;
}

function isGitConfigRead(args) {
  if (args[0] === "get" || args[0] === "list") {
    return args.slice(1).every((a) => !a.startsWith("-") || GIT_CONFIG_MODIFIERS.has(a) || a === "--all");
  }
  if (!args.some((a) => GIT_CONFIG_QUERY.has(a))) return false;
  return args.every((a) => !a.startsWith("-") || GIT_CONFIG_QUERY.has(a) || GIT_CONFIG_MODIFIERS.has(a));
}

function isGitStateRead(args) {
  let k = 0;
  while (k < args.length && args[k].startsWith("-")) {
    if (args[k] === "--no-pager") k += 1;
    else if (args[k] === "-C" && k + 1 < args.length) k += 2;
    else return false; // -c and every other global option can change behavior
  }
  const sub = args[k];
  const rest = args.slice(k + 1);
  if (sub === undefined || hasOutputFlag(rest)) return false;
  if (GIT_PLAIN.has(sub)) return true;
  if (sub === "branch") return isGitBranchListing(rest);
  if (sub === "remote") return isGitRemoteRead(rest);
  if (sub === "config") return isGitConfigRead(rest);
  if (sub === "worktree") return rest[0] === "list";
  return false;
}

function isGhApiRead(args) {
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (/^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a) || /^-[fF].+/.test(a)) return false;
    let method = null;
    if (a === "-X" || a === "--method") method = args[(k += 1)] ?? "";
    else if (a.startsWith("--method=")) method = a.slice("--method=".length);
    else if (a.startsWith("-X")) method = a.slice(2);
    if (method !== null && method.toUpperCase() !== "GET") return false;
  }
  return true;
}

function isGhStateRead(args) {
  const [group, verb] = args;
  if (group === "search") return verb !== undefined;
  if (group === "api") return isGhApiRead(args.slice(1));
  return GH_PAIRS.has(`${group} ${verb}`);
}

function isNodeStateRead(args) {
  const [script, verb] = args;
  if (typeof script !== "string" || programName(script) !== "ledger.mjs") return false;
  return NODE_LEDGER_VERBS.has(verb);
}

/** "state", "filter", "neutral", "empty" or "other" for one segment's tokens. */
function classifySegment(tokens) {
  let k = 0;
  while (k < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[k])) k += 1;
  const [prog, ...args] = tokens.slice(k);
  if (prog === undefined) return k > 0 ? "neutral" : "empty";
  const name = programName(prog);
  if (name === "cd") return args.length <= 1 ? "neutral" : "other";
  if (name === "git") return isGitStateRead(args) ? "state" : "other";
  if (name === "gh") return isGhStateRead(args) ? "state" : "other";
  if (name === "node") return isNodeStateRead(args) ? "state" : "other";
  // An env assignment could reconfigure a filter (e.g. a config-file path).
  if (k === 0 && Object.hasOwn(PIPE_FILTERS, name) && PIPE_FILTERS[name](args)) return "filter";
  return "other";
}

/**
 * Whether a shell command string is a pure state read (see the header and
 * STATE_READ_CLASSIFIER). A non-string, an empty command, or a command made
 * only of neutral segments is not a state read. A read-only filter counts
 * only when it is reached through `|` from a pipeline that began with a
 * state read.
 */
export function isStateReadCommand(cmd) {
  if (typeof cmd !== "string") return false;
  const segments = tokenize(cmd);
  if (segments === null) return false;
  let sawState = false;
  let pipelineFromState = false; // the current pipeline's first segment was a state read
  for (const { tokens, piped } of segments) {
    const kind = classifySegment(tokens);
    if (kind === "other") return false;
    if (piped) {
      if (!pipelineFromState || (kind !== "state" && kind !== "filter")) return false;
      continue;
    }
    if (kind === "filter") return false;
    pipelineFromState = kind === "state";
    if (kind === "state") sawState = true;
  }
  return sawState;
}

/**
 * Turn a shell argv array into the command string it runs: a bash/sh/zsh
 * `-c`/`-lc` wrapper or a PowerShell `-Command` wrapper is unwrapped; any
 * other argv is joined with spaces (a plain argv never goes through a shell,
 * so joining only makes the check stricter). Returns null for anything that
 * is not a non-empty array of strings.
 */
export function unwrapShellArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) return null;
  const prog = programName(argv[0]);
  if (SHELL_WRAPPERS.has(prog)) {
    return argv.length === 3 && (argv[1] === "-c" || argv[1] === "-lc") ? argv[2] : null;
  }
  if (POWERSHELL_WRAPPERS.has(prog)) {
    const idx = argv.findIndex((a, n) => n > 0 && /^-(command|c)$/i.test(a));
    if (idx === -1 || idx !== argv.length - 2) return null;
    const flagsBefore = argv.slice(1, idx);
    if (!flagsBefore.every((a) => /^-(noprofile|noninteractive|nologo)$/i.test(a))) return null;
    return argv[idx + 1];
  }
  return argv.join(" ");
}

/**
 * The same streak walk the trace scripts use for the 20-call backstop, over
 * events with the state reads removed: a state read neither counts as a call
 * nor closes a streak (only a delegation closes one). Indices (`startIndex`,
 * `crossedAt.calls`, `closedBy.index`) are positions in that filtered
 * sequence, so `backstopFollowThrough` over these entries measures extra
 * non-state calls past the threshold.
 */
export function callStreaksExcludingStateReads(events, { isDelegation, threshold }) {
  const kept = events.filter((e) => !e.stateRead);
  const streaks = [];
  let s = { startIndex: 0, calls: 0, crossedAt: {}, closedBy: null };
  kept.forEach((e, i) => {
    if (isDelegation(e)) {
      s.closedBy = { index: i, name: e.name };
      streaks.push(s);
      s = { startIndex: i + 1, calls: 0, crossedAt: {}, closedBy: null };
      return;
    }
    s.calls += 1;
    if (s.calls >= threshold && s.crossedAt.calls === undefined) s.crossedAt.calls = i;
  });
  if (s.calls > 0) streaks.push(s);
  return streaks;
}

/** Per-session additive fields for the excluding-state view. */
export function excludingStateReadsSummary(events, streaks) {
  return {
    stateReads: events.filter((e) => e.stateRead).length,
    excludingStateReads: {
      maxStreakCalls: streaks.reduce((m, x) => Math.max(m, x.calls), 0),
      crossingsCalls20: streaks.filter((x) => x.crossedAt.calls !== undefined).length,
    },
  };
}

/** Report-level totals for the excluding-state view, over valid sessions. */
export function stateReadTotals(sessions) {
  return {
    stateReads: sessions.reduce((n, x) => n + x.stateReads, 0),
    sessionsCrossingCalls20ExcludingStateReads: sessions.filter((x) => x.excludingStateReads.crossingsCalls20 > 0).length,
    streaksCrossingCalls20ExcludingStateReads: sessions.reduce((n, x) => n + x.excludingStateReads.crossingsCalls20, 0),
  };
}
