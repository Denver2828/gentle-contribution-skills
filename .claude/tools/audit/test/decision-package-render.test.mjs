// The text form of the acceptance trace is read by a human in a terminal.
// Auditor text is free text: rendered raw, a control sequence in it could
// clear the screen, move the cursor, retitle the window, overwrite what was
// already printed, or reorder how a line reads. The renderer shows every such
// character as a visible mark instead. It changes presentation only: the
// trace object, the stored artifact and every hash stay as they were. A mark
// makes a control visible; it says nothing about whether the text is true.
//
// Every control below is built from its code point, never typed as a literal
// or as an escape, so no editor or tool layer can alter the input.

import test from 'node:test';
import assert from 'node:assert/strict';

import { admitAuditorResult, auditorResultIntact } from '../lib/auditor-result.mjs';
import { admitTaskContract } from '../lib/task-contract.mjs';
import { validateAuditorResult } from '../lib/validate.mjs';
import { acceptanceTrace, renderAcceptanceTrace, inline, terminalJson, NOT_RECORDED } from '../lib/decision-package.mjs';
import { auditorResult, auditorResultV3, passingAcceptanceCoverage, TASK_CONTRACT } from './helpers/documents.mjs';

const subject = `sha256:${'a'.repeat(64)}`;
const taskContract = admitTaskContract(TASK_CONTRACT);
const admit = (result) => admitAuditorResult(result, { taskContract });
const ch = (...codes) => String.fromCodePoint(...codes);
const mark = (code) => `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;

const ESC = ch(0x1B);
const CASES = {
  'clear screen and home': { text: `visible${ESC}[2J${ESC}[HALL CHECKS PASSED; NO LIMITS`, codes: [0x1B] },
  'cursor movement': { text: `real limit${ESC}[1A${ESC}[2K${ESC}[10;1Hoverwritten`, codes: [0x1B] },
  'OSC window title with BEL': { text: `limit${ESC}]0;AUDIT PASSED${ch(0x07)}tail`, codes: [0x1B, 0x07] },
  'OSC hyperlink with ST': { text: `see ${ESC}]8;;http://example.invalid${ESC}${ch(0x5C)}here`, codes: [0x1B] },
  'C1 CSI and OSC': { text: `limit${ch(0x9B)}2J${ch(0x9D)}0;title${ch(0x9C)}tail`, codes: [0x9B, 0x9D, 0x9C] },
  backspace: { text: `FAIL${ch(0x08, 0x08, 0x08, 0x08)}PASS`, codes: [0x08] },
  'carriage return': { text: `honest limit${ch(0x0D)}no limit at all`, codes: [0x0D] },
  'line breaks': { text: `one${ch(0x0A)}[zz] PASS${ch(0x0D, 0x0A)}two${ch(0x2028)}three${ch(0x2029)}four${ch(0x85)}five${ch(0x0B)}six${ch(0x0C)}seven`, codes: [0x0A, 0x0D, 0x2028, 0x2029, 0x85, 0x0B, 0x0C] },
  'bidirectional override': { text: `limit ${ch(0x202E)}SSAP${ch(0x202C)} end`, codes: [0x202E, 0x202C] },
  'bidirectional isolates and marks': { text: `a${ch(0x2066)}b${ch(0x2067)}c${ch(0x2068)}d${ch(0x2069)}e${ch(0x200E)}f${ch(0x200F)}g${ch(0x061C)}h${ch(0x202A)}i${ch(0x202B)}j${ch(0x202D)}k`, codes: [0x2066, 0x2067, 0x2068, 0x2069, 0x200E, 0x200F, 0x061C, 0x202A, 0x202B, 0x202D] },
  'NUL, DEL and tab': { text: `a${ch(0x00)}b${ch(0x7F)}c${ch(0x09)}d`, codes: [0x00, 0x7F, 0x09] },
};

// Anything a terminal may act on or that changes how a line reads: C0, DEL,
// C1, the Unicode line and paragraph separators, and the bidi controls.
const ACTIVE = (code) => code <= 0x1F || (code >= 0x7F && code <= 0x9F)
  || code === 0x2028 || code === 0x2029 || code === 0x061C || code === 0x200E || code === 0x200F
  || (code >= 0x202A && code <= 0x202E) || (code >= 0x2066 && code <= 0x2069)
  || code === 0x200B || (code >= 0x2060 && code <= 0x2064) || code === 0xFEFF || code === 0x180E
  || (code >= 0x206A && code <= 0x206F) || (code >= 0xFFF9 && code <= 0xFFFB)
  || (code >= 0xE0000 && code <= 0xE007F) || (code >= 0xD800 && code <= 0xDFFF);
const activeIn = (text) => [...text].map((char) => char.codePointAt(0)).filter(ACTIVE);

/** Undo the renderer's marks: the reader can always get the original back. */
const restore = (rendered) => rendered.replace(/<U\+([0-9A-F]{4,6})>/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));

const FIELDS = ['limit', 'evidence', 'method', 'falsifier', 'reason'];
function resultWith(field, text) {
  const coverage = passingAcceptanceCoverage();
  const row = { ...coverage[0], status: 'FAIL', reason: 'the reproduction disproved the claim', remediation: 'correct the claim' };
  if (field === 'method' || field === 'falsifier') row.verification = { ...row.verification, [field]: text };
  else row[field] = text;
  coverage[0] = row;
  return auditorResult(subject, 'NEEDS_CHANGES', { coverage });
}
const bodyLines = (text) => text.split('\n');

test('the reported case: a limit that clears the screen is admitted, and rendered with no active control', () => {
  const hostile = CASES['clear screen and home'].text;
  const submitted = resultWith('limit', hostile);
  assert.equal(validateAuditorResult(submitted).valid, true, 'the store validates presence, so this text is admitted');
  const admitted = admit(submitted);
  const text = renderAcceptanceTrace(acceptanceTrace({ taskContract, auditResult: admitted }));
  assert.equal(text.includes(ESC), false, 'no escape character reaches the terminal');
  assert.equal(text.includes(`visible${mark(0x1B)}[2J${mark(0x1B)}[HALL CHECKS PASSED; NO LIMITS`), true, 'the sequence is shown, not executed');
});

for (const [label, { text: hostile, codes }] of Object.entries(CASES)) {
  test(`${label}: no active control leaves the renderer, in any interpolated field`, () => {
    for (const field of FIELDS) {
      const admitted = admit(resultWith(field, hostile));
      const text = renderAcceptanceTrace(acceptanceTrace({ taskContract, auditResult: admitted }));
      // The renderer's own line feeds are the only control it may emit.
      assert.deepEqual(activeIn(text).filter((code) => code !== 0x0A), [], `${field}: active controls in the output`);
      for (const code of codes) assert.equal(text.includes(mark(code)), true, `${field}: ${mark(code)} is shown`);
      assert.equal(restore(text).includes(hostile), true, `${field}: the original text is recoverable from its marks`);
      const headers = bodyLines(text).filter((line) => line.startsWith('['));
      assert.deepEqual(headers, ['[acceptance-1] FAIL', '[acceptance-2] PASS'], `${field}: no forged block`);
      assert.equal(bodyLines(text).filter((line) => /^ {2}(Claim|Check|Would refute|Refuted by|Result|Limit|Reason): /.test(line)).length, 11, `${field}: one line per value`);
    }
  });
}

test('a control in the claim of the task contract is neutralised as well', () => {
  const raw = {
    ...TASK_CONTRACT,
    done_when: [{ id: 'acceptance-1', condition: `claim${ESC}[2Jtext` }, TASK_CONTRACT.done_when[1]],
  };
  const contract = admitTaskContract(raw);
  const result = auditorResult(subject, 'PASS', { taskContract: raw });
  const text = renderAcceptanceTrace(acceptanceTrace({ taskContract: contract, auditResult: admitAuditorResult(result, { taskContract: contract }) }));
  assert.equal(text.includes(ESC), false);
  assert.equal(text.includes(`claim${mark(0x1B)}[2Jtext`), true);
});

test('text that already contains a mark stays distinguishable from a real control', () => {
  const literal = `the log printed <U+001B> and then ${ESC}[0m`;
  const text = renderAcceptanceTrace(acceptanceTrace({ taskContract, auditResult: admit(resultWith('limit', literal)) }));
  assert.equal(text.includes(ESC), false);
  const line = bodyLines(text).find((entry) => entry.startsWith('  Limit:  '));
  assert.equal(line, `  Limit:  the log printed ${mark(0x3C)}U+001B> and then ${mark(0x1B)}[0m`);
  assert.equal(restore(line), `  Limit:  ${literal}`, 'the mapping is reversible, so a typed mark cannot pass for a control');
});

test('legitimate Unicode and ordinary punctuation are left exactly as written', () => {
  const samples = [
    'solo se ejecutó en Windows 11, Node v24.13.0; ñandú, ¿cuánto?',
    `${ch(0x65E5, 0x672C, 0x8A9E)} ${ch(0x0639, 0x0631, 0x0628, 0x064A)} ${ch(0x05E2, 0x05D1, 0x05E8, 0x05D9, 0x05EA)} ${ch(0x1F469, 0x200D, 0x1F4BB)} ${ch(0x0915, 0x094D, 0x200D, 0x0937)}`,
    'C:\\Users\\x\\repo, a < b && c > d, 100% [ok] {x} `code` "q" <tag> U+0041 \\n',
    `non-breaking${ch(0xA0)}space and soft${ch(0xAD)}hyphen`,
  ];
  for (const sample of samples) {
    const text = renderAcceptanceTrace(acceptanceTrace({ taskContract, auditResult: admit(resultWith('limit', sample)) }));
    assert.equal(bodyLines(text).find((entry) => entry.startsWith('  Limit:  ')), `  Limit:  ${sample}`);
  }
});

test('rendering is presentation only: the trace, the result and its identity are untouched', () => {
  const hostile = CASES['clear screen and home'].text;
  const admitted = admit(resultWith('limit', hostile));
  const before = JSON.stringify(admitted);
  const trace = acceptanceTrace({ taskContract, auditResult: admitted });
  const snapshot = JSON.stringify(trace);
  renderAcceptanceTrace(trace);
  assert.equal(trace.rows[0].limit, hostile, 'the JSON trace keeps the recorded bytes');
  assert.equal(JSON.stringify(trace), snapshot);
  assert.equal(JSON.stringify(admitted), before);
  assert.equal(auditorResultIntact(admitted), true);
});

test('the falsifier is labelled as hypothetical on PASS and as observed on FAIL', () => {
  const coverage = passingAcceptanceCoverage();
  coverage[0] = { ...coverage[0], status: 'FAIL', reason: 'disproved', remediation: 'correct it' };
  const text = renderAcceptanceTrace(acceptanceTrace({ taskContract, auditResult: admit(auditorResult(subject, 'NEEDS_CHANGES', { coverage })) }));
  assert.equal(text.includes(`  Check:  ${coverage[0].verification.method}\n  Refuted by: ${coverage[0].verification.falsifier}\n`), true);
  assert.equal(text.includes(`  Check:  ${coverage[1].verification.method}\n  Would refute: ${coverage[1].verification.falsifier}\n`), true);
});

test('ordinary and historical rendering are unchanged', () => {
  const coverage = passingAcceptanceCoverage();
  const current = renderAcceptanceTrace(acceptanceTrace({ taskContract, auditResult: admit(auditorResult(subject, 'PASS', { coverage })) }));
  assert.equal(current.includes('<U+'), false);
  assert.equal(current.includes(`  Limit:  ${coverage[0].limit}`), true);
  assert.equal(current.includes(`  Check:  ${coverage[0].verification.method}\n  Would refute: ${coverage[0].verification.falsifier}\n`), true);
  assert.equal(current.includes(`  Result: PASS - ${coverage[0].evidence}`), true);

  const historical = auditorResultV3(subject);
  historical.acceptanceCoverage[0] = { ...historical.acceptanceCoverage[0], evidence: `old${ESC}[2Jevidence` };
  const old = renderAcceptanceTrace(acceptanceTrace({ taskContract, auditResult: historical }));
  assert.equal(old.includes(`${NOT_RECORDED} (auditor-result/v3)`), true);
  assert.equal(old.includes(ESC), false, 'a historical artifact is neutralised on display too, and never rewritten');
  assert.equal(old.includes(`old${mark(0x1B)}[2Jevidence`), true);
});

// -- gaps found by the independent review of the renderer ---------------------------------

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, offset) => from + offset);

test('every C0, DEL and C1 code point is marked, one by one', () => {
  for (const code of [...range(0x00, 0x1F), ...range(0x7F, 0x9F)]) {
    const out = inline(`a${ch(code)}b`);
    assert.equal(out, `a${mark(code)}b`, mark(code));
  }
});

test('unpaired surrogates are marked and a valid pair is left alone', () => {
  const high = String.fromCharCode(0xD83D);
  const low = String.fromCharCode(0xDE00);
  assert.equal(inline(`a${high}b`), `a${mark(0xD83D)}b`);
  assert.equal(inline(`a${low}b`), `a${mark(0xDE00)}b`);
  assert.equal(inline(`a${low}${high}b`), `a${mark(0xDE00)}${mark(0xD83D)}b`);
  assert.equal(inline(`a${high}${low}b`), `a${ch(0x1F600)}b`);
});

test('characters that hide text from the eye are marked; joiners and selectors that scripts need are kept', () => {
  const hiddenInstruction = [0xE0072, 0xE0065, 0xE0070, 0xE006F, 0xE0072, 0xE0074, 0xE0020, 0xE0050, 0xE0041, 0xE0053, 0xE0053];
  const out = inline(`none${ch(...hiddenInstruction)}`);
  assert.equal(out, `none${hiddenInstruction.map(mark).join('')}`, 'an invisible tag-character string is shown');
  for (const code of [0x200B, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xFEFF, 0x180E, ...range(0x206A, 0x206F), ...range(0xFFF9, 0xFFFB), 0xE0001, 0xE007F]) {
    assert.equal(inline(`a${ch(code)}b`), `a${mark(code)}b`, mark(code));
  }
  for (const code of [0x200C, 0x200D, 0xFE0F, 0xAD, 0xA0, 0x0301, 0x3000]) {
    assert.equal(inline(`a${ch(code)}b`), `a${ch(code)}b`, `${mark(code)} is legitimate text`);
  }
});

test('header and row-label fields are neutralised too, whatever put them there', () => {
  const hostile = `x${ESC}[2J${ch(0x202E)}y${ch(0x0A)}[zz] PASS`;
  const trace = {
    schemaVersion: hostile, traceRecorded: false, subject_id: hostile, auditResultId: hostile, verdict: hostile,
    rows: [{ acceptanceId: hostile, claim: hostile, status: hostile, evidence: hostile, method: null, falsifier: null, limit: null, reason: hostile, remediation: null }],
  };
  const text = renderAcceptanceTrace(trace);
  assert.deepEqual(activeIn(text).filter((code) => code !== 0x0A), []);
  assert.equal(bodyLines(text).filter((line) => line.startsWith('[')).length, 1);
  assert.equal(bodyLines(text).length, 10, 'two header lines, a blank, the row header, four values, a reason, and the final newline');
  const empty = renderAcceptanceTrace({ ...trace, rows: [] });
  assert.deepEqual(activeIn(empty).filter((code) => code !== 0x0A), []);
});

test('the method and the falsifier are on separate lines, so neither can impersonate the other', () => {
  const build = (method, falsifier) => {
    const coverage = passingAcceptanceCoverage();
    coverage[0] = { ...coverage[0], verification: { method, falsifier } };
    return renderAcceptanceTrace(acceptanceTrace({ taskContract, auditResult: admit(auditorResult(subject, 'PASS', { coverage })) }));
  };
  assert.notEqual(build('a | would refute: b', 'c'), build('a', 'b | would refute: c'));
  assert.notEqual(build('a | would have contradicted it: b', 'c'), build('a', 'b | would have contradicted it: c'));
});

test('the JSON form for a terminal carries the same data with no active control in it', () => {
  const hostile = `visible${ch(0x9B)}2J${ch(0x9B)}HALL CHECKS PASSED${ch(0x202E)}x${ESC}${ch(0x7F)}${ch(0x2028)}${ch(0xE0050)}${ch(0x200B)}`;
  const legit = `ñandú ${ch(0x65E5, 0x672C)} ${ch(0x1F469, 0x200D, 0x1F4BB)} C:\\Users\\x "quoted" <U+001B>`;
  const value = { limit: hostile, nested: [{ evidence: legit, [`key${ch(0x9B)}`]: hostile }], n: 1, t: true, z: null };
  const printed = terminalJson(value);
  assert.deepEqual(activeIn(printed).filter((code) => code !== 0x0A), [], 'nothing a terminal or a bidi renderer acts on');
  assert.deepEqual(JSON.parse(printed), value, 'and it parses back to exactly the recorded data');
  assert.equal(printed.includes(legit.replaceAll('\\', '\\\\').replaceAll('"', '\\"')), true, 'legitimate text is printed as written');
  assert.equal(terminalJson({ a: 1 }), `${JSON.stringify({ a: 1 }, null, 2)}\n`, 'ordinary output is byte-identical to before');
});
