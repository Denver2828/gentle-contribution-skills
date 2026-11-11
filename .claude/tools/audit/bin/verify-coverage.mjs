#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateCoverage } from '../lib/coverage.mjs';

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: verify-coverage.mjs <receipt.json> [--require-interval] [--require-stable-retrieval]\n');
  process.exit(2);
}
const result = evaluateCoverage(JSON.parse(readFileSync(resolve(path), 'utf8')), {
  requireInterval: process.argv.includes('--require-interval'),
  requireStableRetrieval: process.argv.includes('--require-stable-retrieval'),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.complete) process.exit(1);
