// The acceptance trace of a decision package: for every acceptance condition,
// claim -> pertinent check -> result -> limit.
//
// This module only projects what a durable auditor result already holds. It
// assesses nothing, and it never fills a gap: a result written before
// auditor-result/v4 has no verification and no limit, and is reported as
// exactly that. Whether a recorded method was pertinent, or a recorded limit
// honest, is the auditor's review and the human's reading; no code here, or in
// the store, can establish it.

/** What a pre-v4 result says about its check and its limit. */
export const NOT_RECORDED = 'not recorded by this version';

const TRACE_VERSION = 'auditor-result/v4';

/**
 * One row per acceptance condition of the task contract, in contract order,
 * followed by any row the result carries for an id the contract does not
 * name. `traceRecorded` tells a null that means "this version never asked"
 * (false) from a null that means "the check was not run" (true).
 */
export function acceptanceTrace({ taskContract, auditResult }) {
  const traceRecorded = auditResult.schemaVersion === TRACE_VERSION;
  const coverage = Array.isArray(auditResult.acceptanceCoverage) ? auditResult.acceptanceCoverage : [];
  const conditions = taskContract?.done_when ?? [];
  const known = new Set(conditions.map((entry) => entry.id));

  const project = (claim, entry, acceptanceId) => ({
    acceptanceId,
    claim,
    status: entry?.status ?? null,
    evidence: entry?.evidence ?? null,
    method: entry?.verification?.method ?? null,
    falsifier: entry?.verification?.falsifier ?? null,
    limit: entry?.limit ?? null,
    reason: entry?.reason ?? null,
    remediation: entry?.remediation ?? null,
  });

  const rows = [
    ...conditions.flatMap(({ id, condition }) => {
      const matches = coverage.filter((entry) => entry.acceptanceId === id);
      return matches.length === 0 ? [project(condition, null, id)] : matches.map((entry) => project(condition, entry, id));
    }),
    ...coverage.filter((entry) => !known.has(entry.acceptanceId)).map((entry) => project(null, entry, entry.acceptanceId)),
  ];

  return {
    schemaVersion: auditResult.schemaVersion,
    traceRecorded,
    subject_id: auditResult.subject_id,
    auditResultId: auditResult.auditResultId ?? null,
    verdict: auditResult.verdict ?? null,
    rows,
  };
}

/**
 * Display neutralisation. Everything interpolated into the text trace comes
 * from an artifact, and auditor text is free text. Rendered raw it could act
 * on the terminal the human reads it in: an escape sequence can clear the
 * screen, move the cursor or retitle the window; a backspace or carriage
 * return can overprint what was already shown; a line break can continue a
 * value into lines that read as another condition's block; a bidirectional
 * control can reorder how a line reads.
 *
 * Each such code point is replaced, one for one, by a visible mark of the form
 * <U+XXXX>. Nothing is interpreted, stripped or summarised, so the reader can
 * see what was there. A literal "<U+" in the text has its "<" marked as well,
 * which keeps the mapping reversible: a typed mark cannot pass for a control.
 *
 * This is presentation only. It never touches the trace object, the stored
 * artifact, its hashes or its identity, and it applies to every version on
 * display without rewriting any of them. It also proves nothing about the
 * text: a control made visible is still whatever the auditor wrote.
 *
 * Covered: C0 controls (including tab, line feed, carriage return, escape),
 * DEL, C1 controls (including the 8-bit CSI, OSC and ST), the line and
 * paragraph separators, the bidirectional marks, embeddings, overrides and
 * isolates, and unpaired surrogates. Also covered, because they hide text
 * from the eye rather than drive a terminal, and the reader of this output
 * may be an agent as well as a person: tag characters, the zero-width space,
 * word joiner and invisible operators, the byte order mark, the Mongolian
 * vowel separator, the deprecated format characters and the interlinear
 * annotation characters.
 *
 * Left as written: every other character. That includes the zero-width
 * joiner and non-joiner, variation selectors and combining marks, which
 * scripts and emoji need, and ordinary spaces. So this does not stop text
 * that merely looks misleading: a long run of spaces can still push words to
 * the start of a wrapped line, and a filler letter can still look blank.
 */
function isDisplayControl(code) {
  return code <= 0x1F
    || (code >= 0x7F && code <= 0x9F)
    || code === 0x2028 || code === 0x2029
    || code === 0x061C || code === 0x200E || code === 0x200F
    || (code >= 0x202A && code <= 0x202E)
    || (code >= 0x2066 && code <= 0x2069)
    || (code >= 0xD800 && code <= 0xDFFF)
    || code === 0x200B || (code >= 0x2060 && code <= 0x2064)
    || code === 0xFEFF || code === 0x180E
    || (code >= 0x206A && code <= 0x206F)
    || (code >= 0xFFF9 && code <= 0xFFFB)
    || (code >= 0xE0000 && code <= 0xE007F);
}

const mark = (code) => `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;

export function inline(value) {
  const text = String(value);
  let out = '';
  let index = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (isDisplayControl(code) || (char === '<' && text.startsWith('U+', index + 1))) out += mark(code);
    else out += char;
    index += char.length;
  }
  return out;
}

/**
 * JSON for a terminal: the same data, and valid JSON that parses back to
 * exactly the value given, but with every code point `inline` would mark
 * written as a JSON escape instead of raw. JSON.stringify already escapes C0
 * and unpaired surrogates; it leaves DEL, C1, the separators, the
 * bidirectional controls and the hidden-text characters as they are, and a
 * terminal receives them. Here the representation is the JSON escape, which
 * is unambiguous by construction, so no mark is needed.
 */
export function terminalJson(value) {
  let out = '';
  for (const char of JSON.stringify(value, null, 2)) {
    const code = char.codePointAt(0);
    if (code === 0x0A || !isDisplayControl(code)) { out += char; continue; }
    for (let index = 0; index < char.length; index += 1) {
      out += `\\u${char.charCodeAt(index).toString(16).padStart(4, '0')}`;
    }
  }
  return `${out}\n`;
}

const unrecorded = (trace) => `${NOT_RECORDED} (${inline(trace.schemaVersion)})`;

function checkLine(trace, row) {
  if (!trace.traceRecorded) return unrecorded(trace);
  if (row.method === null) return 'no check recorded for this row';
  return inline(row.method);
}

/**
 * The falsifier on its own line, so the method and the falsifier cannot be
 * made to read as each other with a separator typed into either. It always
 * concerns the original claim: on a FAIL row it is the contradiction that was
 * observed, so the label does not read as hypothetical there.
 */
function falsifierLine(trace, row) {
  if (!trace.traceRecorded || row.status === null || row.falsifier === null) return null;
  return `  ${row.status === 'FAIL' ? 'Refuted by' : 'Would refute'}: ${inline(row.falsifier)}`;
}

function limitLine(trace, row) {
  if (!trace.traceRecorded) return unrecorded(trace);
  if (row.limit === null) return 'none stated for this row';
  return inline(row.limit);
}

/**
 * Plain text for the decision package. Per condition: claim, check, the
 * falsifier when one was recorded, result and limit, one value per line.
 * Nothing is summarised and nothing is added.
 */
export function renderAcceptanceTrace(trace) {
  const lines = [
    `Acceptance trace for subject ${inline(trace.subject_id)}`,
    `Auditor result ${inline(trace.auditResultId ?? 'without identity')} (${inline(trace.schemaVersion)}), verdict ${inline(trace.verdict ?? 'not derived')}`,
  ];
  if (trace.rows.length === 0) {
    lines.push('', `No acceptance conditions: ${unrecorded(trace)}.`);
  }
  for (const row of trace.rows) {
    lines.push(
      '',
      `[${inline(row.acceptanceId)}] ${inline(row.status ?? 'NO COVERAGE ROW')}`,
      `  Claim:  ${row.claim === null ? 'not a condition of the frozen task contract' : inline(row.claim)}`,
      `  Check:  ${row.status === null ? 'no coverage row for this condition' : checkLine(trace, row)}`,
      ...(falsifierLine(trace, row) === null ? [] : [falsifierLine(trace, row)]),
      `  Result: ${row.status === null ? 'no coverage row for this condition' : `${inline(row.status)} - ${inline(row.evidence)}`}`,
      `  Limit:  ${row.status === null ? 'no coverage row for this condition' : limitLine(trace, row)}`,
    );
    // Whatever the version, a row that did not pass shows why, as recorded.
    if (row.status !== null && row.status !== 'PASS' && row.reason) {
      lines.push(`  Reason: ${inline(row.reason)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
