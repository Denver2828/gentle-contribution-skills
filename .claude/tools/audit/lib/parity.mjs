// Citation parity: does the cited location actually contain what was declared?
//
// The hole this closes was demonstrated on this very tool. A policy declared
// a branch rule and cited CONTRIBUTING.md; the check verified only that the
// FILE existed. The rule the policy carried had been inferred from looking at
// branch names, and no amount of "the file is there" would have caught it.
//
// The rule that makes this worth anything: a match found somewhere else in the
// file does NOT validate a wrong line number. A citation names a location, and
// a location that does not hold the value is a wrong citation, full stop. The
// place it was actually found is reported as diagnosis, never as absolution.

import { readFileText, FileUnreadableError, FileUndecodableError, PathOutsideRepositoryError } from './adapters/files.mjs';
import { sha256Hex } from './canonical.mjs';
import { redactString } from './redact.mjs';
import { STATUS } from './status.mjs';

/** How much cited text travels in the evidence. Hashes always cover the whole. */
export const EVIDENCE_EXCERPT_LIMIT = 300;

export class MalformedReferenceError extends Error {
  constructor(reference, detail) {
    super(`"${reference}" is not a valid source reference: ${detail}`);
    this.name = 'MalformedReferenceError';
    this.reference = reference;
  }
}

/**
 * Parse `path`, `path#Lnn` or `path#Lnn-Lmm`, strictly.
 *
 * Strict means every other shape is refused rather than coerced: `#245`,
 * `#Labc`, `#L0`, `#L10-L5`, a trailing separator, or more than one `#`. A
 * reference the reader has to guess about cannot anchor anything.
 */
export function parseSourceRef(reference) {
  if (typeof reference !== 'string' || reference.trim() === '') {
    throw new MalformedReferenceError(String(reference), 'empty reference');
  }

  const parts = reference.split('#');
  if (parts.length > 2) throw new MalformedReferenceError(reference, 'more than one "#" fragment');

  const [path, fragment] = parts;
  if (path.trim() === '') throw new MalformedReferenceError(reference, 'empty path');

  if (fragment === undefined) return { path, from: null, to: null };

  const match = /^L([1-9][0-9]*)(?:-L([1-9][0-9]*))?$/.exec(fragment);
  if (match === null) {
    throw new MalformedReferenceError(reference, `fragment "${fragment}" is not "Lnn" or "Lnn-Lmm" with positive line numbers`);
  }

  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (to < from) throw new MalformedReferenceError(reference, `range ${from}-${to} ends before it starts`);

  return { path, from, to };
}

export class AmbiguousRegionError extends Error {
  constructor(detail) {
    super(detail);
    this.name = 'AmbiguousRegionError';
  }
}

/**
 * Extract the value of a single YAML `run:` entry from a cited region.
 *
 * Containment was the wrong comparison for a command: `go test ./...` is a
 * substring of `go test ./... -count=1`, and those are different commands.
 * So the field is read, and the whole value is compared.
 *
 * Deliberately not a YAML parser. It reads the one shape a command citation is
 * allowed to have, and refuses everything else instead of guessing:
 *
 *   run: <plain or quoted scalar>          a single line
 *   run: |                                 a block, whose range must be cited
 *     line
 *     line
 */
export function extractYamlRunValue(region) {
  const lines = region.split('\n');
  const keyed = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*(-\s+)?run\s*:/.test(line));

  if (keyed.length === 0) throw new AmbiguousRegionError('the cited region holds no YAML "run:" entry');
  if (keyed.length > 1) throw new AmbiguousRegionError(`the cited region holds ${keyed.length} "run:" entries, so which one is declared is ambiguous`);

  const { line, index } = keyed[0];
  const after = line.replace(/^\s*(-\s+)?run\s*:/, '');
  const indicator = /^\s*([|>])([-+]?)(\d*)\s*$/.exec(after);

  if (indicator === null) {
    const scalar = after.trim();
    if (scalar === '') throw new AmbiguousRegionError('the "run:" entry has an empty value');
    if (index !== lines.length - 1 && lines.slice(index + 1).some((rest) => rest.trim() !== '')) {
      throw new AmbiguousRegionError('the citation covers more than the single-line "run:" entry it names');
    }
    // A plain scalar ends at " #" per YAML. Rather than decide whether a
    // command legitimately contains it, refuse the comparison.
    if (/\s#/.test(scalar) && !/^["']/.test(scalar)) {
      throw new AmbiguousRegionError('the plain scalar contains " #", which YAML reads as a comment and this reader will not disambiguate');
    }
    const quoted = /^(["'])([\s\S]*)\1$/.exec(scalar);
    return quoted === null ? scalar : quoted[2];
  }

  if (indicator[3] !== '') throw new AmbiguousRegionError('explicit block indentation indicators are not supported');

  const body = lines.slice(index + 1);
  if (body.length === 0 || body.every((entry) => entry.trim() === '')) {
    throw new AmbiguousRegionError('the "run:" entry opens a block scalar, but the citation covers only its first line; cite the whole block as a range');
  }

  const meaningful = body.filter((entry) => entry.trim() !== '');
  const indent = Math.min(...meaningful.map((entry) => entry.length - entry.trimStart().length));
  const dedented = body.map((entry) => entry.slice(indent)).join('\n');

  // `|` keeps the trailing newline, `|-` strips it; either way the comparison
  // normalises trailing whitespace, so only `>` folding would change meaning.
  if (indicator[1] === '>') throw new AmbiguousRegionError('folded block scalars (">") are not supported, because folding changes the command');

  return dedented.replace(/\s+$/, '');
}

/** The only normalisation applied before an exact comparison. */
export function normaliseForComparison(value) {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(/[ \t]+$/gm, '').trim();
}

const excerpt = (text) => ({
  text: redactString(text).slice(0, EVIDENCE_EXCERPT_LIMIT),
  truncated: redactString(text).length > EVIDENCE_EXCERPT_LIMIT,
});

/** 1-based line numbers where `needle` occurs. Diagnosis only, never absolution. */
function linesContaining(lines, needle) {
  const found = [];
  const first = needle.split('\n')[0];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(first)) found.push(index + 1);
    if (found.length >= 10) break;
  }
  return found;
}

/**
 * Verify that the value a policy declared really sits at the location it cited.
 *
 * @returns {{status, reason, observed}} where `observed` is the evidence payload:
 *          source, location, expected, observed and their hashes.
 */
export const MATCH_MODES = Object.freeze(['literal', 'yaml-run']);

/**
 * Verify that the value a policy declared really sits at the location it cited.
 *
 * @param {string} [input.match]  'literal' compares the whole cited region;
 *                                'yaml-run' reads the region's `run:` field and
 *                                compares the complete command. Both are exact
 *                                after whitespace normalisation -- containment
 *                                is never enough, because `go test ./...` is a
 *                                substring of `go test ./... -count=1`.
 * @returns {{status, reason, observed}} where `observed` is the evidence payload.
 */
export function verifyCitation({ root, reference, expected, label, tracked, match = 'literal' }) {
  const base = { label, source: String(reference), match };

  const inconclusive = (reason, extra) => ({
    status: STATUS.UNKNOWN,
    reason,
    observed: { ...base, ...extra },
  });

  if (typeof expected !== 'string' || expected.trim() === '') {
    return inconclusive(`${label}: the declared value is empty, so there is nothing determinate to look for`, { expected: String(expected) });
  }

  let reference_;
  try {
    reference_ = parseSourceRef(reference);
  } catch (error) {
    return inconclusive(`${label}: ${error.message}`, { malformed: true });
  }

  const { path, from, to } = reference_;
  const expectedExcerpt = excerpt(expected);
  const located = { ...base, path, lines: from === null ? null : { from, to }, expected: expectedExcerpt.text, expectedTruncated: expectedExcerpt.truncated, expectedHash: `sha256:${sha256Hex(redactString(expected))}` };

  // A file-level match would not prove the citation is correct, so a citation
  // with no location is not compared at all.
  if (from === null) {
    return inconclusive(`${label}: the declaration cites ${path} but no line, and a match anywhere in a file does not verify a location`, located);
  }

  if (tracked !== undefined && !tracked.has(path)) {
    return inconclusive(`${label}: the cited file ${path} is not tracked in this repository`, { ...located, sourceTracked: false });
  }

  let text;
  try {
    text = readFileText(root, path);
  } catch (error) {
    if (error instanceof FileUndecodableError) {
      return inconclusive(`${label}: the cited file ${path} is not valid UTF-8, so its content cannot be compared`, { ...located, undecodable: true });
    }
    if (error instanceof FileUnreadableError || error instanceof PathOutsideRepositoryError) {
      return inconclusive(`${label}: ${error.message}`, { ...located, unreadable: true });
    }
    throw error;
  }

  const lines = text.split('\n');
  if (to > lines.length) {
    return inconclusive(
      `${label}: ${path} has ${lines.length} line(s), so the cited range ${from}-${to} points past the end of the file`,
      { ...located, fileLines: lines.length }
    );
  }

  const region = lines.slice(from - 1, to).join('\n');
  const where = `${path} line${from === to ? ` ${from}` : `s ${from}-${to}`}`;
  const regionExcerpt = excerpt(region);
  const payload = {
    ...located,
    observed: regionExcerpt.text,
    observedTruncated: regionExcerpt.truncated,
    observedHash: `sha256:${sha256Hex(redactString(region))}`,
    fileHash: `sha256:${sha256Hex(redactString(text))}`,
    fileLines: lines.length,
  };

  // Reduce the cited region to the value it is supposed to hold. A region this
  // reader cannot interpret unambiguously is inconclusive, never a comparison.
  let actual;
  if (match === 'yaml-run') {
    try {
      actual = extractYamlRunValue(region);
    } catch (error) {
      if (error instanceof AmbiguousRegionError) {
        return inconclusive(`${label}: ${where} cannot be read as a single YAML run entry: ${error.message}`, { ...payload, ambiguousRegion: true });
      }
      throw error;
    }
  } else {
    actual = region;
  }

  const normalisedActual = normaliseForComparison(actual);
  const normalisedExpected = normaliseForComparison(expected);
  const compared = {
    ...payload,
    comparedValue: excerpt(normalisedActual).text,
    comparedValueHash: `sha256:${sha256Hex(redactString(normalisedActual))}`,
  };

  if (normalisedActual === normalisedExpected) {
    return { status: STATUS.PASS, reason: `${label}: ${where} holds exactly the declared value`, observed: compared };
  }

  // Diagnosis only. A value found on another line explains the mistake; it
  // never authorises the citation.
  const elsewhere = linesContaining(lines, expected);
  return {
    status: STATUS.FAIL,
    reason: elsewhere.length > 0
      ? `${label}: ${where} does not hold the declared value; it appears at line(s) ${elsewhere.join(', ')}, which makes the citation wrong rather than the value`
      : `${label}: ${where} does not hold the declared value, and it appears nowhere in the file`,
    observed: { ...compared, foundAtLines: elsewhere },
  };
}
