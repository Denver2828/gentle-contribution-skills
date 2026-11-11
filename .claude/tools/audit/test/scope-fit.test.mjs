import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScopeFit } from '../lib/scope-fit.mjs';

const fit = { failure_class: 'missing consumer', mandatory_consumer: '.claude/hooks/pre-commit', intervention_point: 'before commit', counterfactual_proof: 'controlled mutation' };
const decide = (scope_decision, fit_decision = fit) => evaluateScopeFit({ scope_decision, fit_decision, continuation: 'take the route' });

test('owned direct controls require a real root, consumer and intervention', () => {
  assert.equal(decide({ owner: 'ours', authority: 'outer', allowed_edit_root: '.claude', route: 'direct' }).coherent, true);
  assert.equal(decide({ owner: 'ours', authority: 'outer', allowed_edit_root: '.claude', route: 'direct' }, { ...fit, mandatory_consumer: 'none' }).coherent, false);
});

test('third-party targets can only be proposals with no edit root', () => {
  assert.equal(decide({ owner: 'third_party', authority: 'upstream', allowed_edit_root: 'none', route: 'proposal' }).coherent, true);
  assert.equal(decide({ owner: 'third_party', authority: 'upstream', allowed_edit_root: 'src', route: 'direct' }).coherent, false);
  assert.equal(decide(
    { owner: 'third_party', allowed_edit_root: 'none', route: 'proposal' },
    { failure_class: 'proposal gap' }
  ).coherent, false);
});

test('absence of authority archives rather than inventing one', () => {
  assert.equal(decide({ owner: 'none', authority: 'none', allowed_edit_root: 'none', route: 'archive' }).coherent, true);
  assert.equal(decide({ owner: 'none', authority: 'new', allowed_edit_root: '.claude', route: 'direct' }).coherent, false);
});
