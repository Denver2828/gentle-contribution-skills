#!/usr/bin/env node
// Codex CLI analog of odd-trace.mjs. Reads every Codex rollout transcript
// under a session root (recursively, since Codex stores them under
// YYYY/MM/DD/rollout-*.jsonl) and measures the same ODD delegation triggers
// as observable events, reusing odd-trace.mjs's pure THRESHOLD constants and
// `backstopFollowThrough` rather than duplicating that logic.
//
// Usage: node odd-trace-codex.mjs <sessions-dir> [--valid-from <iso>] [--cwd-prefix <path>]
//
// Format notes (verified against real rollout files under
// ~/.codex/sessions, see docs/odd-codex-trace.md for the method):
//
// - Each line is {timestamp, type, payload}. The file's own identity comes
//   from its FIRST `session_meta` record only: later `session_meta` lines in
//   the same file are replayed ancestor metadata (carried over by
//   compaction/forking), not a second session living in the same file.
//
// - Delegation = the `collaboration/spawn_agent` function_call: it creates a
//   brand-new agent thread with its own `agent_path`. `followup_task` and
//   `send_message` are NOT counted as delegation: both target an EXISTING
//   `agent_path` (verified: their `target` argument matches an already
//   spawn_agent'd path), so they are Codex's analog of Claude's
//   `SendMessage` continuing an existing subagent -- which odd-trace.mjs's
//   DELEGATION set also excludes. `wait_agent`, `list_agents` and
//   `interrupt_agent` are ordinary calls (like Bash), not delegations.
//
// - Reads and edits both go through the single `custom_tool_call` named
//   `exec` (a JS sandbox: `tools.exec_command(...)`, `tools.mcp__*(...)`,
//   arbitrary shell, and `apply_patch`-style diffs can all appear inside one
//   exec call's `input`). Only an embedded apply_patch diff
//   ("*** Add/Update/Delete File: <path>") is an unambiguous, observable
//   edit marker, so ONLY edits are measured; read counts and the 4-file
//   mapping trigger are reported as not observable, never guessed.
//
// - Main-thread vs sub-agent is decided by the file's own first session_meta
//   record: `thread_source === "subagent"`, or (for the pre-thread_source
//   format) an object-shaped `source` carrying a `subagent` key. A
//   `forked_from_id` alone does NOT indicate a sub-agent: main-thread
//   sessions also carry it after a compaction-driven fork
//   (`thread_source: "agent_forked_thread"`, string `source`) -- verified
//   against real data; using forked_from_id alone would have misclassified
//   those as sub-agents.
//
// - A gentle-ai reviewer subprocess is a Codex CLI process gentle-ai spawns
//   for one review lens. It reports thread_source "user" (it looks like an
//   ordinary new top-level session to Codex, not a subagent), so it needs
//   its own rule: cwd under a Temp `gentle-ai-codex-reviewer-<pid>`
//   directory AND one of the first few user messages starts with
//   `GENTLE_AI_REVIEW_BINDING` (the literal first user-role message is
//   usually a `<recommended_plugins>` boilerplate wrapper Codex injects, not
//   the actual first user turn, so both conditions are checked; a cwd match
//   without the marker is not treated as a reviewer subprocess).
//
// - State reads (OTS-1, additive): a call whose shell commands are all pure
//   read-only state verbs (lib/odd-state-reads.mjs) is left out of a second
//   view of the 20-call backstop (`stateReads`, `excludingStateReads`,
//   `stateReadTotals`, `backstopFollowThroughExcludingStateReads`). Commands
//   are read from an `exec` input only when it is nothing but literal
//   `tools.exec_command({cmd: ...})` calls and `text(...)`/`console.log(...)`
//   output statements (rule set version 2, OTS-3; see execInputCommands).
//   Every original field is unchanged.

import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { THRESHOLD, backstopFollowThrough } from "./odd-trace.mjs";
import {
  STATE_READ_CLASSIFIER,
  callStreaksExcludingStateReads,
  excludingStateReadsSummary,
  isStateReadCommand,
  stateReadTotals,
  unwrapShellArgv,
} from "../lib/odd-state-reads.mjs";

export const DELEGATION_NAME = "spawn_agent";
// Documented, not used to change behavior: these target an existing agent
// path and are deliberately excluded from delegation counting (see header).
export const CONTINUATION_NAMES = new Set(["followup_task", "send_message"]);
export const CALL_PAYLOAD_TYPES = new Set(["custom_tool_call", "function_call"]);

const PATCH_FILE_RE = /\*\*\* (Add|Update|Delete) File: ([^\n]*?)(?:\\n|\n)/g;
const REVIEWER_CWD_RE = /[\\/][Tt]emp[\\/]gentle-ai-codex-reviewer-\d+(?:[\\/]|$)/;
const ODD_TASKS_RE = /odd[\\/]tasks[\\/]/i;
const MAX_USER_MESSAGES_CHECKED_FOR_REVIEW_BINDING = 3;

/**
 * Extract the distinct file paths an `exec` call's apply_patch diff touched,
 * from the still-encoded JS source text of the call's `input` (never the
 * evaluated string): a patch embedded in a double-quoted JS string carries
 * its line breaks as the literal two characters "\" "n"; a patch embedded in
 * a backtick template literal carries real newline characters. Both forms
 * are handled by the same pattern. Windows path separators are doubled in
 * this still-encoded text (a single "\" needs "\\" in JS source), so pairs
 * are collapsed back to one for a readable, comparable path.
 */
export function extractPatchedFiles(execInput) {
  const files = new Set();
  if (typeof execInput !== "string") return files;
  PATCH_FILE_RE.lastIndex = 0;
  let m;
  while ((m = PATCH_FILE_RE.exec(execInput))) {
    files.add(m[2].replace(/\\\\/g, "\\"));
  }
  return files;
}

// Older per-primitive function_call names that run one shell command.
export const SHELL_FUNCTION_NAMES = new Set(["exec_command", "shell", "shell_command"]);
const IDENT_RE = /[A-Za-z_$][\w$]*/y;
const SCALAR_RE = /-?\d+(?:\.\d+)?|true|false|null/y;
const JS_ESCAPES = { n: "\n", t: "\t", r: "\r" };

/**
 * Decode one JS string literal (double, single or backtick quoted) starting
 * at `input[start]`. Returns { value, end } or null for anything the scanner
 * refuses to evaluate: a template with `${`, \u/\x escapes, or no closing
 * quote.
 */
function readStringLiteral(input, start) {
  const quote = input[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let value = "";
  let j = start + 1;
  while (j < input.length && input[j] !== quote) {
    if (quote === "`" && input.startsWith("${", j)) return null;
    if (input[j] === "\\") {
      const next = input[j + 1];
      if (next === undefined || next === "u" || next === "x") return null;
      value += JS_ESCAPES[next] ?? next;
      j += 2;
      continue;
    }
    value += input[j];
    j += 1;
  }
  return j < input.length ? { value, end: j + 1 } : null;
}

/**
 * The shell command strings inside an `exec` call's JS source, or null when
 * the source is anything but a sequence of these statements (separated by
 * whitespace and/or `;`):
 *   [const|let|var <id> =] <call>
 *   text(<out>) | console.log(<out>)
 *   return <id>[.<id>...]
 * with
 *   <call> = [await] tools.exec_command({ <key>: <literal>, ... })
 *   <out>  = <term> [+ <term> ...]
 *   <term> = await <call> | <id>[.<id>...] | <string literal>
 *          | JSON.stringify(<id>[.<id>...] [, null, <integer>])
 * where every object value is a string, number, boolean or null literal,
 * `cmd` is a string, and no string is a template with `${`. `text(...)` is
 * the exec sandbox's output function: the shapes above cover what a
 * read-only census of real rollouts showed (see docs/odd-codex-trace.md).
 * Any other statement (a patch, an MCP or write_stdin call, a variable or
 * shorthand command, a loop, arbitrary JS) makes the whole call unreadable,
 * hence not a state read.
 */
export function execInputCommands(input) {
  if (typeof input !== "string") return null;
  const cmds = [];
  let i = 0;
  const skip = (re) => { while (i < input.length && re.test(input[i])) i += 1; };
  const lit = (text) => {
    if (!input.startsWith(text, i)) return false;
    i += text.length;
    return true;
  };
  const sticky = (re) => {
    re.lastIndex = i;
    const m = re.exec(input);
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const dottedPath = () => {
    if (sticky(IDENT_RE) === null) return false;
    while (lit(".")) if (sticky(IDENT_RE) === null) return false;
    return true;
  };
  // `tools.exec_command({...})` at i (after any `await`): pushes its cmd.
  const execCall = () => {
    if (!lit("tools.exec_command(")) return false;
    skip(/\s/);
    if (!lit("{")) return false;
    let cmd = null;
    for (;;) {
      skip(/\s/);
      if (lit("}")) break;
      let key = null;
      const quotedKey = readStringLiteral(input, i);
      if (quotedKey && input[i] !== "`") {
        key = quotedKey.value;
        i = quotedKey.end;
      } else key = sticky(IDENT_RE);
      if (key === null) return false;
      skip(/\s/);
      if (!lit(":")) return false;
      skip(/\s/);
      const str = readStringLiteral(input, i);
      if (str) {
        if (key === "cmd") cmd = str.value;
        i = str.end;
      } else if (key === "cmd" || sticky(SCALAR_RE) === null) {
        return false;
      }
      skip(/\s/);
      if (!lit(",") && input[i] !== "}") return false;
    }
    skip(/\s/);
    if (cmd === null || !lit(")")) return false;
    cmds.push(cmd);
    return true;
  };
  const term = () => {
    if (lit("await ")) {
      skip(/\s/);
      return execCall();
    }
    if (lit("JSON.stringify(")) {
      skip(/\s/);
      if (!dottedPath()) return false;
      skip(/\s/);
      if (lit(",")) {
        skip(/\s/);
        if (!lit("null")) return false;
        skip(/\s/);
        if (!lit(",")) return false;
        skip(/\s/);
        if (sticky(/\d+/y) === null) return false;
        skip(/\s/);
      }
      return lit(")");
    }
    const str = readStringLiteral(input, i);
    if (str) {
      i = str.end;
      return true;
    }
    return dottedPath();
  };
  // text(<out>) / console.log(<out>): the argument is one or more terms joined by +.
  const output = () => {
    skip(/\s/);
    if (!term()) return false;
    skip(/\s/);
    while (lit("+")) {
      skip(/\s/);
      if (!term()) return false;
      skip(/\s/);
    }
    return lit(")");
  };

  skip(/[\s;]/);
  while (i < input.length) {
    if (lit("return ")) {
      skip(/\s/);
      if (!dottedPath()) return null;
    } else if (lit("console.log(") || lit("text(")) {
      if (!output()) return null;
    } else {
      const save = i;
      const decl = sticky(IDENT_RE);
      if (decl === "const" || decl === "let" || decl === "var") {
        skip(/\s/);
        if (sticky(IDENT_RE) === null) return null;
        skip(/\s/);
        if (!lit("=")) return null;
        skip(/\s/);
      } else i = save;
      if (lit("await")) skip(/\s/);
      if (!execCall()) return null;
    }
    skip(/[\s;]/);
  }
  return cmds.length > 0 ? cmds : null;
}

/**
 * The shell command strings a call payload runs, or null when they cannot
 * be read: `custom_tool_call` `exec` (see execInputCommands), or an older
 * `function_call` named in SHELL_FUNCTION_NAMES whose JSON `arguments` carry
 * `cmd`/`command` as a string or an argv array (a bash `-lc` or PowerShell
 * `-Command` wrapper is unwrapped by unwrapShellArgv).
 */
export function codexPayloadCommands(payload) {
  if (payload?.type === "custom_tool_call" && payload.name === "exec") return execInputCommands(payload.input);
  if (payload?.type !== "function_call" || !SHELL_FUNCTION_NAMES.has(payload.name)) return null;
  let args;
  try {
    args = typeof payload.arguments === "string" ? JSON.parse(payload.arguments) : payload.arguments;
  } catch {
    return null;
  }
  const raw = args?.cmd ?? args?.command;
  const cmd = typeof raw === "string" ? raw : unwrapShellArgv(raw);
  return typeof cmd === "string" ? [cmd] : null;
}

/** Whether every shell command a call payload runs is a pure state read. */
export function isStateReadCodexPayload(payload) {
  const cmds = codexPayloadCommands(payload);
  return cmds !== null && cmds.every(isStateReadCommand);
}

/** SHA-256 of a buffer, hex-encoded. */
function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Whether a rollout's own (first) session_meta record marks it as a
 * sub-agent thread. See header comment for the forked_from_id caveat this
 * deliberately does NOT rely on.
 */
export function isSubagentMeta(meta) {
  if (!meta) return false;
  if (meta.thread_source === "subagent") return true;
  const { source } = meta;
  // The pre-thread_source shape verified in real rollouts is an OBJECT
  // carrying a `subagent` key (e.g. `{ subagent: { thread_spawn: {} } }`).
  // Any other object shape -- an array, or a plain object without that key
  // -- is not that documented shape and must not be misclassified as a
  // sub-agent.
  return (
    typeof source === "object"
    && source !== null
    && !Array.isArray(source)
    && Object.prototype.hasOwnProperty.call(source, "subagent")
  );
}

/**
 * Whether this rollout is a gentle-ai reviewer subprocess: its cwd is a Temp
 * `gentle-ai-codex-reviewer-<pid>` directory AND one of its first few
 * user-role messages starts with the GENTLE_AI_REVIEW_BINDING marker.
 */
export function isReviewerSubprocess(cwd, earlyUserTexts) {
  if (typeof cwd !== "string" || !REVIEWER_CWD_RE.test(cwd)) return false;
  return earlyUserTexts.some((t) => typeof t === "string" && t.trimStart().startsWith("GENTLE_AI_REVIEW_BINDING"));
}

function newStreak(startIndex) {
  return { startIndex, calls: 0, edits: 0, editFiles: new Set(), crossedAt: {}, closedBy: null };
}

function finishStreak(s) {
  return {
    startIndex: s.startIndex,
    calls: s.calls,
    edits: s.edits,
    distinctEditFiles: s.editFiles.size,
    crossedAt: s.crossedAt,
    closedBy: s.closedBy,
  };
}

/**
 * Recursively collect every *.jsonl file under `root` (Codex stores rollouts
 * under YYYY/MM/DD/, unlike the flat directory odd-trace.mjs reads).
 */
function collectJsonlFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && p.toLowerCase().endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * Analyze one rollout from its already-read buffer (the same bytes used for
 * the SHA-256 in `corpus`, per the OCM-4 review finding that a transcript
 * must not be read twice for hashing vs. analysis).
 */
export function analyzeRollout(file, buffer) {
  const text = buffer.toString("utf8");
  const lines = text.split("\n").filter(Boolean);

  let meta = null;
  let firstTs = null;
  let lastTs = null;
  // Track the epoch-ms value alongside the raw string so min/max are chosen
  // by actual time, not by lexicographic string order (which only agrees
  // with chronological order when every timestamp shares the same format)
  // and not by line order. An unparseable `timestamp` field (Date.parse
  // returns NaN) is ignored entirely here, never adopted as firstTs/lastTs:
  // a rollout whose only timestamp(s) are unparseable ends up with
  // firstTs === null, which the exclusion logic below reports as "start
  // time unknown" rather than failing open and counting it as valid.
  let firstTsAt = Infinity;
  let lastTsAt = -Infinity;
  const events = [];
  const earlyUserTexts = [];

  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.timestamp) {
      const at = Date.parse(o.timestamp);
      if (!Number.isNaN(at)) {
        if (at < firstTsAt) { firstTsAt = at; firstTs = o.timestamp; }
        if (at > lastTsAt) { lastTsAt = at; lastTs = o.timestamp; }
      }
    }
    if (o.type === "session_meta" && !meta) {
      meta = o.payload;
      continue;
    }
    if (o.type !== "response_item" || !o.payload) continue;
    const { payload } = o;

    if (
      payload.type === "message"
      && payload.role === "user"
      && earlyUserTexts.length < MAX_USER_MESSAGES_CHECKED_FOR_REVIEW_BINDING
      && Array.isArray(payload.content)
    ) {
      earlyUserTexts.push(payload.content.map((c) => c.text ?? "").join(""));
    }

    if (!CALL_PAYLOAD_TYPES.has(payload.type)) continue;
    const editedFiles = payload.name === "exec" ? extractPatchedFiles(payload.input) : new Set();
    events.push({ name: payload.name, editedFiles, stateRead: isStateReadCodexPayload(payload) });
  }

  const streaks = [];
  let s = newStreak(0);
  events.forEach((e, i) => {
    if (e.name === DELEGATION_NAME) {
      s.closedBy = { index: i, name: e.name };
      streaks.push(finishStreak(s));
      s = newStreak(i + 1);
      return;
    }
    s.calls += 1;
    if (e.editedFiles.size > 0) {
      s.edits += 1;
      for (const f of e.editedFiles) s.editFiles.add(f);
    }
    if (s.calls >= THRESHOLD.calls && s.crossedAt.calls === undefined) s.crossedAt.calls = i;
    if (s.edits >= THRESHOLD.edits && s.crossedAt.edits === undefined) s.crossedAt.edits = i;
    if (s.editFiles.size >= THRESHOLD.writerFiles && s.crossedAt.writerFiles === undefined)
      s.crossedAt.writerFiles = i;
  });
  if (s.calls > 0) streaks.push(finishStreak(s));

  const delegations = events.filter((e) => e.name === DELEGATION_NAME).length;
  const count = (key) => streaks.filter((x) => x.crossedAt[key] !== undefined).length;
  const maxStreakCalls = streaks.reduce((m, x) => Math.max(m, x.calls), 0);
  const nonEmptyStreaks = streaks.filter((x) => x.calls > 0).length;
  const emptyStreaks = streaks.length - nonEmptyStreaks;
  const touchedOddTasks = events.some((e) => [...e.editedFiles].some((f) => ODD_TASKS_RE.test(f)));
  const editCallsObserved = events.filter((e) => e.editedFiles.size > 0).length;
  const streakDetailExcludingStateReads = callStreaksExcludingStateReads(events, {
    isDelegation: (e) => e.name === DELEGATION_NAME,
    threshold: THRESHOLD.calls,
  });

  return {
    file: file.split(/[\\/]/).pop(),
    sessionId: meta?.id ?? meta?.session_id ?? null,
    forkedFromId: meta?.forked_from_id ?? null,
    threadSource: meta?.thread_source ?? null,
    cwd: meta?.cwd ?? null,
    originator: meta?.originator ?? null,
    cliVersion: meta?.cli_version ?? null,
    firstTs,
    lastTs,
    toolCalls: events.length,
    delegations,
    streaks: nonEmptyStreaks,
    emptyStreaks,
    maxStreakCalls,
    crossings: { calls20: count("calls"), edits2: count("edits"), writer2Files: count("writerFiles") },
    touchedOddTasks,
    editCallsObserved,
    ...excludingStateReadsSummary(events, streakDetailExcludingStateReads),
    // Internal, used only for exclusion decisions; stripped before reporting.
    _isSubagent: isSubagentMeta(meta),
    _isReviewerSubprocess: isReviewerSubprocess(meta?.cwd ?? null, earlyUserTexts),
    streakDetail: streaks,
    // Not emitted per session; feeds backstopFollowThroughExcludingStateReads.
    streakDetailExcludingStateReads,
  };
}

export const summarizeCodex = (list) => ({
  sessions: list.length,
  toolCalls: list.reduce((n, x) => n + x.toolCalls, 0),
  delegations: list.reduce((n, x) => n + x.delegations, 0),
  sessionsWithZeroDelegation: list.filter((x) => x.delegations === 0).length,
  sessionsCrossingCalls20: list.filter((x) => x.crossings.calls20 > 0).length,
  sessionsCrossingEdits2: list.filter((x) => x.crossings.edits2 > 0).length,
  sessionsCrossingWriter2: list.filter((x) => x.crossings.writer2Files > 0).length,
  streaksTotal: list.reduce((n, x) => n + x.streaks, 0),
  emptyStreaksTotal: list.reduce((n, x) => n + x.emptyStreaks, 0),
  streaksCrossingCalls20: list.reduce((n, x) => n + x.crossings.calls20, 0),
  streaksCrossingEdits2: list.reduce((n, x) => n + x.crossings.edits2, 0),
  sessionsTouchingOddTasks: list.filter((x) => x.touchedOddTasks).length,
  editCallsObservedTotal: list.reduce((n, x) => n + x.editCallsObserved, 0),
});

export const USAGE = "usage: node odd-trace-codex.mjs <sessions-dir> [--valid-from <iso>] [--cwd-prefix <path>]";

function takeFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return { value: undefined, present: false };
  const value = idx + 1 < args.length ? args[idx + 1] : "";
  args.splice(idx, idx + 1 < args.length ? 2 : 1);
  return { value, present: true };
}

export function parseArgs(argv) {
  const args = [...argv];
  const { value: validFrom, present: hasValidFrom } = takeFlagValue(args, "--valid-from");
  const { value: cwdPrefix, present: hasCwdPrefix } = takeFlagValue(args, "--cwd-prefix");
  const [dir] = args;
  return {
    dir,
    validFrom: hasValidFrom ? validFrom : undefined,
    cwdPrefix: hasCwdPrefix ? cwdPrefix : undefined,
  };
}

function normalizeForPrefixMatch(p) {
  return p.toLowerCase().replace(/\//g, "\\").replace(/\\+$/, "");
}

/**
 * Whether `cwd` is the `prefixNormalized` directory itself or a path under
 * it. Plain `startsWith` would also match a sibling directory that merely
 * shares the same leading characters (`C:\A\projects` matching
 * `C:\A\projectsX`); requiring the match to land exactly at the prefix or
 * continue with a path separator rules that out. `prefixNormalized` is
 * already lowercased with `/` folded to `\` and trailing separators
 * stripped (see `normalizeForPrefixMatch`), so only `cwd` needs normalizing
 * here.
 */
function cwdMatchesPrefix(cwd, prefixNormalized) {
  if (typeof cwd !== "string") return false;
  const cwdNormalized = normalizeForPrefixMatch(cwd);
  return cwdNormalized === prefixNormalized || cwdNormalized.startsWith(`${prefixNormalized}\\`);
}

/**
 * Build the full Codex report for every rollout under `dir`. Pure aside from
 * the filesystem reads themselves, so tests can point it at small synthetic
 * fixtures. Mirrors odd-trace.mjs's `buildReport` contract: an invalid
 * `--valid-from` throws rather than running uncut; every excluded session is
 * listed with its reason, never silently dropped.
 */
export function buildCodexReport(dir, { validFromIso, cwdPrefix } = {}) {
  let validFromAt = NaN;
  let validFromNormalized = null;
  if (validFromIso !== undefined) {
    validFromAt = Date.parse(validFromIso);
    if (Number.isNaN(validFromAt)) {
      throw new Error(
        `odd-trace-codex: --valid-from value ${JSON.stringify(validFromIso)} is not a valid ISO 8601 timestamp`,
      );
    }
    validFromNormalized = new Date(validFromAt).toISOString();
  }
  const cwdPrefixNormalized = cwdPrefix !== undefined ? normalizeForPrefixMatch(cwdPrefix) : null;

  const files = collectJsonlFiles(dir);
  const corpus = [];
  const analyzedAll = [];
  for (const f of files) {
    const buf = readFileSync(f);
    const relFile = f.split(/[\\/]/).slice(-4).join("/"); // YYYY/MM/DD/rollout-....jsonl
    const analyzed = analyzeRollout(f, buf);
    analyzed.file = relFile;
    corpus.push({ file: relFile, bytes: buf.length, sha256: sha256Buffer(buf) });
    analyzedAll.push(analyzed);
  }
  analyzedAll.sort((a, b) => (a.firstTs ?? "").localeCompare(b.firstTs ?? ""));

  // Classification order matters: sub-agent and reviewer-subprocess status is
  // decided first, from session_meta/cwd/early messages alone, REGARDLESS of
  // whether the rollout ever called a tool. Checking `toolCalls > 0` first
  // would misfile a reviewer subprocess that only reads its binding and
  // replies with a verdict (never calling exec) as a generic "no observable
  // tool call" exclusion, hiding what it actually was -- verified against
  // real data: most gentle-ai reviewer subprocesses never call a tool.
  const excluded = [];
  const validSessions = [];
  const corpusStatus = new Map(corpus.map((c) => [c.file, "excluded"])); // flipped to "valid" below

  for (const x of analyzedAll) {
    const { _isSubagent, _isReviewerSubprocess, ...rest } = x;
    const base = { file: x.file, sessionId: x.sessionId, firstTs: x.firstTs, cwd: x.cwd };

    if (_isSubagent) {
      excluded.push({
        ...base,
        reason: `sub-agent/forked rollout: thread_source=${JSON.stringify(x.threadSource)}`
          + (x.forkedFromId ? `, forked_from_id=${x.forkedFromId}` : ""),
      });
      continue;
    }
    if (_isReviewerSubprocess) {
      excluded.push({
        ...base,
        reason: "gentle-ai reviewer subprocess: cwd under Temp gentle-ai-codex-reviewer-*"
          + " and an early user message starts with GENTLE_AI_REVIEW_BINDING",
      });
      continue;
    }
    if (x.toolCalls === 0) {
      excluded.push({ ...base, reason: "no observable tool call (custom_tool_call/function_call) in this rollout" });
      continue;
    }
    if (x.firstTs === null) {
      excluded.push({ ...base, reason: "start time unknown: no event in this rollout carried a timestamp" });
      continue;
    }
    if (validFromNormalized !== null && Date.parse(x.firstTs) < validFromAt) {
      excluded.push({ ...base, reason: `started before valid-from ${validFromNormalized}` });
      continue;
    }
    if (cwdPrefixNormalized !== null && !cwdMatchesPrefix(x.cwd, cwdPrefixNormalized)) {
      excluded.push({ ...base, reason: `cwd does not match --cwd-prefix ${cwdPrefix}: ${x.cwd ?? "(unknown)"}` });
      continue;
    }
    validSessions.push(rest);
    corpusStatus.set(x.file, "valid");
  }

  const corpusFinal = corpus
    .map((c) => ({ ...c, status: corpusStatus.get(c.file) }))
    .sort((a, b) => a.file.localeCompare(b.file));

  return {
    generatedAt: new Date().toISOString(),
    sessionsRoot: dir.split(/[\\/]/).filter(Boolean).slice(-1)[0],
    validFrom: validFromNormalized,
    cwdPrefix: cwdPrefix ?? null,
    delegationName: DELEGATION_NAME,
    continuationNames: [...CONTINUATION_NAMES],
    callPayloadTypes: [...CALL_PAYLOAD_TYPES],
    thresholds: { calls: THRESHOLD.calls, edits: THRESHOLD.edits, writerFiles: THRESHOLD.writerFiles },
    notObservable: {
      reads: "reads are not distinguishable from other shell/JS work inside the single `exec` custom_tool_call; never guessed",
      mapping4Files: "depends on distinct read files, which are not observable (see reads)",
    },
    totals: summarizeCodex(validSessions),
    backstopFollowThrough: backstopFollowThrough(validSessions.flatMap((x) => x.streakDetail)),
    // Additive view (OTS-1): the 20-call backstop with read-only state
    // commands left out of the count; every field above is unchanged.
    stateReadClassifier: {
      ...STATE_READ_CLASSIFIER,
      codexPayloads: "custom_tool_call exec whose JS source is only [const x =] [await] tools.exec_command({cmd: <string literal>, ...})"
        + " statements, text(...)/console.log(...) of + joined terms (await tools.exec_command({...}), a variable path,"
        + " a string literal without ${, JSON.stringify(<path>[, null, <n>])) and return <path>, where every embedded"
        + " command must be a state read; or function_call "
        + `${[...SHELL_FUNCTION_NAMES].join("/")} with a cmd/command string or argv array;`
        + " any other payload is not a state read",
    },
    stateReadTotals: stateReadTotals(validSessions),
    backstopFollowThroughExcludingStateReads: backstopFollowThrough(
      validSessions.flatMap((x) => x.streakDetailExcludingStateReads),
    ),
    excluded,
    corpus: corpusFinal,
    sessions: validSessions.map(({ streakDetail, streakDetailExcludingStateReads, ...rest }) => rest),
    streakDetail: Object.fromEntries(validSessions.map((x) => [x.file, x.streakDetail])),
  };
}

// -- process boundary -------------------------------------------------------------

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();

if (invokedDirectly) {
  const { dir, validFrom, cwdPrefix } = parseArgs(process.argv.slice(2));

  if (!dir) {
    console.error(USAGE);
    process.exit(2);
  }
  if (validFrom !== undefined && Number.isNaN(Date.parse(validFrom))) {
    console.error(USAGE);
    console.error(`odd-trace-codex: --valid-from value ${JSON.stringify(validFrom)} is not a valid ISO 8601 timestamp`);
    process.exit(2);
  }

  console.log(JSON.stringify(buildCodexReport(dir, { validFromIso: validFrom, cwdPrefix }), null, 2));
}
