#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { attestSut, compareSutAttestations } from '../lib/sut-boundary.mjs';
import { WORKSPACE_ROOT } from '../lib/store/paths.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((all, token, i, list) => {
  if (token.startsWith('--')) all.push([token.slice(2), list[i + 1]]);
  return all;
}, []));
const current = attestSut(resolve(args.sut || join(WORKSPACE_ROOT, 'src')));
if (args.baseline) {
  const baseline = JSON.parse(readFileSync(resolve(args.baseline), 'utf8'));
  const comparison = compareSutAttestations(baseline, current);
  process.stdout.write(`${JSON.stringify({ ...comparison, current }, null, 2)}\n`);
  if (!comparison.equal) {
    process.stderr.write('sut-attest: SUT state changed. Next action: stop and inspect; never reset or clean src automatically.\n');
    process.exit(1);
  }
} else {
  process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
}
