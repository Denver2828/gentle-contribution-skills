#!/usr/bin/env node
// Deterministic commit-message policy for this workspace.
//
// The subject must keep the Conventional Commit shape already used by the
// repository. `fixup!` and `squash!` are admitted only when the subject they
// wrap is itself conventional, so temporary history cannot smuggle in a shape
// the final commit would reject. Bodies are otherwise free-form. Git comment
// lines are ignored before both subject and trailer checks.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CONVENTIONAL_SUBJECT = /^[a-z][a-z0-9-]*(?:\([^()\r\n]+\))?!?: \S.*$/;
const TEMPORARY_SUBJECT = /^(fixup|squash)! (.+)$/;
const TRAILER = /^\s*([A-Za-z][A-Za-z0-9-]*):\s*(.*?)\s*$/;

const EXPLICIT_AI_TRAILERS = new Set([
  'ai-assisted-by',
  'ai-generated-by',
  'ai-reviewed-by',
]);

const ATTRIBUTION_TRAILERS = new Set([
  'assisted-by',
  'generated-by',
  'reviewed-by',
  'tested-by',
]);

// Names here are deliberately phrases that identify a tool or vendor, not
// human first names such as Claude or Gemini on their own.
const AI_IDENTITY = /\b(?:AI (?:assistant|agent|model|tool|system)|artificial intelligence|ChatGPT|OpenAI(?: Codex)?|Codex CLI|Claude Code|Anthropic(?: Claude)?|Google Gemini|GitHub Copilot|OpenCode|Kilo(?:Code| Code))\b/i;
const STRONG_AI_IDENTITY = /\b(?:artificial intelligence|ChatGPT|OpenAI(?: Codex)?|Codex CLI|Claude Code|Anthropic(?: Claude)?|Google Gemini|GitHub Copilot|OpenCode|Kilo(?:Code| Code))\b/i;

const isComment = (line) => /^\s*#/.test(line);

export function subjectIsValid(subject) {
  const temporary = subject.match(TEMPORARY_SUBJECT);
  const candidate = temporary === null ? subject : temporary[2];
  return CONVENTIONAL_SUBJECT.test(candidate);
}

export function extractFinalTrailers(lines) {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  if (end === 0) return [];

  let start = end - 1;
  while (start >= 0 && lines[start].trim() !== '') start -= 1;
  if (start < 0) return [];

  const paragraph = lines.slice(start + 1, end);
  const trailers = [];
  for (const line of paragraph) {
    const trailer = line.match(TRAILER);
    if (trailer !== null) {
      trailers.push({ key: trailer[1], value: trailer[2] });
      continue;
    }
    if (/^\s+\S/.test(line) && trailers.length > 0) {
      trailers.at(-1).value += `\n${line.trim()}`;
      continue;
    }
    return [];
  }
  return trailers;
}

export function validateCommitMessage(message) {
  const lines = String(message).replaceAll('\r\n', '\n').split('\n');
  const visible = lines.filter((line) => !isComment(line));
  const subject = visible.find((line) => line.trim() !== '')?.trim() ?? '';
  const errors = [];

  if (!subjectIsValid(subject)) {
    errors.push('subject must match type(optional-scope)!: description; fixup!/squash! may only wrap that same shape');
  }

  for (const trailer of extractFinalTrailers(visible)) {
    const key = trailer.key.toLowerCase();
    const value = trailer.value;
    if (key === 'co-authored-by') {
      errors.push('Co-Authored-By trailers are not allowed');
      continue;
    }
    if (EXPLICIT_AI_TRAILERS.has(key)) {
      errors.push(`${trailer.key} is an AI-attribution trailer and is not allowed`);
      continue;
    }
    if (ATTRIBUTION_TRAILERS.has(key) && AI_IDENTITY.test(value)) {
      errors.push(`${trailer.key} names an AI tool or model and is not allowed`);
      continue;
    }
    if (key === 'signed-off-by' && STRONG_AI_IDENTITY.test(value)) {
      errors.push('Signed-off-by may name a human signer, not an AI tool or model');
    }
  }

  return { valid: errors.length === 0, subject, errors };
}

function fail(messagePath, errors) {
  process.stderr.write('\ncommit-msg: BLOCKED — commit message violates workspace policy\n\n');
  for (const error of errors) process.stderr.write(`  - ${error}\n`);
  process.stderr.write(
    `\nExpected subject: type(optional-scope)!: description\n` +
    `Next action: edit ${messagePath} (or correct -m), remove the named trailer, then retry git commit.\n` +
    'Bypass: git commit --no-verify  # procedural bypass, your call\n\n'
  );
  process.exit(1);
}

function main() {
  const messagePath = process.argv[2];
  if (!messagePath) fail('<commit-message-file>', ['Git did not provide a commit-message file']);

  let message;
  try {
    message = readFileSync(messagePath, 'utf8');
  } catch (error) {
    fail(messagePath, [`could not read commit-message file: ${error.message}`]);
  }

  const result = validateCommitMessage(message);
  if (!result.valid) fail(messagePath, result.errors);
  process.stdout.write(`commit-msg: subject accepted (${result.subject})\n`);
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (invokedDirectly) main();
