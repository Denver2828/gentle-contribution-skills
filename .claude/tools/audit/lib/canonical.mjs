// Canonical serialization and content digests.
//
// Every hash in this tool is computed over the output of canonicalJson. Two
// runs that observed the same thing must produce byte-identical text, or the
// digest is decoration rather than evidence.
//
// This module refuses to serialize values JSON.stringify would silently drop
// or mangle (undefined, functions, NaN, Infinity). A silent drop turns a
// partial observation into a complete-looking one, which is the exact failure
// mode this tool exists to prevent.

import { createHash } from 'node:crypto';

/** Fields that legitimately differ between two runs over identical state. */
export const VOLATILE_RESULT_FIELDS = Object.freeze(['runId', 'startedAt', 'finishedAt']);
export const VOLATILE_CHECK_FIELDS = Object.freeze(['durationMs']);

export class CanonicalError extends Error {
  constructor(message, path) {
    super(path ? `${message} at ${path}` : message);
    this.name = 'CanonicalError';
    this.path = path ?? '';
  }
}

function encode(value, path) {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalError(`non-finite number (${value}) cannot be serialized`, path);
      }
      // Reject -0 so it cannot hash differently from 0.
      return Object.is(value, -0) ? '0' : JSON.stringify(value);

    case 'string':
      return JSON.stringify(value);

    case 'undefined':
      throw new CanonicalError('undefined cannot be serialized; use null explicitly', path);

    case 'function':
    case 'symbol':
    case 'bigint':
      throw new CanonicalError(`${typeof value} cannot be serialized`, path);

    default:
      break;
  }

  if (Array.isArray(value)) {
    const items = value.map((item, index) => encode(item, `${path}[${index}]`));
    return `[${items.join(',')}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalError(
      `only plain objects can be serialized, received ${value.constructor?.name ?? 'unknown'}`,
      path
    );
  }

  const keys = Object.keys(value).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${encode(value[key], `${path}/${key}`)}`);
  return `{${entries.join(',')}}`;
}

/** Deterministic JSON text: keys sorted, no incidental whitespace. */
export function canonicalJson(value) {
  return encode(value, '');
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Content digest of any serializable value, prefixed with its algorithm. */
export function digest(value) {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/**
 * Copy of a result with the documented volatile fields removed, so two runs
 * over identical repository state can be compared for equivalence.
 */
export function stripVolatile(result) {
  const copy = { ...result };
  for (const field of VOLATILE_RESULT_FIELDS) delete copy[field];

  if (Array.isArray(copy.checks)) {
    copy.checks = copy.checks.map((check) => {
      const trimmed = { ...check };
      for (const field of VOLATILE_CHECK_FIELDS) delete trimmed[field];
      return trimmed;
    });
  }

  return copy;
}

/** True when two results describe the same observation, ignoring volatile fields. */
export function equivalent(left, right) {
  return canonicalJson(stripVolatile(left)) === canonicalJson(stripVolatile(right));
}
