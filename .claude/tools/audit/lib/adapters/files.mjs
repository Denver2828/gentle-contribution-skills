// Read-only file adapter.
//
// Reads bytes from the working tree and decodes them strictly, for the same
// reason the Git adapter does: a file that is not valid UTF-8 must produce an
// inconclusive reading, never a silently altered one that then gets compared
// and hashed as if it were the file's content.

import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

export class PathOutsideRepositoryError extends Error {
  constructor(path) {
    super(`refusing to read "${path}": only repository-relative paths without ".." segments are allowed`);
    this.name = 'PathOutsideRepositoryError';
    this.path = path;
  }
}

export class FileUnreadableError extends Error {
  constructor(path, detail) {
    super(`"${path}" could not be read: ${detail}`);
    this.name = 'FileUnreadableError';
    this.path = path;
  }
}

export class FileUndecodableError extends Error {
  constructor(path, detail) {
    super(`"${path}" is not valid UTF-8: ${detail}`);
    this.name = 'FileUndecodableError';
    this.path = path;
  }
}

/** Reject anything that could read outside the repository. */
export function assertRepositoryRelative(path) {
  if (typeof path !== 'string' || path.trim() === '') throw new PathOutsideRepositoryError(String(path));
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path)) throw new PathOutsideRepositoryError(path);
  if (path.split(/[/\\]/).includes('..')) throw new PathOutsideRepositoryError(path);
  return path;
}

/** Raw bytes of a repository-relative file. */
export function readFileBytes(root, path) {
  assertRepositoryRelative(path);
  try {
    return readFileSync(join(root, path));
  } catch (error) {
    throw new FileUnreadableError(path, error.message);
  }
}

/**
 * Text of a repository-relative file, strictly decoded and with line endings
 * normalised to LF.
 *
 * Normalising CRLF matters here: the same file checked out under
 * core.autocrlf=true and false differs byte for byte while saying the same
 * thing, and a citation must not break because of the checkout's line endings.
 */
export function readFileText(root, path) {
  const bytes = readFileBytes(root, path);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new FileUndecodableError(path, error.message);
  }
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}
