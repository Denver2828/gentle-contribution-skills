#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateScopeFit } from '../lib/scope-fit.mjs';
const path = process.argv[2];
if (!path) { process.stderr.write('usage: verify-scope-fit.mjs <decision.json>\n'); process.exit(2); }
const result = evaluateScopeFit(JSON.parse(readFileSync(resolve(path), 'utf8')));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.coherent) process.exit(1);
