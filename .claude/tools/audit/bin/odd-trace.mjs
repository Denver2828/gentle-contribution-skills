#!/usr/bin/env node
// Deterministic ODD trace audit over Claude Code transcripts. Reads every
// main-thread JSONL transcript in a project directory, rebuilds the ordered
// tool_use sequence, and measures the ODD delegation triggers as observable
// events. No model is involved; this costs zero tokens.
//
// Usage: node odd-trace.mjs <transcript-dir> [rule-installed-iso] [--valid-from <iso>]
//
// `rule-installed-iso` splits sessions into beforeRule/afterRule by whether
// they started at or after that instant (whole-corpus view).
//
// `--valid-from <iso>` is a stricter, independent cutoff: a session whose
// first timestamp is before it is reported under `excluded` (with its
// sessionId, firstTs and reason) and is removed from `totals`, `beforeRule`,
// `afterRule` and `streakDetail` entirely -- it never counts anywhere except
// in `excluded`. Without the flag, behavior is unchanged for timestamped
// sessions: `excluded` holds no valid-from exclusions and every session that
// has any tool call is counted as before.
//
// A session with tool calls but no timestamped event has an unknown start
// time. It is always reported under `excluded` with a distinct reason
// ("start time unknown"), regardless of --valid-from: unknown never counts as
// early and never lands in beforeRule/afterRule.
//
// An invalid --valid-from value throws (API) or exits non-zero with the
// usage message (CLI); it is never silently ignored.
//
// The report also carries `corpus` (every analyzed transcript's file name,
// byte size and SHA-256, valid and excluded) for freeze-and-reproduce, and
// `backstopFollowThrough` (crossed/followed/ranToEnd counts and
// extraCallsPastThreshold over the valid corpus's streaks).
//
// Additive (OTS-1): `stateReadClassifier`, `stateReadTotals`,
// `backstopFollowThroughExcludingStateReads` and, per session, `stateReads`
// and `excludingStateReads` report the same 20-call backstop with read-only
// state commands (lib/odd-state-reads.mjs) left out of the count. Every
// original field is unchanged.
//
// Trigger definitions (from routing.go v3.2.1+ prose):
//   backstop: ~20 tool calls, 5 exploratory reads, or 2 non-mechanical edits
//             without any delegation
//   mapping:  understanding needs 4+ files -> delegate one mapper
//   writer:   implementation touches 2+ non-trivial files -> delegate one writer
// "non-mechanical" and "non-trivial" are not observable from a transcript, so
// edit-based counts are reported as candidates, never as violations.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  STATE_READ_CLASSIFIER,
  callStreaksExcludingStateReads,
  excludingStateReadsSummary,
  isStateReadCommand,
  stateReadTotals,
} from "../lib/odd-state-reads.mjs";

export const DELEGATION = new Set(["Agent", "Task"]);
export const READ = new Set(["Read", "Grep", "Glob", "mcp__codegraph__codegraph_explore"]);
export const EDIT = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export const THRESHOLD = { calls: 20, reads: 5, edits: 2, mappingFiles: 4, writerFiles: 2 };

function newStreak(startIndex) {
  return {
    startIndex,
    calls: 0,
    reads: 0,
    edits: 0,
    bash: 0,
    readFiles: new Set(),
    editFiles: new Set(),
    crossedAt: {},
    closedBy: null,
  };
}

function finishStreak(s) {
  return {
    startIndex: s.startIndex,
    calls: s.calls,
    reads: s.reads,
    edits: s.edits,
    bash: s.bash,
    distinctReadFiles: s.readFiles.size,
    distinctEditFiles: s.editFiles.size,
    crossedAt: s.crossedAt,
    closedBy: s.closedBy,
  };
}

/** SHA-256 of a buffer, hex-encoded. Used for corpus-freeze reproducibility. */
function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Backstop follow-through over a flat list of streak-detail entries (as
 * stored in `streakDetail`): among streaks that crossed the 20-call
 * threshold, how many were eventually closed by a delegation and how many
 * ran to the end of the session with none. `extraCallsPastThreshold` counts
 * only the non-delegating calls made after the crossing and before the
 * delegation -- `closedBy.index - crossedAt.calls` also counts the
 * delegating call itself (index `i` where the `Agent`/`Task` event sits),
 * so it is off by one; subtracting 1 corrects it. A streak that never
 * delegates (`closedBy: null`) contributes no entry, since there is no
 * bounded "extra calls before delegating" to measure for it.
 */
export function backstopFollowThrough(streakDetails) {
  const crossed = streakDetails.filter((s) => s.crossedAt.calls !== undefined);
  const followed = crossed.filter((s) => s.closedBy !== null);
  const ranToEnd = crossed.filter((s) => s.closedBy === null);
  const extraCallsPastThreshold = followed
    .map((s) => s.closedBy.index - s.crossedAt.calls - 1)
    .sort((a, b) => a - b);
  return {
    crossed: crossed.length,
    followed: followed.length,
    ranToEnd: ranToEnd.length,
    extraCallsPastThreshold,
  };
}

/**
 * Rebuild one session's ordered tool_use sequence and measure the delegation
 * triggers over it, from its already-read buffer (the same bytes used for
 * the SHA-256 in `corpus`, so a transcript still being appended cannot get a
 * hash that describes different bytes than the ones analyzed here -- see
 * odd-trace-codex.mjs's `analyzeRollout`, which this mirrors).
 * `ruleInstalledAt` is a parsed epoch ms value (or NaN when no whole-corpus
 * cutoff was supplied); it is a parameter rather than a closure so this
 * function stays pure and independently testable.
 */
export function analyzeSession(file, buffer, ruleInstalledAt) {
  const lines = buffer.toString("utf8").split("\n").filter(Boolean);
  const events = [];
  let sessionId = null;
  let version = null;
  const branches = new Set();
  let firstTs = null;
  let lastTs = null;
  let userPrompts = 0;
  let touchedOddTasks = false;

  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain) continue;
    if (o.sessionId && !sessionId) sessionId = o.sessionId;
    if (o.version && !version) version = o.version;
    if (o.gitBranch) branches.add(o.gitBranch);
    if (o.timestamp) {
      if (!firstTs || o.timestamp < firstTs) firstTs = o.timestamp;
      if (!lastTs || o.timestamp > lastTs) lastTs = o.timestamp;
    }
    if (o.type === "user" && typeof o.message?.content === "string") userPrompts += 1;
    if (o.type !== "assistant" || !Array.isArray(o.message?.content)) continue;
    for (const c of o.message.content) {
      if (c.type !== "tool_use") continue;
      const input = c.input ?? {};
      const path = input.file_path ?? input.path ?? null;
      // Feature-document signal: an Edit/Write whose target path is under
      // odd/tasks. Content mentions of "odd/tasks" do not count (they occur in
      // documentation sessions that never create a feature document).
      if (EDIT.has(c.name) && typeof path === "string" && /odd[\\/]tasks[\\/]/.test(path))
        touchedOddTasks = true;
      // State read: a Bash call whose command is a pure read-only state verb
      // (lib/odd-state-reads.mjs). Only the additive excluding-state view uses
      // it; every original count below still counts the call.
      const stateRead = c.name === "Bash" && isStateReadCommand(input.command);
      events.push({ ts: o.timestamp, name: c.name, path, stateRead });
    }
  }

  const streaks = [];
  let s = newStreak(0);
  events.forEach((e, i) => {
    if (DELEGATION.has(e.name)) {
      s.closedBy = { index: i, name: e.name };
      streaks.push(finishStreak(s));
      s = newStreak(i + 1);
      return;
    }
    s.calls += 1;
    if (e.name === "Bash") s.bash += 1;
    if (READ.has(e.name)) {
      s.reads += 1;
      if (e.path) s.readFiles.add(e.path);
    }
    if (EDIT.has(e.name)) {
      s.edits += 1;
      if (e.path) s.editFiles.add(e.path);
    }
    if (s.calls >= THRESHOLD.calls && s.crossedAt.calls === undefined) s.crossedAt.calls = i;
    if (s.reads >= THRESHOLD.reads && s.crossedAt.reads === undefined) s.crossedAt.reads = i;
    if (s.edits >= THRESHOLD.edits && s.crossedAt.edits === undefined) s.crossedAt.edits = i;
    if (s.readFiles.size >= THRESHOLD.mappingFiles && s.crossedAt.mappingFiles === undefined)
      s.crossedAt.mappingFiles = i;
    if (s.editFiles.size >= THRESHOLD.writerFiles && s.crossedAt.writerFiles === undefined)
      s.crossedAt.writerFiles = i;
  });
  if (s.calls > 0) streaks.push(finishStreak(s));

  const delegations = events.filter((e) => DELEGATION.has(e.name)).length;
  const count = (key) => streaks.filter((x) => x.crossedAt[key] !== undefined).length;
  const maxCalls = streaks.reduce((m, x) => Math.max(m, x.calls), 0);
  // A streak with zero calls is a delegation immediately followed by another
  // delegation (or session start/end with no calls in between); it can never
  // cross any threshold and inflates streak-based denominators if counted.
  const nonEmptyStreaks = streaks.filter((x) => x.calls > 0).length;
  const emptyStreaks = streaks.length - nonEmptyStreaks;
  const streakDetailExcludingStateReads = callStreaksExcludingStateReads(events, {
    isDelegation: (e) => DELEGATION.has(e.name),
    threshold: THRESHOLD.calls,
  });

  return {
    file: file.split(/[\\/]/).pop(),
    sessionId,
    version,
    branches: [...branches],
    firstTs,
    lastTs,
    // firstTs is null when no event in the session carried a `timestamp`.
    // `Date.parse(null ?? 0)` does not fail loudly: V8 parses the coerced
    // string "0" as a valid (very early, year-2000-ish) date, which used to
    // silently misclassify an unknown start time as "before" any real
    // cutoff. Unknown must stay null, never an early date.
    ruleInstalled:
      Number.isNaN(ruleInstalledAt) || firstTs === null
        ? null
        : Date.parse(firstTs) >= ruleInstalledAt,
    userPrompts,
    toolCalls: events.length,
    delegations,
    streaks: nonEmptyStreaks,
    emptyStreaks,
    maxStreakCalls: maxCalls,
    crossings: {
      calls20: count("calls"),
      reads5: count("reads"),
      edits2: count("edits"),
      mapping4Files: count("mappingFiles"),
      writer2Files: count("writerFiles"),
    },
    touchedOddTasks,
    ...excludingStateReadsSummary(events, streakDetailExcludingStateReads),
    streakDetail: streaks,
    // Not emitted per session in the report (see buildReport); feeds
    // backstopFollowThroughExcludingStateReads.
    streakDetailExcludingStateReads,
  };
}

export const summarize = (list) => ({
  sessions: list.length,
  toolCalls: list.reduce((n, x) => n + x.toolCalls, 0),
  delegations: list.reduce((n, x) => n + x.delegations, 0),
  sessionsWithZeroDelegation: list.filter((x) => x.delegations === 0).length,
  sessionsCrossingCalls20: list.filter((x) => x.crossings.calls20 > 0).length,
  sessionsCrossingReads5: list.filter((x) => x.crossings.reads5 > 0).length,
  sessionsCrossingEdits2: list.filter((x) => x.crossings.edits2 > 0).length,
  sessionsCrossingMapping4: list.filter((x) => x.crossings.mapping4Files > 0).length,
  sessionsCrossingWriter2: list.filter((x) => x.crossings.writer2Files > 0).length,
  streaksTotal: list.reduce((n, x) => n + x.streaks, 0),
  emptyStreaksTotal: list.reduce((n, x) => n + x.emptyStreaks, 0),
  streaksCrossingCalls20: list.reduce((n, x) => n + x.crossings.calls20, 0),
  streaksCrossingReads5: list.reduce((n, x) => n + x.crossings.reads5, 0),
  streaksCrossingEdits2: list.reduce((n, x) => n + x.crossings.edits2, 0),
  sessionsTouchingOddTasks: list.filter((x) => x.touchedOddTasks).length,
});

export const USAGE = "usage: node odd-trace.mjs <transcript-dir> [rule-installed-iso] [--valid-from <iso>]";

/**
 * Split argv into the two existing positionals plus the new `--valid-from`
 * flag, wherever it appears. The positionals keep working exactly as before
 * when the flag is absent.
 */
export function parseArgs(argv) {
  const args = [...argv];
  const flagIndex = args.indexOf("--valid-from");
  let validFrom;
  if (flagIndex !== -1) {
    validFrom = flagIndex + 1 < args.length ? args[flagIndex + 1] : "";
    args.splice(flagIndex, flagIndex + 1 < args.length ? 2 : 1);
  }
  const [dir, ruleInstalledIso] = args;
  return { dir, ruleInstalledIso, validFrom };
}

/**
 * Build the full report for `dir`. Pure aside from the filesystem read of the
 * transcripts themselves, so tests can point it at small synthetic fixtures
 * instead of spawning a process.
 */
export function buildReport(dir, { ruleInstalledIso, validFromIso } = {}) {
  const ruleInstalledAt = ruleInstalledIso ? Date.parse(ruleInstalledIso) : NaN;

  // An invalid --valid-from must fail loudly, never run uncut. The CLI
  // boundary below already rejects it before calling in, but buildReport is
  // also a public API (tests, other scripts) and must not silently ignore a
  // malformed cutoff. `null` means the same thing as `undefined` here --
  // "no cutoff was supplied" -- since a JSON-round-tripped caller (or one
  // that reads an optional field from a config object) has no clean way to
  // omit a key versus setting it to `null`; an empty string or any other
  // non-empty non-ISO string still throws, matching the CLI's usage error
  // for a bare `--valid-from` flag with no value.
  let validFromAt = NaN;
  let validFromNormalized = null;
  if (validFromIso !== undefined && validFromIso !== null) {
    validFromAt = Date.parse(validFromIso);
    if (Number.isNaN(validFromAt)) {
      throw new Error(
        `odd-trace: --valid-from value ${JSON.stringify(validFromIso)} is not a valid ISO 8601 timestamp`,
      );
    }
    validFromNormalized = new Date(validFromAt).toISOString();
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());

  // Read each transcript exactly once: the same buffer feeds both the
  // analysis below and the corpus byte-size/SHA-256 further down, so a
  // transcript still being appended to cannot get a hash that describes
  // different bytes than the ones actually analyzed.
  const buffers = new Map(files.map((f) => [f, readFileSync(f)]));

  const sessions = files
    .map((f) => analyzeSession(f, buffers.get(f), ruleInstalledAt))
    .filter((x) => x.toolCalls > 0);
  sessions.sort((a, b) => (a.firstTs ?? "").localeCompare(b.firstTs ?? ""));

  // A session counts under the version/instant it STARTED with: the cutoff
  // compares firstTs only, so a session that straddles the cutoff (starts
  // before it, keeps running after it) is excluded in full, never split.
  //
  // A session with tool calls but no timestamped event (firstTs === null)
  // has an unknown start time. It must never be treated as "early" (see the
  // ruleInstalled comment in analyzeSession) and must never be silently
  // counted in beforeRule/afterRule: it is always excluded here, with a
  // distinct reason, independent of whether --valid-from was even given.
  const excluded = [];
  const validSessions = [];
  const corpus = [];
  for (const x of sessions) {
    const filePath = join(dir, x.file);
    const buf = buffers.get(filePath);
    const corpusEntry = { file: x.file, bytes: buf.length, sha256: sha256Buffer(buf) };

    if (x.firstTs === null) {
      excluded.push({
        sessionId: x.sessionId,
        firstTs: x.firstTs,
        reason: "start time unknown: no event in this session carried a timestamp",
      });
      corpus.push({ ...corpusEntry, status: "excluded" });
      continue;
    }
    if (validFromNormalized !== null && Date.parse(x.firstTs) < validFromAt) {
      excluded.push({
        sessionId: x.sessionId,
        firstTs: x.firstTs,
        reason: `started before valid-from ${validFromNormalized}`,
      });
      corpus.push({ ...corpusEntry, status: "excluded" });
    } else {
      validSessions.push(x);
      corpus.push({ ...corpusEntry, status: "valid" });
    }
  }
  corpus.sort((a, b) => a.file.localeCompare(b.file));

  const before = validSessions.filter((x) => x.ruleInstalled === false);
  const after = validSessions.filter((x) => x.ruleInstalled === true);
  const backstopFollowThroughValid = backstopFollowThrough(
    validSessions.flatMap((x) => x.streakDetail),
  );

  return {
    generatedAt: new Date().toISOString(),
    transcriptDir: dir.split(/[\\/]/).slice(-1)[0],
    ruleInstalledAt: Number.isNaN(ruleInstalledAt) ? null : new Date(ruleInstalledAt).toISOString(),
    validFrom: validFromNormalized,
    thresholds: THRESHOLD,
    readTools: [...READ],
    editTools: [...EDIT],
    delegationTools: [...DELEGATION],
    totals: summarize(validSessions),
    beforeRule: summarize(before),
    afterRule: summarize(after),
    // Backstop follow-through over the valid corpus only, matching the scope
    // of `totals`/`sessions`/`streakDetail` below (see backstopFollowThrough
    // doc comment for the off-by-one it corrects).
    backstopFollowThrough: backstopFollowThroughValid,
    // Additive view (OTS-1): the same 20-call backstop with read-only state
    // commands left out of the count (they never close a streak either).
    // Every field above keeps its original meaning and value.
    stateReadClassifier: STATE_READ_CLASSIFIER,
    stateReadTotals: stateReadTotals(validSessions),
    backstopFollowThroughExcludingStateReads: backstopFollowThrough(
      validSessions.flatMap((x) => x.streakDetailExcludingStateReads),
    ),
    excluded,
    // Freeze-and-reproduce evidence: every analyzed transcript file (valid or
    // excluded), its byte size and its SHA-256, so a later run can verify it
    // is reading byte-identical input.
    corpus,
    sessions: validSessions.map(({ streakDetail, streakDetailExcludingStateReads, ...rest }) => rest),
    streakDetail: Object.fromEntries(validSessions.map((x) => [x.file, x.streakDetail])),
  };
}

// -- process boundary -------------------------------------------------------------

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();

if (invokedDirectly) {
  const { dir, ruleInstalledIso, validFrom } = parseArgs(process.argv.slice(2));

  if (!dir) {
    console.error(USAGE);
    process.exit(2);
  }
  if (validFrom !== undefined && Number.isNaN(Date.parse(validFrom))) {
    console.error(USAGE);
    console.error(`odd-trace: --valid-from value ${JSON.stringify(validFrom)} is not a valid ISO 8601 timestamp`);
    process.exit(2);
  }

  console.log(JSON.stringify(buildReport(dir, { ruleInstalledIso, validFromIso: validFrom }), null, 2));
}
