// The publication guard: a pure string decision, broad on writes and narrow on
// the allow. The table is the contract; the process boundary is checked once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decide, UPSTREAM_REPO, PUBLISHER_PATH } from '../bin/publish-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, '..', 'bin', 'publish-guard.mjs');

const REPO = 'Gentleman-Programming/gentle-ai';

// -- reads pass untouched --------------------------------------------------------------

test('read commands against the upstream repository are allowed', () => {
  const reads = [
    `gh issue view 3297 --repo ${REPO} --comments`,
    `gh issue list --repo ${REPO} --state open --limit 60 --json number,title`,
    `gh pr list --repo ${REPO} --state open`,
    `gh search issues --repo ${REPO} --include-prs --limit 25 "install lock"`,
    `gh api repos/${REPO}/issues/3297`,
    `gh pr diff 3028 --repo ${REPO}`,
    `gh pr checks 3028 --repo ${REPO}`,
    `gh release list --repo ${REPO}`,
    `git clone https://github.com/${REPO}.git src`,
  ];
  for (const command of reads) {
    assert.equal(decide(command).decision, 'allow', command);
  }
});

test('commands that never mention the upstream repository are not this guard\'s question', () => {
  const elsewhere = [
    'gh issue create --repo Denver2828/gentle-aporte --title x --body y',
    'gh pr merge 12 --repo Denver2828/gentle-aporte',
    'curl -X POST https://example.com/api',
    'ls -la',
  ];
  for (const command of elsewhere) {
    assert.equal(decide(command).decision, 'allow', command);
  }
});

// -- writes are denied, and the denial names the sanctioned path ------------------------

test('write-shaped gh commands against the upstream repository are denied', () => {
  const writes = [
    `gh issue comment 3297 --repo ${REPO} --body-file draft.md`,
    `gh issue create --repo ${REPO} --title "t" --body-file draft.md`,
    `gh issue edit 3297 --repo ${REPO} --body nuevo`,
    `gh issue close 3297 --repo ${REPO}`,
    `gh pr create --repo ${REPO} --title t --body-file d.md`,
    `gh pr comment 3028 --repo ${REPO} --body x`,
    `gh pr edit 3028 --repo ${REPO}`,
    `gh pr merge 3028 --repo ${REPO}`,
    `gh release create v1 --repo ${REPO}`,
    `gh api -X POST repos/${REPO}/issues -f title=x`,
    `gh api --method PATCH repos/${REPO}/issues/3297 -f state=closed`,
    `gh api repos/${REPO}/issues/3297/comments -f body="hola"`,
    `gh api repos/${REPO}/issues/3297/comments -F body=@draft.md`,
    `gh api repos/${REPO}/issues --input payload.json`,
  ];
  for (const command of writes) {
    const verdict = decide(command);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /publish\.mjs/, 'the denial teaches the sanctioned path');
  }
});

test('curl carrying the repository and a mutation shape is denied too', () => {
  const writes = [
    `curl -X POST https://api.github.com/repos/${REPO}/issues -d '{"title":"x"}'`,
    `curl -X DELETE https://api.github.com/repos/${REPO}/issues/comments/1`,
    `curl -d '{"body":"x"}' https://api.github.com/repos/${REPO}/issues/1/comments`,
    `curl --data-raw '{"body":"x"}' https://api.github.com/repos/${REPO}/issues/1/comments`,
    `curl --form body=@d.md https://api.github.com/repos/${REPO}/issues/1/comments`,
  ];
  for (const command of writes) {
    assert.equal(decide(command).decision, 'deny', command);
  }
});

test('case and whitespace games do not slip a write past the tokens', () => {
  assert.equal(decide(`GH ISSUE  Comment 3297 --repo ${REPO.toUpperCase()} --body x`).decision, 'deny');
  assert.equal(decide(`gh api -XPOST repos/${REPO}/issues`).decision, 'deny');
  assert.equal(decide(`gh\tissue\tcreate --repo ${REPO}`).decision, 'deny');
});

// -- the controlled publisher, judged like any other command ------------------------------

// ASTRA-06 round-one correction: denials are now evaluated over the WHOLE
// command before any exception is considered. A publisher invocation
// followed by a `#` comment that happens to name a write shape and the
// repository is therefore DENIED -- the write-shape scan runs over the whole
// flat string and does not know a match sits inside a comment. The rephrase
// is to drop the comment. A publisher invocation chained to a command that
// never mentions a write shape still allows, because nothing in it denies.
test('the controlled publisher is judged like any other command: no write shape, no denial', () => {
  assert.equal(
    decide(`node ${PUBLISHER_PATH} --lineage comment-3297 --body-file draft.md # issue comment on ${REPO}`).decision,
    'deny',
  );
  assert.equal(
    decide(`node .claude\\tools\\audit\\bin\\publish.mjs --lineage issue-x --body-file d.md --title-file t.txt && echo done ${REPO}`).decision,
    'allow',
  );
});

test('doubt denies: a missing command string is not waved through', () => {
  assert.equal(decide(undefined).decision, 'deny');
  assert.equal(decide(null).decision, 'deny');
  assert.equal(decide(42).decision, 'deny');
});

test('the exported constants are what the semantics hang on', () => {
  assert.equal(UPSTREAM_REPO, 'gentleman-programming/gentle-ai');
  assert.equal(PUBLISHER_PATH, '.claude/tools/audit/bin/publish.mjs');
});

// -- the process boundary, per the PreToolUse hook contract -------------------------------

const runGuard = (input) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify(input), encoding: 'utf8' });

test('over stdin, a denied command yields the PreToolUse deny JSON and exit 0', () => {
  const outcome = runGuard({ tool_name: 'Bash', tool_input: { command: `gh issue comment 1 --repo ${REPO} --body x` } });

  assert.equal(outcome.status, 0);
  const response = JSON.parse(outcome.stdout);
  assert.equal(response.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(response.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(response.hookSpecificOutput.permissionDecisionReason, /publish\.mjs/);
});

test('over stdin, an allowed command emits nothing: the normal permission flow decides', () => {
  const outcome = runGuard({ tool_name: 'Bash', tool_input: { command: `gh issue view 1 --repo ${REPO}` } });

  assert.equal(outcome.status, 0);
  assert.equal(outcome.stdout, '', 'no output means no decision, never a force-approve');
});

test('unreadable hook input exits 2, which blocks: a guard that cannot read must not wave through', () => {
  const outcome = spawnSync(process.execPath, [GUARD], { input: '{ not json', encoding: 'utf8' });

  assert.equal(outcome.status, 2);
  assert.match(outcome.stderr, /denying rather than guessing/);
});

// -- the open-ended side: any gh verb that is not a known read ------------------------

test('gh verbs outside the read set are denied even though no write token names them', () => {
  // Each of these mutates the upstream repository in public, and each one
  // matched no WRITE_SHAPE. `pr ready` is the one that was actually found in
  // the wild: it flipped a real pull request out of draft with nothing in the
  // way. Enumerating writes means the verbs nobody enumerated decide the
  // outcome, so the gh branch enumerates reads instead.
  const unnamed = [
    `gh pr ready 3439 --repo ${REPO}`,
    `gh pr close 3439 --repo ${REPO}`,
    `gh pr reopen 3439 --repo ${REPO}`,
    `gh pr review 3439 --repo ${REPO} --approve`,
    `gh pr lock 3439 --repo ${REPO}`,
    `gh issue reopen 3297 --repo ${REPO}`,
    `gh issue delete 3297 --repo ${REPO}`,
    `gh issue transfer 3297 --repo ${REPO} otro/repo`,
    `gh issue pin 3297 --repo ${REPO}`,
    `gh label create urgente --repo ${REPO}`,
    `gh label delete bug --repo ${REPO}`,
    `gh repo archive --repo ${REPO}`,
    `gh workflow run ci.yml --repo ${REPO}`,
    `gh run cancel 123 --repo ${REPO}`,
    `gh secret set TOKEN --repo ${REPO}`,
    // The point of an allowlist is the verb that does not exist yet:
    `gh pr teleport 3439 --repo ${REPO}`,
  ];
  for (const command of unnamed) {
    const verdict = decide(command);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /publish[.]mjs/, 'the denial still teaches the sanctioned path');
  }
});

test('the read set is what keeps the intake readings working', () => {
  const reads = [
    `gh pr view 3439 --repo ${REPO} --json isDraft`,
    `gh run watch 123 --repo ${REPO}`,
    `gh release download v1 --repo ${REPO}`,
    `gh issue status --repo ${REPO}`,
    `gh api repos/${REPO}/pulls/3439`,
  ];
  for (const command of reads) {
    assert.equal(decide(command).decision, 'allow', command);
  }
});

test('a gh command naming another repository stays outside what this guard judges', () => {
  assert.equal(decide('gh pr ready 12 --repo Denver2828/gentle-aporte').decision, 'allow');
});

// -- ASTRA-06 round-one correction: denials over the WHOLE command, no segmentation ----------
//
// The prior design split each command into shell segments and judged them
// separately; a quote- or redirection-blind splitter could separate a write
// token from the repository mention it belonged with, so each half allowed
// on its own (the CRITICAL regression both judges confirmed). These tests
// pin the corrected, unsegmented algorithm: WRITE_SHAPES over the whole flat
// command first, then every `gh` invocation proving its own read. Every
// Windows path below uses String.raw so the runtime string really contains
// backslashes (ASTRA-06-JD-2: a plain template literal silently turns `\t`
// and `\b` into TAB and BACKSPACE, which quietly stops exercising the
// fixture at all).

const WIN_PUBLISHER_PATH = String.raw`C:\ExampleWorkspace\projects\gentle\.claude\tools\audit\bin\publish.mjs`;

test('ASTRA-06 fixture guard: the Windows-styled publisher path fixture really contains publish.mjs', () => {
  assert.ok(WIN_PUBLISHER_PATH.includes('publish.mjs'), 'a broken template-literal escape must fail loudly, not silently stop testing anything');
});

test('REGRESSION (ASTRA-06 round-one correction): a write shape denies no matter where the repository sits or what follows it', () => {
  const smuggled = [
    // a separator inside a quoted argument, --repo after --body and before it
    `gh issue comment 1 --body "a; b" --repo ${REPO}`,
    `gh issue comment 1 --repo ${REPO} --body "a; b"`,
    `gh issue create --title "a | b" --body x --repo ${REPO}`,
    `curl -d '{"body":"a; b"}' https://api.github.com/repos/${REPO}/issues`,
    `gh api -f body='a; b' repos/${REPO}/issues/1/comments`,
    // a redirection between the write flag and the rest of the command
    `gh api repos/${REPO}/issues 2>&1 -f title=x`,
    `gh api repos/${REPO}/issues -f title=x &> log`,
    `curl -d '{"title":"x"}' https://api.github.com/repos/${REPO}/issues 2>&1`,
  ];
  for (const command of smuggled) {
    const verdict = decide(command);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /publish[.]mjs/, 'the denial still teaches the sanctioned path');
  }
});

test('REGRESSION (ASTRA-06 round-one correction): mentioning the publisher path in a comment does not excuse a write', () => {
  const smuggled = [
    `gh issue create --repo ${REPO} --title t --body b # ${PUBLISHER_PATH}`,
    `gh issue comment 42 --repo ${REPO} --body "see ${PUBLISHER_PATH}"`,
    `gh issue comment 42 --repo ${REPO} --body x # ${WIN_PUBLISHER_PATH}`,
  ];
  for (const command of smuggled) {
    assert.ok(command.includes('publish.mjs'), `fixture must really carry the publisher path: ${JSON.stringify(command)}`);
    const verdict = decide(command);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /publish[.]mjs/, 'the denial still teaches the sanctioned path');
  }
});

test('REGRESSION (ASTRA-06 round-one correction): a read shape elsewhere in the command does not prove an unlisted gh verb', () => {
  const smuggled = [
    `gh pr ready 1 --repo ${REPO} # gh pr view`,
    `gh pr ready 1 --repo ${REPO}; gh pr view 1 --repo ${REPO}`,
    `gh pr view 1 --repo ${REPO} && gh pr ready 1 --repo ${REPO}`,
    `gh pr list --repo ${REPO} --json number -q '.[].number' | xargs -I{} gh pr ready {} --repo ${REPO}`,
    `gh pr view 1 --repo ${REPO}\ngh pr ready 1 --repo ${REPO}`,
    `echo $(gh pr ready 1 --repo ${REPO})`,
    `echo \`gh pr ready 1 --repo ${REPO}\``,
    // an unlisted verb with a quoted separator in its own arguments
    `gh pr ready 1 --body "x; y" --repo ${REPO}`,
  ];
  for (const command of smuggled) {
    assert.equal(decide(command).decision, 'deny', command);
  }
});

test('REGRESSION (ASTRA-06 round-one correction): chaining a write to the publisher still denies the command', () => {
  const smuggled = [
    `node ${PUBLISHER_PATH} --lineage x --body-file d.md; gh issue create --repo ${REPO} --title t --body b`,
    `gh issue create --repo ${REPO} --title t --body b; node ${PUBLISHER_PATH} --lineage x --body-file d.md`,
    `echo ${PUBLISHER_PATH} && gh pr merge 7 --repo ${REPO}`,
    `node ${WIN_PUBLISHER_PATH} --lineage x --body-file d.md; gh pr merge 7 --repo ${REPO}`,
  ];
  for (const command of smuggled) {
    const verdict = decide(command);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /publish[.]mjs/, 'the denial still teaches the sanctioned path');
  }
});

test('CONTROL (ASTRA-06 round-one correction): the publisher invocation keeps passing, quoted, chained and on a real Windows path', () => {
  const legitimate = [
    `node ${PUBLISHER_PATH} --lineage x --body-file d.md`,
    `node ${WIN_PUBLISHER_PATH} --lineage x --body-file d.md && echo done ${REPO}`,
    `node "${PUBLISHER_PATH}" --lineage x --body-file d.md && echo done ${REPO}`,
    `cd C:/ExampleWorkspace/projects/gentle && node ${PUBLISHER_PATH} --lineage x --body-file d.md`,
    `node ${PUBLISHER_PATH} --lineage x --body-file d.md 2>&1 | tee log.txt`,
  ];
  for (const command of legitimate) {
    assert.ok(command.includes('publish.mjs'), `fixture must really carry the publisher path: ${JSON.stringify(command)}`);
    assert.equal(decide(command).decision, 'allow', command);
  }
});

test('CONTROL (ASTRA-06 round-one correction): genuine reads keep passing, in compounds, subshells and via env/absolute-path invocations', () => {
  const legitimate = [
    `gh issue list --repo ${REPO} --json number | head -5`,
    `gh pr view 1 --repo ${REPO} --json body -q '.body | length'`,
    `gh pr view 1 --repo ${REPO} > out.txt 2>&1`,
    `echo "$(gh pr view 1 --repo ${REPO} --json isDraft)"`,
    `gh issue view 1 --repo ${REPO}; gh pr view 2 --repo ${REPO}`,
    `(gh issue view 1 --repo ${REPO})`,
    `env GH_PAGER= gh pr view 1 --repo ${REPO}`,
    `/usr/bin/gh pr view 1 --repo ${REPO}`,
    // a global flag before the verb
    `gh --repo ${REPO} issue view 1`,
    `gh issue view 1 --repo ${REPO} --json title -q "#"`,
    // no repository named at all: out of scope regardless of the verb
    `gh issue create --title "fix #12" --body b`,
  ];
  for (const command of legitimate) {
    assert.equal(decide(command).decision, 'allow', command);
  }
});

// -- G1 characterization: decisions the diagnostic reasons must never flip ------------------
//
// Pinned on the unchanged guard (c8b32db1). An upstream URL inside inline
// payload text is a repository mention like any other, so a write shape
// beside it denies even when `-R` names another repository; the same write
// with the payload in a file carries no mention and allows. `gh --version`
// next to a read denies through the read branch: as a leading invocation
// its flag consumes the next token (`&&`) as a value, and as a trailing one
// it has no verb at all.

const FORK = 'Denver2828/gentle-aporte';
const INLINE_BODY_UPSTREAM_URL = `gh pr create -R ${FORK} --title "fix: x" --body "Closes https://github.com/${REPO}/issues/5139"`;
const BODY_FILE_SAME_WRITE = `gh pr create -R ${FORK} --title "fix: x" --body-file pr-body.md`;
const VERSION_THEN_READ = `gh --version && gh search issues --repo ${REPO} "publish guard"`;
const READ_THEN_VERSION = `gh issue view 5139 --repo ${REPO} && gh --version`;

test('PIN (G1): an upstream URL in inline payload text denies a write aimed at another repository', () => {
  assert.equal(decide(INLINE_BODY_UPSTREAM_URL).decision, 'deny');
});

test('PIN (G1): the same write with the payload in a file allows', () => {
  assert.equal(decide(BODY_FILE_SAME_WRITE).decision, 'allow');
});

test('PIN (G1): gh --version beside an upstream read denies, leading or trailing', () => {
  assert.equal(decide(VERSION_THEN_READ).decision, 'deny');
  assert.equal(decide(READ_THEN_VERSION).decision, 'deny');
});

// -- G1 diagnostics: every deny names its concrete cause, decisions unchanged ---------------
//
// The diagnostic is appended after the sanctioned-path text, so the reason
// still teaches publish.mjs; it only adds which shape or which invocation
// decided the deny.

const PAYLOAD_HINT = /if the target is not upstream/i;

test('DIAGNOSTIC (G1): a write-shape deny names the matched write shape', () => {
  const verdict = decide(`gh pr create --repo ${REPO} --title t --body-file d.md`);
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /publish[.]mjs/);
  assert.match(verdict.reason, /write shape `pr create`/);
  assert.doesNotMatch(verdict.reason, PAYLOAD_HINT, 'the target is upstream: no payload hint');
});

test('DIAGNOSTIC (G1): an upstream URL only in payload text, with -R naming another repo, gets the conditional file hint', () => {
  const verdict = decide(INLINE_BODY_UPSTREAM_URL);
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /publish[.]mjs/);
  assert.match(verdict.reason, /write shape `pr create`/);
  assert.match(verdict.reason, PAYLOAD_HINT);
  assert.match(verdict.reason, /denver2828\/gentle-aporte/i);
  assert.match(verdict.reason, /--body-file/);
  assert.match(verdict.reason, /Write tool/);
});

test('DIAGNOSTIC (G1): the payload hint stays off when the upstream name is not only inside a URL', () => {
  const bare = decide(`gh pr create -R ${FORK} --title t --body "mirrors ${REPO} upstream"`);
  assert.equal(bare.decision, 'deny');
  assert.doesNotMatch(bare.reason, PAYLOAD_HINT);
  const noRepoFlag = decide(`gh pr create --title t --body "see https://github.com/${REPO}/issues/1"`);
  assert.equal(noRepoFlag.decision, 'deny');
  assert.doesNotMatch(noRepoFlag.reason, PAYLOAD_HINT);
});

test('DIAGNOSTIC (G1): a read-shape deny names the offending invocation and the verb it read', () => {
  const verdict = decide(`gh pr ready 3439 --repo ${REPO}`);
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /publish[.]mjs/);
  assert.match(verdict.reason, /`gh pr ready 3439/);
  assert.match(verdict.reason, /verb `pr ready`/);
});

test('DIAGNOSTIC (G1): gh --version leading a compound names the token its flag consumed', () => {
  const verdict = decide(VERSION_THEN_READ);
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /publish[.]mjs/);
  assert.match(verdict.reason, /`gh --version &&/);
  assert.match(verdict.reason, /`--version` took `&&` as its value/);
  assert.match(verdict.reason, /run `gh --version` as its own command/);
});

test('DIAGNOSTIC (G1): gh --version trailing a read reports no verb', () => {
  const verdict = decide(READ_THEN_VERSION);
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /publish[.]mjs/);
  assert.match(verdict.reason, /`gh --version`/);
  assert.match(verdict.reason, /no verb/);
  assert.match(verdict.reason, /run `gh --version` as its own command/);
});

// -- W-1 (2026-10-01): upstream write shapes that reached allow ---------------------------
//
// Found by the read-only repro on 950f56ec: each of these writes to the
// upstream repository matched no write shape. Quote characters and
// backslashes are a shell's to remove, so write shapes are also matched over
// a quote-free copy of the WHOLE string (no segmentation); that copy can only
// add denies.

const API = `https://api.github.com/repos/${REPO}`;
const SPLIT_REPO = REPO.replace('gentle-ai', `gentle''-ai`);

test('W-1: git push to the upstream URL is denied', () => {
  const writes = [
    `git push https://github.com/${REPO}.git HEAD:main`,
    `git -C work push --force https://github.com/${REPO} fix:main`,
    `git -c http.extraheader=x push https://github.com/${REPO}.git main`,
    `git p''ush https://github.com/${REPO}.git HEAD:main`,
    `git send-pack https://github.com/${REPO}.git main`,
  ];
  for (const command of writes) {
    const verdict = decide(command);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /publish[.]mjs/);
    assert.match(verdict.reason, /Cause:/);
  }
});

test('W-1: curl and wget write shapes that matched nothing are denied', () => {
  const writes = [
    `curl --request POST ${API}/issues -H "Accept: x"`,
    `curl --request=PATCH ${API}/issues/1`,
    `curl --json @b.json ${API}/issues`,
    `curl -T body.json ${API}/issues/1/comments`,
    `curl --upload-file body.json ${API}/issues/1/comments`,
    `curl -X "POST" ${API}/issues`,
    `curl -X 'DELETE' ${API}/issues/comments/1`,
    `curl -X P''OST ${API}/issues`,
    `c''url -X P''OST ${API}/issues`,
    `curl -sX POST ${API}/issues`,
    `curl -X $METHOD ${API}/issues`,
    `curl -d@b.json ${API}/issues`,
    `curl -sSd @b.json ${API}/issues`,
    `curl -sF body=@d.md ${API}/issues/1/comments`,
    `curl -K req.cfg ${API}/issues`,
    `curl --config req.cfg ${API}/issues`,
    `wget --post-data=x ${API}/issues`,
    `wget --post-file=b.json ${API}/issues`,
    `wget --method=PUT --body-file=b.json ${API}/contents/x`,
  ];
  for (const command of writes) {
    const verdict = decide(command);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /publish[.]mjs/);
    assert.match(verdict.reason, /Cause:/);
  }
});

test('W-1: a quote-split gh invocation or repository name does not escape the read allowlist', () => {
  const writes = [
    `g''h pr ready 1 --repo ${REPO}`,
    `"gh" pr ready 1 --repo ${REPO}`,
    `gh pr ready 1 --repo ${SPLIT_REPO}`,
    `gh issue comment 1 --repo ${SPLIT_REPO} --body x`,
  ];
  assert.ok(!SPLIT_REPO.toLowerCase().includes(UPSTREAM_REPO), 'fixture must really split the repository name');
  for (const command of writes) {
    const verdict = decide(command);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /publish[.]mjs/);
  }
});

test('W-1 CONTROL: upstream reads through git, curl, wget and gh keep allowing', () => {
  const reads = [
    `git clone https://github.com/${REPO}.git src`,
    `git fetch https://github.com/${REPO}.git main`,
    `git ls-remote https://github.com/${REPO}.git`,
    `curl -X GET ${API}/issues/1`,
    `curl --request GET ${API}/issues/1`,
    `curl -X "GET" ${API}/issues/1`,
    `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh`,
    `curl -sS -H "Accept: application/vnd.github+json" ${API}/issues/1`,
    `curl -I ${API}`,
    `wget -qO- https://raw.githubusercontent.com/${REPO}/main/README.md`,
    `gh api --method GET repos/${REPO}/issues/1`,
    `gh api -X GET repos/${REPO}/issues/1`,
    `gh issue view 1 --repo ${REPO} --json title,body`,
  ];
  for (const command of reads) {
    assert.equal(decide(command).decision, 'allow', command);
  }
});

// -- W-2 (2026-10-01): curl's data flags belong to curl ---------------------------------
//
// `-d` was matched for every tool: `base64 -d`, `ls -d`, `tr -d`, `fd -d` and
// the shell test `[ -d` made 49 of 220 historical denials. The data shapes
// now count only when the command names curl or wget (also once quotes are
// removed) or a GitHub API host any other HTTP client could be aimed at.

test('W-2: reads whose -d belongs to another tool allow', () => {
  const reads = [
    `gh api repos/${REPO}/contents/.github/workflows/x.yml --jq '.content' | base64 -d`,
    `gh api repos/${REPO}/contents/x.go?ref=v1 --jq .content | base64 -d > x.go && rg -n func x.go`,
    `ls -d $HOME/go/pkg/mod/github.com/${REPO}/v2@v2.6.0`,
    `gh run view 9 --repo ${REPO} --log-failed 2>&1 | tr -d '\\r' | rg error`,
    // `fd -d 1 ...` moved to the W-2b deny table: fd is not an exempt read tool.
    `m=$HOME/go/pkg/mod/github.com/${REPO}/v2@v2.6.0; if [ -d "$m" ]; then rg -n x "$m"; fi`,
    `gh pr view 1 --repo ${REPO} --json body -q .body | tr -d '\\n' | wc -c`,
  ];
  for (const command of reads) {
    assert.equal(decide(command).decision, 'allow', command);
  }
});

test('W-2: curl and wget data flags against the upstream repository still deny', () => {
  const writes = [
    `curl -d '{"body":"x"}' ${API}/issues/1/comments`,
    `c''url -d @b.json ${API}/issues/1/comments`,
    `curl.exe -d @b.json ${API}/issues/1/comments`,
    `/usr/bin/curl --data-raw x ${API}/issues/1/comments`,
    `curl --expand-data x ${API}/issues/1/comments`,
    `wget --post-data=x ${API}/issues`,
    // no client named, but a GitHub API host is: the data flag still counts
    `$C -d @b.json ${API}/issues/1/comments`,
    `xh --form body=x ${API}/issues/1/comments`,
    // a curl beside a base64 -d keeps the -d counting
    `base64 -d b64 > b.json; curl -d @b.json ${API}/issues/1/comments`,
  ];
  for (const command of writes) {
    const verdict = decide(command);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /publish[.]mjs/);
    assert.match(verdict.reason, /Cause:/);
  }
});

test('W-2 DIAGNOSTIC: a client-gated deny names the HTTP client condition', () => {
  // W-2b: `-d` no longer depends on a client being named, so the client
  // condition is pinned on `--json`, which still does.
  const verdict = decide(`curl --json @b.json ${API}/issues/1/comments`);
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /write shape `--json`/);
  assert.match(verdict.reason, /curl, wget or a GitHub API host/);
});

// -- W-2b (2026-10-01): the data flags deny without a client in sight ---------------------
//
// Adversarial BLOCK on W-2: gating `-d`, `--data*` and `--form` on a NAMED
// client let every hidden client through (`$C`, `$'\x63url'`, httpie, xh, a
// script). `--data*` and `--form` deny unconditionally again, as before W-2.
// Short `-d` denies unless it directly follows a known read tool standing in
// command position, in the flat string AND its quote-free copy.

const HIDDEN_HOST = `"https://$(<host.txt)/repos/${REPO}`;
const VAR_HOST = `"$H/repos/${REPO}`;

test('W-2b: hidden-client data writes against the upstream repository deny', () => {
  const writes = [
    `$'\\x63url' -d @b.json ${HIDDEN_HOST}/issues/1/comments"`,
    `$C -d @b.json ${VAR_HOST}/issues/1/comments"`,
    `http --form POST ${HIDDEN_HOST}/issues" title=x`,
    `xh --form ${HIDDEN_HOST}/issues/1/comments" body=x`,
    `cu\${X}rl -d @b.json ${VAR_HOST}/issues/1/comments"`,
    `"$(printf c)url" --data @b.json ${VAR_HOST}/issues"`,
    `$CURL_BIN -d @b.json ${VAR_HOST}/issues"`,
    `node post.mjs --data @b.json ${REPO}`,
    `H=https://api.git; H=\${H}hub.com; $'\\x63url' -d @b.json "$H/repos/${REPO}/issues"`,
    `python3 -m httpie --form POST ${VAR_HOST}/issues" title=x`,
    `$(<c.txt) --data-binary @b.json ${VAR_HOST}/issues"`,
    // bundled and glued short forms
    `$C -sSd @b.json ${VAR_HOST}/issues"`,
    `$C -d@b.json ${VAR_HOST}/issues"`,
    `$C --form-string body=x ${VAR_HOST}/issues"`,
  ];
  for (const command of writes) {
    const verdict = decide(command);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /publish[.]mjs/);
    assert.match(verdict.reason, /Cause:/);
  }
});

test('W-2b: a read tool name does not buy the exemption outside command position', () => {
  const writes = [
    // base64 is curl's first URL; -d is curl's
    `$C base64 -d @b.json ${VAR_HOST}/issues"`,
    // an escaped separator is part of curl's argument, not a separator
    `$C x\\;base64 -d @b.json ${VAR_HOST}/issues"`,
    `$C if [ -d @b.json ${VAR_HOST}/issues"`,
    `$C x >& base64 -d @b.json ${VAR_HOST}/issues"`,
    // quotes around the tool or a separator do not create the exemption
    `$C "x; base64" -d @b.json ${VAR_HOST}/issues"`,
    `b''ase64 -d x; ${REPO}`,
    // a redefined read tool is no read tool
    `ls() { $C "$@"; }; ls -d @b.json ${VAR_HOST}/issues"`,
    `alias ls=$C; ls -d @b.json ${VAR_HOST}/issues"`,
    // one exempt -d does not excuse another
    `ls -d x; $C -d @b.json ${VAR_HOST}/issues"`,
    // fd and other tools are not exempt
    `fd -d 3 . "c:/users/x/go/pkg/mod/github.com/${REPO}"`,
    `fd -d 1 -t d . "c:/users/x/go/pkg/mod/github.com/${REPO}"`,
  ];
  for (const command of writes) {
    const verdict = decide(command);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /publish[.]mjs/);
  }
});

test('W-2b: -d right after a read tool in command position allows', () => {
  const reads = [
    `gh api repos/${REPO}/contents/x --jq .content | base64 -d`,
    `ls -d $HOME/go/pkg/mod/github.com/${REPO}/v2@v2.6.0`,
    `ls -ld $HOME/go/pkg/mod/github.com/${REPO}/v2@v2.6.0`,
    `gh pr view 1 --repo ${REPO} --json body -q .body | tr -d '\\n' | wc -c`,
    `eza -d $HOME/go/pkg/mod/github.com/${REPO}`,
    `m=$HOME/go/pkg/mod/github.com/${REPO}; if [ -d "$m" ]; then rg -n x "$m"; fi`,
    `test -d $HOME/go/pkg/mod/github.com/${REPO} && echo yes`,
    `x="$(ls -d $HOME/go/pkg/mod/github.com/${REPO}/*)"; echo "$x"`,
    `M=$HOME/go/pkg/mod/github.com/${REPO}; diff <(tr -d '\\r' < "$M/a") <(tr -d '\\r' < b)`,
  ];
  for (const command of reads) {
    assert.equal(decide(command).decision, 'allow', command);
  }
});

test('W-2b DIAGNOSTIC: a -d deny names the read-tool exemption it missed', () => {
  const verdict = decide(`fd -d 3 . "c:/users/x/go/pkg/mod/github.com/${REPO}"`);
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /write shape `-d`/);
  assert.match(verdict.reason, /base64, ls, tr, eza, \[ or test/);
});

test('W-1 DIAGNOSTIC: a deny found only after removing quotes says so', () => {
  const verdict = decide(`curl -X P''OST ${API}/issues`);
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /quote characters/);
});
