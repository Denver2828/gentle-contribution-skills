// Where the store lives, and which strings may become file names.
//
// The location is derived from THIS module's own path, never from
// process.cwd(). That is not a preference: resolving from the working
// directory is exactly how the contribution ledger ended up inside the
// upstream clone, one `git add -A` away from being published in someone
// else's pull request.
//
// Every id that becomes part of a path is validated first. An id is data that
// arrives from a document, and a document is something anyone can write.

import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute, resolve, sep } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `<workspace>/.claude/tools/audit/lib/store` -> `<workspace>` */
export const WORKSPACE_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
export const DEFAULT_STORE_ROOT = join(WORKSPACE_ROOT, '.claude', 'state', 'audit');

export class UnsafeIdentifierError extends Error {
  constructor(label, value, detail) {
    super(`${label} ${JSON.stringify(value)} cannot be used as a path component: ${detail}`);
    this.name = 'UnsafeIdentifierError';
  }
}

export class StoreLocationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreLocationError';
  }
}

const CONTENT_ID = /^sha256:[0-9a-f]{64}$/;
const LINEAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A content-addressed id, and the bare hex that becomes its file name. */
export function assertContentId(value, label = 'id') {
  if (typeof value !== 'string' || !CONTENT_ID.test(value)) {
    throw new UnsafeIdentifierError(label, value, 'expected sha256:<64 hex>');
  }
  return value.slice('sha256:'.length);
}

/** A lineage name. Conservative on purpose: it becomes a directory name. */
export function assertLineageName(value) {
  if (typeof value !== 'string' || !LINEAGE_NAME.test(value)) {
    throw new UnsafeIdentifierError('lineage', value, 'expected 1-128 chars of [A-Za-z0-9._-] starting alphanumeric');
  }
  if (value === '.' || value === '..' || value.includes('..')) {
    throw new UnsafeIdentifierError('lineage', value, 'traversal segments are refused');
  }
  return value;
}

/**
 * Refuse anything that could escape the store.
 *
 * Belt and braces: the id patterns above already exclude separators and dots,
 * and this re-checks the resolved path, because a validator that is correct
 * today is one refactor away from not being.
 */
export function withinStore(storeRoot, ...segments) {
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment === '') {
      throw new UnsafeIdentifierError('path segment', segment, 'empty');
    }
    if (isAbsolute(segment) || /^[A-Za-z]:/.test(segment) || segment.includes('/') || segment.includes('\\')) {
      throw new UnsafeIdentifierError('path segment', segment, 'separators and absolute paths are refused');
    }
    if (segment === '.' || segment === '..' || segment.split(/[\\/]/).some((part) => part === '.' || part === '..')) {
      throw new UnsafeIdentifierError('path segment', segment, 'traversal segments are refused');
    }
  }

  const candidate = resolve(storeRoot, ...segments);
  const root = resolve(storeRoot);
  // Strictly under the root: resolving TO the root means the segments cancelled
  // out, which is the shape a traversal takes when it succeeds.
  if (!candidate.startsWith(root + sep)) {
    throw new UnsafeIdentifierError('path', segments.join('/'), `resolves to ${candidate}, which is not strictly inside ${root}`);
  }
  return candidate;
}

/**
 * Resolve the store root.
 *
 * An override exists for tests only, and is refused outside the workspace
 * unless the test flag is set. Production has exactly one location, and it is
 * not negotiable from an environment variable.
 */
export function resolveStoreRoot({ override, allowOutsideWorkspace = false } = {}) {
  if (override === undefined || override === null || override === '') return DEFAULT_STORE_ROOT;

  const resolved = resolve(override);
  const workspace = resolve(WORKSPACE_ROOT);
  const inside = resolved === workspace || resolved.startsWith(workspace + sep);

  if (!inside && !allowOutsideWorkspace) {
    throw new StoreLocationError(
      `refusing a store at ${resolved}: it is outside the workspace ${workspace}. ` +
      'Anchoring the store anywhere else is how it ended up inside the upstream clone.'
    );
  }
  return resolved;
}
