#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SCHEMA_ID, verifyPortableSkillLineage } from '../lib/portable-skill-lineage.mjs';

const args = process.argv.slice(2);
const value = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

const manifestPath = value('--manifest');
const root = resolve(value('--root') ?? process.cwd());

if (manifestPath === undefined) {
  process.stderr.write('usage: verify-portable-skill-lineage.mjs --manifest <manifest.json> [--root <repository-root>]\n');
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8'));
} catch (error) {
  const result = {
    schema_id: SCHEMA_ID,
    skill_id: null,
    manifest_version: null,
    current_state: 'blocked',
    artifacts: [],
    findings: [{
      state: 'blocked',
      code: 'manifest_unreadable',
      reason: `Manifest ${manifestPath} is missing, unreadable, or invalid JSON: ${error.code ?? error.message}.`,
      action: 'Restore a valid manifest before promotion.',
    }],
    summary: { current: 0, needs_review: 0, blocked: 0 },
    exit_code: 2,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.exit_code);
}

const result = verifyPortableSkillLineage({ manifest, root });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.exit_code);
