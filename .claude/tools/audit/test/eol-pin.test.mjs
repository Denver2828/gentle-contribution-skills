// A digest bound in a portable-skill lineage manifest is a digest over the
// artifact's git blob bytes. Two things once broke that silently: a Windows
// checkout with core.autocrlf=true handed the verifier CRLF bytes the manifest
// never bound (false drift on three proof artifacts), and the genesis manifest
// bound SKILL.md bytes that were edited again before the commit (real drift
// that no committed revision could ever reproduce). This test pins both:
// the harness tree is declared LF, no bound artifact carries a CR, and every
// bound digest reproduces from the committed blob, not from the working copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { digestBytes } from '../lib/portable-skill-lineage.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const manifestPath = '.claude/skills/gentle-ai-observation-to-ratchet/references/portable-lineage.v1.json';
const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'));

function committedBlob(path) {
  const result = spawnSync('git', ['show', `HEAD:${path}`], { cwd: root, maxBuffer: 1 << 26 });
  assert.equal(result.status, 0, `git show HEAD:${path} failed: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

test('.gitattributes pins the harness tree to LF', () => {
  const attributes = readFileSync(join(root, '.gitattributes'), 'utf8');
  assert.match(attributes, /^\.claude\/\*\* text=auto eol=lf$/m, '.claude/** must be declared text=auto eol=lf');
});

test('no bound artifact carries a CR byte in the working copy', () => {
  for (const binding of manifest.bindings) {
    const bytes = readFileSync(join(root, binding.path));
    assert.equal(bytes.includes(13), false, `${binding.path} carries CR bytes; the digest would not reproduce on an LF checkout`);
  }
});

test('every bound digest reproduces from the committed git blob', () => {
  for (const binding of manifest.bindings) {
    assert.equal(digestBytes(committedBlob(binding.path)), binding.sha256, `${binding.path}: manifest digest does not match HEAD blob; a manifest must bind committed bytes`);
  }
});

test('the prior manifest named by a repair revision reproduces its bound digest', () => {
  if (manifest.revision.kind !== 'repair') return;
  const prior = manifest.revision.prior_manifest;
  assert.equal(digestBytes(readFileSync(join(root, prior.path))), prior.sha256, `${prior.path} does not match revision.prior_manifest.sha256`);
});
