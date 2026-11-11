// odd-state-reads (OTS-3): read-only text filters are accepted as pipe
// consumers after a state read, and nowhere else. Every command below is
// synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';

import { STATE_READ_CLASSIFIER, isStateReadCommand } from '../lib/odd-state-reads.mjs';

test('the classifier carries a rule-set version and lists its pipe filters', () => {
  assert.equal(STATE_READ_CLASSIFIER.version, 2);
  assert.ok(Array.isArray(STATE_READ_CLASSIFIER.pipeFilters.allowed));
  assert.ok(STATE_READ_CLASSIFIER.pipeFilters.allowed.some((f) => f.startsWith('head')));
  assert.ok(STATE_READ_CLASSIFIER.pipeFilters.notFilters.includes('awk'));
});

test('a state read piped into read-only filters is a state read', () => {
  for (const cmd of [
    'git log | head -5',
    'git log --oneline | head -n 20',
    'git log --oneline | tail -3',
    'git status --short | wc -l',
    'git branch -a | sort',
    'git branch -a | sort -u | uniq -c',
    'git log --format=%an | sort | uniq',
    'git log --oneline | cut -d" " -f1',
    'git log -1 | tr a-z A-Z',
    'git log --oneline | grep -i fix',
    'git log --oneline | egrep "a|b"',
    'git ls-files | fgrep .mjs',
    'git ls-files | rg "\\.mjs$"',
    'git diff | rg --replace X foo',
    'gh pr list --json number | jq .',
    "gh pr view 1 --json title | jq -r '.title'",
    'gh api repos/o/r/pulls | jq ".[0].number"',
    'git show HEAD:a.json | bat -p -l json',
    'git show HEAD:a.md | bat --paging=never',
    'git log 2>&1 | head -5',
    'git log | head -5 2>/dev/null',
    'cd C:/repo && git log --oneline | head -5 && git status | tail -1',
    'git log | git status',
    'git log | HEAD.EXE -3',
    'git log | /usr/bin/head -3',
  ]) {
    assert.equal(isStateReadCommand(cmd), true, cmd);
  }
});

test('write-capable, program-running or unknown pipe consumers are not state reads', () => {
  for (const cmd of [
    'git status | tee out',
    "git log | awk '{print}'",
    'git log | gawk 1',
    'git log | sed -n 1p',
    'git log | perl -ne print',
    'git log | python -c x',
    'git log | node -e "process.stdin.pipe(process.stdout)"',
    'git log | xargs echo',
    'git log | sh',
    'git log | bash -c x',
    'git log | less',
    'git log | tail -f',
    'git log | tail --follow',
    'git log | tail -F',
    'git log | tail -fn 5',
    'git log | sort -o f',
    'git log | sort --output=f',
    'git log | sort -uo f',
    'git log | sort --compress-program=gzip',
    'git log | uniq - out.txt',
    'git log | rg --pre ./x foo',
    'git log | rg --pre=./x foo',
    'git log | rg --pre-glob "*.gz" foo',
    'git log | bat',
    'git log | bat -p --pager "less -R"',
    'git log | bat -p --unknown-flag',
    'git log | RIPGREP_CONFIG_PATH=x rg foo',
    'git log | head -5 > out.txt',
    'git log | head -5 | tee out',
    'git commit -m x | head -1',
    'npm test | tail -5',
    'cd C:/repo | head',
    'git log |& head',
  ]) {
    assert.equal(isStateReadCommand(cmd), false, cmd);
  }
});

test('a filter that does not consume a state read is not a state read', () => {
  for (const cmd of [
    'rg foo file',
    'head -5 file.txt',
    'wc -l a.js',
    'jq . a.json',
    'bat -p a.md',
    'git status && rg foo file',
    'git log | head -5; rg foo',
    'git status || tail -5 a.log',
    'cd C:/repo && head a.txt',
  ]) {
    assert.equal(isStateReadCommand(cmd), false, cmd);
  }
});
