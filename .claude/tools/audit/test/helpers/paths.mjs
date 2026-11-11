// Mirrors the path canonicalization that lib/context-doctor.mjs and
// lib/sut-boundary.mjs both apply (see their own `canonicalProspectivePath`):
// walk up to the closest existing ancestor, resolve it through
// `realpathSync.native`, then rejoin any suffix that does not exist yet.
//
// A test that builds an expected path straight from `os.tmpdir()` or an
// `mkdtemp*` result only matches the library's output on a machine whose
// temp directory has no symlink (macOS: `/var` -> `/private/var`) and no
// 8.3 short-name alias (Windows: `RUNNER~1` vs `runneradmin`). Apply this
// same resolution to the expectation so the comparison holds everywhere.
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export function canonicalProspectivePath(value) {
  let current = resolve(value);
  const suffix = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(basename(current));
    current = parent;
  }
  const ancestor = existsSync(current) ? realpathSync.native(current) : current;
  return resolve(ancestor, ...suffix);
}
